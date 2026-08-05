package license

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestAnonymizeRegionLookupIP(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "ipv4", in: "175.182.36.120", want: "175.182.36.1"},
		{name: "ipv4 whitespace", in: " 203.0.113.255 ", want: "203.0.113.1"},
		{name: "mapped ipv4", in: "::ffff:175.182.36.120", want: "175.182.36.1"},
		{name: "ipv6 unchanged", in: "2001:db8::120", want: "2001:db8::120"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := anonymizeRegionLookupIP(tt.in); got != tt.want {
				t.Fatalf("anonymizeRegionLookupIP(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestExchangeRatesRefreshesExpiredLicenseServerRates(t *testing.T) {
	var calls atomic.Int32
	rate := 7.2
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"rates":   map[string]float64{"usd": rate},
		})
	}))
	defer server.Close()

	m := &Manager{key: "key", machineID: "machine", serverURL: server.URL, client: server.Client()}
	rates, err := m.ExchangeRates(context.Background())
	if err != nil || rates["USD"] != 7.2 || rates["CNY"] != 1 {
		t.Fatalf("first fetch = %#v, %v", rates, err)
	}
	rate = 7.35
	m.exchangeMu.Lock()
	m.exchangeFetchedAt = time.Now().Add(-exchangeRatesTTL)
	m.exchangeMu.Unlock()
	rates, err = m.ExchangeRates(context.Background())
	if err != nil || rates["USD"] != 7.35 || calls.Load() != 2 {
		t.Fatalf("refreshed fetch = %#v, %v; calls=%d", rates, err, calls.Load())
	}
}

func TestExchangeRatesUsesLastValidRatesOnFetchFailure(t *testing.T) {
	m := &Manager{
		key: "key", machineID: "machine", serverURL: "http://127.0.0.1:1",
		client:            &http.Client{Timeout: 100 * time.Millisecond},
		exchangeRates:     map[string]float64{"USD": 7.1},
		exchangeFetchedAt: time.Now().Add(-exchangeRatesTTL),
	}
	rates, err := m.ExchangeRates(context.Background())
	if err != nil || rates["USD"] != 7.1 {
		t.Fatalf("stale fallback = %#v, %v", rates, err)
	}
}

func TestResolveIPRegionDoesNotSendFullIPv4Address(t *testing.T) {
	const realIP = "175.182.36.120"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			IP string `json:"ip"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode request: %v", err)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if request.IP != "175.182.36.1" {
			t.Errorf("region lookup sent IP %q, want anonymized IP", request.IP)
		}
		if request.IP == realIP {
			t.Errorf("region lookup leaked the full server IP")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"region":{"country":"TW"}}`))
	}))
	defer server.Close()

	manager := &Manager{
		key:       "test-key",
		machineID: "test-machine",
		serverURL: server.URL,
		client:    server.Client(),
	}
	region, err := manager.ResolveIPRegion(context.Background(), realIP)
	if err != nil {
		t.Fatalf("ResolveIPRegion() error = %v", err)
	}
	if region.Country != "TW" {
		t.Fatalf("ResolveIPRegion() country = %q, want TW", region.Country)
	}
}
