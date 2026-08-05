package storage

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBackfillDailyTrafficLedgerFromSnapshots(t *testing.T) {
	repo, err := NewTrafficRepository(filepath.Join(t.TempDir(), "legacy-backfill.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	ctx := context.Background()
	result, err := repo.db.Exec(`INSERT INTO remote_servers(name,token,status,connection_mode,listen_port,pull_address,pull_port,pull_token) VALUES('legacy','token','connected','push',0,'',0,'')`)
	if err != nil {
		t.Fatal(err)
	}
	serverID, _ := result.LastInsertId()

	for _, row := range []struct {
		date     string
		nodeUp   int64
		nodeDown int64
		userUp   int64
		userDown int64
		systemUp int64
		systemDn int64
	}{
		{"2026-07-30", 100, 200, 50, 80, 1000, 2000},
		{"2026-07-31", 130, 260, 70, 110, 1400, 2300},
		{"2026-08-01", 180, 300, 95, 150, 1900, 2700},
	} {
		if _, err := repo.db.Exec(`INSERT INTO node_traffic_snapshots(server_id,tag,type,date,uplink,downlink) VALUES(?,?,?,?,?,?)`, serverID, "in", "inbound", row.date, row.nodeUp, row.nodeDown); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.db.Exec(`INSERT INTO user_traffic_snapshots(server_id,username,date,uplink,downlink) VALUES(?,?,?,?,?)`, serverID, "alice", row.date, row.userUp, row.userDown); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.db.Exec(`INSERT INTO user_email_traffic_snapshots(server_id,email,date,uplink,downlink) VALUES(?,?,?,?,?)`, serverID, "alice__in", row.date, row.userUp, row.userDown); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.db.Exec(`INSERT INTO server_system_traffic_snapshots(server_id,date,rx_cycle,tx_cycle) VALUES(?,?,?,?)`, serverID, row.date, row.systemDn, row.systemUp); err != nil {
			t.Fatal(err)
		}
	}
	// A reset in one direction is not guessed. The still-monotonic direction is
	// retained, and the date is explicitly marked incomplete.
	if _, err := repo.db.Exec(`INSERT INTO node_traffic_snapshots(server_id,tag,type,date,uplink,downlink) VALUES(?,?,?,?,?,?),(?,?,?,?,?,?)`,
		serverID, "reset", "inbound", "2026-07-30", 100, 10,
		serverID, "reset", "inbound", "2026-07-31", 20, 30); err != nil {
		t.Fatal(err)
	}
	// Legacy snapshot tables did not consistently enforce their server foreign
	// key. Deleted servers may therefore leave rows behind; PostgreSQL's new
	// ledger does enforce it, so these rows must be ignored atomically.
	if _, err := repo.db.Exec(`INSERT INTO node_traffic_snapshots(server_id,tag,type,date,uplink,downlink) VALUES(999999,'orphan','inbound','2026-07-30',1,2),(999999,'orphan','inbound','2026-07-31',3,5)`); err != nil {
		t.Fatal(err)
	}

	got, err := repo.BackfillDailyTrafficLedgerFromSnapshots(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.NodeRows != 3 || got.UserRows != 2 || got.EmailRows != 2 || got.SystemRows != 2 || got.IncompleteDates < 1 {
		t.Fatalf("unexpected result: %+v", got)
	}
	var up, down int64
	if err := repo.db.QueryRow(`SELECT uplink,downlink FROM traffic_daily_nodes WHERE server_id=? AND tag='in' AND type='inbound' AND date='2026-07-30'`, serverID).Scan(&up, &down); err != nil {
		t.Fatal(err)
	}
	if up != 30 || down != 60 {
		t.Fatalf("first node day=%d/%d want 30/60", up, down)
	}
	if err := repo.db.QueryRow(`SELECT uplink,downlink FROM traffic_daily_system_servers WHERE server_id=? AND date='2026-07-31'`, serverID).Scan(&up, &down); err != nil {
		t.Fatal(err)
	}
	if up != 500 || down != 400 {
		t.Fatalf("second system day=%d/%d want 500/400", up, down)
	}
	if err := repo.db.QueryRow(`SELECT uplink,downlink FROM traffic_daily_user_emails WHERE server_id=? AND email='alice__in' AND date='2026-07-31'`, serverID).Scan(&up, &down); err != nil {
		t.Fatal(err)
	}
	if up != 25 || down != 40 {
		t.Fatalf("second email day=%d/%d want 25/40", up, down)
	}
	var reason string
	if err := repo.db.QueryRow(`SELECT reason FROM traffic_daily_incomplete_dates WHERE date='2026-07-30'`).Scan(&reason); err != nil {
		t.Fatal(err)
	}

	second, err := repo.BackfillDailyTrafficLedgerFromSnapshots(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !second.AlreadyDone {
		t.Fatalf("second run was not idempotent: %+v", second)
	}
	if err := repo.db.QueryRow(`SELECT uplink,downlink FROM traffic_daily_nodes WHERE server_id=? AND tag='in' AND date='2026-07-30'`, serverID).Scan(&up, &down); err != nil {
		t.Fatal(err)
	}
	if up != 30 || down != 60 {
		t.Fatalf("idempotent rerun changed node day=%d/%d", up, down)
	}
	var orphanRows int
	if err := repo.db.QueryRow(`SELECT COUNT(*) FROM traffic_daily_nodes WHERE server_id=999999`).Scan(&orphanRows); err != nil {
		t.Fatal(err)
	}
	if orphanRows != 0 {
		t.Fatalf("migrated %d orphan snapshot rows", orphanRows)
	}
}

func TestLegacySnapshotDeltaRejectsGaps(t *testing.T) {
	_, incomplete, err := legacySnapshotDelta("2026-07-30", "2026-08-01", 10, 20, 30, 40)
	if err != nil {
		t.Fatal(err)
	}
	if !incomplete {
		t.Fatal("two-day snapshot gap must be incomplete")
	}
}

func TestBackfillReconcilesUpgradeDayWithoutDoubleCounting(t *testing.T) {
	repo, err := NewTrafficRepository(filepath.Join(t.TempDir(), "cutoff-backfill.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	result, err := repo.db.Exec(`INSERT INTO remote_servers(name,token,status,connection_mode,listen_port,pull_address,pull_port,pull_token) VALUES('cutoff','cutoff-token','connected','push',0,'',0,'')`)
	if err != nil {
		t.Fatal(err)
	}
	serverID, _ := result.LastInsertId()
	today := trafficLedgerDate(time.Now())
	yesterday := trafficLedgerDate(time.Now().AddDate(0, 0, -1))
	if _, err := repo.db.Exec(`INSERT INTO node_traffic_snapshots(server_id,tag,type,date,uplink,downlink) VALUES(?,?,?,?,?,?),(?,?,?,?,?,?)`, serverID, "in", "inbound", yesterday, 100, 200, serverID, "in", "inbound", today, 130, 250); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.db.Exec(`INSERT INTO node_traffic(server_id,tag,type,uplink,downlink,last_uplink,last_downlink) VALUES(?,?,?,?,?,?,?)`, serverID, "in", "inbound", 160, 300, 160, 300); err != nil {
		t.Fatal(err)
	}
	// Ten/twenty bytes were already observed after startup. Cutoff catch-up must
	// add only 20/30, not the whole 30/50 since midnight.
	if _, err := repo.db.Exec(`INSERT INTO traffic_daily_nodes(server_id,tag,type,date,uplink,downlink) VALUES(?,?,?,?,?,?)`, serverID, "in", "inbound", today, 10, 20); err != nil {
		t.Fatal(err)
	}
	got, err := repo.BackfillDailyTrafficLedgerFromSnapshots(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.IncompleteDates != 0 {
		t.Fatalf("cutoff unexpectedly incomplete: %+v", got)
	}
	var up, down int64
	if err := repo.db.QueryRow(`SELECT uplink,downlink FROM traffic_daily_nodes WHERE server_id=? AND tag='in' AND date=?`, serverID, today).Scan(&up, &down); err != nil {
		t.Fatal(err)
	}
	if up != 30 || down != 50 {
		t.Fatalf("cutoff total=%d/%d want 30/50", up, down)
	}
	if !repo.DailyTrafficLedgerComplete(context.Background(), yesterday) {
		t.Fatal("backfilled range was not advertised as complete")
	}
}

func TestSafeSystemSnapshotBackfillPreservesMigratedTraffic(t *testing.T) {
	repo, err := NewTrafficRepository(filepath.Join(t.TempDir(), "safe-system-backfill.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	result, err := repo.db.Exec(`INSERT INTO remote_servers(name,token,status,connection_mode,traffic_source,traffic_stats_mode,system_rx_cycle,system_tx_cycle,system_last_seen_rx,system_last_seen_tx,system_boot_time_unix,traffic_used_offset) VALUES('safe','safe-token','connected','push','system','both',9000,7000,19000,17000,12345,-4000)`)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := result.LastInsertId()
	if _, err := repo.db.Exec(`INSERT INTO node_traffic_snapshots(server_id,tag,type,date,uplink,downlink) VALUES(?,?,?,?,?,?),(?,?,?,?,?,?)`, id, "in", "inbound", "2026-08-01", 100, 200, id, "in", "inbound", "2026-08-02", 150, 260); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.db.Exec(`INSERT INTO server_system_traffic_snapshots(server_id,date,rx_cycle,tx_cycle) VALUES(?,?,?,?)`, id, "2026-08-01", 888, 777); err != nil {
		t.Fatal(err)
	}
	inserted, err := repo.BackfillMissingServerSystemTrafficSnapshots(context.Background(), id)
	if err != nil || inserted != 1 {
		t.Fatalf("inserted=%d err=%v", inserted, err)
	}
	var rx, tx, lastRx, lastTx, boot, offset int64
	if err := repo.db.QueryRow(`SELECT system_rx_cycle,system_tx_cycle,system_last_seen_rx,system_last_seen_tx,system_boot_time_unix,traffic_used_offset FROM remote_servers WHERE id=?`, id).Scan(&rx, &tx, &lastRx, &lastTx, &boot, &offset); err != nil {
		t.Fatal(err)
	}
	if rx != 9000 || tx != 7000 || lastRx != 19000 || lastTx != 17000 || boot != 12345 || offset != -4000 {
		t.Fatalf("live state changed: %d/%d %d/%d boot=%d offset=%d", rx, tx, lastRx, lastTx, boot, offset)
	}
	var snapRx, snapTx int64
	if err := repo.db.QueryRow(`SELECT rx_cycle,tx_cycle FROM server_system_traffic_snapshots WHERE server_id=? AND date='2026-08-01'`, id).Scan(&snapRx, &snapTx); err != nil {
		t.Fatal(err)
	}
	if snapRx != 888 || snapTx != 777 {
		t.Fatalf("existing snapshot overwritten: %d/%d", snapRx, snapTx)
	}
	if err := repo.db.QueryRow(`SELECT rx_cycle,tx_cycle FROM server_system_traffic_snapshots WHERE server_id=? AND date='2026-08-02'`, id).Scan(&snapRx, &snapTx); err != nil {
		t.Fatal(err)
	}
	if snapRx != 260 || snapTx != 150 {
		t.Fatalf("missing snapshot=%d/%d", snapRx, snapTx)
	}
}

func TestBackfillDailyTrafficLedgerPostgres(t *testing.T) {
	database := os.Getenv("MMWX_TEST_POSTGRES_DATABASE")
	if database == "" {
		t.Skip("MMWX_TEST_POSTGRES_DATABASE is not set")
	}
	repo, err := NewTrafficRepositoryFromConfig(DatabaseConfig{
		Driver: "postgres", Host: os.Getenv("MMWX_TEST_POSTGRES_HOST"), Port: 5432,
		Database: database, Username: "mmwx", Password: "mmwx-loadtest", SSLMode: "disable",
		MaxOpenConns: 10, MaxIdleConns: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	result, err := repo.db.Exec(`INSERT INTO remote_servers(name,token,status,connection_mode,listen_port,pull_address,pull_port,pull_token) VALUES('pg-legacy','pg-token','connected','push',0,'',0,'')`)
	if err != nil {
		t.Fatal(err)
	}
	serverID, _ := result.LastInsertId()
	for _, value := range []struct {
		date string
		up   int64
		down int64
	}{{"2026-07-29", 100, 200}, {"2026-07-30", 145, 275}} {
		if _, err := repo.db.Exec(`INSERT INTO node_traffic_snapshots(server_id,tag,type,date,uplink,downlink) VALUES(?,?,?,?,?,?)`, serverID, "pg-in", "inbound", value.date, value.up, value.down); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := repo.db.Exec(`INSERT INTO node_traffic_snapshots(server_id,tag,type,date,uplink,downlink) VALUES(999999,'pg-orphan','inbound','2026-07-29',1,1),(999999,'pg-orphan','inbound','2026-07-30',2,2)`); err != nil {
		t.Fatal(err)
	}
	backfill, err := repo.BackfillDailyTrafficLedgerFromSnapshots(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if backfill.NodeRows != 1 {
		t.Fatalf("postgres backfill result: %+v", backfill)
	}
	var up, down int64
	if err := repo.db.QueryRow(`SELECT uplink,downlink FROM traffic_daily_nodes WHERE server_id=? AND tag='pg-in' AND date='2026-07-29'`, serverID).Scan(&up, &down); err != nil {
		t.Fatal(err)
	}
	if up != 45 || down != 75 {
		t.Fatalf("postgres historical delta=%d/%d want 45/75", up, down)
	}
}
