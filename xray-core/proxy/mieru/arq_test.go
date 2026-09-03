package mieru

import (
	"testing"
	"time"
)

// localhost 互通不会丢包/乱序,故 ARQ 的重排/去重路径需单测直接覆盖(真实网络才会触发)。
func newTestARQ(t *testing.T) *arqSession {
	t.Helper()
	key, _ := deriveKey(hashPassword("u", "p"), timeSalt(roundedUnixTime(1700000000)))
	aead, _ := newAEAD(key)
	// writePkt 吞掉(ack/重传包);测试只关心交付顺序。
	return newARQSession(1, "u", aead, func([]byte) error { return nil })
}

func dataSeg(seq uint32, payload string) *segment {
	return &segment{protocolType: protoDataClientToServer, sessionID: 1, seq: seq, payload: []byte(payload)}
}

// 乱序到达应按 seq 有序交付。
func TestARQReordersOutOfOrder(t *testing.T) {
	a := newTestARQ(t)
	defer a.close()
	// 乱序喂:2,0,1
	a.onSegment(dataSeg(2, "C"))
	a.onSegment(dataSeg(0, "A"))
	a.onSegment(dataSeg(1, "B"))

	got := drain(t, a, 3)
	if got != "ABC" {
		t.Errorf("交付顺序 = %q, want ABC", got)
	}
}

// 重复段不应重复交付。
func TestARQDropsDuplicates(t *testing.T) {
	a := newTestARQ(t)
	defer a.close()
	a.onSegment(dataSeg(0, "A"))
	a.onSegment(dataSeg(0, "A")) // 重复
	a.onSegment(dataSeg(1, "B"))
	a.onSegment(dataSeg(1, "B")) // 重复

	got := drain(t, a, 2)
	if got != "AB" {
		t.Errorf("交付 = %q, want AB(无重复)", got)
	}
}

// 累积确认:收到对端 ack(unackSeq)应释放待确认段。
func TestARQApplyAckReleasesUnacked(t *testing.T) {
	a := newTestARQ(t)
	defer a.close()
	// 手动塞 3 个待确认段 seq 0,1,2
	a.sndMu.Lock()
	a.sndNext = 3
	a.unacked[0] = &unackedSeg{pkt: []byte{1}}
	a.unacked[1] = &unackedSeg{pkt: []byte{2}}
	a.unacked[2] = &unackedSeg{pkt: []byte{3}}
	a.sndMu.Unlock()

	// 对端确认到 seq 2(即 0,1 已收)
	a.applyAck(2, 4096)
	a.sndMu.Lock()
	_, has0 := a.unacked[0]
	_, has1 := a.unacked[1]
	_, has2 := a.unacked[2]
	unack := a.sndUnack
	a.sndMu.Unlock()
	if has0 || has1 || !has2 {
		t.Errorf("应释放 seq0/1、保留 seq2: has0=%v has1=%v has2=%v", has0, has1, has2)
	}
	if unack != 2 {
		t.Errorf("sndUnack = %d, want 2", unack)
	}
}

// drain 从 delivered 通道读 n 个段的 payload 拼成字符串。
func drain(t *testing.T, a *arqSession, n int) string {
	t.Helper()
	var out []byte
	for i := 0; i < n; i++ {
		select {
		case seg := <-a.delivered:
			out = append(out, seg.payload...)
		case <-time.After(2 * time.Second):
			t.Fatalf("交付超时:只收到 %d/%d 段", i, n)
		}
	}
	return string(out)
}
