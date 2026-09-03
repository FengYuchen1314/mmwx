package storage

import (
	"context"
	"fmt"
	"math"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// TestTrafficLedgerConcurrentMultiServerConservation simulates cumulative
// reports from many agents. Half the logical nodes represent routed exits and
// use different billing weights. Duplicate reports and a real Xray restart are
// included; neither may lose or double-book bytes.
func TestTrafficLedgerConcurrentMultiServerConservation(t *testing.T) {
	if testing.Short() {
		t.Skip("stress regression")
	}
	repo, err := NewTrafficRepository(filepath.Join(t.TempDir(), "traffic-stress.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	ctx := context.Background()
	const servers, users, rounds = 20, 24, 36
	serverIDs := make([]int64, servers)
	for s := 0; s < servers; s++ {
		res, err := repo.db.Exec(`INSERT INTO remote_servers(name,token,status,connection_mode,listen_port,pull_address,pull_port,pull_token) VALUES(?,?,'connected','push',0,'',0,'')`, fmt.Sprintf("stress-%d", s), fmt.Sprintf("token-%d", s))
		if err != nil {
			t.Fatal(err)
		}
		serverIDs[s], _ = res.LastInsertId()
	}
	type expected struct{ rawUp, rawDown, weightedUp, weightedDown, nodeUp, nodeDown float64 }
	wants := make([]expected, servers)
	var wg sync.WaitGroup
	errCh := make(chan error, servers)
	for s, serverID := range serverIDs {
		wg.Add(1)
		go func(s int, serverID int64) {
			defer wg.Done()
			cumUp, cumDown := make([]int64, users), make([]int64, users)
			build := func() []UserEmailTrafficUpsert {
				rows := make([]UserEmailTrafficUpsert, 0, users)
				for u := 0; u < users; u++ {
					nodeID := int64(1000 + s*100 + u%8)
					weight := []float64{1, 1.5, 2, 3}[u%4]
					rows = append(rows, UserEmailTrafficUpsert{Email: fmt.Sprintf("u%d__tag-%d", u, u%4), AttributedUsername: fmt.Sprintf("u%d", u), Uplink: cumUp[u], Downlink: cumDown[u], Weight: weight, NodeShares: []WeightedNodeShare{{NodeID: nodeID, RawShare: 1, Weight: weight}}})
				}
				return rows
			}
			// Establish cumulative baselines without importing pre-existing bytes.
			if err := repo.UpsertTrafficBatch(ctx, serverID, build(), nil, false); err != nil {
				errCh <- err
				return
			}
			var want expected
			for round := 1; round <= rounds; round++ {
				restarted := round == 19
				if restarted {
					for u := 0; u < users; u++ {
						cumUp[u] = 0
						cumDown[u] = 0
					}
				}
				var tickUp, tickDown int64
				for u := 0; u < users; u++ {
					du := int64(1000 + s*11 + u*7 + round)
					dd := du*3 + 17
					cumUp[u] += du
					cumDown[u] += dd
					tickUp += du
					tickDown += dd
					w := []float64{1, 1.5, 2, 3}[u%4]
					want.rawUp += float64(du)
					want.rawDown += float64(dd)
					want.weightedUp += float64(du) * w
					want.weightedDown += float64(dd) * w
				}
				if err := repo.UpsertTrafficBatch(ctx, serverID, build(), nil, restarted); err != nil {
					errCh <- err
					return
				}
				// The physical inbound and routed outbound see the same proxied bytes;
				// they are intentionally separate node counters.
				nodes := []NodeTrafficItem{{Tag: "in-main", Type: "inbound", Uplink: int64(want.nodeUp) + tickUp, Downlink: int64(want.nodeDown) + tickDown}, {Tag: "route-exit", Type: "outbound", Uplink: int64(want.nodeUp) + tickUp, Downlink: int64(want.nodeDown) + tickDown}}
				if round == 1 {
					if err := repo.UpsertNodeTrafficBatch(ctx, serverID, []NodeTrafficItem{{Tag: "in-main", Type: "inbound"}, {Tag: "route-exit", Type: "outbound"}}, false); err != nil {
						errCh <- err
						return
					}
				}
				want.nodeUp += float64(tickUp)
				want.nodeDown += float64(tickDown)
				if err := repo.UpsertNodeTrafficBatch(ctx, serverID, nodes, false); err != nil {
					errCh <- err
					return
				}
				if round%9 == 0 { // duplicate cumulative report must book zero
					if err := repo.UpsertTrafficBatch(ctx, serverID, build(), nil, false); err != nil {
						errCh <- err
						return
					}
					if err := repo.UpsertNodeTrafficBatch(ctx, serverID, nodes, false); err != nil {
						errCh <- err
						return
					}
				}
			}
			wants[s] = want
		}(s, serverID)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatal(err)
	}
	date := trafficLedgerDate(time.Now())
	for s, serverID := range serverIDs {
		want := wants[s]
		var emailRaw, emailWeighted, nodeRaw, nodeWeighted float64
		if err := repo.db.QueryRow(`SELECT COALESCE(SUM(uplink+downlink),0),COALESCE(SUM(weighted_uplink+weighted_downlink),0) FROM traffic_daily_user_emails WHERE server_id=? AND date=?`, serverID, date).Scan(&emailRaw, &emailWeighted); err != nil {
			t.Fatal(err)
		}
		if err := repo.db.QueryRow(`SELECT COALESCE(SUM(uplink+downlink),0),COALESCE(SUM(weighted_uplink+weighted_downlink),0) FROM traffic_daily_user_nodes WHERE server_id=? AND date=?`, serverID, date).Scan(&nodeRaw, &nodeWeighted); err != nil {
			t.Fatal(err)
		}
		assertNear := func(name string, got, want float64) {
			t.Helper()
			if math.Abs(got-want) > 0.01 {
				t.Fatalf("server=%d %s got=%.3f want=%.3f", s, name, got, want)
			}
		}
		assertNear("email raw", emailRaw, want.rawUp+want.rawDown)
		assertNear("user-node raw", nodeRaw, emailRaw)
		assertNear("email weighted", emailWeighted, want.weightedUp+want.weightedDown)
		assertNear("user-node weighted", nodeWeighted, emailWeighted)
		var inbound, outbound float64
		if err := repo.db.QueryRow(`SELECT COALESCE(SUM(CASE WHEN type='inbound' THEN uplink+downlink ELSE 0 END),0),COALESCE(SUM(CASE WHEN type='outbound' THEN uplink+downlink ELSE 0 END),0) FROM traffic_daily_nodes WHERE server_id=? AND date=?`, serverID, date).Scan(&inbound, &outbound); err != nil {
			t.Fatal(err)
		}
		assertNear("inbound", inbound, want.nodeUp+want.nodeDown)
		assertNear("outbound", outbound, inbound)
	}
}
