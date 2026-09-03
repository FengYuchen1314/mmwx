package handler

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"strings"
	"time"

	"miaomiaowux/internal/storage"
)

// GenerateSelfSignedCert POST /api/admin/certificates/self-signed
// 为某台服务器生成一张自签证书(HY2「允许不安全」场景),下发到 agent 的 xray 证书目录,返回 cert/key 路径。
// 客户端需 skip-cert-verify 才能连接:fork 的 xray 服务端禁用了 allowInsecure,证书校验放到客户端跳过。
func (h *CertificateHandler) GenerateSelfSignedCert(w http.ResponseWriter, r *http.Request) {
	if !h.requireAdmin(r) {
		respondJSON(w, http.StatusForbidden, map[string]any{"success": false, "message": "管理员权限不足"})
		return
	}
	var req struct {
		ServerID int64  `json:"server_id"`
		Domain   string `json:"domain"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ServerID <= 0 {
		respondJSON(w, http.StatusBadRequest, map[string]any{"success": false, "message": "server_id required"})
		return
	}
	domain := strings.TrimSpace(req.Domain)
	if domain == "" {
		respondJSON(w, http.StatusBadRequest, map[string]any{"success": false, "message": "需要域名或 IP 作为 SNI"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	server, err := h.repo.GetRemoteServer(ctx, req.ServerID)
	if err != nil || server == nil {
		respondJSON(w, http.StatusNotFound, map[string]any{"success": false, "message": "服务器不存在"})
		return
	}
	// IsFederated 是非持久化字段,GetRemoteServer 不填充;显式补上,否则联邦(分享)服务器
	// 的证书下发会走直连 agent 路径(消费方连不到)而失败。
	server.IsFederated = h.repo.IsFederatedServer(ctx, req.ServerID)

	certPEM, keyPEM, gerr := generateSelfSignedCertPEM(domain)
	if gerr != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "生成自签证书失败: " + gerr.Error()})
		return
	}

	// 自签证书此前只存在于本次请求内存并直接下发 Agent，主控没有任何副本，
	// 因而数据库/数据目录备份都无法恢复。复用 ACME 客户端的证书落盘逻辑，
	// 将材料保存到 data/certs，并在 certificates 表保存 PEM（数据库备份的兜底副本）。
	result, perr := h.acmeClient.ProcessCertResult(domain, []byte(certPEM), []byte(keyPEM))
	if perr != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "保存自签证书失败: " + perr.Error()})
		return
	}
	cert := &storage.Certificate{
		Domain:         domain,
		Email:          "self-signed@local",
		Provider:       "self-signed",
		CertPath:       result.CertPath,
		KeyPath:        result.KeyPath,
		CertPEM:        result.CertPEM,
		KeyPEM:         result.KeyPEM,
		Status:         storage.CertStatusValid,
		ExpiryDate:     &result.ExpiryDate,
		IssueDate:      &result.IssueDate,
		AutoRenew:      false,
		ChallengeMode:  "manual",
		RemoteServerID: req.ServerID,
		DeployTarget:   "xray",
		DeployCertPath: "/usr/local/etc/xray/certs/" + certDeployFilename(domain) + ".pem",
		DeployKeyPath:  "/usr/local/etc/xray/certs/" + certDeployFilename(domain) + ".key",
		AutoDeploy:     false,
	}
	if existing, eerr := h.repo.GetCertificateByDomain(ctx, domain, req.ServerID); eerr == nil && existing != nil {
		cert.ID = existing.ID
		if uerr := h.repo.UpdateCertificate(ctx, cert); uerr != nil {
			respondJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "更新自签证书记录失败: " + uerr.Error()})
			return
		}
	} else if cerr := h.repo.CreateCertificate(ctx, cert); cerr != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "保存自签证书记录失败: " + cerr.Error()})
		return
	}

	certPath, keyPath, derr := h.DeployCertToServerSync(ctx, server, cert)
	if derr != nil {
		respondJSON(w, http.StatusBadGateway, map[string]any{"success": false, "message": "下发自签证书到服务器失败: " + derr.Error()})
		return
	}

	respondJSON(w, http.StatusOK, map[string]any{
		"success":   true,
		"domain":    domain,
		"cert_path": certPath,
		"key_path":  keyPath,
	})
}

// generateSelfSignedCertPEM 生成一张 10 年有效期的 ECDSA P-256 自签证书(CN=domain,SAN 含 domain / IP)。
func generateSelfSignedCertPEM(domain string) (certPEM, keyPEM string, err error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", "", err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return "", "", err
	}
	tmpl := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: domain},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	if ip := net.ParseIP(domain); ip != nil {
		tmpl.IPAddresses = []net.IP{ip}
	} else {
		tmpl.DNSNames = []string{domain}
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		return "", "", err
	}
	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return "", "", err
	}
	certPEM = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	keyPEM = string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}))
	return certPEM, keyPEM, nil
}
