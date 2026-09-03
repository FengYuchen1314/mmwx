package mieru

import (
	"github.com/xtls/xray-core/common/protocol"
	"google.golang.org/protobuf/proto"
)

// MemoryAccount 是运行期的 mieru 用户凭据。AEAD key 需结合每连接的 nonce/timeSalt 派生,
// 这里预算好 hashedPassword(= SHA256(password ‖ 0x00 ‖ username))以加速握手期逐用户试解。
type MemoryAccount struct {
	Username       string
	Password       string
	hashedPassword []byte
}

func (a *Account) AsAccount() (protocol.Account, error) {
	return &MemoryAccount{
		Username:       a.Username,
		Password:       a.Password,
		hashedPassword: hashPassword(a.Username, a.Password),
	}, nil
}

func (m *MemoryAccount) Equals(another protocol.Account) bool {
	if o, ok := another.(*MemoryAccount); ok {
		return m.Username == o.Username
	}
	return false
}

func (m *MemoryAccount) ToProto() proto.Message {
	return &Account{Username: m.Username, Password: m.Password}
}
