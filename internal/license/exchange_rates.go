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

// exchangeRatesTTL keeps probe prices reasonably close to the values configured
// on the license server. Probe payloads are requested frequently, so fetching on
// every request would put unnecessary load on the license service.
const exchangeRatesTTL = 24 * time.Hour

// ExchangeRates returns the value of one unit of each currency in CNY.
// Results are cached because the public probe payload is rebuilt frequently.
func (m *Manager) ExchangeRates(ctx context.Context) (map[string]float64, error) {
	if m == nil || m.key == "" || m.serverURL == "" {
		return nil, errors.New("license unavailable")
	}
	m.exchangeMu.RLock()
	if time.Since(m.exchangeFetchedAt) < exchangeRatesTTL && len(m.exchangeRates) > 0 {
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
		return m.staleExchangeRates(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return m.staleExchangeRates(errors.New("exchange rate service unavailable"))
	}
	var result struct {
		Success bool               `json:"success"`
		Rates   map[string]float64 `json:"rates"`
		Error   string             `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return m.staleExchangeRates(err)
	}
	if !result.Success || len(result.Rates) == 0 {
		return m.staleExchangeRates(errors.New(result.Error))
	}
	clean := make(map[string]float64, len(result.Rates)+1)
	for code, rate := range result.Rates {
		code = strings.ToUpper(strings.TrimSpace(code))
		if len(code) == 3 && rate > 0 {
			clean[code] = rate
		}
	}
	clean["CNY"] = 1
	if len(clean) == 1 {
		return m.staleExchangeRates(errors.New("license server returned no valid exchange rates"))
	}
	m.exchangeMu.Lock()
	m.exchangeRates = cloneRates(clean)
	m.exchangeFetchedAt = time.Now()
	m.exchangeMu.Unlock()
	return cloneRates(clean), nil
}

// staleExchangeRates keeps the probe usable during a temporary license-server
// outage without silently replacing configured rates with hard-coded defaults.
func (m *Manager) staleExchangeRates(fetchErr error) (map[string]float64, error) {
	m.exchangeMu.RLock()
	defer m.exchangeMu.RUnlock()
	if len(m.exchangeRates) > 0 {
		return cloneRates(m.exchangeRates), nil
	}
	return nil, fetchErr
}

func cloneRates(src map[string]float64) map[string]float64 {
	out := make(map[string]float64, len(src))
	for k, v := range src {
		out[k] = v
	}
	return out
}
