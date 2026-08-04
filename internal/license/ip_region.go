package license

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/netip"
	"strings"
)

type IPRegion struct {
	Country         string `json:"country"`
	Region          string `json:"region"`
	City            string `json:"city"`
	ProviderName    string `json:"provider_name,omitempty"`
	ProviderURL     string `json:"provider_url,omitempty"`
	TelecomPaidPeer bool   `json:"telecom_paid_peer,omitempty"`
}

func (r IPRegion) Label() string {
	parts := make([]string, 0, 3)
	for _, part := range []string{r.Country, r.Region, r.City} {
		if part != "" && (len(parts) == 0 || parts[len(parts)-1] != part) {
			parts = append(parts, part)
		}
	}
	return strings.Join(parts, " · ")
}

// Flag converts the ISO-3166 alpha-2 country code returned by ipinfo into a flag emoji.
func (r IPRegion) Flag() string {
	code := strings.ToUpper(strings.TrimSpace(r.Country))
	if len(code) != 2 || code[0] < 'A' || code[0] > 'Z' || code[1] < 'A' || code[1] > 'Z' {
		return ""
	}
	return string([]rune{0x1F1E6 + rune(code[0]-'A'), 0x1F1E6 + rune(code[1]-'A')})
}

func (m *Manager) ResolveIPRegion(ctx context.Context, ip string) (IPRegion, error) {
	if m == nil || m.key == "" || m.serverURL == "" {
		return IPRegion{}, errors.New("license unavailable")
	}
	body, _ := json.Marshal(map[string]any{"key": m.key, "machine_id": m.machineID, "nonce": genNonce(), "ip": anonymizeRegionLookupIP(ip)})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.serverURL+"/api/v1/ip-region", bytes.NewReader(body))
	if err != nil {
		return IPRegion{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := m.client.Do(req)
	if err != nil {
		return IPRegion{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return IPRegion{}, errors.New("region service unavailable")
	}
	var out struct {
		Success bool     `json:"success"`
		Region  IPRegion `json:"region"`
		Error   string   `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return IPRegion{}, err
	}
	if !out.Success {
		return IPRegion{}, errors.New(out.Error)
	}
	return out.Region, nil
}

// anonymizeRegionLookupIP 保留 IPv4 所属 /24 网段，但不把服务器的完整真实地址发送给
// 许可证服务。许可证服务本身也是按 /24 缓存，因此使用固定的 .1 不影响缓存键、地域和
// 服务商绑定。IPv6 维持现状，避免擅自改变现有 /48 查询行为。
func anonymizeRegionLookupIP(raw string) string {
	addr, err := netip.ParseAddr(strings.TrimSpace(raw))
	if err != nil {
		return raw
	}
	addr = addr.Unmap()
	if !addr.Is4() {
		return addr.String()
	}
	octets := addr.As4()
	octets[3] = 1
	return netip.AddrFrom4(octets).String()
}
