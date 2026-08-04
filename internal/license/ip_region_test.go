package license

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
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
