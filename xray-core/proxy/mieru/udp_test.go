package mieru

import (
	"bytes"
	"encoding/hex"
	"testing"
)

// 真实 fixture:官方 mieru 客户端(UDP transport)发出的 openSessionRequest 首包(324 字节,抓包所得)。
// 用户 alice/secret123,timeSalt 取整时间 1784817120。验证 UDP 段解码(nonce-per-包、meta+payload 同 nonce)。
const realUDPFullHex = "797862744c466c2405622377a02e635d8e1a0b63fa19a6fb06bb8c23b9e80014b0f2edddd8696e95ebd9d7133bb19ea8115488df6a14e3296376b7b4e5452a76474d7c2a3bed26d401ba8de5558a07f3299881b8f60a01f8b71990566f91b1885900dc8f4525cd185954fa67f7199f73a55b36fcc94e42ea4d6d1407a4b9aa7cf6686274d5bf4669609b56960f37ba9d1d763398516ef80fe3c187e0a0272cf80950bb4be2f154679ce95da27b889000e385ffb240200100008000000000000300100040000004008100500210001080000219000031300058820001400000005040004221044800000000401040010000040000002004c018000082010109000a54670800080400010a00800101004000000004400400040100000000060000444000100300000401440200c8000000080000210000040300040004800002a80000020a"

func TestUDPSegmentDecodeRealPacket(t *testing.T) {
	// 完整包见 scratchpad/udp_seg1.hex;此处内联完整 324 字节。
	seg, err := hex.DecodeString(realUDPFullHex)
	if err != nil || len(seg) != 324 {
		t.Fatalf("fixture len=%d err=%v", len(seg), err)
	}
	nonce := seg[:nonceLen]
	if !nonceMatchesUser("alice", nonce) {
		t.Fatal("nonce userTag 未命中 alice")
	}
	key, _ := deriveKey(hashPassword("alice", "secret123"), timeSalt(1784817120))
	aead, _ := newAEAD(key)

	s, err := decodeUDPSegment(seg, aead)
	if err != nil {
		t.Fatalf("decodeUDPSegment: %v", err)
	}
	if s.protocolType != protoOpenSessionRequest || s.sessionID != 2139550746 || s.seq != 0 {
		t.Errorf("meta 错误: type=%d sid=%d seq=%d", s.protocolType, s.sessionID, s.seq)
	}
	if len(s.payload) != 92 {
		t.Fatalf("payloadLen=%d want 92", len(s.payload))
	}
	wantPrefix := []byte{0x05, 0x01, 0x00, 0x03, 0x0b, 'e', 'x', 'a', 'm', 'p', 'l', 'e', '.', 'c', 'o', 'm', 0x00, 0x50}
	if !bytes.HasPrefix(s.payload, wantPrefix) {
		t.Errorf("payload 未以 socks5 CONNECT 开头: %x", s.payload[:20])
	}
}

// encode→decode 自洽:UDP 段封装后应能解回(含 meta+payload 同 nonce 语义)。
func TestUDPSegmentRoundTrip(t *testing.T) {
	key, _ := deriveKey(hashPassword("u", "p"), timeSalt(roundedUnixTime(1700000000)))
	aead, _ := newAEAD(key)

	pl := []byte("mieru udp payload")
	meta := dataMeta{protocolType: protoDataServerToClient, sessionID: 7, seq: 3, unackSeq: 2, window: 4096, payloadLen: uint16(len(pl))}.encode()
	pkt, err := encodeUDPSegment(meta, pl, aead, "u")
	if err != nil {
		t.Fatal(err)
	}
	if !nonceMatchesUser("u", pkt[:nonceLen]) {
		t.Error("encode 后 nonce 应带 userTag")
	}
	s, err := decodeUDPSegment(pkt, aead)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if s.protocolType != protoDataServerToClient || s.sessionID != 7 || s.seq != 3 || s.unackSeq != 2 || string(s.payload) != string(pl) {
		t.Errorf("round-trip 不一致: %+v", s)
	}
}
