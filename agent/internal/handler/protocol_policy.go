package handler

import (
	"fmt"
	"strings"
)

// validateManagedInbound is intentionally duplicated at the Agent boundary.
// The controller is not a security boundary: a compromised controller token
// must not make an Agent accept protocols outside the product policy.
func validateManagedInbound(inbound map[string]interface{}) error {
	if inbound == nil {
		return fmt.Errorf("inbound is required")
	}
	protocol := strings.ToLower(strings.TrimSpace(policyString(inbound["protocol"])))
	settings, _ := inbound["settings"].(map[string]interface{})
	stream, _ := inbound["streamSettings"].(map[string]interface{})

	switch protocol {
	case "vless":
		if stream == nil || strings.ToLower(strings.TrimSpace(policyString(stream["security"]))) != "reality" {
			return fmt.Errorf("VLESS only supports REALITY")
		}
		switch strings.ToLower(strings.TrimSpace(policyString(stream["network"]))) {
		case "tcp":
			if !policyAllVision(settings) {
				return fmt.Errorf("VLESS + TCP requires Vision flow")
			}
		case "xhttp", "splithttp":
			if policyHasFlow(settings) {
				return fmt.Errorf("VLESS + XHTTP cannot use Vision flow")
			}
			xhttp, _ := stream["xhttpSettings"].(map[string]interface{})
			if xhttp == nil {
				xhttp, _ = stream["splithttpSettings"].(map[string]interface{})
			}
			if xhttp == nil {
				return fmt.Errorf("VLESS + XHTTP requires xhttpSettings")
			}
			if _, ok := xhttp["xmux"].(map[string]interface{}); !ok {
				return fmt.Errorf("VLESS + XHTTP requires XMUX")
			}
		default:
			return fmt.Errorf("VLESS only supports REALITY + Vision or XHTTP + REALITY + XMUX")
		}
	case "anytls":
		if len(policyItems(settings, "users")) == 0 {
			return fmt.Errorf("AnyTLS requires a user")
		}
		ext, _ := inbound["mmwxShadowTLS"].(map[string]interface{})
		if ext == nil || ext["enabled"] != true || strings.TrimSpace(policyString(ext["handshake"])) == "" || strings.TrimSpace(policyString(ext["password"])) == "" {
			return fmt.Errorf("AnyTLS requires ShadowTLS handshake and password")
		}
	case "mieru":
		if len(policyItems(settings, "users")) == 0 {
			return fmt.Errorf("Mieru requires a user")
		}
		if transport := strings.ToUpper(strings.TrimSpace(policyString(settings["transport"]))); transport != "" && transport != "TCP" {
			return fmt.Errorf("only Mieru TCP is supported")
		}
	case "socks":
		if strings.ToLower(strings.TrimSpace(policyString(settings["auth"]))) != "password" || len(policyItems(settings, "accounts")) == 0 {
			return fmt.Errorf("SOCKS5 requires username/password authentication")
		}
	default:
		return fmt.Errorf("unsupported inbound protocol %q", protocol)
	}
	return nil
}

func policyString(v interface{}) string {
	s, _ := v.(string)
	return s
}

func policyItems(settings map[string]interface{}, key string) []interface{} {
	if settings == nil {
		return nil
	}
	items, _ := settings[key].([]interface{})
	return items
}

func policyHasFlow(settings map[string]interface{}) bool {
	for _, raw := range policyItems(settings, "clients") {
		client, _ := raw.(map[string]interface{})
		if strings.TrimSpace(policyString(client["flow"])) != "" {
			return true
		}
	}
	return false
}

func policyAllVision(settings map[string]interface{}) bool {
	clients := policyItems(settings, "clients")
	if len(clients) == 0 {
		return false
	}
	for _, raw := range clients {
		client, _ := raw.(map[string]interface{})
		if strings.TrimSpace(policyString(client["flow"])) != "xtls-rprx-vision" {
			return false
		}
	}
	return true
}
