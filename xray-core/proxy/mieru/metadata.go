// metadata.go:mieru 段元数据(定长 32 字节)编解码。依据 docs/protocol.md「Metadata Format」。
// 两类(低熵扩展 10/11 暂不实现):
//
//	Session(2..5):| type | _ | timestamp(4) | sessionID(4) | seq(4) | status(1) | payloadLen(2) | suffixLen(1) | _(14) |
//	Data   (6..9):| type | _ | timestamp(4) | sessionID(4) | seq(4) | unackSeq(4) | window(2) | frag(1) | prefixLen(1) | payloadLen(2) | suffixLen(1) | _(7) |
package mieru

import (
	"encoding/binary"

	"github.com/xtls/xray-core/common/errors"
)

const metadataLen = 32

// protocol type 取值(规范定义)。
const (
	protoOpenSessionRequest   = 2
	protoOpenSessionResponse  = 3
	protoCloseSessionRequest  = 4
	protoCloseSessionResponse = 5
	protoDataClientToServer   = 6
	protoDataServerToClient   = 7
	protoAckClientToServer    = 8
	protoAckServerToClient    = 9
	// 低熵扩展(暂不支持,但需识别以便优雅拒绝)
	protoDataClientToServerLowEntropy = 10
	protoDataServerToClientLowEntropy = 11
)

// sessionMeta 对应 Session Metadata(protocol type 2..5)。
type sessionMeta struct {
	protocolType uint8
	timestamp    uint32 // 距 epoch 的分钟数
	sessionID    uint32
	seq          uint32
	statusCode   uint8
	payloadLen   uint16 // ≤1024
	suffixLen    uint8  // padding 2 长度
}

func (m sessionMeta) encode() []byte {
	b := make([]byte, metadataLen)
	b[0] = m.protocolType
	// b[1] unused
	binary.BigEndian.PutUint32(b[2:6], m.timestamp)
	binary.BigEndian.PutUint32(b[6:10], m.sessionID)
	binary.BigEndian.PutUint32(b[10:14], m.seq)
	b[14] = m.statusCode
	binary.BigEndian.PutUint16(b[15:17], m.payloadLen)
	b[17] = m.suffixLen
	// b[18:32] unused
	return b
}

func decodeSessionMeta(b []byte) (sessionMeta, error) {
	if len(b) < metadataLen {
		return sessionMeta{}, errors.New("mieru: session metadata too short")
	}
	return sessionMeta{
		protocolType: b[0],
		timestamp:    binary.BigEndian.Uint32(b[2:6]),
		sessionID:    binary.BigEndian.Uint32(b[6:10]),
		seq:          binary.BigEndian.Uint32(b[10:14]),
		statusCode:   b[14],
		payloadLen:   binary.BigEndian.Uint16(b[15:17]),
		suffixLen:    b[17],
	}, nil
}

// dataMeta 对应 Data Metadata(protocol type 6..9)。
type dataMeta struct {
	protocolType uint8
	timestamp    uint32
	sessionID    uint32
	seq          uint32
	unackSeq     uint32
	window       uint16
	fragment     uint8
	prefixLen    uint8 // padding 1 长度
	payloadLen   uint16
	suffixLen    uint8 // padding 2 长度
}

func (m dataMeta) encode() []byte {
	b := make([]byte, metadataLen)
	b[0] = m.protocolType
	// b[1] unused
	binary.BigEndian.PutUint32(b[2:6], m.timestamp)
	binary.BigEndian.PutUint32(b[6:10], m.sessionID)
	binary.BigEndian.PutUint32(b[10:14], m.seq)
	binary.BigEndian.PutUint32(b[14:18], m.unackSeq)
	binary.BigEndian.PutUint16(b[18:20], m.window)
	b[20] = m.fragment
	b[21] = m.prefixLen
	binary.BigEndian.PutUint16(b[22:24], m.payloadLen)
	b[24] = m.suffixLen
	// b[25:32] unused
	return b
}

func decodeDataMeta(b []byte) (dataMeta, error) {
	if len(b) < metadataLen {
		return dataMeta{}, errors.New("mieru: data metadata too short")
	}
	return dataMeta{
		protocolType: b[0],
		timestamp:    binary.BigEndian.Uint32(b[2:6]),
		sessionID:    binary.BigEndian.Uint32(b[6:10]),
		seq:          binary.BigEndian.Uint32(b[10:14]),
		unackSeq:     binary.BigEndian.Uint32(b[14:18]),
		window:       binary.BigEndian.Uint16(b[18:20]),
		fragment:     b[20],
		prefixLen:    b[21],
		payloadLen:   binary.BigEndian.Uint16(b[22:24]),
		suffixLen:    b[24],
	}, nil
}

// metaProtocolType 从已解密的 32 字节元数据里取 protocol type(用于分派 session/data 解码)。
func metaProtocolType(b []byte) uint8 {
	if len(b) == 0 {
		return 0
	}
	return b[0]
}

// isDataMeta / isSessionMeta 判断 protocol type 属于哪类元数据。
func isSessionMeta(t uint8) bool {
	return t >= protoOpenSessionRequest && t <= protoCloseSessionResponse
}
func isDataMeta(t uint8) bool { return t >= protoDataClientToServer && t <= protoAckServerToClient }
