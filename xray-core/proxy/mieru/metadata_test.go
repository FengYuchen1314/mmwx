package mieru

import (
	"encoding/hex"
	"testing"
)

// 参考字节由独立 Python 按 docs/protocol.md 布局打包(净室:对规范布局验证)。
func TestSessionMetaEncodeVector(t *testing.T) {
	m := sessionMeta{
		protocolType: protoOpenSessionRequest, timestamp: 100, sessionID: 0xAABBCCDD,
		seq: 1, statusCode: 0, payloadLen: 5, suffixLen: 3,
	}
	if got := hex.EncodeToString(m.encode()); got != "020000000064aabbccdd00000001000005030000000000000000000000000000" {
		t.Errorf("session encode = %s", got)
	}
	dec, err := decodeSessionMeta(m.encode())
	if err != nil || dec != m {
		t.Errorf("session round-trip: %+v err=%v", dec, err)
	}
}

func TestDataMetaEncodeVector(t *testing.T) {
	m := dataMeta{
		protocolType: protoDataClientToServer, timestamp: 200, sessionID: 0x11223344,
		seq: 7, unackSeq: 6, window: 256, fragment: 2, prefixLen: 4, payloadLen: 9, suffixLen: 1,
	}
	if got := hex.EncodeToString(m.encode()); got != "0600000000c81122334400000007000000060100020400090100000000000000" {
		t.Errorf("data encode = %s", got)
	}
	dec, err := decodeDataMeta(m.encode())
	if err != nil || dec != m {
		t.Errorf("data round-trip: %+v err=%v", dec, err)
	}
}

func TestMetaTypeClassify(t *testing.T) {
	if !isSessionMeta(protoOpenSessionRequest) || !isSessionMeta(protoCloseSessionResponse) {
		t.Error("session type 分类错误")
	}
	if !isDataMeta(protoDataClientToServer) || !isDataMeta(protoAckServerToClient) {
		t.Error("data type 分类错误")
	}
	if isSessionMeta(protoDataClientToServer) || isDataMeta(protoOpenSessionRequest) {
		t.Error("跨类误判")
	}
}
