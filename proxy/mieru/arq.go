// arq.go:mieru UDP underlay 的**每会话可靠传输**(ARQ)。UDP 不保证送达/顺序,mieru 用
// seq/ack/window 自建可靠层(累积确认,类 TCP)。语义(黑盒观测,见 [[mieru-port-cleanroom]]):
//   - seq:每方向每会话的段序号,从 0(openSession)起逐段 +1(会话控制段与数据段共享 seq 空间)。
//   - unAckSeq:累积确认——"我下一个期望收到的 seq"(即已收到 unAckSeq-1 及之前的全部)。
//   - ack 段(8/9,seq=0 不占序号)或数据段上捎带 unAckSeq。
//   - window:接收方广告窗口;发送方未确认段数不得超过它。
//
// 互通只要求:正确累积确认 + 重传未确认段 + 乱序重排/去重。重传 RTO 用简单固定值 + 退避即可
// (对端不关心我如何计时,只要我会重传/确认)。
package mieru

import (
	"crypto/cipher"
	"sync"
	"time"

	"github.com/xtls/xray-core/common/buf"
	"github.com/xtls/xray-core/common/errors"
)

var errClosed = errors.New("mieru: arq session closed")

const (
	arqRTO        = 200 * time.Millisecond // 重传超时(简单固定 + 退避)
	arqMaxRetry   = 12                     // 单段最大重传次数,超则放弃会话
	udpMaxPayload = 1100                   // 每数据段 payload 上限(MTU1400 - nonce24 - meta32 - tag16 - tag16 - 余量)
	arqSendWindow = 256                    // 我方发送窗口上限(受对端 window 再收紧)
)

// unackedSeg 是一个已发送但未被确认的段(用于重传)。
type unackedSeg struct {
	pkt      []byte
	lastSent time.Time
	retries  int
}

// arqSession 提供一条会话的可靠、有序字节流(over UDP)。
// 接收:按 seq 重排后经 delivered 通道有序交付 *segment。
// 发送:sendSegment 分配 seq、缓存待确认、按对端 window 限流,retransmitLoop 负责重传。
type arqSession struct {
	id        uint32
	username  string
	aead      cipher.AEAD
	writePkt  func([]byte) error // 发一个 UDP 包(调用方串行化)
	closeOnce sync.Once
	closed    chan struct{}

	// 接收侧
	rcvMu     sync.Mutex
	rcvNext   uint32              // 下一个期望 seq
	reorder   map[uint32]*segment // 乱序缓存
	delivered chan *segment       // 有序交付给会话逻辑

	// 发送侧
	sndMu    sync.Mutex
	sndNext  uint32                 // 下一个分配的 seq
	sndUnack uint32                 // 最老未确认 seq
	peerWin  uint16                 // 对端广告窗口
	unacked  map[uint32]*unackedSeg // seq → 待确认段
	sndCond  *sync.Cond             // 窗口有空位时唤醒发送方
}

func newARQSession(id uint32, username string, aead cipher.AEAD, writePkt func([]byte) error) *arqSession {
	s := &arqSession{
		id:        id,
		username:  username,
		aead:      aead,
		writePkt:  writePkt,
		closed:    make(chan struct{}),
		reorder:   make(map[uint32]*segment),
		delivered: make(chan *segment, 64),
		peerWin:   arqSendWindow,
		unacked:   make(map[uint32]*unackedSeg),
	}
	s.sndCond = sync.NewCond(&s.sndMu)
	go s.retransmitLoop()
	return s
}

// onSegment 处理一个刚解出的收到段:更新发送侧确认 + 接收侧重排 + 回 ack。
func (s *arqSession) onSegment(seg *segment) {
	// 数据/ack 段捎带对端的 window 与对我方段的累积确认(unackSeq)。
	if isDataMeta(seg.protocolType) {
		s.applyAck(seg.unackSeq, seg.window)
	}
	// ack 段(8/9)只用于确认,不进接收流。
	if seg.protocolType == protoAckClientToServer || seg.protocolType == protoAckServerToClient {
		return
	}
	s.recvInOrder(seg)
}

// recvInOrder 按 seq 重排交付;去重、缓存乱序;交付后回累积 ack。
func (s *arqSession) recvInOrder(seg *segment) {
	s.rcvMu.Lock()
	if seg.seq < s.rcvNext {
		// 重复段:对端可能没收到我的 ack,补发一次 ack。
		s.rcvMu.Unlock()
		s.sendAck()
		return
	}
	if seg.seq > s.rcvNext {
		if _, ok := s.reorder[seg.seq]; !ok {
			s.reorder[seg.seq] = seg
		}
		s.rcvMu.Unlock()
		s.sendAck() // 触发对端快速重传缺口
		return
	}
	// seg.seq == rcvNext:有序交付,并连带已缓存的后续段。
	var toDeliver []*segment
	for {
		toDeliver = append(toDeliver, seg)
		s.rcvNext++
		next, ok := s.reorder[s.rcvNext]
		if !ok {
			break
		}
		delete(s.reorder, s.rcvNext)
		seg = next
	}
	s.rcvMu.Unlock()

	for _, d := range toDeliver {
		select {
		case s.delivered <- d:
		case <-s.closed:
			return
		}
	}
	s.sendAck()
}

// applyAck 处理对端对我方发送段的累积确认:释放 seq < unackSeq 的待确认段,更新窗口。
func (s *arqSession) applyAck(unackSeq uint32, window uint16) {
	s.sndMu.Lock()
	if window > 0 {
		s.peerWin = window
	}
	for seq := s.sndUnack; seq < unackSeq; seq++ {
		delete(s.unacked, seq)
	}
	if unackSeq > s.sndUnack {
		s.sndUnack = unackSeq
	}
	s.sndCond.Broadcast()
	s.sndMu.Unlock()
}

// sendSegment 分配 seq、封包、缓存待确认、发出。窗口满则阻塞等待确认。
// metaFactory 用分配到的 seq + 当前累积 ack(rcvNext)构造 32B 元数据。
func (s *arqSession) sendSegment(metaFactory func(seq, unackSeq uint32, window uint16) []byte, payload []byte) error {
	s.sndMu.Lock()
	for {
		inflight := s.sndNext - s.sndUnack
		win := uint32(s.peerWin)
		if win > arqSendWindow {
			win = arqSendWindow
		}
		if inflight < win {
			break
		}
		select {
		case <-s.closed:
			s.sndMu.Unlock()
			return errClosed
		default:
		}
		s.sndCond.Wait()
	}
	seq := s.sndNext
	s.sndNext++
	s.sndMu.Unlock()

	s.rcvMu.Lock()
	unackSeq := s.rcvNext
	s.rcvMu.Unlock()

	pkt, err := encodeUDPSegment(metaFactory(seq, unackSeq, s.rcvWindow()), payload, s.aead, s.username)
	if err != nil {
		return err
	}
	s.sndMu.Lock()
	s.unacked[seq] = &unackedSeg{pkt: pkt, lastSent: time.Now()}
	s.sndMu.Unlock()
	return s.writePkt(pkt)
}

// sendAck 发一个纯 ack 段(累积确认对端到 rcvNext)。
func (s *arqSession) sendAck() {
	s.rcvMu.Lock()
	unackSeq := s.rcvNext
	s.rcvMu.Unlock()
	meta := dataMeta{
		protocolType: protoAckServerToClient,
		sessionID:    s.id,
		seq:          0,
		unackSeq:     unackSeq,
		window:       s.rcvWindow(),
	}.encode()
	pkt, err := encodeUDPSegment(meta, nil, s.aead, s.username)
	if err == nil {
		_ = s.writePkt(pkt)
	}
}

// rcvWindow 返回我方广告的接收窗口(简单固定;够大即可,避免拖慢下载)。
func (s *arqSession) rcvWindow() uint16 { return 4096 }

// retransmitLoop 周期性重传超过 RTO 未确认的段(指数退避封顶)。
func (s *arqSession) retransmitLoop() {
	ticker := time.NewTicker(arqRTO / 2)
	defer ticker.Stop()
	for {
		select {
		case <-s.closed:
			return
		case <-ticker.C:
		}
		now := time.Now()
		s.sndMu.Lock()
		var give bool
		for _, u := range s.unacked {
			backoff := arqRTO << minInt(u.retries, 5)
			if now.Sub(u.lastSent) < backoff {
				continue
			}
			if u.retries >= arqMaxRetry {
				give = true
				break
			}
			u.retries++
			u.lastSent = now
			pkt := u.pkt
			s.sndMu.Unlock()
			_ = s.writePkt(pkt)
			s.sndMu.Lock()
		}
		s.sndMu.Unlock()
		if give {
			s.close()
			return
		}
	}
}

func (s *arqSession) close() {
	s.closeOnce.Do(func() {
		close(s.closed)
		s.sndMu.Lock()
		s.sndCond.Broadcast()
		s.sndMu.Unlock()
	})
}

// bytesToUDPFragments 把字节流切成 ≤udpMaxPayload 的片。
func bytesToUDPFragments(b []byte) [][]byte {
	var out [][]byte
	for len(b) > 0 {
		n := len(b)
		if n > udpMaxPayload {
			n = udpMaxPayload
		}
		chunk := make([]byte, n)
		copy(chunk, b[:n])
		out = append(out, chunk)
		b = b[n:]
	}
	return out
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// mbToBytes 把 MultiBuffer 拼成连续字节(会释放 mb)。
func mbToBytes(mb buf.MultiBuffer) []byte {
	var out []byte
	for _, b := range mb {
		out = append(out, b.Bytes()...)
	}
	buf.ReleaseMulti(mb)
	return out
}
