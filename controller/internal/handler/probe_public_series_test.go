package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"miaomiaowux/internal/storage"
)

func TestProbeSystemSeriesHonorsPublicMetricSwitches(t *testing.T) {
	repo, err := storage.NewTrafficRepository(filepath.Join(t.TempDir(), "probe-series.db"))
	if err != nil {
		t.Fatalf("NewTrafficRepository: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })

	ctx := context.Background()
	server := &storage.RemoteServer{Name: "probe-test", Token: "probe-test-token"}
	if err := repo.CreateRemoteServer(ctx, server); err != nil {
		t.Fatalf("CreateRemoteServer: %v", err)
	}
	ids, _ := json.Marshal([]int64{server.ID})
	for key, value := range map[string]string{
		probeDisguiseEnabledKey:       "1",
		probeDisguiseServerIDsKey:     string(ids),
		probeDisguiseMetricCPUKey:     "",
		probeDisguiseMetricMemKey:     "",
		probeDisguiseMetricSpeedKey:   "0",
		probeDisguiseMetricTrafficKey: "0",
	} {
		if err := repo.SetSystemSetting(ctx, key, value); err != nil {
			t.Fatalf("SetSystemSetting(%s): %v", key, err)
		}
	}

	store := NewProbeMetricsStore(8)
	store.IngestSys(server.ID, ProbeSysSnapshot{
		CPUPct: 42.5, HasCPU: true,
		MemUsed: 512, MemTotal: 1024, HasMem: true,
		CumulativeUp: 2048, CumulativeDown: 4096, HasNetwork: true,
	})
	handler := NewProbeSeriesHandler(repo, store)

	request := func() map[string]json.RawMessage {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/api/public/probe-series?metric=system&server=0&range=1h", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
		}
		var payload struct {
			Series map[string]json.RawMessage `json:"series"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		return payload.Series
	}

	disabledSeries := request()
	for _, key := range []string{"cpu_pct", "mem_used", "mem_total", "upload_speed", "download_speed", "cumulative_up", "cumulative_down"} {
		if _, exists := disabledSeries[key]; exists {
			t.Fatalf("disabled metric %q leaked from system series", key)
		}
	}

	for _, key := range []string{probeDisguiseMetricCPUKey, probeDisguiseMetricMemKey, probeDisguiseMetricSpeedKey, probeDisguiseMetricTrafficKey} {
		if err := repo.SetSystemSetting(ctx, key, "1"); err != nil {
			t.Fatalf("enable %s: %v", key, err)
		}
	}
	series := request()
	for _, key := range []string{"cpu_pct", "mem_used", "mem_total", "upload_speed", "download_speed", "cumulative_up", "cumulative_down"} {
		if _, exists := series[key]; !exists {
			t.Fatalf("enabled metric %q missing from system series", key)
		}
	}
}

func TestProbePublicTrafficSwitchHidesDailyLedger(t *testing.T) {
	repo, err := storage.NewTrafficRepository(filepath.Join(t.TempDir(), "probe-list.db"))
	if err != nil {
		t.Fatalf("NewTrafficRepository: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })

	ctx := context.Background()
	server := &storage.RemoteServer{Name: "probe-list-test", Token: "probe-list-token"}
	if err := repo.CreateRemoteServer(ctx, server); err != nil {
		t.Fatalf("CreateRemoteServer: %v", err)
	}
	ids, _ := json.Marshal([]int64{server.ID})
	for key, value := range map[string]string{
		probeDisguiseEnabledKey:       "1",
		probeDisguiseServerIDsKey:     string(ids),
		probeDisguiseMetricTrafficKey: "0",
	} {
		if err := repo.SetSystemSetting(ctx, key, value); err != nil {
			t.Fatalf("SetSystemSetting(%s): %v", key, err)
		}
	}
	// Establish a node-traffic baseline and then a real daily delta, so the
	// assertion covers populated ledger data rather than only an empty table.
	if err := repo.UpsertNodeTrafficBatch(ctx, server.ID, []storage.NodeTrafficItem{{Tag: "in", Type: "inbound", Uplink: 100, Downlink: 200}}, false); err != nil {
		t.Fatalf("traffic baseline: %v", err)
	}
	if err := repo.UpsertNodeTrafficBatch(ctx, server.ID, []storage.NodeTrafficItem{{Tag: "in", Type: "inbound", Uplink: 130, Downlink: 260}}, false); err != nil {
		t.Fatalf("traffic delta: %v", err)
	}

	handler := NewProbePublicHandler(repo, nil, nil)
	request := func() map[string]json.RawMessage {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/api/public/probe-servers", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
		}
		var payload struct {
			Servers []map[string]json.RawMessage `json:"servers"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if len(payload.Servers) != 1 {
			t.Fatalf("servers = %d, body = %s", len(payload.Servers), rec.Body.String())
		}
		return payload.Servers[0]
	}

	disabled := request()
	for _, key := range []string{"traffic_used", "traffic_limit", "cumulative_up", "cumulative_down", "daily_traffic"} {
		if _, exists := disabled[key]; exists {
			t.Fatalf("disabled traffic field %q leaked from public list", key)
		}
	}
	if err := repo.SetSystemSetting(ctx, probeDisguiseMetricTrafficKey, "1"); err != nil {
		t.Fatalf("enable traffic: %v", err)
	}
	enabled := request()
	for _, key := range []string{"traffic_used", "traffic_limit", "daily_traffic"} {
		if _, exists := enabled[key]; !exists {
			t.Fatalf("enabled traffic field %q missing from public list", key)
		}
	}
}
