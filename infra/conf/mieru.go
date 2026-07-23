package conf

import (
	"github.com/xtls/xray-core/common/errors"
	"github.com/xtls/xray-core/common/protocol"
	"github.com/xtls/xray-core/common/serial"
	"github.com/xtls/xray-core/proxy/mieru"
	"google.golang.org/protobuf/proto"
)

type MieruUser struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Level    byte   `json:"level"`
	Email    string `json:"email"`
}

type MieruServerConfig struct {
	Users     []*MieruUser `json:"users"`
	Transport string       `json:"transport"`
}

func (c *MieruServerConfig) Build() (proto.Message, error) {
	cfg := &mieru.ServerConfig{
		Users:     make([]*protocol.User, 0, len(c.Users)),
		Transport: c.Transport,
	}
	for _, u := range c.Users {
		if u.Username == "" || u.Password == "" {
			return nil, errors.New("MIERU: user username and password are required")
		}
		cfg.Users = append(cfg.Users, &protocol.User{
			Level: uint32(u.Level),
			Email: u.Email,
			Account: serial.ToTypedMessage(&mieru.Account{
				Username: u.Username,
				Password: u.Password,
			}),
		})
	}
	return cfg, nil
}
