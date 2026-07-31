package handler

import (
	"testing"

	"miaomiaowux/internal/storage"
)

func TestCollectManagedXrayCertPaths(t *testing.T) {
	config := `{
		"inbounds": [{
			"streamSettings": {
				"tlsSettings": {
					"certificates": [
						{
							"certificateFile": "/usr/local/etc/xray/certs/example.com.pem",
							"keyFile": "/usr/local/etc/xray/certs/example.com.key"
						},
						{
							"certificateFile": "/etc/custom/manual.pem",
							"keyFile": "/etc/custom/manual.key"
						},
						{
							"certificateFile": "/usr/local/etc/xray/certs/../../outside.pem",
							"keyFile": "/usr/local/etc/xray/certs/../../outside.key"
						}
					]
				}
			}
		}]
	}`

	refs := collectManagedXrayCertPaths(config)
	if len(refs) != 1 {
		t.Fatalf("expected one managed certificate reference, got %d: %#v", len(refs), refs)
	}
	if got := refs["/usr/local/etc/xray/certs/example.com.pem"]; got != "/usr/local/etc/xray/certs/example.com.key" {
		t.Fatalf("unexpected key path: %q", got)
	}
}

func TestCollectManagedXrayCertPathsInvalidJSON(t *testing.T) {
	if refs := collectManagedXrayCertPaths("{"); len(refs) != 0 {
		t.Fatalf("invalid JSON must not produce references: %#v", refs)
	}
}

func TestCollectXrayCertPathsIncludesHistoricalCustomDirectory(t *testing.T) {
	config := `{"inbounds":[{"streamSettings":{"tlsSettings":{"certificates":[{"certificateFile":"/etc/xray/legacy/example.com.pem","keyFile":"/etc/xray/legacy/example.com.key"}]}}}]}`
	refs := collectXrayCertPaths(config)
	if got := refs["/etc/xray/legacy/example.com.pem"]; got != "/etc/xray/legacy/example.com.key" {
		t.Fatalf("historical certificate reference missing, got %q", got)
	}
}

func TestCertificateMatchesSnapshotPaths(t *testing.T) {
	cert := &storage.Certificate{
		Domain:  "example.com",
		CertPEM: "certificate",
		KeyPEM:  "private-key",
	}
	if !certificateMatchesSnapshotPaths(cert,
		"/usr/local/etc/xray/certs/example.com.pem",
		"/usr/local/etc/xray/certs/example.com.key") {
		t.Fatal("managed Xray paths should match certificate material")
	}
	if !certificateMatchesSnapshotPaths(cert,
		"/etc/xray/legacy/example.com.crt",
		"/etc/xray/legacy/example.com.key") {
		t.Fatal("legacy directory with deterministic certificate filenames should match")
	}
	if certificateMatchesSnapshotPaths(cert,
		"/etc/xray/legacy/other.pem",
		"/etc/xray/legacy/other.key") {
		t.Fatal("unrelated certificate paths must not match")
	}
	cert.KeyPEM = ""
	if certificateMatchesSnapshotPaths(cert,
		"/usr/local/etc/xray/certs/example.com.pem",
		"/usr/local/etc/xray/certs/example.com.key") {
		t.Fatal("certificate without private key material must not match")
	}
}

func TestManagedXrayCertPathsWildcard(t *testing.T) {
	certPath, keyPath := managedXrayCertPaths("*.example.com")
	if certPath != "/usr/local/etc/xray/certs/_.example.com.pem" {
		t.Fatalf("unexpected wildcard cert path: %s", certPath)
	}
	if keyPath != "/usr/local/etc/xray/certs/_.example.com.key" {
		t.Fatalf("unexpected wildcard key path: %s", keyPath)
	}
}

func TestXrayCertSyncFingerprint(t *testing.T) {
	h := &CertificateHandler{}
	cert := &storage.Certificate{ID: 12, CertPEM: "cert-v1", KeyPEM: "key-v1"}

	if !h.needsXrayCertSync(7, cert) {
		t.Fatal("certificate without a successful deployment must need sync")
	}
	h.rememberXrayCertSync(7, cert)
	if h.needsXrayCertSync(7, cert) {
		t.Fatal("unchanged successfully deployed certificate must not need sync")
	}

	cert.CertPEM = "cert-v2"
	if !h.needsXrayCertSync(7, cert) {
		t.Fatal("changed certificate material must need sync")
	}

	h.forgetXrayCertSync(7, cert.ID)
	if !h.needsXrayCertSync(7, cert) {
		t.Fatal("failed or forgotten deployment must need sync")
	}
}

func TestCertReferencedByPaths(t *testing.T) {
	cert := &storage.Certificate{Domain: "example.com"}
	refs := map[string]string{
		"/usr/local/etc/xray/certs/example.com.pem": "/usr/local/etc/xray/certs/example.com.key",
	}
	if !certReferencedByPaths(cert, refs) {
		t.Fatal("expected exact managed path pair to match")
	}
	refs["/usr/local/etc/xray/certs/example.com.pem"] = "/usr/local/etc/xray/certs/other.key"
	if certReferencedByPaths(cert, refs) {
		t.Fatal("mismatched key path must not match")
	}
}

func TestCertificateMaterialDeployTarget(t *testing.T) {
	tests := []struct {
		name string
		cert *storage.Certificate
		want string
	}{
		{name: "auto deploy uses nginx path only", cert: &storage.Certificate{AutoDeploy: true, DeployTarget: "both", DeployCertPath: "/usr/local/nginx/cert/a.pem", DeployKeyPath: "/usr/local/nginx/cert/a.key"}, want: "nginx"},
		{name: "explicit target remains unchanged", cert: &storage.Certificate{DeployTarget: "both", DeployCertPath: "/tmp/a.pem", DeployKeyPath: "/tmp/a.key"}, want: "both"},
		{name: "auto deploy without paths is disabled", cert: &storage.Certificate{AutoDeploy: true, DeployTarget: "both"}, want: "none"},
		{name: "empty target is none", cert: &storage.Certificate{}, want: "none"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := certificateMaterialDeployTarget(tt.cert); got != tt.want {
				t.Fatalf("certificateMaterialDeployTarget() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestHasCertificateDeployPaths(t *testing.T) {
	if hasCertificateDeployPaths(&storage.Certificate{DeployCertPath: "", DeployKeyPath: "/tmp/key"}) {
		t.Fatal("empty certificate path must not be deployable")
	}
	if !hasCertificateDeployPaths(&storage.Certificate{DeployCertPath: "/tmp/cert", DeployKeyPath: "/tmp/key"}) {
		t.Fatal("non-empty certificate and key paths must be deployable")
	}
}
