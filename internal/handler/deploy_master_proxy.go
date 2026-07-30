package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"

	"miaomiaowux/internal/storage"
	"miaomiaowux/templates"
)

// deploy_master_proxy.go:「宿主机 agent 反代主控」。
//
// Docker 部署的主控自身开 HTTPS 需要容器内跑 nginx(容器无 systemd,体验差)。更干净的方式:
// 在主控宿主机上装一个 agent,用它的 nginx 对外 listen 443,反代到主控的 http 端口(127.0.0.1:<PORT>)。
// 前提:该 agent 与主控同机(proxy_pass 127.0.0.1 才通),前端仅在「同机 && 主控为 Docker 部署」时显示入口。
//
// Agent 开启偷自己时，443 属于 Xray tunnel/fallback 入口，Nginx 只能监听
// 127.0.0.1:8001 接收 Xray 回落流量。因此这里必须使用对应模式的 domain_proxy.conf，
// 不能使用主控直装场景的 mmwx_domain.conf（它会让 Nginx 抢占 443）。

// deployMasterProxy 在指定(同机)agent 上部署「反代主控」nginx 配置 + 证书。
func (h *RemoteManageHandler) deployMasterProxy(ctx context.Context, server *storage.RemoteServer) error {
	masterDomain := strings.ToLower(strings.TrimSpace(getDomainFromMasterURL(h.repo, ctx)))
	if masterDomain == "" {
		return fmt.Errorf("主控 master_url 未配置域名,无法反代主控;请先在设置里把 master_url 配成 https://你的域名")
	}
	// 主控面板端口(Docker 容器监听的宿主机端口),默认 12889,与模板里的 proxy_pass 端口一致。
	panelPort := os.Getenv("PORT")
	if panelPort == "" {
		panelPort = "12889"
	}

	// 证书:主控该域名的证书;没有先触发自动签发,让用户稍后重试(签发是异步的)。
	cert, err := h.deployNginxCertificateBeforeConfig(ctx, server, masterDomain)
	if err != nil {
		return err
	}
	certName := certDeployFilename(cert.Domain)

	mode := server.StealMode
	if mode != "fallback" {
		mode = "tunnel"
	}
	nginxConf, err := templates.ReadFile(mode + "/nginx.conf")
	if err != nil {
		return fmt.Errorf("读取 %s/nginx.conf 模板失败: %w", mode, err)
	}
	panelBackend := "http://127.0.0.1:" + panelPort
	domainConf, err := renderStealSelfDomainConf(
		mode,
		"proxy",
		panelBackend,
		masterDomain,
		certName,
		h.fetchWSSInbounds(ctx, server.ID),
	)
	if err != nil {
		return fmt.Errorf("渲染主控反代配置失败: %w", err)
	}

	// 腾出 443(清掉可能占用的 stream 端口),再下发 nginx 配置。
	clearPayload, _ := json.Marshal(map[string]int{"port": 443})
	if _, err := h.forwardToRemoteServer(ctx, server.ID, http.MethodPost, "/api/child/nginx/clear-stream-port", clearPayload); err != nil {
		log.Printf("[ProxyMaster] clear stream port 443 on server %d: %v (non-fatal)", server.ID, err)
	}

	sslPayload, _ := json.Marshal(map[string]any{
		"domain":        masterDomain,
		"nginx_config":  string(nginxConf),
		"domain_config": domainConf,
	})
	if _, err := h.forwardNginxSetupSSL(ctx, server.ID, sslPayload); err != nil {
		return fmt.Errorf("下发 nginx 反代配置失败: %w", err)
	}

	log.Printf("[ProxyMaster] 已在 server %d (%s) 部署主控反代: %s (127.0.0.1:8001) → %s", server.ID, server.Name, masterDomain, panelBackend)
	return nil
}

// DeployMasterProxyByID 给首次连接自动部署等内部调用提供按 ID 的入口。
func (h *RemoteManageHandler) DeployMasterProxyByID(ctx context.Context, serverID int64) error {
	server, err := h.repo.GetRemoteServer(ctx, serverID)
	if err != nil {
		return fmt.Errorf("获取服务器信息失败: %w", err)
	}
	return h.deployMasterProxy(ctx, server)
}

// HandleProxyMaster POST /api/admin/remote/proxy-master?server_id= —— 在同机 agent 上部署反代主控。
func (h *RemoteManageHandler) HandleProxyMaster(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		remoteWriteError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	serverID := r.URL.Query().Get("server_id")
	if serverID == "" {
		remoteWriteError(w, http.StatusBadRequest, "server_id required")
		return
	}
	id, err := strconv.ParseInt(serverID, 10, 64)
	if err != nil {
		remoteWriteError(w, http.StatusBadRequest, "invalid server_id")
		return
	}
	server, err := h.repo.GetRemoteServer(r.Context(), id)
	if err != nil {
		remoteWriteError(w, http.StatusNotFound, "server not found")
		return
	}
	if err := h.deployMasterProxy(r.Context(), server); err != nil {
		remoteWriteError(w, http.StatusBadGateway, err.Error())
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"success": true, "message": "已在该 agent 上部署主控反代,主控域名现在可经该 agent 的 nginx 走 HTTPS 访问"})
}
