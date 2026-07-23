package mieru

import (
	"bytes"
	"encoding/hex"
	"testing"
)

// 真实 fixture:官方 mieru 客户端(TCP)发出的 openSessionRequest 首段(335 字节,抓包所得)。
// 用户 alice/secret123,该会话的 timeSalt 取整时间 = 1784804880(抓包时刻,dt=-120 桶)。
// 端到端验证 crypto+metadata+segment 三层对真实线字节的解码正确(净室:对二进制线行为,非对源码)。
const realFirstSegHex = "627346665248469b9c16ced10eb39cdc4336681e0657a2405d5d336b1fe8fa5661c53660771e9eff83643112546f80e5dd6125e4f8bd576df0f3e6d1d6db25585ccd743f22e37007588e5449fa51d385435239ef8b9da7fe2d7ff881e446ce3b2118c03bdcf9293a62d357eafb72d86bab1d2c406bd704b3e665b339936fd7311c3517672a68a0e8406ac806c1ab1bb75bd868fa501d6a29f97f775825f7f2c75e37f93630561869a5a4de77e589ba08748ee9a13cdffffffffbf5ffffeff7ffdffffcff5dfdb7bfff9dfbfeffdfffffeffdfbfffeffeffff7b7e9efffbd11fccfefbffffff7ffefbaeff5fffedf77bff5bfbfffeffd77ce7be5bffedffbfdfff797ffefffbfffdbfffdfe91bef7ffffb9fffff7d6effffdff376ffffffffbffd9dfff8f5ffffeff7c7fffff77ff9ddfefffbbff1fff7fe7ff7ffeffdfffffd7ef5ffffbff7ffdffffdf58fd3fffaf"

const realFirstSegRoundedTime = 1784804880

func TestSegmentReaderDecodesRealOpenSession(t *testing.T) {
	seg, err := hex.DecodeString(realFirstSegHex)
	if err != nil || len(seg) != 335 {
		t.Fatalf("fixture 解析失败 len=%d err=%v", len(seg), err)
	}
	nonce := seg[:nonceLen]

	// 服务端定位用户:末 4 字节 userTag 应命中 alice
	if !nonceMatchesUser("alice", nonce) {
		t.Fatal("nonce userTag 未命中 alice")
	}

	// 用已知 timeSalt 派生 key(真实互通中服务端会试 3 个桶)
	key, err := deriveKey(hashPassword("alice", "secret123"), timeSalt(realFirstSegRoundedTime))
	if err != nil {
		t.Fatalf("deriveKey: %v", err)
	}
	aead, err := newAEAD(key)
	if err != nil {
		t.Fatalf("newAEAD: %v", err)
	}

	sr := newSegmentReader(bytes.NewReader(seg[nonceLen:]), aead, nonce)
	s, err := sr.read()
	if err != nil {
		t.Fatalf("read segment: %v", err)
	}

	if s.protocolType != protoOpenSessionRequest {
		t.Errorf("protocolType=%d, want openSessionRequest(2)", s.protocolType)
	}
	if s.sessionID != 3773469574 || s.seq != 0 {
		t.Errorf("sessionID=%d seq=%d", s.sessionID, s.seq)
	}
	// payload 应以 socks5 CONNECT 请求开头:05 01 00 03 0b "example.com" 00 50
	wantPrefix := []byte{0x05, 0x01, 0x00, 0x03, 0x0b, 'e', 'x', 'a', 'm', 'p', 'l', 'e', '.', 'c', 'o', 'm', 0x00, 0x50}
	if len(s.payload) != 92 {
		t.Fatalf("payloadLen=%d, want 92", len(s.payload))
	}
	if !bytes.HasPrefix(s.payload, wantPrefix) {
		t.Errorf("payload 未以 socks5 CONNECT 请求开头: %x", s.payload[:20])
	}
	// 其余为初始应用数据(HTTP GET)
	if !bytes.Contains(s.payload, []byte("GET / HTTP/1.1")) {
		t.Errorf("payload 应含初始 HTTP 数据: %q", string(s.payload[18:]))
	}
}

// segmentWriter 写出的段,segmentReader 应能读回(自洽 round-trip:含首段 nonce、无 nonce 的后续段)。
func TestSegmentWriteReadRoundTrip(t *testing.T) {
	key, _ := deriveKey(hashPassword("u", "p"), timeSalt(roundedUnixTime(1700000000)))
	aead, _ := newAEAD(key)

	nonce := make([]byte, nonceLen)
	for i := range nonce {
		nonce[i] = byte(i)
	}
	applyUserTag(nonce, "u")

	var buf bytes.Buffer
	w := newSegmentWriter(&buf, aead, nonce)
	// 段1:openSessionResponse(无 payload)
	m1 := sessionMeta{protocolType: protoOpenSessionResponse, sessionID: 42, seq: 0}.encode()
	if err := w.write(m1, nil); err != nil {
		t.Fatal(err)
	}
	// 段2:dataServerToClient,带 payload
	pl := []byte("the quick brown fox")
	m2 := dataMeta{protocolType: protoDataServerToClient, sessionID: 42, seq: 1, window: 4096, payloadLen: uint16(len(pl))}.encode()
	if err := w.write(m2, pl); err != nil {
		t.Fatal(err)
	}

	r := newSegmentReader(bytes.NewReader(buf.Bytes()[nonceLen:]), aead, nonce)
	s1, err := r.read()
	if err != nil || s1.protocolType != protoOpenSessionResponse || s1.sessionID != 42 {
		t.Fatalf("段1: %+v err=%v", s1, err)
	}
	s2, err := r.read()
	if err != nil || s2.protocolType != protoDataServerToClient || string(s2.payload) != string(pl) {
		t.Fatalf("段2: %+v err=%v", s2, err)
	}
	if s2.window != 4096 {
		t.Errorf("window=%d", s2.window)
	}
}
