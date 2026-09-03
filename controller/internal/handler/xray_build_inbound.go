package handler

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// 高层 inbound 构建器:把「协议 + 端口 + 域名/安全」等高层意图,在服务端拼成一条完整的 xray 入站,
// 并自动生成所需密钥(reality x25519 / UUID / 密码)。用于 MCP/自动化 —— 让 agent 无需复刻前端
// inbound-wizard 的 3.8k 行配置逻辑即可"加入站"。只覆盖常用协议 + 合理默认;冷门组合仍走前端 UI。
//
// 产出结构与前端 xray-config-generator.ts 对齐(protocol/settings/streamSettings),
// 直接可 POST 到 /api/admin/remote/inbounds。

type BuildInboundHandler struct{}

func NewBuildInboundHandler() *BuildInboundHandler { return &BuildInboundHandler{} }

// HandleProfiles provides the UI with the same closed catalog used by the
// request validator. It prevents a separately maintained frontend dropdown
// from drifting back toward removed protocols.
func (h *BuildInboundHandler) HandleProfiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, fmt.Errorf("method not allowed"))
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"profiles": SupportedProtocolProfiles()})
}

type buildInboundRequest struct {
	Profile    string `json:"profile"`     // required: one of SupportedProtocolProfiles
	Protocol   string `json:"protocol"`    // ignored; retained only for a clear error on legacy callers
	Port       int    `json:"port"`        // 监听端口(必填)
	Tag        string `json:"tag"`         // 入站 tag;留空自动生成 <protocol>-in-<port>
	Transport  string `json:"transport"`   // tcp(默认) / ws
	Security   string `json:"security"`    // reality / tls / none;留空按协议给默认
	ServerName string `json:"server_name"` // TLS SNI,或 reality 的偷取目标域名(如 www.microsoft.com)
	Dest       string `json:"dest"`        // reality 偷取目标 host:port;留空则用 server_name:443
	Path       string `json:"path"`        // ws path,默认 /ws
	Host       string `json:"host"`        // ws Host header(可选)
	Method     string `json:"method"`      // reserved for API compatibility; catalogue profiles do not use it
	Email      string `json:"email"`       // 客户端标识(email),留空自动生成
	UUID       string `json:"uuid"`        // VLESS / Mieru client id, generated when blank
	Password   string `json:"password"`    // AnyTLS / SOCKS5 password, generated when blank
	Auth       string `json:"auth"`        // ShadowTLS password, generated when blank
	CertDomain string `json:"cert_domain"` // TLS 证书域名(tls 安全时,后端按域名解析已签发证书)
}

// HandleBuildInbound POST /api/admin/xray/build-inbound —— 返回 { success, inbound, credentials }。
// inbound 可直接 apply;credentials 汇总自动生成的密钥,供 agent 告知用户如何连接(尤其 reality 公钥)。
func (h *BuildInboundHandler) HandleBuildInbound(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, fmt.Errorf("method not allowed"))
		return
	}
	var req buildInboundRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeBadRequest(w, "请求格式错误")
		return
	}
	req.Protocol = strings.ToLower(strings.TrimSpace(req.Protocol))
	req.Profile = strings.ToLower(strings.TrimSpace(req.Profile))
	if req.Profile == "" {
		writeBadRequest(w, "profile 必填；请选择受支持的协议组合")
		return
	}
	if req.Port <= 0 || req.Port > 65535 {
		writeBadRequest(w, "port 必填且须在 1-65535")
		return
	}

	inbound, creds, err := buildInbound(&req)
	if err != nil {
		writeBadRequest(w, err.Error())
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"success":     true,
		"inbound":     inbound,
		"credentials": creds,
	})
}

// buildInbound 依据高层意图拼出完整入站 + 汇总生成的凭据。
func buildInbound(req *buildInboundRequest) (map[string]any, map[string]any, error) {
	profile := strings.ToLower(strings.TrimSpace(req.Profile))
	tag := strings.TrimSpace(req.Tag)
	if tag == "" {
		tag = fmt.Sprintf("%s-in-%d", profile, req.Port)
	}
	email := strings.TrimSpace(req.Email)
	if email == "" {
		email = tag
	}
	inbound := map[string]any{
		"port":     req.Port,
		"listen":   "0.0.0.0",
		"tag":      tag,
		"sniffing": map[string]any{"enabled": true, "destOverride": []string{"http", "tls", "quic"}},
	}
	creds := map[string]any{}

	switch profile {
	case "vless-reality-vision":
		inbound["protocol"] = "vless"
		uuid := orGen(req.UUID, newUUIDv4)
		client := map[string]any{"id": uuid, "level": 0, "email": email, "flow": "xtls-rprx-vision"}
		inbound["settings"] = map[string]any{"decryption": "none", "clients": []any{client}}
		ss, c, err := buildStream(req, "tcp", "reality")
		if err != nil {
			return nil, nil, err
		}
		inbound["streamSettings"] = ss
		creds = merge(c, map[string]any{"uuid": uuid, "email": email, "flow": client["flow"]})

	case "vless-xhttp-reality-xmux":
		inbound["protocol"] = "vless"
		uuid := orGen(req.UUID, newUUIDv4)
		inbound["settings"] = map[string]any{"decryption": "none", "clients": []any{map[string]any{"id": uuid, "level": 0, "email": email}}}
		ss, c, err := buildXHTTPRealityStream(req)
		if err != nil {
			return nil, nil, err
		}
		inbound["streamSettings"] = ss
		creds = merge(c, map[string]any{"uuid": uuid, "email": email})

	case "anytls-shadowtls":
		inbound["protocol"] = "anytls"
		pw := orGen(req.Password, genPassword)
		inbound["settings"] = map[string]any{"users": []any{map[string]any{"password": pw, "level": 0, "email": email}}}
		inbound["streamSettings"] = map[string]any{"network": "tcp"}
		handshake := strings.TrimSpace(req.Dest)
		if handshake == "" {
			handshake = strings.TrimSpace(req.ServerName)
		}
		if handshake == "" {
			return nil, nil, fmt.Errorf("AnyTLS + ShadowTLS 需要 handshake 目标(如 www.cloudflare.com:443)")
		}
		if !strings.Contains(handshake, ":") {
			handshake += ":443"
		}
		// This extension is consumed by mmw-agent.  It is intentionally not an
		// Xray stream setting: ShadowTLS is a separate, supervised process.
		shadowPassword := orGen(req.Auth, genPassword)
		inbound["mmwxShadowTLS"] = map[string]any{"enabled": true, "handshake": handshake, "password": shadowPassword, "public_port": req.Port}
		creds = map[string]any{"password": pw, "email": email, "shadowtls_handshake": handshake, "shadowtls_password": shadowPassword}

	case "mieru":
		inbound["protocol"] = "mieru"
		username := strings.TrimSpace(req.Email)
		if username == "" {
			username = email
		}
		pw := orGen(req.Password, genPassword)
		inbound["settings"] = map[string]any{"transport": "TCP", "users": []any{map[string]any{"username": username, "password": pw, "level": 0, "email": email}}}
		inbound["streamSettings"] = map[string]any{"network": "tcp"}
		creds = map[string]any{"username": username, "password": pw, "email": email}

	case "socks5":
		inbound["protocol"] = "socks"
		username := strings.TrimSpace(req.Email)
		if username == "" {
			username = email
		}
		pw := orGen(req.Password, genPassword)
		inbound["settings"] = map[string]any{"auth": "password", "udp": true, "accounts": []any{map[string]any{"user": username, "pass": pw}}}
		inbound["streamSettings"] = map[string]any{"network": "tcp"}
		creds = map[string]any{"username": username, "password": pw}

	default:
		return nil, nil, fmt.Errorf("不支持 profile %q", profile)
	}
	if err := ValidateManagedInbound(inbound); err != nil {
		return nil, nil, err
	}

	return inbound, creds, nil
}

func buildXHTTPRealityStream(req *buildInboundRequest) (map[string]any, map[string]any, error) {
	ss, creds, err := buildStream(req, "xhttp", "reality")
	if err != nil {
		return nil, nil, err
	}
	path := strings.TrimSpace(req.Path)
	if path == "" {
		path = "/xhttp"
	}
	xhttp := map[string]any{
		"path": path,
		"mode": "auto",
		"xmux": map[string]any{
			// Xray forbids setting maxConnections and maxConcurrency together.
			"maxConcurrency":   map[string]any{"from": 4, "to": 16},
			"cMaxReuseTimes":   map[string]any{"from": 0, "to": 0},
			"hMaxRequestTimes": map[string]any{"from": 0, "to": 0},
			"hMaxReusableSecs": map[string]any{"from": 0, "to": 0},
			"hKeepAlivePeriod": 0,
		},
	}
	if host := strings.TrimSpace(req.Host); host != "" {
		xhttp["host"] = host
	}
	ss["xhttpSettings"] = xhttp
	return ss, creds, nil
}

// buildStream 拼 streamSettings(传输 tcp/ws + 安全 reality/tls/none),返回 streamSettings 与该安全层生成的凭据。
func buildStream(req *buildInboundRequest, transport, security string) (map[string]any, map[string]any, error) {
	ss := map[string]any{"network": transport}
	creds := map[string]any{}

	if transport == "ws" {
		wsPath := strings.TrimSpace(req.Path) // path 大小写敏感,不能走 def()(会转小写)
		if wsPath == "" {
			wsPath = "/ws"
		}
		ws := map[string]any{"path": wsPath}
		if h := strings.TrimSpace(req.Host); h != "" {
			ws["headers"] = map[string]any{"Host": h}
		}
		ss["wsSettings"] = ws
	}

	switch security {
	case "none", "":
		ss["security"] = "none"
	case "tls":
		tls := map[string]any{}
		if sni := strings.TrimSpace(req.ServerName); sni != "" {
			tls["serverName"] = sni
		}
		if cd := strings.TrimSpace(req.CertDomain); cd != "" {
			tls["certDomain"] = cd
		}
		ss["security"] = "tls"
		ss["tlsSettings"] = tls
	case "reality":
		sni := strings.TrimSpace(req.ServerName)
		if sni == "" {
			return nil, nil, fmt.Errorf("reality 需要 server_name(偷取目标域名,如 www.microsoft.com)")
		}
		dest := strings.TrimSpace(req.Dest)
		if dest == "" {
			dest = sni + ":443"
		}
		priv, pub, err := genX25519Pair()
		if err != nil {
			return nil, nil, fmt.Errorf("生成 reality 密钥失败: %w", err)
		}
		privKey := base64.RawURLEncoding.EncodeToString(priv)
		pubKey := base64.RawURLEncoding.EncodeToString(pub)
		shortID, err := genShortID()
		if err != nil {
			return nil, nil, err
		}
		ss["security"] = "reality"
		ss["realitySettings"] = map[string]any{
			"dest":        dest,
			"serverNames": []string{sni},
			"privateKey":  privKey,
			"shortIds":    []string{shortID},
			"publicKey":   pubKey, // 供客户端连接用;xray 入站忽略,但我们随 inbound 存下方便回读
		}
		creds = map[string]any{
			"reality_public_key": pubKey, // 客户端连接必须用这个公钥
			"reality_short_id":   shortID,
			"reality_dest":       dest,
			"reality_sni":        sni,
		}
	default:
		return nil, nil, fmt.Errorf("security 仅支持 reality / tls / none")
	}
	return ss, creds, nil
}

// ---- 生成原语 ----

func orGen(v string, gen func() string) string {
	if s := strings.TrimSpace(v); s != "" {
		return s
	}
	return gen()
}

func def(v, d string) string {
	if s := strings.TrimSpace(v); s != "" {
		return strings.ToLower(s)
	}
	return d
}

func merge(a, b map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		if v != nil {
			out[k] = v
		}
	}
	return out
}

// newUUIDv4 生成标准 UUID v4(vless/vmess 客户端 id)。
func newUUIDv4() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// genPassword 生成 16 字节随机密码(base64url,trojan/hy2 用)。
func genPassword() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// genSSPassword 生成 SS2022 需要的 base64(标准)密钥;默认 16 字节(128 位方法)。
func genSSPassword() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return base64.StdEncoding.EncodeToString(b)
}

// genShortID 生成 reality shortId(8 位 hex)。
func genShortID() (string, error) {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
