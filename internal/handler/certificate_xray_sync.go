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

// collectManagedXrayCertPaths 只收集由主控托管目录引用的 certificateFile/keyFile 对。
// 其它手工路径不参与自动覆盖，避免把用户自己维护的证书误认成主控证书。
func collectManagedXrayCertPaths(configJSON string) map[string]string {
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
			if strings.HasPrefix(certPath, managedXrayCertDir+"/") &&
				strings.HasPrefix(keyPath, managedXrayCertDir+"/") {
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
