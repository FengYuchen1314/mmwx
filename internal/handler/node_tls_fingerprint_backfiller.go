package handler

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"miaomiaowux/internal/storage"
)

// NodeTLSFingerprintBackfiller 补全并刷新节点的服务端证书 SHA-256。
// 首次启动后执行一次，之后每天执行；每次运行都会进入日志管理的“定时任务”。
type NodeTLSFingerprintBackfiller struct {
	repo *storage.TrafficRepository
}

func NewNodeTLSFingerprintBackfiller(repo *storage.TrafficRepository) *NodeTLSFingerprintBackfiller {
	return &NodeTLSFingerprintBackfiller{repo: repo}
}

func (b *NodeTLSFingerprintBackfiller) Start(ctx context.Context, initialDelay time.Duration) {
	go func() {
		timer := time.NewTimer(initialDelay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			b.recordedRun(ctx)
		}

		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				b.recordedRun(ctx)
			}
		}
	}()
}

func (b *NodeTLSFingerprintBackfiller) recordedRun(ctx context.Context) {
	log.Printf("[NodeTLSFingerprintBackfill] task started")
	startedAt := time.Now()
	runID, startErr := b.repo.StartTaskRun(ctx, "node_tls_fingerprint_backfill", "任务已启动，正在扫描节点")
	if startErr != nil {
		log.Printf("[NodeTLSFingerprintBackfill] create running record failed: %v", startErr)
	}
	detail, err := b.runOnce(ctx)
	status := "ok"
	if err != nil {
		status = "error"
		detail = err.Error()
		log.Printf("[NodeTLSFingerprintBackfill] task failed: %v", err)
	} else {
		log.Printf("[NodeTLSFingerprintBackfill] task completed: %s", detail)
	}
	if finishErr := b.repo.FinishTaskRun(ctx, runID, time.Since(startedAt).Milliseconds(), status, detail); finishErr != nil {
		log.Printf("[NodeTLSFingerprintBackfill] finish running record failed: %v", finishErr)
	}
}

func (b *NodeTLSFingerprintBackfiller) runOnce(ctx context.Context) (string, error) {
	if b.repo == nil {
		return "", fmt.Errorf("repository not initialized")
	}
	users, err := b.repo.ListUsers(ctx, 0)
	if err != nil {
		return "", err
	}

	var nodes []storage.Node
	for _, user := range users {
		userNodes, err := b.repo.ListNodes(ctx, user.Username)
		if err != nil {
			return "", fmt.Errorf("list nodes for %s: %w", user.Username, err)
		}
		nodes = append(nodes, userNodes...)
	}

	// 网络握手可能一直等到超时。使用固定大小 worker pool，避免历史节点较多时串行执行数分钟，
	// 同时限制并发，防止补全任务给主控和 SQLite 带来突发压力。
	const workers = 8
	jobs := make(chan storage.Node)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var scanned, eligible, updated, unchanged, skipped, failed int
	var failureNames []string
	recordFailure := func(nodeName string, err error) {
		mu.Lock()
		defer mu.Unlock()
		failed++
		if len(failureNames) < 10 {
			failureNames = append(failureNames, nodeName+": "+err.Error())
		}
	}
	process := func(node storage.Node) {
		mu.Lock()
		scanned++
		mu.Unlock()
		cfg, ok := decodeProxyConfig(node.ClashConfig)
		if !ok || !isTLSProxy(cfg, node.Protocol) || isRealityProxy(cfg) {
			mu.Lock()
			skipped++
			mu.Unlock()
			return
		}
		mu.Lock()
		eligible++
		mu.Unlock()

		fingerprint, source, err := b.resolveFingerprint(ctx, cfg, node.Protocol)
		if err != nil {
			recordFailure(node.NodeName, err)
			return
		}
		old := normalizedCertFingerprint(stringValue(cfg["tls-fingerprint"]))
		if old == fingerprint {
			mu.Lock()
			unchanged++
			mu.Unlock()
			return
		}
		cfg["tls-fingerprint"] = fingerprint
		clashRaw, _ := json.Marshal(cfg)
		parsedRaw := addFingerprintToConfig(node.ParsedConfig, fingerprint)
		if err := b.repo.UpdateNodeProxyConfigs(ctx, node.ID, parsedRaw, string(clashRaw)); err != nil {
			recordFailure(node.NodeName, err)
			return
		}
		mu.Lock()
		updated++
		mu.Unlock()
		log.Printf("[NodeTLSFingerprintBackfill] node=%d name=%q fingerprint refreshed source=%s", node.ID, node.NodeName, source)
	}
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for node := range jobs {
				process(node)
			}
		}()
	}
	for _, node := range nodes {
		select {
		case <-ctx.Done():
			close(jobs)
			wg.Wait()
			return "", ctx.Err()
		case jobs <- node:
		}
	}
	close(jobs)
	wg.Wait()

	detail := fmt.Sprintf("扫描=%d TLS=%d 更新=%d 未变化=%d 跳过=%d 失败=%d", scanned, eligible, updated, unchanged, skipped, failed)
	if len(failureNames) > 0 {
		detail += "；未补全：" + strings.Join(failureNames, "；")
	}
	if failed > 0 {
		return "", fmt.Errorf("%s", detail)
	}
	return detail, nil
}

func (b *NodeTLSFingerprintBackfiller) resolveFingerprint(ctx context.Context, cfg map[string]any, protocol string) (string, string, error) {
	server := strings.TrimSpace(stringValue(cfg["server"]))
	sni := proxySNI(cfg)
	if sni == "" {
		sni = server
	}

	// 妙妙屋X管理的证书直接从数据库计算，QUIC/Hysteria2 也能安全覆盖。
	if sni != "" {
		if cert, err := b.repo.FindCertificateForDomain(ctx, sni); err == nil && strings.TrimSpace(cert.CertPEM) != "" {
			if fp, err := certPEMSha256(cert.CertPEM); err == nil {
				return fp, "certificate-db", nil
			}
		}
	}

	if isHysteriaProxy(cfg, protocol) {
		if fp := existingFingerprint(cfg); fp != "" {
			return fp, "existing", nil
		}
		return "", "", fmt.Errorf("Hysteria/QUIC 无法通过 TCP 探测且未匹配到证书")
	}
	port := intValue(cfg["port"])
	if server == "" || port == 0 {
		return "", "", fmt.Errorf("节点地址或端口为空")
	}
	dialCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	fp, err := fetchPeerCertSha256(dialCtx, server, port, sni, proxyALPN(cfg))
	if err != nil {
		return "", "", fmt.Errorf("探测 %s:%d 失败: %w", server, port, err)
	}
	return fp, "tls-probe", nil
}

func decodeProxyConfig(raw string) (map[string]any, bool) {
	var cfg map[string]any
	if strings.TrimSpace(raw) == "" || json.Unmarshal([]byte(raw), &cfg) != nil || cfg == nil {
		return nil, false
	}
	return cfg, true
}

func addFingerprintToConfig(raw, fingerprint string) string {
	cfg, ok := decodeProxyConfig(raw)
	if !ok {
		return raw
	}
	cfg["tls-fingerprint"] = fingerprint
	out, err := json.Marshal(cfg)
	if err != nil {
		return raw
	}
	return string(out)
}

func isTLSProxy(cfg map[string]any, protocol string) bool {
	p := strings.ToLower(strings.TrimSpace(protocol))
	if p == "trojan" || p == "hysteria" || p == "hysteria2" || p == "hy2" || p == "tuic" {
		return true
	}
	switch v := cfg["tls"].(type) {
	case bool:
		return v
	case string:
		return strings.EqualFold(v, "true") || strings.EqualFold(v, "tls") || v == "1"
	}
	return false
}

func isRealityProxy(cfg map[string]any) bool {
	if v, ok := cfg["reality-opts"].(map[string]any); ok && v != nil {
		return true
	}
	return strings.EqualFold(stringValue(cfg["security"]), "reality")
}

func isHysteriaProxy(cfg map[string]any, protocol string) bool {
	p := strings.ToLower(strings.TrimSpace(protocol))
	return p == "hysteria" || p == "hysteria2" || p == "hy2" || strings.EqualFold(stringValue(cfg["network"]), "hysteria")
}

func proxySNI(cfg map[string]any) string {
	for _, key := range []string{"sni", "servername", "server-name"} {
		if value := strings.TrimSpace(stringValue(cfg[key])); value != "" {
			return value
		}
	}
	return ""
}

func proxyALPN(cfg map[string]any) string {
	switch values := cfg["alpn"].(type) {
	case []any:
		parts := make([]string, 0, len(values))
		for _, value := range values {
			if s := strings.TrimSpace(stringValue(value)); s != "" {
				parts = append(parts, s)
			}
		}
		return strings.Join(parts, ",")
	case []string:
		return strings.Join(values, ",")
	case string:
		return values
	}
	return ""
}

func existingFingerprint(cfg map[string]any) string {
	for _, key := range []string{"tls-fingerprint", "pinnedPeerCertSha256", "pcs", "pinSHA256"} {
		if fp := normalizedCertFingerprint(stringValue(cfg[key])); fp != "" {
			return fp
		}
	}
	return ""
}

func normalizedCertFingerprint(value string) string {
	value = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(value), ":", ""))
	if len(value) != sha256HexLength {
		return ""
	}
	if _, err := hex.DecodeString(value); err != nil {
		return ""
	}
	return value
}

const sha256HexLength = 64

func stringValue(value any) string {
	s, _ := value.(string)
	return s
}

func intValue(value any) int {
	switch v := value.(type) {
	case float64:
		return int(v)
	case int:
		return v
	case json.Number:
		n, _ := strconv.Atoi(v.String())
		return n
	case string:
		n, _ := strconv.Atoi(v)
		return n
	}
	return 0
}
