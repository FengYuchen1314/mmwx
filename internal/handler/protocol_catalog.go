package handler

import (
	"fmt"
	"strings"
)

// ProtocolProfile is the complete, user-selectable inbound shape.  Protocol is
// deliberately kept separate from Profile: Xray calls both VLESS variants
// "vless", while they have incompatible transport and flow requirements.
type ProtocolProfile struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Protocol string `json:"protocol"`
}

var supportedProtocolProfiles = []ProtocolProfile{
	{ID: "vless-reality-vision", Label: "VLESS + REALITY + Vision", Protocol: "vless"},
	{ID: "vless-xhttp-reality-xmux", Label: "VLESS + XHTTP + REALITY + XMUX", Protocol: "vless"},
	{ID: "anytls-shadowtls", Label: "AnyTLS + ShadowTLS", Protocol: "anytls"},
	{ID: "mieru", Label: "Mieru", Protocol: "mieru"},
	{ID: "socks5", Label: "SOCKS5", Protocol: "socks"},
}

// SupportedProtocolProfiles returns a copy so callers cannot mutate the
// application policy by accident.
func SupportedProtocolProfiles() []ProtocolProfile {
	profiles := make([]ProtocolProfile, len(supportedProtocolProfiles))
	copy(profiles, supportedProtocolProfiles)
	return profiles
}

// ValidateManagedInbound is the backend boundary for all user-managed Xray
// inbounds.  UI filtering is only a convenience; this validation also covers
// direct API callers and updates.
//
// Xray service inbounds (api, tunnel-in, dokodemo-door, ...) do not traverse
// the remote management API and are intentionally outside this policy.
func ValidateManagedInbound(inbound map[string]interface{}) error {
	if inbound == nil {
		return fmt.Errorf("inbound is required")
	}
	protocol := strings.ToLower(strings.TrimSpace(catalogString(inbound["protocol"])))
	settings, _ := inbound["settings"].(map[string]interface{})
	stream, _ := inbound["streamSettings"].(map[string]interface{})

	switch protocol {
	case "vless":
		if stream == nil || strings.ToLower(strings.TrimSpace(catalogString(stream["security"]))) != "reality" {
			return fmt.Errorf("VLESS 仅支持 REALITY")
		}
		network := strings.ToLower(strings.TrimSpace(catalogString(stream["network"])))
		switch network {
		case "tcp":
			if !allVLESSClientsUseVision(settings) {
				return fmt.Errorf("VLESS + TCP 必须使用 Vision flow")
			}
		case "xhttp", "splithttp":
			if anyVLESSClientUsesFlow(settings) {
				return fmt.Errorf("VLESS + XHTTP 不支持 Vision flow")
			}
			xhttp, _ := stream["xhttpSettings"].(map[string]interface{})
			if xhttp == nil {
				xhttp, _ = stream["splithttpSettings"].(map[string]interface{})
			}
			if xhttp == nil {
				return fmt.Errorf("VLESS + XHTTP 需要 xhttpSettings")
			}
			if _, ok := xhttp["xmux"].(map[string]interface{}); !ok {
				return fmt.Errorf("VLESS + XHTTP 必须启用 XMUX")
			}
		default:
			return fmt.Errorf("VLESS 仅支持 REALITY + Vision 或 XHTTP + REALITY + XMUX")
		}
		return nil

	case "anytls":
		if settings == nil || len(credentialItems(settings, "users")) == 0 {
			return fmt.Errorf("AnyTLS 需要至少一个用户")
		}
		shadow, _ := inbound["mmwxShadowTLS"].(map[string]interface{})
		if shadow == nil || shadow["enabled"] != true || strings.TrimSpace(catalogString(shadow["handshake"])) == "" || strings.TrimSpace(catalogString(shadow["password"])) == "" {
			return fmt.Errorf("AnyTLS 必须通过 ShadowTLS，并配置 handshake 目标和密码")
		}
		return nil

	case "mieru":
		if settings == nil || len(credentialItems(settings, "users")) == 0 {
			return fmt.Errorf("Mieru 需要至少一个用户")
		}
		if transport := strings.ToUpper(strings.TrimSpace(catalogString(settings["transport"]))); transport != "" && transport != "TCP" {
			return fmt.Errorf("当前仅支持 Mieru TCP")
		}
		return nil

	case "socks":
		if settings == nil || strings.ToLower(strings.TrimSpace(catalogString(settings["auth"]))) != "password" || len(credentialItems(settings, "accounts")) == 0 {
			return fmt.Errorf("SOCKS5 必须启用用户名密码认证")
		}
		return nil
	default:
		return fmt.Errorf("不支持协议 %q；仅支持 VLESS + REALITY + Vision、VLESS + XHTTP + REALITY + XMUX、AnyTLS + ShadowTLS、Mieru、SOCKS5", protocol)
	}
}

func catalogString(v interface{}) string {
	s, _ := v.(string)
	return s
}

func credentialItems(settings map[string]interface{}, key string) []interface{} {
	items, _ := settings[key].([]interface{})
	return items
}

func anyVLESSClientUsesFlow(settings map[string]interface{}) bool {
	for _, client := range credentialItems(settings, "clients") {
		item, _ := client.(map[string]interface{})
		if strings.TrimSpace(catalogString(item["flow"])) != "" {
			return true
		}
	}
	return false
}

func allVLESSClientsUseVision(settings map[string]interface{}) bool {
	clients := credentialItems(settings, "clients")
	if len(clients) == 0 {
		return false
	}
	for _, client := range clients {
		item, _ := client.(map[string]interface{})
		if strings.TrimSpace(catalogString(item["flow"])) != "xtls-rprx-vision" {
			return false
		}
	}
	return true
}
