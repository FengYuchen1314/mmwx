package license

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// ExchangeRates returns the value of one unit of each currency in CNY.
// Results are cached because the public probe payload is rebuilt frequently.
func (m *Manager) ExchangeRates(ctx context.Context) (map[string]float64, error) {
	if m == nil || m.key == "" || m.serverURL == "" {
		return nil, errors.New("license unavailable")
	}
	m.exchangeMu.RLock()
	if time.Since(m.exchangeFetchedAt) < 6*time.Hour && len(m.exchangeRates) > 0 {
		out := cloneRates(m.exchangeRates)
		m.exchangeMu.RUnlock()
		return out, nil
	}
	m.exchangeMu.RUnlock()
	body, _ := json.Marshal(map[string]any{"key": m.key, "machine_id": m.machineID, "nonce": genNonce()})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(m.serverURL, "/")+"/api/v1/exchange-rates", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := m.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("exchange rate service unavailable")
	}
	var result struct {
		Success bool               `json:"success"`
		Rates   map[string]float64 `json:"rates"`
		Error   string             `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	if !result.Success || len(result.Rates) == 0 {
		return nil, errors.New(result.Error)
	}
	m.exchangeMu.Lock()
	m.exchangeRates = cloneRates(result.Rates)
	m.exchangeFetchedAt = time.Now()
	m.exchangeMu.Unlock()
	return cloneRates(result.Rates), nil
}

func cloneRates(src map[string]float64) map[string]float64 {
	out := make(map[string]float64, len(src))
	for k, v := range src {
		out[k] = v
	}
	return out
}
