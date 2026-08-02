package handler

import (
	"context"
	"crypto/tls"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"miaomiaowux/internal/notify"
	"miaomiaowux/internal/storage"
)

const (
	settingHTTPSRecoveryEnabled = "master_https_recovery_enabled"
	settingRecoveryURL          = "master_recovery_url"
	settingRecoveryFailureMin   = "master_recovery_failure_minutes"
	settingRecoveryGraceMin     = "master_recovery_startup_grace_minutes"
	settingRecoveryPending      = "master_https_recovery_pending"
	settingRecoveryReason       = "master_https_recovery_reason"
	settingForcePublicHTTP      = "master_force_public_http"
)

// MasterHTTPSRecoveryMonitor only changes state after both independent signals fail:
// the configured public HTTPS endpoint and every agent that has connected before.
type MasterHTTPSRecoveryMonitor struct {
	repo      *storage.TrafficRepository
	port      string
	startedAt time.Time
	failedAt  time.Time
	restart   func() error
	client    *http.Client
}

func NewMasterHTTPSRecoveryMonitor(repo *storage.TrafficRepository, port string, restart func() error) *MasterHTTPSRecoveryMonitor {
	if strings.TrimSpace(port) == "" {
		port = "12889"
	}
	return &MasterHTTPSRecoveryMonitor{
		repo: repo, port: port, startedAt: time.Now(), restart: restart,
		client: &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }},
	}
}

func settingMinutes(ctx context.Context, repo *storage.TrafficRepository, key string, def int) time.Duration {
	v, _ := repo.GetSystemSetting(ctx, key)
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n < 1 {
		n = def
	}
	return time.Duration(n) * time.Minute
}

func (m *MasterHTTPSRecoveryMonitor) eligibleAgentsOffline(ctx context.Context, failureFor time.Duration) (bool, int, error) {
	servers, err := m.repo.ListRemoteServers(ctx)
	if err != nil {
		return false, 0, err
	}
	offline, eligible := eligibleServersOffline(servers, time.Now(), failureFor)
	return offline, eligible, nil
}

func eligibleServersOffline(servers []storage.RemoteServer, now time.Time, failureFor time.Duration) (bool, int) {
	eligible := 0
	allOffline := true
	for _, server := range servers {
		if server.IsFederated || server.LastHeartbeat == nil {
			continue
		}
		eligible++
		if now.Sub(*server.LastHeartbeat) < failureFor {
			allOffline = false
		}
	}
	return eligible > 0 && allOffline, eligible
}

func (m *MasterHTTPSRecoveryMonitor) probeHTTPS(ctx context.Context, rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" {
		return fmt.Errorf("主控地址不是有效 HTTPS URL")
	}
	if _, err = net.DefaultResolver.LookupHost(ctx, u.Hostname()); err != nil {
		return fmt.Errorf("DNS 探测失败: %w", err)
	}
	addr := net.JoinHostPort(u.Hostname(), u.Port())
	if u.Port() == "" {
		addr = net.JoinHostPort(u.Hostname(), "443")
	}
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	conn, err := tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{ServerName: u.Hostname(), MinVersion: tls.VersionTLS12})
	if err != nil {
		return fmt.Errorf("TLS 探测失败: %w", err)
	}
	_ = conn.Close()
	u.Path, u.RawQuery, u.Fragment = "/api/setup/status", "", ""
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	resp, err := m.client.Do(req)
	if err != nil {
		return fmt.Errorf("HTTPS 探测失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 500 {
		return fmt.Errorf("HTTPS 探测返回 %d", resp.StatusCode)
	}
	return nil
}

func normalizeRecoveryURL(raw, port string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "http" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", fmt.Errorf("HTTP 恢复地址无效")
	}
	if u.Port() == "" {
		u.Host = net.JoinHostPort(u.Hostname(), port)
	}
	u.Path = ""
	return strings.TrimRight(u.String(), "/"), nil
}

func deriveRecoveryURL(masterURL, port string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(masterURL))
	if err != nil || u.Hostname() == "" {
		return "", fmt.Errorf("无法从主控地址推导 HTTP 恢复地址")
	}
	return "http://" + net.JoinHostPort(u.Hostname(), port), nil
}

// effectiveRecoveryURL keeps recovery automatic for normal deployments while
// retaining an optional override for CDN/NAT/split-DNS environments.
func effectiveRecoveryURL(ctx context.Context, repo *storage.TrafficRepository, port string) (string, bool, error) {
	custom, _ := repo.GetSystemSetting(ctx, settingRecoveryURL)
	if strings.TrimSpace(custom) != "" {
		normalized, err := normalizeRecoveryURL(custom, port)
		return normalized, true, err
	}
	masterURL, _ := repo.GetSystemSetting(ctx, "master_url")
	derived, err := deriveRecoveryURL(masterURL, port)
	return derived, false, err
}

// masterListenPort returns the actual HTTP port used by the master process.
// Recovery URLs must not assume the historical 12889 default because PORT is
// configurable in both native and container deployments.
func masterListenPort() string {
	port := strings.TrimSpace(os.Getenv("PORT"))
	if port == "" {
		return "12889"
	}
	if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
		return "12889"
	}
	return port
}

func (m *MasterHTTPSRecoveryMonitor) check(ctx context.Context) {
	enabled, _ := m.repo.GetSystemSetting(ctx, settingHTTPSRecoveryEnabled)
	masterURL, _ := m.repo.GetSystemSetting(ctx, "master_url")
	localOnly, _ := m.repo.GetSystemSetting(ctx, "master_local_only")
	if enabled != "1" || localOnly != "1" || !strings.HasPrefix(strings.ToLower(masterURL), "https://") {
		m.failedAt = time.Time{}
		return
	}
	grace := settingMinutes(ctx, m.repo, settingRecoveryGraceMin, 10)
	if time.Since(m.startedAt) < grace {
		return
	}
	failureFor := settingMinutes(ctx, m.repo, settingRecoveryFailureMin, 5)
	offline, eligible, err := m.eligibleAgentsOffline(ctx, failureFor)
	if err != nil || eligible == 0 {
		m.failedAt = time.Time{}
		return
	}
	if err := m.probeHTTPS(ctx, masterURL); err == nil {
		m.failedAt = time.Time{}
		return
	} else if m.failedAt.IsZero() {
		m.failedAt = time.Now()
		log.Printf("[Master HTTPS Recovery] public HTTPS probe failed (%d known agents, all_offline=%v): %v", eligible, offline, err)
		return
	} else if !offline || time.Since(m.failedAt) < failureFor {
		return
	}

	recoveryURL, _, err := effectiveRecoveryURL(ctx, m.repo, m.port)
	if err != nil {
		log.Printf("[Master HTTPS Recovery] recovery cancelled: %v", err)
		return
	}
	reason := fmt.Sprintf("公网 HTTPS 连续失败且 %d 台曾在线 Agent 全部失联", eligible)
	transition := map[string]string{
		"master_url": recoveryURL, "master_local_only": "0", settingForcePublicHTTP: "1",
		settingRecoveryPending: "1", settingRecoveryReason: reason,
	}
	if err := m.repo.SetSystemSettings(ctx, transition); err != nil {
		log.Printf("[Master HTTPS Recovery] failed to persist recovery transition: %v", err)
		return
	}
	log.Printf("[Master HTTPS Recovery] switching to %s and restarting", recoveryURL)
	if m.restart != nil {
		if err := m.restart(); err != nil {
			log.Printf("[Master HTTPS Recovery] restart failed: %v", err)
		}
	}
}

func (m *MasterHTTPSRecoveryMonitor) Start(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.check(ctx)
		}
	}
}

// FinishPendingMasterHTTPSRecovery emits one persistent-cycle notification after restart.
func FinishPendingMasterHTTPSRecovery(ctx context.Context, repo *storage.TrafficRepository) {
	pending, _ := repo.GetSystemSetting(ctx, settingRecoveryPending)
	if pending != "1" {
		return
	}
	reason, _ := repo.GetSystemSetting(ctx, settingRecoveryReason)
	masterURL, _ := repo.GetSystemSetting(ctx, "master_url")
	notifyAsync(ctx, notify.EventAgentLongOffline, "主控HTTPS故障，已恢复HTTP模式", fmt.Sprintf("恢复地址: `%s`\n原因: %s", masterURL, reason))
	log.Printf("[Master HTTPS Recovery] 主控HTTPS故障，已恢复HTTP模式: %s (%s)", masterURL, reason)
	_ = repo.SetSystemSetting(ctx, settingRecoveryPending, "0")
}
