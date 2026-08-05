package handler

import (
	"testing"

	"miaomiaowux/internal/storage"
)

func TestSubEmailBaselineFallsBackAsOneCycle(t *testing.T) {
	row := storage.UserEmailTraffic{ServerID: 7, Email: "tom__in", Uplink: 13, Downlink: 75}
	key := "7|tom__in"

	// Baseline is from the previous reset cycle. Both directions must retain
	// the current-cycle values; independently clamping them produced 0 B rows.
	got := subEmailBaseline(row, map[string]int64{key: 100}, map[string]int64{key: 200})
	if got.Uplink != 13 || got.Downlink != 75 {
		t.Fatalf("cross-cycle fallback=%d/%d want 13/75", got.Uplink, got.Downlink)
	}

	// A baseline in the same cycle is still subtracted normally.
	got = subEmailBaseline(row, map[string]int64{key: 3}, map[string]int64{key: 5})
	if got.Uplink != 10 || got.Downlink != 70 {
		t.Fatalf("same-cycle delta=%d/%d want 10/70", got.Uplink, got.Downlink)
	}
}
