package handler

import "testing"

func TestValidateManagedInboundAllowsOnlyProductProfiles(t *testing.T) {
	tests := []struct {
		name    string
		inbound map[string]interface{}
		wantErr bool
	}{
		{
			name: "vless reality vision",
			inbound: map[string]interface{}{
				"protocol":       "vless",
				"settings":       map[string]interface{}{"clients": []interface{}{map[string]interface{}{"id": "id", "flow": "xtls-rprx-vision"}}},
				"streamSettings": map[string]interface{}{"network": "tcp", "security": "reality"},
			},
		},
		{
			name: "vless xhttp reality xmux",
			inbound: map[string]interface{}{
				"protocol":       "vless",
				"settings":       map[string]interface{}{"clients": []interface{}{map[string]interface{}{"id": "id"}}},
				"streamSettings": map[string]interface{}{"network": "xhttp", "security": "reality", "xhttpSettings": map[string]interface{}{"xmux": map[string]interface{}{}}},
			},
		},
		{
			name: "anytls shadowtls",
			inbound: map[string]interface{}{
				"protocol":      "anytls",
				"settings":      map[string]interface{}{"users": []interface{}{map[string]interface{}{"password": "secret"}}},
				"mmwxShadowTLS": map[string]interface{}{"enabled": true, "handshake": "www.cloudflare.com:443", "password": "shadow-secret"},
			},
		},
		{
			name: "mieru tcp",
			inbound: map[string]interface{}{
				"protocol": "mieru",
				"settings": map[string]interface{}{"transport": "TCP", "users": []interface{}{map[string]interface{}{"username": "u", "password": "p"}}},
			},
		},
		{
			name: "socks5 password",
			inbound: map[string]interface{}{
				"protocol": "socks",
				"settings": map[string]interface{}{"auth": "password", "accounts": []interface{}{map[string]interface{}{"user": "u", "pass": "p"}}},
			},
		},
		{
			name: "vless ws is rejected",
			inbound: map[string]interface{}{
				"protocol":       "vless",
				"settings":       map[string]interface{}{"clients": []interface{}{map[string]interface{}{"id": "id"}}},
				"streamSettings": map[string]interface{}{"network": "ws", "security": "reality"},
			},
			wantErr: true,
		},
		{
			name: "trojan is rejected",
			inbound: map[string]interface{}{
				"protocol": "trojan",
				"settings": map[string]interface{}{"clients": []interface{}{map[string]interface{}{"password": "p"}}},
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateManagedInbound(tt.inbound)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ValidateManagedInbound() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
