package shadowtls

import "testing"

func TestPrepareMovesAnyTLSBehindLoopback(t *testing.T) {
	inbound := map[string]interface{}{
		"protocol": "anytls",
		"tag":      "anytls-shadowtls-in-443",
		"port":     443,
		"mmwxShadowTLS": map[string]interface{}{
			"enabled":   true,
			"handshake": "www.cloudflare.com:443",
			"password":  "shadow-secret",
		},
	}
	config, enabled, err := Prepare(inbound)
	if err != nil || !enabled {
		t.Fatalf("Prepare() = (%+v, %v, %v)", config, enabled, err)
	}
	if config.PublicPort != 443 || config.InternalPort == 443 {
		t.Fatalf("unexpected ports: %+v", config)
	}
	if inbound["listen"] != "127.0.0.1" || asPort(inbound["port"]) != config.InternalPort {
		t.Fatalf("inbound was not rewritten to loopback: %#v", inbound)
	}
}

func TestPrepareRejectsAnyTLSWithoutShadowTLS(t *testing.T) {
	_, _, err := Prepare(map[string]interface{}{"protocol": "anytls", "tag": "x", "port": 443})
	if err == nil {
		t.Fatal("expected missing ShadowTLS extension to be rejected")
	}
}
