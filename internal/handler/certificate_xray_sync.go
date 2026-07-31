package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"path"
	"strings"
	"time"

	"miaomiaowux/internal/storage"
)

const managedXrayCertDir = "/usr/local/etc/xray/certs"

func xrayCertMaterialHash(certPEM, keyPEM string) string {
	sum := sha256.Sum256([]byte(certPEM + "\x00" + keyPEM))
	return hex.EncodeToString(sum[:])
}

func xrayCertSyncKey(serverID, certID int64) string {
	return fmt.Sprintf("%d:%d", serverID, certID)
}

func (h *CertificateHandler) rememberXrayCertSync(serverID int64, cert *storage.Certificate) {
	if cert == nil || cert.ID <= 0 {
		return
	}
	h.xrayCertSynced.Store(xrayCertSyncKey(serverID, cert.ID), xrayCertMaterialHash(cert.CertPEM, cert.KeyPEM))
}

func (h *CertificateHandler) forgetXrayCertSync(serverID, certID int64) {
	h.xrayCertSynced.Delete(xrayCertSyncKey(serverID, certID))
}

func (h *CertificateHandler) needsXrayCertSync(serverID int64, cert *storage.Certificate) bool {
	if cert == nil || cert.ID <= 0 {
		return false
	}
	got, ok := h.xrayCertSynced.Load(xrayCertSyncKey(serverID, cert.ID))
	return !ok || got != xrayCertMaterialHash(cert.CertPEM, cert.KeyPEM)
}

func managedXrayCertPaths(domain string) (string, string) {
	name := certDeployFilename(domain)
	return path.Join(managedXrayCertDir, name+".pem"), path.Join(managedXrayCertDir, name+".key")
}

// collectXrayCertPaths 收集配置中所有 certificateFile/keyFile 对。
// 历史快照可能引用老目录或用户曾配置的显式路径，恢复前同样需要先补文件。
func collectXrayCertPaths(configJSON string) map[string]string {
	out := make(map[string]string)
	if strings.TrimSpace(configJSON) == "" {
		return out
	}
	var root any
	if err := json.Unmarshal([]byte(configJSON), &root); err != nil {
		return out
	}
	var walk func(any)
	walk = func(v any) {
		switch value := v.(type) {
		case map[string]any:
			certPath, _ := value["certificateFile"].(string)
			keyPath, _ := value["keyFile"].(string)
			certPath = path.Clean(strings.TrimSpace(certPath))
			keyPath = path.Clean(strings.TrimSpace(keyPath))
			if certPath != "." && keyPath != "." {
				out[certPath] = keyPath
			}
			for _, child := range value {
				walk(child)
			}
		case []any:
			for _, child := range value {
				walk(child)
			}
		}
	}
	walk(root)
	return out
}

// collectManagedXrayCertPaths 只收集由主控托管目录引用的 certificateFile/keyFile 对。
// 其它手工路径不参与自动覆盖，避免把用户自己维护的证书误认成主控证书。
func collectManagedXrayCertPaths(configJSON string) map[string]string {
	out := make(map[string]string)
	for certPath, keyPath := range collectXrayCertPaths(configJSON) {
		if strings.HasPrefix(certPath, managedXrayCertDir+"/") &&
			strings.HasPrefix(keyPath, managedXrayCertDir+"/") {
			out[certPath] = keyPath
		}
	}
	return out
}

func certificateMatchesSnapshotPaths(cert *storage.Certificate, certPath, keyPath string) bool {
	if cert == nil || strings.TrimSpace(cert.CertPEM) == "" || strings.TrimSpace(cert.KeyPEM) == "" {
		return false
	}
	cleanCert := path.Clean(certPath)
	cleanKey := path.Clean(keyPath)
	managedCert, managedKey := managedXrayCertPaths(cert.Domain)
	if cleanCert == managedCert && cleanKey == managedKey {
		return true
	}
	if cert.DeployCertPath != "" && cert.DeployKeyPath != "" &&
		cleanCert == path.Clean(cert.DeployCertPath) && cleanKey == path.Clean(cert.DeployKeyPath) {
		return true
	}
	// 兼容旧 Xray 证书目录：目录可能变化，但主控生成的确定性文件名不变。
	wantName := certDeployFilename(cert.Domain)
	certBase := strings.TrimSuffix(path.Base(cleanCert), path.Ext(cleanCert))
	keyBase := strings.TrimSuffix(path.Base(cleanKey), path.Ext(cleanKey))
	return certBase == wantName && keyBase == wantName
}

// deploySnapshotCertificates 在历史配置 test/PUT 前，把它引用的证书同步到 Agent 的原路径。
// 任一引用无法从证书库找到材料就失败，避免下发一个必然无法启动的配置。
func (h *RemoteManageHandler) deploySnapshotCertificates(ctx context.Context, serverID int64, configJSON string) error {
	refs := collectXrayCertPaths(configJSON)
	if len(refs) == 0 {
		return nil
	}
	if h.certHandler == nil {
		return fmt.Errorf("配置引用了 %d 组证书，但证书处理器未初始化", len(refs))
	}
	certs, err := h.repo.ListCertificates(ctx)
	if err != nil {
		return fmt.Errorf("读取证书库失败: %w", err)
	}
	for certPath, keyPath := range refs {
		var matched *storage.Certificate
		for i := range certs {
			if certificateMatchesSnapshotPaths(&certs[i], certPath, keyPath) {
				matched = &certs[i]
				break
			}
		}
		if matched == nil {
			return fmt.Errorf("历史配置引用证书 %s，但主控证书库中没有匹配的证书材料", certPath)
		}
		payload := WSCertDeployPayload{
			Domain:   matched.Domain,
			CertPEM:  matched.CertPEM,
			KeyPEM:   matched.KeyPEM,
			CertPath: certPath,
			KeyPath:  keyPath,
			Reload:   "none",
		}
		body, _ := json.Marshal(payload)
		if _, err := h.forwardToRemoteServer(ctx, serverID, "POST", "/api/child/cert/deploy", body); err != nil {
			return fmt.Errorf("下发证书 %s 失败: %w", certPath, err)
		}
		h.certHandler.rememberXrayCertSync(serverID, matched)
		log.Printf("[XraySnapshot] server=%d deployed certificate before config restore: %s", serverID, certPath)
	}
	return nil
}

func (h *CertificateHandler) managedXrayReferences(ctx context.Context, serverID int64) map[string]string {
	refs := make(map[string]string)
	merge := func(configJSON string) {
		for certPath, keyPath := range collectManagedXrayCertPaths(configJSON) {
			refs[certPath] = keyPath
		}
	}
	if current, err := h.repo.GetCurrentXraySnapshot(ctx, serverID); err == nil && current != nil {
		merge(current.ConfigJSON)
	}
	if pending, err := h.repo.GetPendingXrayRecovery(ctx, serverID); err == nil && pending != nil {
		merge(pending.ConfigJSON)
	}
	return refs
}

func certReferencedByPaths(cert *storage.Certificate, refs map[string]string) bool {
	certPath, keyPath := managedXrayCertPaths(cert.Domain)
	return refs[certPath] == keyPath
}

func (h *CertificateHandler) deployManagedXrayCert(ctx context.Context, server *storage.RemoteServer, cert *storage.Certificate) error {
	if _, _, err := h.DeployCertToServerSync(ctx, server, cert); err != nil {
		h.forgetXrayCertSync(server.ID, cert.ID)
		return err
	}
	if h.remoteManage == nil {
		h.forgetXrayCertSync(server.ID, cert.ID)
		return fmt.Errorf("remote manage handler not initialized")
	}
	if err := h.remoteManage.restartXrayWithRecovery(ctx, server.ID, "CertificateSync"); err != nil {
		h.forgetXrayCertSync(server.ID, cert.ID)
		return err
	}
	return nil
}

// syncManagedXrayAfterMaterialUpdate 在本地托管证书签发、续期或覆盖上传后，
// 异步更新所有实际引用该确定性 Xray 路径的服务器。
func (h *CertificateHandler) syncManagedXrayAfterMaterialUpdate(cert *storage.Certificate, certPEM, keyPEM string) {
	if cert == nil || cert.ID <= 0 || cert.RemoteServerID != 0 || certPEM == "" || keyPEM == "" {
		return
	}
	updated := *cert
	updated.CertPEM = certPEM
	updated.KeyPEM = keyPEM
	updated.Status = storage.CertStatusValid

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		h.xrayCertSyncMu.Lock()
		defer h.xrayCertSyncMu.Unlock()

		servers, err := h.repo.ListRemoteServers(ctx)
		if err != nil {
			log.Printf("[Certificate] ListRemoteServers for Xray cert sync failed: %v", err)
			return
		}
		for i := range servers {
			refs := h.managedXrayReferences(ctx, servers[i].ID)
			if !certReferencedByPaths(&updated, refs) || !h.needsXrayCertSync(servers[i].ID, &updated) {
				continue
			}
			if err := h.deployManagedXrayCert(ctx, &servers[i], &updated); err != nil {
				log.Printf("[Certificate] Xray cert sync failed for %s on server %d: %v", updated.Domain, servers[i].ID, err)
				continue
			}
			log.Printf("[Certificate] Xray cert synced after material update for %s on server %d", updated.Domain, servers[i].ID)
		}
	}()
}

// SyncManagedXrayCertificatesOnReconnect 在 agent 配置快照同步完成后补发托管证书。
// 成功部署过且内容指纹未变化的证书会跳过，避免普通重连反复重启 Xray。
func (h *CertificateHandler) SyncManagedXrayCertificatesOnReconnect(ctx context.Context, serverID int64) {
	h.xrayCertSyncMu.Lock()
	defer h.xrayCertSyncMu.Unlock()

	refs := h.managedXrayReferences(ctx, serverID)
	if len(refs) == 0 {
		return
	}
	server, err := h.repo.GetRemoteServer(ctx, serverID)
	if err != nil {
		log.Printf("[Certificate] GetRemoteServer for reconnect cert sync failed: %v", err)
		return
	}
	certs, err := h.repo.ListValidCertificates(ctx)
	if err != nil {
		log.Printf("[Certificate] ListValidCertificates for reconnect cert sync failed: %v", err)
		return
	}
	for i := range certs {
		cert := &certs[i]
		if cert.RemoteServerID != 0 || cert.CertPEM == "" || cert.KeyPEM == "" ||
			!certReferencedByPaths(cert, refs) || !h.needsXrayCertSync(serverID, cert) {
			continue
		}
		if err := h.deployManagedXrayCert(ctx, server, cert); err != nil {
			log.Printf("[Certificate] Reconnect Xray cert sync failed for %s on server %d: %v", cert.Domain, serverID, err)
			continue
		}
		log.Printf("[Certificate] Reconnect Xray cert sync succeeded for %s on server %d", cert.Domain, serverID)
	}
}
