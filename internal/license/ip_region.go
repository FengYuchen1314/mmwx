package license

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

type IPRegion struct {
	Country string `json:"country"`
	Region  string `json:"region"`
	City    string `json:"city"`
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
	body, _ := json.Marshal(map[string]any{"key": m.key, "machine_id": m.machineID, "nonce": genNonce(), "ip": ip})
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
