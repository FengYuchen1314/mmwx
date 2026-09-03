package handler

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	texttemplate "text/template"

	"miaomiaowux/internal/storage"
	"miaomiaowux/templates"
)

// VLESS WSS 入站 nginx 联动:
//   - 入站创建时:自动分配本地端口 + 随机 path,强制 listen 127.0.0.1 + security=none
//     (TLS 由 nginx 在 443 端口处理,xray 只负责 127.0.0.1:<port> 的 ws upgrade)
//   - 入站创建/删除后:聚合渲染该 server 全部 vless+ws 入站到一份 nginx domain.conf,
//     调 agent /api/child/nginx/setup-ssl 下发 + reload
//
// 与 reality 流程互斥(都覆盖 servers/{domain}.conf),设计上同一 server.domain 不应同时用两种。

const (
	wssPortRangeStart = 11000
	wssPortRangeEnd   = 19999
)

// wssServerLocks per-server mutex,防止并发添加 WSS 入站抢到同一端口。
var wssServerLocks sync.Map // serverID(int64) → *sync.Mutex

func wssServerLock(serverID int64) *sync.Mutex {
	v, _ := wssServerLocks.LoadOrStore(serverID, &sync.Mutex{})
	return v.(*sync.Mutex)
}

// 8 字符 a-z0-9 随机串,用于 ws path。
func randomWSPath() string {
	const charset = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "fallback1" // 极端罕见,撑住 nginx location 匹配即可
	}
	for i := range b {
		b[i] = charset[int(b[i])%len(charset)]
	}
	return "/ws/" + string(b)
}

// isVlessWSInboundReq 从 HandleInbounds 收到的 inboundReq 里判断是否 vless+ws 入站添加请求。
// 入参形如 {action: "add", inbound: {protocol, port, listen, streamSettings: {network, security, wsSettings: {path}}, ...}}。
func isVlessWSInboundReq(inboundReq map[string]interface{}) bool {
	inbound, _ := inboundReq["inbound"].(map[string]interface{})
	if inbound == nil {
		return false
	}
	if protocol, _ := inbound["protocol"].(string); strings.ToLower(protocol) != "vless" {
		return false
	}
	ss, _ := inbound["streamSettings"].(map[string]interface{})
	if ss == nil {
		return false
	}
	network, _ := ss["network"].(string)
	return network == "ws"
}

// preprocessWSSInbound 在 forward 之前对 vless+ws 入站强制注入安全默认值。
// 返回新的 body(已 marshal 好,可直接 forward)。
//
// 调用方持有 server-level 锁,内部扫端口安全。
func (h *RemoteManageHandler) preprocessWSSInbound(ctx context.Context, serverID int64, body []byte, inboundReq map[string]interface{}) ([]byte, error) {
	inbound, _ := inboundReq["inbound"].(map[string]interface{})
	if inbound == nil {
		return body, nil
	}

	// 强制 listen 127.0.0.1(xray 只接收 nginx 反代,不直接对外)
	inbound["listen"] = "127.0.0.1"

	// 自动分配未占用本地端口
	port, err := h.allocateWSSPort(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("分配 WSS 本地端口失败: %v", err)
	}
	inbound["port"] = port

	// 强制 streamSettings.security="none"(TLS 给 nginx)
	ss, _ := inbound["streamSettings"].(map[string]interface{})
	if ss == nil {
		ss = map[string]interface{}{}
		inbound["streamSettings"] = ss
	}
	ss["network"] = "ws"
	ss["security"] = "none"

	// wsSettings.path 后端强制随机化(隐蔽性 + 避免前端默认 "/wss" 等可猜路径泄漏)。
	// 用户想要的可见 path 在节点详情可查。
	ws, _ := ss["wsSettings"].(map[string]interface{})
	if ws == nil {
		ws = map[string]interface{}{}
		ss["wsSettings"] = ws
	}
	ws["path"] = randomWSPath()

	newBody, err := json.Marshal(inboundReq)
	if err != nil {
		return nil, fmt.Errorf("重新序列化 inbound 失败: %v", err)
	}
	return newBody, nil
}

// allocateWSSPort 在 wssPortRangeStart-End 段挑一个未被该 server 现有 inbounds 占用的端口。
// 走 forward GET /api/child/inbounds 拿当前真实端口集(权威,不依赖 cache 的 snapshot)。
func (h *RemoteManageHandler) allocateWSSPort(ctx context.Context, serverID int64) (int, error) {
	used := make(map[int]struct{})
	if result, err := h.forwardToRemoteServer(ctx, serverID, http.MethodGet, "/api/child/inbounds", nil); err == nil {
		var resp struct {
			Inbounds []map[string]interface{} `json:"inbounds"`
		}
		if jerr := json.Unmarshal(result, &resp); jerr == nil {
			for _, ib := range resp.Inbounds {
				if p, ok := ib["port"].(float64); ok {
					used[int(p)] = struct{}{}
				}
			}
		}
	}

	// 从 start 顺序找第一个空闲;扫整段都满了直接报错(WSS 入站不应该有这么多)
	for p := wssPortRangeStart; p <= wssPortRangeEnd; p++ {
		if _, taken := used[p]; !taken {
			return p, nil
		}
	}
	return 0, fmt.Errorf("端口段 %d-%d 全被占用", wssPortRangeStart, wssPortRangeEnd)
}

// wssInboundInfo 渲染到 nginx 模板的单条 location 信息。
type wssInboundInfo struct {
	WSPath string
	Port   string
}

// SyncWSSNginx 查该 server 所有 vless+ws 入站,聚合渲染 nginx domain.conf 并下发 agent。
// 关键约束:
//   - server.domain 必须有(无域名直接跳过,日志即可)
//   - 根域必须有可用证书(无证书直接跳过 — 调用前前端已预检,只兜底)
//   - 不下发主 nginx.conf(留空),只覆盖 servers/{domain}.conf
//   - infos 为空(用户删完所有 WSS 入站)时也走渲染流程下发空 location 的 server 块,
//     把旧 location 全部覆盖,避免死 backend 残留。同机主控域名始终保留主控反代。
//
// 大写导出:nodes.go 的 deleteRemoteInbound 也要调,删节点路径不走 HandleInbounds remove。
func (h *RemoteManageHandler) SyncWSSNginx(ctx context.Context, serverID int64) error {
	return h.syncWSSNginx(ctx, serverID, "", 0)
}

// syncWSSNginx 在创建时优先使用用户选择的 SNI/证书；其他同步场景则从服务器地址自动探测。
func (h *RemoteManageHandler) syncWSSNginx(ctx context.Context, serverID int64, selectedDomain string, selectedCertID int64) error {
	server, err := h.repo.GetRemoteServer(ctx, serverID)
	if err != nil {
		return fmt.Errorf("server not found: %v", err)
	}
	domain := normalizeWSSDomain(selectedDomain)
	candidates := wssServerDomainCandidates(server)

	var cert *storage.Certificate
	if selectedCertID > 0 {
		cert, err = h.repo.GetCertificate(ctx, selectedCertID)
		if err != nil || cert == nil || cert.CertPEM == "" || cert.KeyPEM == "" {
			return fmt.Errorf("所选证书不存在或缺少 PEM(id=%d)", selectedCertID)
		}
		if domain == "" {
			for _, candidate := range candidates {
				if wssCertificateCovers(candidate, cert.Domain) {
					domain = candidate
					break
				}
			}
			if domain == "" && !strings.HasPrefix(cert.Domain, "*.") {
				domain = normalizeWSSDomain(cert.Domain)
			}
		}
		if domain == "" || !wssCertificateCovers(domain, cert.Domain) {
			return fmt.Errorf("所选证书 %s 不能覆盖 WSS 域名 %s", cert.Domain, domain)
		}
	} else {
		lookupDomains := candidates
		if domain != "" {
			lookupDomains = append([]string{domain}, candidates...)
		}
		for _, candidate := range lookupDomains {
			if c, findErr := h.repo.FindCertificateForDomain(ctx, candidate); findErr == nil && c != nil && c.CertPEM != "" && c.KeyPEM != "" {
				cert = c
				domain = candidate
				break
			}
		}
	}
	if cert == nil {
		return fmt.Errorf("server %d 的服务器地址/DDNS 域名未匹配到可用证书，候选: %s", serverID, strings.Join(candidates, ", "))
	}
	certName := certDeployFilename(cert.Domain)

	// Nginx 刚安装完时，自动证书部署可能仍在后台执行。在写入 WSS 配置前再同步部署一次，
	// 并等 agent 确认文件已落盘，避免 nginx -t 因证书文件不存在而失败。
	certPayload, _ := json.Marshal(WSCertDeployPayload{
		Domain:   cert.Domain,
		CertPEM:  cert.CertPEM,
		KeyPEM:   cert.KeyPEM,
		CertPath: fmt.Sprintf("/usr/local/nginx/cert/%s.pem", certName),
		KeyPath:  fmt.Sprintf("/usr/local/nginx/cert/%s.key", certName),
		Reload:   "none",
	})
	if _, err := h.forwardToRemoteServer(ctx, serverID, http.MethodPost, "/api/child/cert/deploy", certPayload); err != nil {
		return fmt.Errorf("同步部署 nginx 证书失败: %v", err)
	}

	// 拉全部 inbounds,过滤 vless+ws
	result, err := h.forwardToRemoteServer(ctx, serverID, http.MethodGet, "/api/child/inbounds", nil)
	if err != nil {
		return fmt.Errorf("拉取 inbounds 失败: %v", err)
	}
	var resp struct {
		Inbounds []map[string]interface{} `json:"inbounds"`
	}
	if err := json.Unmarshal(result, &resp); err != nil {
		return fmt.Errorf("解析 inbounds 失败: %v", err)
	}

	infos := extractWSSInbounds(resp.Inbounds)

	// 偷自己 server(steal_mode=tunnel/fallback):ws location 合并进伪装站 conf(listen 127.0.0.1:8001,
	// 流量走 tunnel 域名分流 / reality fallback 到 nginx),不用 wss_domain.conf.tpl(listen 443 会和
	// xray 的 443 抢端口 + 冲掉伪装站)。renderStealSelfDomainConf 把伪装站 location / 和 ws location 一并渲染,
	// 无 ws 入站时就是纯伪装站 conf(不再空 404 兜底冲掉伪装站)。
	if server.StealMode == "tunnel" || server.StealMode == "fallback" {
		conf, rerr := renderStealSelfDomainConf(server.StealMode, server.SiteType, server.SiteValue, domain, certName, infos)
		if rerr != nil {
			return rerr
		}
		payload, _ := json.Marshal(map[string]interface{}{
			"domain":        domain,
			"nginx_config":  "",
			"domain_config": conf,
		})
		if _, err := h.forwardNginxSetupSSL(ctx, serverID, payload); err != nil {
			return fmt.Errorf("下发偷自己 nginx 配置失败: %v", err)
		}
		log.Printf("[WSS-Nginx] server %d domain=%s 偷自己模式:伪装站 + %d 条 ws location(listen 8001)已下发", serverID, domain, len(infos))
		return nil
	}

	// 纯 WSS server(非偷自己, listen 443 独占):
	// 空 infos 也继续走模板渲染:渲染后是「只有 ssl 配置 + 默认 404 location」的 server 块,
	// 覆盖 servers/{domain}.conf 后,旧的 WSS location 全部被冲掉,不再残留死 backend。
	// 当前架构假设 WSS 与 reality 在同 domain 互斥(同 conf 文件覆盖),没有共存场景下的副作用。
	if len(infos) == 0 {
		log.Printf("[WSS-Nginx] server %d domain=%s 已无 vless+ws 入站,下发空 location 兜底(覆盖残留)", serverID, domain)
	}

	// 新安装的 Nginx 仍是安装脚本默认主配置，未必包含 servers/*.conf。
	// 纯 WSS 必须先用 single_nginx.conf 接管主配置，再把域名配置写入 servers/ 目录。
	nginxConf, err := templates.ReadFile("single_nginx.conf")
	if err != nil {
		return fmt.Errorf("读取 single_nginx.conf 模板失败: %v", err)
	}

	// 同机 Agent 的 WSS 使用主控域名时，这份配置同时承担主控 HTTPS 入口。
	// 精确 WSS location 与主控 location / 可以共存；删除最后一个 WSS 入站时也只清理
	// WSS location，不能把主控反代覆盖成默认 404。
	if h.isSameHostMasterWSSDomain(ctx, server, domain) {
		conf, renderErr := renderMasterDomainWSSConf(domain, certName, infos)
		if renderErr != nil {
			return renderErr
		}
		payload, _ := json.Marshal(map[string]interface{}{
			"domain":        domain,
			"nginx_config":  string(nginxConf),
			"domain_config": conf,
		})
		if _, err := h.forwardNginxSetupSSL(ctx, serverID, payload); err != nil {
			return fmt.Errorf("下发主控与 WSS 共存 nginx 配置失败: %v", err)
		}
		log.Printf("[WSS-Nginx] server %d domain=%s 同机主控模式:主控反代 + %d 条 WSS location 已下发", serverID, domain, len(infos))
		return nil
	}

	tplBytes, err := templates.ReadFile("wss_domain.conf.tpl")
	if err != nil {
		return fmt.Errorf("读取 wss 模板失败: %v", err)
	}
	tpl, err := texttemplate.New("wss").Parse(string(tplBytes))
	if err != nil {
		return fmt.Errorf("解析 wss 模板失败: %v", err)
	}
	data := struct {
		Domain   string
		CertName string
		Inbounds []wssInboundInfo
	}{Domain: domain, CertName: certName, Inbounds: infos}
	var buf bytes.Buffer
	if err := tpl.Execute(&buf, data); err != nil {
		return fmt.Errorf("渲染 wss 模板失败: %v", err)
	}

	payload, _ := json.Marshal(map[string]interface{}{
		"domain":        domain,
		"nginx_config":  string(nginxConf),
		"domain_config": buf.String(),
	})
	if _, err := h.forwardNginxSetupSSL(ctx, serverID, payload); err != nil {
		return fmt.Errorf("下发 nginx 配置失败: %v", err)
	}
	log.Printf("[WSS-Nginx] server %d domain=%s 已下发 %d 条 WSS location", serverID, domain, len(infos))
	return nil
}

func normalizeWSSDomain(raw string) string {
	host := strings.TrimSpace(strings.ToLower(raw))
	if host == "" {
		return ""
	}
	if parsed, err := url.Parse(host); err == nil && parsed.Hostname() != "" {
		host = parsed.Hostname()
	} else if splitHost, _, err := net.SplitHostPort(host); err == nil {
		host = splitHost
	}
	return strings.Trim(host, "[] .")
}

func wssServerDomainCandidates(server *storage.RemoteServer) []string {
	seen := make(map[string]struct{})
	result := make([]string, 0, 6)
	for _, raw := range []string{server.Domain, server.DomainV6, server.PullAddress, server.PullAddressV6, server.IPAddress, server.IPAddressV6} {
		host := normalizeWSSDomain(raw)
		if host == "" {
			continue
		}
		if _, exists := seen[host]; exists {
			continue
		}
		seen[host] = struct{}{}
		result = append(result, host)
	}
	return result
}

func wssCertificateCovers(domain, certDomain string) bool {
	domain = normalizeWSSDomain(domain)
	certDomain = normalizeWSSDomain(certDomain)
	if domain == certDomain {
		return true
	}
	if !strings.HasPrefix(certDomain, "*.") {
		return false
	}
	suffix := strings.TrimPrefix(certDomain, "*.")
	return strings.HasSuffix(domain, "."+suffix) && strings.Count(domain, ".") == strings.Count(suffix, ".")+1
}

func (h *RemoteManageHandler) isSameHostMasterWSSDomain(ctx context.Context, server *storage.RemoteServer, domain string) bool {
	if server == nil {
		return false
	}
	masterURL, _ := h.repo.GetSystemSetting(ctx, "master_url")
	if normalizeWSSDomain(masterURL) != normalizeWSSDomain(domain) {
		return false
	}
	return server.SameHostAsMaster || serverTargetsMasterHost(ctx, h.repo,
		server.PullAddress, server.IPAddress, server.Domain)
}

// extractWSSInbounds 从 agent inbounds 列表过滤出 vless+ws 入站的 {path, port}。
func extractWSSInbounds(inbounds []map[string]interface{}) []wssInboundInfo {
	var infos []wssInboundInfo
	for _, ib := range inbounds {
		protocol, _ := ib["protocol"].(string)
		if strings.ToLower(protocol) != "vless" {
			continue
		}
		ss, _ := ib["streamSettings"].(map[string]interface{})
		if ss == nil {
			continue
		}
		if network, _ := ss["network"].(string); network != "ws" {
			continue
		}
		ws, _ := ss["wsSettings"].(map[string]interface{})
		if ws == nil {
			continue
		}
		path, _ := ws["path"].(string)
		if path == "" {
			continue
		}
		var portStr string
		if p, ok := ib["port"].(float64); ok {
			portStr = strconv.Itoa(int(p))
		} else if ps, ok := ib["port"].(string); ok {
			portStr = ps
		}
		if portStr == "" {
			continue
		}
		infos = append(infos, wssInboundInfo{WSPath: path, Port: portStr})
	}
	return infos
}

// fetchWSSInbounds 拉 server 当前所有 vless+ws 入站(用于偷自己 server 下发伪装站时聚合 ws location,
// 避免伪装站下发把已有 ws location 冲掉)。拉失败返回 nil(当作无 ws)。
func (h *RemoteManageHandler) fetchWSSInbounds(ctx context.Context, serverID int64) []wssInboundInfo {
	result, err := h.forwardToRemoteServer(ctx, serverID, http.MethodGet, "/api/child/inbounds", nil)
	if err != nil {
		return nil
	}
	var resp struct {
		Inbounds []map[string]interface{} `json:"inbounds"`
	}
	if json.Unmarshal(result, &resp) != nil {
		return nil
	}
	return extractWSSInbounds(resp.Inbounds)
}

// stealSelfDomainTplPath 按 steal_mode(tunnel/fallback)+ site_type(static/proxy)选伪装站 domain 模板。
func stealSelfDomainTplPath(stealMode, siteType string) string {
	dir := "tunnel"
	if stealMode == "fallback" {
		dir = "fallback"
	}
	if siteType == "proxy" {
		return dir + "/domain_proxy.conf"
	}
	return dir + "/domain_static.conf"
}

// renderStealSelfWSLocations 渲染偷自己 server 的 ws 入站 nginx location(合并进伪装站 conf@8001)。
// 偷自己 nginx listen proxy_protocol,真实客户端 IP 在 $proxy_protocol_addr(不是 $remote_addr)。
func renderStealSelfWSLocations(wssInbounds []wssInboundInfo) string {
	var b strings.Builder
	for _, w := range wssInbounds {
		fmt.Fprintf(&b, `
        location = %s {
            if ($http_upgrade != "websocket") { return 404; }
            proxy_pass         http://127.0.0.1:%s;
            proxy_redirect     off;
            proxy_http_version 1.1;
            proxy_set_header   Upgrade            $http_upgrade;
            proxy_set_header   Connection         "upgrade";
            proxy_set_header   Host               $host;
            proxy_set_header   X-Real-IP          $proxy_protocol_addr;
            proxy_set_header   X-Forwarded-For    $proxy_add_x_forwarded_for;
            proxy_read_timeout 5d;
        }
`, w.WSPath, w.Port)
	}
	return b.String()
}

// renderDirectWSSLocations 渲染直接监听 443 的 WSS location。这里没有
// proxy_protocol，真实来源地址使用 $remote_addr。
func renderDirectWSSLocations(wssInbounds []wssInboundInfo) string {
	var b strings.Builder
	for _, w := range wssInbounds {
		fmt.Fprintf(&b, `
        location = %s {
            if ($http_upgrade != "websocket") { return 404; }
            proxy_pass         http://127.0.0.1:%s;
            proxy_redirect     off;
            proxy_http_version 1.1;
            proxy_set_header   Upgrade            $http_upgrade;
            proxy_set_header   Connection         "upgrade";
            proxy_set_header   Host               $host;
            proxy_set_header   X-Real-IP          $remote_addr;
            proxy_set_header   X-Forwarded-For    $proxy_add_x_forwarded_for;
            proxy_read_timeout 5d;
        }
`, w.WSPath, w.Port)
	}
	return b.String()
}

func injectRenderedLocations(conf, locations string) string {
	if locations == "" {
		return conf
	}
	idx := strings.LastIndex(conf, "}")
	if idx < 0 {
		return conf + locations
	}
	return conf[:idx] + locations + conf[idx:]
}

// injectWSLocations 把 ws location 注入伪装站 conf 的 server 块内(最后一个 } 前)。
// 伪装站模板只有一个 server 块,最后一个 } 即 server 结束。无 ws 入站时原样返回。
func injectWSLocations(conf string, wssInbounds []wssInboundInfo) string {
	return injectRenderedLocations(conf, renderStealSelfWSLocations(wssInbounds))
}

func renderMasterDomainWSSConf(domain, certName string, wssInbounds []wssInboundInfo) (string, error) {
	tpl, err := templates.ReadFile("mmwx_domain.conf")
	if err != nil {
		return "", fmt.Errorf("读取 mmwx_domain.conf 模板失败: %w", err)
	}
	conf := strings.ReplaceAll(string(tpl), "{domain}", domain)
	conf = strings.ReplaceAll(conf, "{cert_name}", certName)
	return injectRenderedLocations(conf, renderDirectWSSLocations(wssInbounds)), nil
}

// renderStealSelfDomainConf 渲染偷自己 server 的 servers/{domain}.conf:
// 伪装站 location /(按 site_type static/proxy, listen 127.0.0.1:8001)+ 该域名所有 ws location。
// 统一入口 —— 供 SyncWSSNginx / deployTunnelConfig / deployFallbackConfig / HandleSetupSSL / HandleAddWebsite 复用,
// 消除各自渲染导致伪装站与 ws location 互相覆盖的问题(reality偷自己 + WSS 共存的核心)。
func renderStealSelfDomainConf(stealMode, siteType, siteValue, domain, certName string, wssInbounds []wssInboundInfo) (string, error) {
	tplPath := stealSelfDomainTplPath(stealMode, siteType)
	tpl, err := templates.ReadFile(tplPath)
	if err != nil {
		return "", fmt.Errorf("读取 %s 模板失败: %w", tplPath, err)
	}
	conf := strings.ReplaceAll(string(tpl), "{domain}", domain)
	conf = strings.ReplaceAll(conf, "{root_domain}", extractRootDomain(domain))
	conf = strings.ReplaceAll(conf, "{cert_name}", certName)
	staticRoot := siteValue
	if staticRoot == "" {
		staticRoot = "/usr/local/nginx/html"
	}
	conf = strings.ReplaceAll(conf, "{static_root_path}", staticRoot)
	conf = strings.ReplaceAll(conf, "{proxy_pass_server}", siteValue)
	return injectWSLocations(conf, wssInbounds), nil
}
