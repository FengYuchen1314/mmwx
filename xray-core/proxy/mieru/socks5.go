// socks5.go:mieru 会话内承载的是 socks5 协议(RFC1928)。openSessionRequest 的 payload =
// socks5 CONNECT 请求 + 紧跟的初始应用数据(HANDSHAKE_NO_WAIT)。这里解析请求头得到目标地址。
package mieru

import (
	"github.com/xtls/xray-core/common/errors"
	xnet "github.com/xtls/xray-core/common/net"
)

const (
	socks5Version         = 0x05
	socks5CmdConnect      = 0x01
	socks5CmdUDPAssociate = 0x03
	socks5ATYPIPv4        = 0x01
	socks5ATYPDomain      = 0x03
	socks5ATYPIPv6        = 0x04
)

// socks5SuccessReplyIPv4 是最小 socks5 成功回复:VER=5 REP=0 RSV=0 ATYP=1 0.0.0.0:0。真实客户端接受任意 bound 地址。
var socks5SuccessReplyIPv4 = []byte{socks5Version, 0x00, 0x00, socks5ATYPIPv4, 0, 0, 0, 0, 0, 0}

// parseSocks5Request 解析 socks5 请求头,返回目标、命令、消耗字节数(其后为初始应用数据)。
func parseSocks5Request(b []byte) (dest xnet.Destination, cmd byte, consumed int, err error) {
	if len(b) < 4 || b[0] != socks5Version {
		return dest, 0, 0, errors.New("mieru: bad socks5 request header")
	}
	cmd = b[1]
	atyp := b[3]
	p := 4
	var addr xnet.Address
	switch atyp {
	case socks5ATYPIPv4:
		if len(b) < p+4+2 {
			return dest, 0, 0, errors.New("mieru: short socks5 ipv4 request")
		}
		addr = xnet.IPAddress(b[p : p+4])
		p += 4
	case socks5ATYPDomain:
		if len(b) < p+1 {
			return dest, 0, 0, errors.New("mieru: short socks5 domain len")
		}
		n := int(b[p])
		p++
		if len(b) < p+n+2 {
			return dest, 0, 0, errors.New("mieru: short socks5 domain request")
		}
		addr = xnet.DomainAddress(string(b[p : p+n]))
		p += n
	case socks5ATYPIPv6:
		if len(b) < p+16+2 {
			return dest, 0, 0, errors.New("mieru: short socks5 ipv6 request")
		}
		addr = xnet.IPAddress(b[p : p+16])
		p += 16
	default:
		return dest, 0, 0, errors.New("mieru: unknown socks5 atyp ", int(atyp))
	}
	port := xnet.PortFromBytes(b[p : p+2])
	p += 2

	network := xnet.Network_TCP
	if cmd == socks5CmdUDPAssociate {
		network = xnet.Network_UDP
	}
	dest = xnet.Destination{Network: network, Address: addr, Port: port}
	return dest, cmd, p, nil
}
