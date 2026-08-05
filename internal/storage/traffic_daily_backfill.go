package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

const trafficDailyBackfillMetaKey = "legacy_snapshot_backfill_v1"

// TrafficDailyBackfillResult describes the one-time conversion from the old
// midnight cumulative snapshots to ingestion-time daily delta buckets.
type TrafficDailyBackfillResult struct {
	AlreadyDone        bool  `json:"already_done"`
	NodeRows           int64 `json:"node_rows"`
	UserRows           int64 `json:"user_rows"`
	EmailRows          int64 `json:"email_rows"`
	UserNodeRows       int64 `json:"user_node_rows"`
	SystemRows         int64 `json:"system_rows"`
	IncompleteDates    int64 `json:"incomplete_dates"`
	ApproxWeightedRows int64 `json:"approx_weighted_rows"`
}

func (v TrafficDailyBackfillResult) String() string {
	return fmt.Sprintf("already_done=%t nodes=%d users=%d emails=%d user_nodes=%d system=%d approximate_weighted=%d incomplete_dates=%d",
		v.AlreadyDone, v.NodeRows, v.UserRows, v.EmailRows, v.UserNodeRows, v.SystemRows, v.ApproxWeightedRows, v.IncompleteDates)
}

type legacyDeltaKey struct {
	serverID int64
	name     string
	typ      string
	date     string
}

type legacyDelta struct {
	up, down int64
}

type legacyEmailDelta struct {
	serverID int64
	email    string
	date     string
	up, down int64
}

type legacyUserNodeKey struct {
	serverID int64
	nodeID   int64
	username string
	date     string
}

type legacyUserNodeDelta struct {
	up, down, weightedUp, weightedDown float64
}

func legacySnapshotDay(value string) (time.Time, error) {
	day, err := time.ParseInLocation("2006-01-02", value, time.Local)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid legacy snapshot date %q: %w", value, err)
	}
	return day, nil
}

// legacySnapshotDelta converts two consecutive midnight cumulative values to
// the traffic that occurred on the first date. A counter decrease means a
// reset happened somewhere in the interval; that direction is unknowable and
// is deliberately omitted instead of inventing traffic.
func legacySnapshotDelta(previousDate, currentDate string, previousUp, previousDown, currentUp, currentDown int64) (legacyDelta, bool, error) {
	previousDay, err := legacySnapshotDay(previousDate)
	if err != nil {
		return legacyDelta{}, false, err
	}
	currentDay, err := legacySnapshotDay(currentDate)
	if err != nil {
		return legacyDelta{}, false, err
	}
	if !currentDay.Equal(previousDay.AddDate(0, 0, 1)) {
		return legacyDelta{}, true, nil
	}
	result := legacyDelta{}
	incomplete := false
	if currentUp >= previousUp {
		result.up = currentUp - previousUp
	} else {
		incomplete = true
	}
	if currentDown >= previousDown {
		result.down = currentDown - previousDown
	} else {
		incomplete = true
	}
	return result, incomplete, nil
}

// BackfillDailyTrafficLedgerFromSnapshots migrates every complete historical
// day before the live ledger's first day. It is transactional and idempotent:
// live rows win on conflict and the completion marker is committed together
// with all generated rows.
func (r *TrafficRepository) BackfillDailyTrafficLedgerFromSnapshots(ctx context.Context) (TrafficDailyBackfillResult, error) {
	if r == nil || r.db == nil {
		return TrafficDailyBackfillResult{}, fmt.Errorf("traffic repository not initialized")
	}
	var existing string
	if err := r.db.QueryRowContext(ctx, `SELECT value FROM traffic_daily_meta WHERE key=?`, trafficDailyBackfillMetaKey).Scan(&existing); err == nil {
		return TrafficDailyBackfillResult{AlreadyDone: true}, nil
	} else if err != sql.ErrNoRows {
		return TrafficDailyBackfillResult{}, fmt.Errorf("read legacy backfill marker: %w", err)
	}
	var startedRaw string
	if err := r.db.QueryRowContext(ctx, `SELECT value FROM traffic_daily_meta WHERE key='started_at'`).Scan(&startedRaw); err != nil {
		return TrafficDailyBackfillResult{}, fmt.Errorf("read daily ledger start: %w", err)
	}
	started, err := time.Parse(time.RFC3339, startedRaw)
	if err != nil {
		return TrafficDailyBackfillResult{}, fmt.Errorf("parse daily ledger start: %w", err)
	}
	cutoff := trafficLedgerDate(started)
	incomplete := map[string]string{}
	markIncomplete := func(date, reason string) { incomplete[date] = reason }

	nodes := map[legacyDeltaKey]legacyDelta{}
	if err := r.collectLegacyNodeDeltas(ctx, cutoff, nodes, markIncomplete); err != nil {
		return TrafficDailyBackfillResult{}, err
	}
	users := map[legacyDeltaKey]legacyDelta{}
	if err := r.collectLegacyUserDeltas(ctx, cutoff, users, markIncomplete); err != nil {
		return TrafficDailyBackfillResult{}, err
	}
	emails, err := r.collectLegacyEmailDeltas(ctx, cutoff, markIncomplete)
	if err != nil {
		return TrafficDailyBackfillResult{}, err
	}
	systems := map[legacyDeltaKey]legacyDelta{}
	if err := r.collectLegacySystemDeltas(ctx, cutoff, systems, markIncomplete); err != nil {
		return TrafficDailyBackfillResult{}, err
	}

	attr, err := r.BuildEmailAttributor(ctx)
	if err != nil {
		return TrafficDailyBackfillResult{}, fmt.Errorf("build historical email attribution: %w", err)
	}
	earliest := ""
	considerDate := func(date string) {
		if date != "" && (earliest == "" || date < earliest) {
			earliest = date
		}
	}
	for key := range nodes {
		considerDate(key.date)
	}
	for key := range users {
		considerDate(key.date)
	}
	for _, value := range emails {
		considerDate(value.date)
	}
	for key := range systems {
		considerDate(key.date)
	}
	userNodes := map[legacyUserNodeKey]legacyUserNodeDelta{}
	type attributedEmail struct {
		legacyEmailDelta
		username string
		weight   float64
	}
	attributedEmails := make([]attributedEmail, 0, len(emails))
	for _, email := range emails {
		attribution, shares, weight := attr.BillingAttribution(email.email, email.serverID)
		attributedEmails = append(attributedEmails, attributedEmail{legacyEmailDelta: email, username: attribution.Username, weight: weight})
		if attribution.Username == "" {
			continue
		}
		if len(shares) == 0 {
			shares = []WeightedNodeShare{{NodeID: 0, RawShare: 1, Weight: weight}}
		}
		for _, share := range shares {
			key := legacyUserNodeKey{serverID: email.serverID, nodeID: share.NodeID, username: attribution.Username, date: email.date}
			value := userNodes[key]
			value.up += float64(email.up) * share.RawShare
			value.down += float64(email.down) * share.RawShare
			value.weightedUp += float64(email.up) * share.Weight
			value.weightedDown += float64(email.down) * share.Weight
			userNodes[key] = value
		}
	}

	// READ COMMITTED is intentional. Collectors update the cumulative counter
	// and today's ledger in one transaction, so (current - midnight snapshot -
	// already booked) is invariant before and after a concurrent report.
	// PostgreSQL SERIALIZABLE aborted this long backfill indefinitely on active
	// installations with SQLSTATE 40001, preventing any history from migrating.
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return TrafficDailyBackfillResult{}, fmt.Errorf("begin legacy traffic backfill: %w", err)
	}
	defer tx.Rollback()
	result := TrafficDailyBackfillResult{IncompleteDates: int64(len(incomplete)), ApproxWeightedRows: int64(len(attributedEmails))}
	// Dates before started_at can never contain ingestion-time rows from this
	// installation. Clear any abandoned/manual partial backfill first so the
	// snapshot conversion is the sole authority for that historical interval.
	for _, table := range []string{"traffic_daily_nodes", "traffic_daily_users", "traffic_daily_user_emails", "traffic_daily_user_nodes", "traffic_daily_system_servers"} {
		if _, deleteErr := tx.ExecContext(ctx, `DELETE FROM `+table+` WHERE date<?`, cutoff); deleteErr != nil {
			return result, fmt.Errorf("clear partial historical ledger %s: %w", table, deleteErr)
		}
	}
	for key, value := range nodes {
		res, execErr := tx.ExecContext(ctx, `INSERT INTO traffic_daily_nodes(server_id,tag,type,date,uplink,downlink) VALUES(?,?,?,?,?,?) ON CONFLICT(server_id,tag,type,date) DO UPDATE SET uplink=excluded.uplink,downlink=excluded.downlink,updated_at=CURRENT_TIMESTAMP`, key.serverID, key.name, key.typ, key.date, value.up, value.down)
		if execErr != nil {
			return result, fmt.Errorf("insert historical node ledger: %w", execErr)
		}
		result.NodeRows += rowsAffected(res)
	}
	for key, value := range users {
		res, execErr := tx.ExecContext(ctx, `INSERT INTO traffic_daily_users(server_id,username,date,uplink,downlink) VALUES(?,?,?,?,?) ON CONFLICT(server_id,username,date) DO UPDATE SET uplink=excluded.uplink,downlink=excluded.downlink,updated_at=CURRENT_TIMESTAMP`, key.serverID, key.name, key.date, value.up, value.down)
		if execErr != nil {
			return result, fmt.Errorf("insert historical user ledger: %w", execErr)
		}
		result.UserRows += rowsAffected(res)
	}
	for _, email := range attributedEmails {
		res, execErr := tx.ExecContext(ctx, `INSERT INTO traffic_daily_user_emails(server_id,email,attributed_username,date,uplink,downlink,weighted_uplink,weighted_downlink) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(server_id,email,attributed_username,date) DO UPDATE SET uplink=excluded.uplink,downlink=excluded.downlink,weighted_uplink=excluded.weighted_uplink,weighted_downlink=excluded.weighted_downlink,updated_at=CURRENT_TIMESTAMP`, email.serverID, email.email, email.username, email.date, email.up, email.down, float64(email.up)*email.weight, float64(email.down)*email.weight)
		if execErr != nil {
			return result, fmt.Errorf("insert historical email ledger: %w", execErr)
		}
		result.EmailRows += rowsAffected(res)
	}
	for key, value := range userNodes {
		res, execErr := tx.ExecContext(ctx, `INSERT INTO traffic_daily_user_nodes(server_id,node_id,username,date,uplink,downlink,weighted_uplink,weighted_downlink) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(server_id,node_id,username,date) DO UPDATE SET uplink=excluded.uplink,downlink=excluded.downlink,weighted_uplink=excluded.weighted_uplink,weighted_downlink=excluded.weighted_downlink,updated_at=CURRENT_TIMESTAMP`, key.serverID, key.nodeID, key.username, key.date, value.up, value.down, value.weightedUp, value.weightedDown)
		if execErr != nil {
			return result, fmt.Errorf("insert historical user-node ledger: %w", execErr)
		}
		result.UserNodeRows += rowsAffected(res)
	}
	for key, value := range systems {
		res, execErr := tx.ExecContext(ctx, `INSERT INTO traffic_daily_system_servers(server_id,date,uplink,downlink) VALUES(?,?,?,?) ON CONFLICT(server_id,date) DO UPDATE SET uplink=excluded.uplink,downlink=excluded.downlink,updated_at=CURRENT_TIMESTAMP`, key.serverID, key.date, value.up, value.down)
		if execErr != nil {
			return result, fmt.Errorf("insert historical system ledger: %w", execErr)
		}
		result.SystemRows += rowsAffected(res)
	}
	// Reconcile the upgrade day too. The live ledger may already contain a few
	// post-start deltas; subtract those before adding the pre-start remainder so
	// concurrent startup reports cannot be counted twice.
	catchupNodes, catchupUsers, catchupSystems, catchupEmails, catchupUserNodes, catchupApprox, catchupIncomplete, catchupErr := r.backfillLedgerCutoffDay(ctx, tx, attr, cutoff)
	if catchupErr != nil {
		return result, catchupErr
	}
	result.NodeRows += catchupNodes
	result.UserRows += catchupUsers
	result.SystemRows += catchupSystems
	result.EmailRows += catchupEmails
	result.UserNodeRows += catchupUserNodes
	result.ApproxWeightedRows += catchupApprox
	if catchupIncomplete {
		incomplete[cutoff] = "legacy cutoff snapshot is greater than the current cumulative counter"
	}
	latestHistorical := ""
	considerLatest := func(date string) {
		if date != "" && date > latestHistorical {
			latestHistorical = date
		}
	}
	for key := range nodes {
		considerLatest(key.date)
	}
	for key := range users {
		considerLatest(key.date)
	}
	for _, value := range emails {
		considerLatest(value.date)
	}
	for key := range systems {
		considerLatest(key.date)
	}
	if latestHistorical != "" {
		lastDay, parseErr := legacySnapshotDay(latestHistorical)
		if parseErr != nil {
			return result, parseErr
		}
		cutoffDay, parseErr := legacySnapshotDay(cutoff)
		if parseErr != nil {
			return result, parseErr
		}
		for day := lastDay.AddDate(0, 0, 1); day.Before(cutoffDay); day = day.AddDate(0, 0, 1) {
			incomplete[trafficLedgerDate(day)] = "legacy snapshots do not cover this date"
		}
	}
	if catchupNodes+catchupUsers+catchupSystems+catchupEmails == 0 {
		var serverCount int64
		if queryErr := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM remote_servers`).Scan(&serverCount); queryErr != nil {
			return result, queryErr
		}
		if serverCount > 0 {
			incomplete[cutoff] = "no cutoff snapshot is available to reconcile the upgrade day"
		}
	}
	considerDate(cutoff)
	result.IncompleteDates = int64(len(incomplete))
	for date, reason := range incomplete {
		if _, execErr := tx.ExecContext(ctx, `INSERT INTO traffic_daily_incomplete_dates(date,reason) VALUES(?,?) ON CONFLICT(date) DO UPDATE SET reason=excluded.reason`, date, reason); execErr != nil {
			return result, fmt.Errorf("mark incomplete historical date: %w", execErr)
		}
	}
	payload, _ := json.Marshal(result)
	if earliest != "" {
		if _, err := tx.ExecContext(ctx, `INSERT INTO traffic_daily_meta(key,value) VALUES('legacy_snapshot_backfill_start_date',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`, earliest); err != nil {
			return result, fmt.Errorf("write legacy backfill coverage: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO traffic_daily_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`, trafficDailyBackfillMetaKey, string(payload)); err != nil {
		return result, fmt.Errorf("write legacy backfill marker: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return result, fmt.Errorf("commit legacy traffic backfill: %w", err)
	}
	return result, nil
}

func (r *TrafficRepository) backfillLedgerCutoffDay(ctx context.Context, tx *dialectTx, attr *EmailAttributor, date string) (nodeRows, userRows, systemRows, emailRows, userNodeRows, approximateRows int64, incomplete bool, err error) {
	statements := []struct {
		name  string
		query string
		dst   *int64
	}{
		{"node", `INSERT INTO traffic_daily_nodes(server_id,tag,type,date,uplink,downlink)
SELECT n.server_id,n.tag,n.type,?,MAX(n.uplink-s.uplink-COALESCE(d.uplink,0),0),MAX(n.downlink-s.downlink-COALESCE(d.downlink,0),0)
FROM node_traffic n JOIN node_traffic_snapshots s ON s.server_id=n.server_id AND s.tag=n.tag AND s.type=n.type AND s.date=?
LEFT JOIN traffic_daily_nodes d ON d.server_id=n.server_id AND d.tag=n.tag AND d.type=n.type AND d.date=?
ON CONFLICT(server_id,tag,type,date) DO UPDATE SET uplink=traffic_daily_nodes.uplink+excluded.uplink,downlink=traffic_daily_nodes.downlink+excluded.downlink,updated_at=CURRENT_TIMESTAMP`, &nodeRows},
		{"user", `INSERT INTO traffic_daily_users(server_id,username,date,uplink,downlink)
SELECT u.server_id,u.username,?,MAX(u.uplink-s.uplink-COALESCE(d.uplink,0),0),MAX(u.downlink-s.downlink-COALESCE(d.downlink,0),0)
FROM user_traffic u JOIN user_traffic_snapshots s ON s.server_id=u.server_id AND s.username=u.username AND s.date=?
LEFT JOIN traffic_daily_users d ON d.server_id=u.server_id AND d.username=u.username AND d.date=?
ON CONFLICT(server_id,username,date) DO UPDATE SET uplink=traffic_daily_users.uplink+excluded.uplink,downlink=traffic_daily_users.downlink+excluded.downlink,updated_at=CURRENT_TIMESTAMP`, &userRows},
		{"system", `INSERT INTO traffic_daily_system_servers(server_id,date,uplink,downlink)
SELECT r.id,?,MAX(r.system_tx_cycle-s.tx_cycle-COALESCE(d.uplink,0),0),MAX(r.system_rx_cycle-s.rx_cycle-COALESCE(d.downlink,0),0)
FROM remote_servers r JOIN server_system_traffic_snapshots s ON s.server_id=r.id AND s.date=?
LEFT JOIN traffic_daily_system_servers d ON d.server_id=r.id AND d.date=?
ON CONFLICT(server_id,date) DO UPDATE SET uplink=traffic_daily_system_servers.uplink+excluded.uplink,downlink=traffic_daily_system_servers.downlink+excluded.downlink,updated_at=CURRENT_TIMESTAMP`, &systemRows},
	}
	for _, statement := range statements {
		result, execErr := tx.ExecContext(ctx, statement.query, date, date, date)
		if execErr != nil {
			return 0, 0, 0, 0, 0, 0, false, fmt.Errorf("backfill cutoff %s traffic: %w", statement.name, execErr)
		}
		*statement.dst += rowsAffected(result)
	}
	for _, query := range []string{
		`SELECT COUNT(*) FROM node_traffic n JOIN node_traffic_snapshots s ON s.server_id=n.server_id AND s.tag=n.tag AND s.type=n.type AND s.date=? WHERE n.uplink<s.uplink OR n.downlink<s.downlink`,
		`SELECT COUNT(*) FROM user_traffic u JOIN user_traffic_snapshots s ON s.server_id=u.server_id AND s.username=u.username AND s.date=? WHERE u.uplink<s.uplink OR u.downlink<s.downlink`,
		`SELECT COUNT(*) FROM remote_servers r JOIN server_system_traffic_snapshots s ON s.server_id=r.id AND s.date=? WHERE r.system_tx_cycle<s.tx_cycle OR r.system_rx_cycle<s.rx_cycle`,
	} {
		var count int64
		if queryErr := tx.QueryRowContext(ctx, query, date).Scan(&count); queryErr != nil {
			return 0, 0, 0, 0, 0, 0, false, queryErr
		}
		incomplete = incomplete || count > 0
	}

	rows, queryErr := tx.QueryContext(ctx, `SELECT e.server_id,e.email,
MAX(e.uplink-s.uplink-COALESCE((SELECT SUM(d.uplink) FROM traffic_daily_user_emails d WHERE d.server_id=e.server_id AND d.email=e.email AND d.date=?),0),0),
MAX(e.downlink-s.downlink-COALESCE((SELECT SUM(d.downlink) FROM traffic_daily_user_emails d WHERE d.server_id=e.server_id AND d.email=e.email AND d.date=?),0),0),
CASE WHEN e.uplink<s.uplink OR e.downlink<s.downlink THEN 1 ELSE 0 END
FROM user_email_traffic e JOIN user_email_traffic_snapshots s ON s.server_id=e.server_id AND s.email=e.email AND s.date=?`, date, date, date)
	if queryErr != nil {
		return 0, 0, 0, 0, 0, 0, false, fmt.Errorf("read cutoff email traffic: %w", queryErr)
	}
	type missingEmail struct {
		serverID int64
		email    string
		up, down int64
		reset    int64
	}
	var missing []missingEmail
	for rows.Next() {
		var value missingEmail
		if scanErr := rows.Scan(&value.serverID, &value.email, &value.up, &value.down, &value.reset); scanErr != nil {
			rows.Close()
			return 0, 0, 0, 0, 0, 0, false, scanErr
		}
		missing = append(missing, value)
	}
	if rowsErr := rows.Err(); rowsErr != nil {
		rows.Close()
		return 0, 0, 0, 0, 0, 0, false, rowsErr
	}
	rows.Close()
	for _, value := range missing {
		if value.reset != 0 {
			incomplete = true
		}
		if value.up == 0 && value.down == 0 {
			continue
		}
		attribution, shares, weight := attr.BillingAttribution(value.email, value.serverID)
		result, execErr := tx.ExecContext(ctx, `INSERT INTO traffic_daily_user_emails(server_id,email,attributed_username,date,uplink,downlink,weighted_uplink,weighted_downlink) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(server_id,email,attributed_username,date) DO UPDATE SET uplink=traffic_daily_user_emails.uplink+excluded.uplink,downlink=traffic_daily_user_emails.downlink+excluded.downlink,weighted_uplink=traffic_daily_user_emails.weighted_uplink+excluded.weighted_uplink,weighted_downlink=traffic_daily_user_emails.weighted_downlink+excluded.weighted_downlink,updated_at=CURRENT_TIMESTAMP`, value.serverID, value.email, attribution.Username, date, value.up, value.down, float64(value.up)*weight, float64(value.down)*weight)
		if execErr != nil {
			return 0, 0, 0, 0, 0, 0, false, fmt.Errorf("insert cutoff email traffic: %w", execErr)
		}
		emailRows += rowsAffected(result)
		approximateRows++
		if attribution.Username == "" {
			continue
		}
		if len(shares) == 0 {
			shares = []WeightedNodeShare{{NodeID: 0, RawShare: 1, Weight: weight}}
		}
		for _, share := range shares {
			result, execErr = tx.ExecContext(ctx, `INSERT INTO traffic_daily_user_nodes(server_id,node_id,username,date,uplink,downlink,weighted_uplink,weighted_downlink) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(server_id,node_id,username,date) DO UPDATE SET uplink=traffic_daily_user_nodes.uplink+excluded.uplink,downlink=traffic_daily_user_nodes.downlink+excluded.downlink,weighted_uplink=traffic_daily_user_nodes.weighted_uplink+excluded.weighted_uplink,weighted_downlink=traffic_daily_user_nodes.weighted_downlink+excluded.weighted_downlink,updated_at=CURRENT_TIMESTAMP`, value.serverID, share.NodeID, attribution.Username, date, float64(value.up)*share.RawShare, float64(value.down)*share.RawShare, float64(value.up)*share.Weight, float64(value.down)*share.Weight)
			if execErr != nil {
				return 0, 0, 0, 0, 0, 0, false, fmt.Errorf("insert cutoff user-node traffic: %w", execErr)
			}
			userNodeRows += rowsAffected(result)
		}
	}
	return
}

func rowsAffected(result sql.Result) int64 { n, _ := result.RowsAffected(); return n }

func collectPair(date, nextDate string, up, down, nextUp, nextDown int64, cutoff string, mark func(string, string)) (legacyDelta, bool, error) {
	if date >= cutoff {
		return legacyDelta{}, false, nil
	}
	delta, bad, err := legacySnapshotDelta(date, nextDate, up, down, nextUp, nextDown)
	if err != nil {
		return legacyDelta{}, false, err
	}
	if bad {
		start, startErr := legacySnapshotDay(date)
		end, endErr := legacySnapshotDay(nextDate)
		if startErr == nil && endErr == nil && end.After(start) {
			for day := start; day.Before(end); day = day.AddDate(0, 0, 1) {
				mark(trafficLedgerDate(day), "legacy snapshots are missing a consecutive boundary or contain a counter reset")
			}
		} else {
			mark(date, "legacy snapshots are missing a consecutive boundary or contain a counter reset")
		}
	}
	return delta, !bad || delta.up > 0 || delta.down > 0, nil
}

func (r *TrafficRepository) collectLegacyNodeDeltas(ctx context.Context, cutoff string, dst map[legacyDeltaKey]legacyDelta, mark func(string, string)) error {
	rows, err := r.db.QueryContext(ctx, `SELECT s.server_id,s.tag,s.type,s.date,s.uplink,s.downlink FROM node_traffic_snapshots s JOIN remote_servers r ON r.id=s.server_id ORDER BY s.server_id,s.tag,s.type,s.date`)
	if err != nil {
		return fmt.Errorf("read legacy node snapshots: %w", err)
	}
	defer rows.Close()
	type row struct {
		server          int64
		name, typ, date string
		up, down        int64
	}
	var previous row
	have := false
	for rows.Next() {
		var current row
		if err := rows.Scan(&current.server, &current.name, &current.typ, &current.date, &current.up, &current.down); err != nil {
			return err
		}
		if have && current.server == previous.server && current.name == previous.name && current.typ == previous.typ {
			d, ok, e := collectPair(previous.date, current.date, previous.up, previous.down, current.up, current.down, cutoff, mark)
			if e != nil {
				return e
			}
			if ok {
				dst[legacyDeltaKey{previous.server, previous.name, previous.typ, previous.date}] = d
			}
		}
		previous = current
		have = true
	}
	return rows.Err()
}

func (r *TrafficRepository) collectLegacyUserDeltas(ctx context.Context, cutoff string, dst map[legacyDeltaKey]legacyDelta, mark func(string, string)) error {
	rows, err := r.db.QueryContext(ctx, `SELECT s.server_id,s.username,s.date,s.uplink,s.downlink FROM user_traffic_snapshots s JOIN remote_servers r ON r.id=s.server_id ORDER BY s.server_id,s.username,s.date`)
	if err != nil {
		return fmt.Errorf("read legacy user snapshots: %w", err)
	}
	defer rows.Close()
	type row struct {
		server     int64
		name, date string
		up, down   int64
	}
	var previous row
	have := false
	for rows.Next() {
		var current row
		if err := rows.Scan(&current.server, &current.name, &current.date, &current.up, &current.down); err != nil {
			return err
		}
		if have && current.server == previous.server && current.name == previous.name {
			d, ok, e := collectPair(previous.date, current.date, previous.up, previous.down, current.up, current.down, cutoff, mark)
			if e != nil {
				return e
			}
			if ok {
				dst[legacyDeltaKey{serverID: previous.server, name: previous.name, date: previous.date}] = d
			}
		}
		previous = current
		have = true
	}
	return rows.Err()
}

func (r *TrafficRepository) collectLegacyEmailDeltas(ctx context.Context, cutoff string, mark func(string, string)) ([]legacyEmailDelta, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT s.server_id,s.email,s.date,s.uplink,s.downlink FROM user_email_traffic_snapshots s JOIN remote_servers r ON r.id=s.server_id ORDER BY s.server_id,s.email,s.date`)
	if err != nil {
		return nil, fmt.Errorf("read legacy email snapshots: %w", err)
	}
	defer rows.Close()
	type row struct {
		server      int64
		email, date string
		up, down    int64
	}
	var previous row
	have := false
	var out []legacyEmailDelta
	for rows.Next() {
		var current row
		if err := rows.Scan(&current.server, &current.email, &current.date, &current.up, &current.down); err != nil {
			return nil, err
		}
		if have && current.server == previous.server && current.email == previous.email {
			d, ok, e := collectPair(previous.date, current.date, previous.up, previous.down, current.up, current.down, cutoff, mark)
			if e != nil {
				return nil, e
			}
			if ok {
				out = append(out, legacyEmailDelta{previous.server, previous.email, previous.date, d.up, d.down})
			}
		}
		previous = current
		have = true
	}
	return out, rows.Err()
}

func (r *TrafficRepository) collectLegacySystemDeltas(ctx context.Context, cutoff string, dst map[legacyDeltaKey]legacyDelta, mark func(string, string)) error {
	rows, err := r.db.QueryContext(ctx, `SELECT s.server_id,s.date,s.tx_cycle,s.rx_cycle FROM server_system_traffic_snapshots s JOIN remote_servers r ON r.id=s.server_id ORDER BY s.server_id,s.date`)
	if err != nil {
		return fmt.Errorf("read legacy system snapshots: %w", err)
	}
	defer rows.Close()
	type row struct {
		server   int64
		date     string
		up, down int64
	}
	var previous row
	have := false
	for rows.Next() {
		var current row
		if err := rows.Scan(&current.server, &current.date, &current.up, &current.down); err != nil {
			return err
		}
		if have && current.server == previous.server {
			d, ok, e := collectPair(previous.date, current.date, previous.up, previous.down, current.up, current.down, cutoff, mark)
			if e != nil {
				return e
			}
			if ok {
				dst[legacyDeltaKey{serverID: previous.server, date: previous.date}] = d
			}
		}
		previous = current
		have = true
	}
	return rows.Err()
}
