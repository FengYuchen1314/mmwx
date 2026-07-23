// segment.go:mieru TCP 段读写。线格式(黑盒抓包字节级验证,见 [[mieru-port-cleanroom]]):
//
//	[nonce(24,仅每方向首段)] [encMeta(32)+tag(16)] [pad1=prefixLen] [encPayload(payloadLen)+tag(16) 仅 payloadLen>0] [pad2=suffixLen]
//
// nonce 每方向只首段出现一次,之后本地 +1;每次 AEAD 操作(解/封 meta 一次、payload 一次)nonce+1。
// 段自定界:先解 32B 元数据得 prefixLen/payloadLen/suffixLen,再据此读余下。padding 是明文熵调节,收方按长度跳过、不校验。
package mieru

import (
	"crypto/cipher"
	"io"

	"github.com/xtls/xray-core/common/errors"
)

const aeadTagLen = 16

// segment 是解出的一个段(会话/数据元数据 + 可选 payload)。
type segment struct {
	protocolType uint8
	sessionID    uint32
	seq          uint32
	unackSeq     uint32
	window       uint16
	statusCode   uint8
	payload      []byte
}

// segmentReader 从一条 TCP 连接的**一个方向**读段。nonce 已由调用方读出(首段的 24 字节)并解析出用户,
// 这里持有该 nonce 计数器,逐段推进(与 snell newRecordReaderResume 同思路)。
type segmentReader struct {
	r     io.Reader
	aead  cipher.AEAD
	nonce []byte // 24 字节计数器,每次 AEAD 操作后 +1
}

func newSegmentReader(r io.Reader, aead cipher.AEAD, nonce []byte) *segmentReader {
	n := make([]byte, nonceLen)
	copy(n, nonce)
	return &segmentReader{r: r, aead: aead, nonce: n}
}

// read 读并解密下一个段。
func (sr *segmentReader) read() (*segment, error) {
	encMeta := make([]byte, metadataLen+aeadTagLen) // 48
	if _, err := io.ReadFull(sr.r, encMeta); err != nil {
		return nil, err
	}
	meta, err := sr.aead.Open(encMeta[:0], sr.nonce, encMeta, nil)
	if err != nil {
		return nil, errors.New("mieru: open metadata failed").Base(err)
	}
	incrementNonce(sr.nonce)

	pt := metaProtocolType(meta)
	seg := &segment{protocolType: pt}
	var prefixLen, payloadLen, suffixLen int
	switch {
	case isSessionMeta(pt):
		m, _ := decodeSessionMeta(meta)
		seg.sessionID, seg.seq, seg.statusCode = m.sessionID, m.seq, m.statusCode
		payloadLen, suffixLen = int(m.payloadLen), int(m.suffixLen)
	case isDataMeta(pt):
		m, _ := decodeDataMeta(meta)
		seg.sessionID, seg.seq, seg.unackSeq, seg.window = m.sessionID, m.seq, m.unackSeq, m.window
		prefixLen, payloadLen, suffixLen = int(m.prefixLen), int(m.payloadLen), int(m.suffixLen)
	default:
		return nil, errors.New("mieru: unsupported metadata protocol type ", int(pt))
	}

	if prefixLen > 0 { // pad1
		if _, err := io.CopyN(io.Discard, sr.r, int64(prefixLen)); err != nil {
			return nil, err
		}
	}
	if payloadLen > 0 {
		buf := make([]byte, payloadLen+aeadTagLen)
		if _, err := io.ReadFull(sr.r, buf); err != nil {
			return nil, err
		}
		pl, err := sr.aead.Open(buf[:0], sr.nonce, buf, nil)
		if err != nil {
			return nil, errors.New("mieru: open payload failed").Base(err)
		}
		incrementNonce(sr.nonce)
		seg.payload = pl
	}
	if suffixLen > 0 { // pad2
		if _, err := io.CopyN(io.Discard, sr.r, int64(suffixLen)); err != nil {
			return nil, err
		}
	}
	return seg, nil
}

// segmentWriter 向一条 TCP 连接的**一个方向**写段。首段前置 24 字节 nonce(本方向自选,末 4 字节带 userTag)。
// 我们发送时不加 padding(prefixLen/suffixLen=0),合法且真实客户端接受。
type segmentWriter struct {
	w         io.Writer
	aead      cipher.AEAD
	nonce     []byte
	firstDone bool
}

func newSegmentWriter(w io.Writer, aead cipher.AEAD, nonce []byte) *segmentWriter {
	n := make([]byte, nonceLen)
	copy(n, nonce)
	return &segmentWriter{w: w, aead: aead, nonce: n}
}

// write 封装并发送一个段。metaBytes 为 32 字节明文元数据(payloadLen 须与 payload 长度一致,prefix/suffix=0)。
func (sw *segmentWriter) write(metaBytes, payload []byte) error {
	out := make([]byte, 0, nonceLen+metadataLen+aeadTagLen+len(payload)+aeadTagLen)
	if !sw.firstDone {
		out = append(out, sw.nonce...)
		sw.firstDone = true
	}
	out = sw.aead.Seal(out, sw.nonce, metaBytes, nil)
	incrementNonce(sw.nonce)
	if len(payload) > 0 {
		out = sw.aead.Seal(out, sw.nonce, payload, nil)
		incrementNonce(sw.nonce)
	}
	_, err := sw.w.Write(out)
	return err
}
