package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"

	"miaomiaowux/internal/storage"
	"miaomiaowux/templates"
)

func (h *RemoteManageHandler) deployTunnelConfig(ctx context.Context, server *storage.RemoteServer) error {
	domain := strings.ToLower(strings.TrimSpace(server.Domain))
	proxyDomain := strings.ToLower(strings.TrimSpace(server.PullAddress))

	nginxConf, err := templates.ReadFile("tunnel/nginx.conf")
	if err != nil {
		return fmt.Errorf("读取 tunnel/nginx.conf 模板失败: %w", err)
	}

	cert, err := h.deployNginxCertificateBeforeConfig(ctx, server, domain)
	if err != nil {
		return err
	}
	certName := certDeployFilename(cert.Domain)
	// 统一渲染:伪装站 location / + 该 server 现有 ws 入站的 location
	// (reality偷自己 + WSS 共存 —— 下发伪装站时把已有 ws location 一并渲染,避免冲掉)
	domainConf, err := renderStealSelfDomainConf(server.StealMode, server.SiteType, server.SiteValue, domain, certName, h.fetchWSSInbounds(ctx, server.ID))
	if err != nil {
		return err
	}

	clearPayload, _ := json.Marshal(map[string]int{"port": 443})
	if _, err := h.forwardToRemoteServer(ctx, server.ID, http.MethodPost, "/api/child/nginx/clear-stream-port", clearPayload); err != nil {
		log.Printf("[DeployTunnel] clear stream port 443 on server %d: %v (non-fatal)", server.ID, err)
	}

	sslPayload, _ := json.Marshal(map[string]any{
		"domain":        domain,
		"nginx_config":  string(nginxConf),
		"domain_config": domainConf,
	})
	if _, err := h.forwardNginxSetupSSL(ctx, server.ID, sslPayload); err != nil {
		return fmt.Errorf("配置 Nginx SSL 失败: %w", err)
	}
	log.Printf("[DeployTunnel] Deployed nginx config to server %d (%s)", server.ID, server.Name)

	configFile := "tunnel/config.json"
	if proxyDomain == "" || proxyDomain == domain {
		configFile = "tunnel/config_ip.json"
	}
	configTpl, err := templates.ReadFile(configFile)
	if err != nil {
		return fmt.Errorf("读取 %s 模板失败: %w", configFile, err)
	}
	configJSON := strings.ReplaceAll(string(configTpl), "{proxy_domain}", proxyDomain)
	// tunnel-in → direct 是兜底规则，域名到 nginx 的特例必须位于它之前。
	configJSON = strings.ReplaceAll(configJSON, "{tunnel_domain}", domain)

	var xrayConfig map[string]any
	if err := json.Unmarshal([]byte(configJSON), &xrayConfig); err != nil {
		return fmt.Errorf("解析 Xray 模板配置失败: %w", err)
	}

	// 普通远程服务器只为自己的伪装域名建立 tunnel-in 路由。
	h.addWebsiteTunnelConfig(xrayConfig, domain)

	updatedConfig, _ := json.MarshalIndent(xrayConfig, "", "    ")

	configPayload, _ := json.Marshal(map[string]string{
		"config": string(updatedConfig),
	})
	if _, err := h.forwardToRemoteServer(ctx, server.ID, http.MethodPost, "/api/child/xray/config", configPayload); err != nil {
		return fmt.Errorf("下发 Xray 配置失败: %w", err)
	}
	log.Printf("[DeployTunnel] Deployed xray config to server %d (%s)", server.ID, server.Name)

	if err := h.restartXrayWithRecovery(ctx, server.ID, "DeployTunnel"); err != nil {
		log.Printf("[DeployTunnel] %v", err)
	}

	log.Printf("[DeployTunnel] Completed tunnel config deployment for server %d (%s), domain=%s", server.ID, server.Name, domain)

	// 通知 agent 更新本地 steal_mode
	if h.wsHandler != nil {
		_ = h.wsHandler.SendConfigUpdate(server.ID, map[string]string{"steal_mode": "tunnel"})
	}

	return nil
}
