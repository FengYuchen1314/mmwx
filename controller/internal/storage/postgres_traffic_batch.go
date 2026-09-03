package storage

import (
	"context"
	"fmt"
	"strings"
	"time"
)

func typedValueGroups(rows int, types ...string) string {
	parts := make([]string, len(types))
	for i, kind := range types {
		parts[i] = "?::" + kind
	}
	group := "(" + strings.Join(parts, ",") + ")"
	return strings.TrimSuffix(strings.Repeat(group+",", rows), ",")
}

func (r *TrafficRepository) upsertNodeTrafficBatchPostgres(ctx context.Context, serverID int64, items []NodeTrafficItem, restarted bool) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id, tag, type, total_uplink, total_downlink, last_uplink, last_downlink FROM node_traffic WHERE server_id=?`, serverID)
	if err != nil {
		return err
	}
	type old struct{ id, totalUp, totalDown, lastUp, lastDown int64 }
	existing := map[string]old{}
	for rows.Next() {
		var o old
		var tag, typ string
		if err := rows.Scan(&o.id, &tag, &typ, &o.totalUp, &o.totalDown, &o.lastUp, &o.lastDown); err != nil {
			rows.Close()
			return err
		}
		existing[tag+"\x00"+typ] = o
	}
	if err := rows.Close(); err != nil {
		return err
	}
	var insertArgs, updateArgs []any
	type ledgerDelta struct {
		tag, typ string
		up, down int64
	}
	var ledger []ledgerDelta
	insertCount, updateCount := 0, 0
	for _, item := range items {
		if item.Tag == "" || item.Type != "inbound" && item.Type != "outbound" {
			continue
		}
		o, ok := existing[item.Tag+"\x00"+item.Type]
		if !ok {
			insertCount++
			insertArgs = append(insertArgs, serverID, item.Tag, item.Type, item.Uplink, item.Downlink)
			continue
		}
		du, dd, tu, td := int64(0), int64(0), o.totalUp, o.totalDown
		if restarted {
			du, dd, tu, td = item.Uplink, item.Downlink, o.totalUp+o.lastUp, o.totalDown+o.lastDown
		} else {
			if item.Uplink > o.lastUp {
				du = item.Uplink - o.lastUp
			}
			if item.Downlink > o.lastDown {
				dd = item.Downlink - o.lastDown
			}
		}
		updateCount++
		updateArgs = append(updateArgs, o.id, du, dd, tu, td, item.Uplink, item.Downlink)
		if du != 0 || dd != 0 {
			ledger = append(ledger, ledgerDelta{item.Tag, item.Type, du, dd})
		}
	}
	if insertCount > 0 {
		q := `INSERT INTO node_traffic (server_id,tag,type,uplink,downlink,total_uplink,total_downlink,last_uplink,last_downlink,updated_at) SELECT v.server_id,v.tag,v.type,0,0,0,0,v.last_up,v.last_down,CURRENT_TIMESTAMP FROM (VALUES ` + typedValueGroups(insertCount, "bigint", "text", "text", "bigint", "bigint") + `) AS v(server_id,tag,type,last_up,last_down) ON CONFLICT(server_id,tag,type) DO NOTHING`
		if _, err := tx.ExecContext(ctx, q, insertArgs...); err != nil {
			return err
		}
	}
	if updateCount > 0 {
		q := `UPDATE node_traffic AS t SET uplink=t.uplink+v.du,downlink=t.downlink+v.dd,total_uplink=v.tu,total_downlink=v.td,last_uplink=v.lu,last_downlink=v.ld,updated_at=CURRENT_TIMESTAMP FROM (VALUES ` + typedValueGroups(updateCount, "bigint", "bigint", "bigint", "bigint", "bigint", "bigint", "bigint") + `) AS v(id,du,dd,tu,td,lu,ld) WHERE t.id=v.id`
		if _, err := tx.ExecContext(ctx, q, updateArgs...); err != nil {
			return err
		}
	}
	date := trafficLedgerDate(time.Now())
	if len(ledger) > 0 {
		args := make([]any, 0, len(ledger)*6)
		for _, d := range ledger {
			args = append(args, serverID, d.tag, d.typ, date, d.up, d.down)
		}
		q := `INSERT INTO traffic_daily_nodes(server_id,tag,type,date,uplink,downlink) SELECT * FROM (VALUES ` + typedValueGroups(len(ledger), "bigint", "text", "text", "text", "bigint", "bigint") + `) AS v(server_id,tag,type,date,uplink,downlink) ON CONFLICT(server_id,tag,type,date) DO UPDATE SET uplink=traffic_daily_nodes.uplink+EXCLUDED.uplink,downlink=traffic_daily_nodes.downlink+EXCLUDED.downlink,updated_at=CURRENT_TIMESTAMP`
		if _, err := tx.ExecContext(ctx, q, args...); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (r *TrafficRepository) upsertTrafficBatchPostgres(ctx context.Context, serverID int64, emails []UserEmailTrafficUpsert, users []UserTrafficUpsert, restarted bool) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := batchEmailTrafficPostgres(ctx, tx, serverID, emails, restarted); err != nil {
		return fmt.Errorf("email batch: %w", err)
	}
	if err := batchUserTrafficPostgres(ctx, tx, serverID, users, restarted); err != nil {
		return fmt.Errorf("user batch: %w", err)
	}
	return tx.Commit()
}

type trafficOld struct{ id, totalUp, totalDown, lastUp, lastDown int64 }

func batchEmailTrafficPostgres(ctx context.Context, tx *dialectTx, serverID int64, items []UserEmailTrafficUpsert, restarted bool) error {
	if len(items) == 0 {
		return nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT id,email,total_uplink,total_downlink,last_uplink,last_downlink FROM user_email_traffic WHERE server_id=?`, serverID)
	if err != nil {
		return err
	}
	existing := map[string]trafficOld{}
	for rows.Next() {
		var o trafficOld
		var key string
		if err := rows.Scan(&o.id, &key, &o.totalUp, &o.totalDown, &o.lastUp, &o.lastDown); err != nil {
			rows.Close()
			return err
		}
		existing[key] = o
	}
	if err := rows.Close(); err != nil {
		return err
	}
	var inserts, updates []any
	type emailLedgerDelta struct {
		email, username string
		up, down        int64
		weight          float64
		shares          []WeightedNodeShare
	}
	var ledger []emailLedgerDelta
	ni, nu := 0, 0
	for _, item := range items {
		if item.Email == "" {
			continue
		}
		if item.Weight <= 0 {
			item.Weight = 1
		}
		o, ok := existing[item.Email]
		if !ok {
			ni++
			inserts = append(inserts, serverID, item.Email, item.Uplink, item.Downlink, item.AttributedUsername)
			continue
		}
		du, dd, tu, td := int64(0), int64(0), o.totalUp, o.totalDown
		if restarted {
			du, dd, tu, td = item.Uplink, item.Downlink, o.totalUp+o.lastUp, o.totalDown+o.lastDown
		} else {
			if item.Uplink > o.lastUp {
				du = item.Uplink - o.lastUp
			}
			if item.Downlink > o.lastDown {
				dd = item.Downlink - o.lastDown
			}
		}
		nu++
		updates = append(updates, o.id, du, dd, float64(du)*item.Weight, float64(dd)*item.Weight, tu, td, item.Uplink, item.Downlink, item.AttributedUsername)
		if du != 0 || dd != 0 {
			ledger = append(ledger, emailLedgerDelta{item.Email, item.AttributedUsername, du, dd, item.Weight, item.NodeShares})
		}
	}
	if ni > 0 {
		q := `INSERT INTO user_email_traffic (server_id,email,uplink,downlink,total_uplink,total_downlink,last_uplink,last_downlink,weighted_uplink,weighted_downlink,cycle_base_weighted_uplink,cycle_base_weighted_downlink,attributed_username,cycle_start,updated_at) SELECT v.server_id,v.email,0,0,0,0,v.lu,v.ld,0,0,0,0,v.username,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM (VALUES ` + typedValueGroups(ni, "bigint", "text", "bigint", "bigint", "text") + `) AS v(server_id,email,lu,ld,username) ON CONFLICT(server_id,email) DO NOTHING`
		if _, err := tx.ExecContext(ctx, q, inserts...); err != nil {
			return err
		}
	}
	if nu > 0 {
		q := `UPDATE user_email_traffic AS t SET uplink=t.uplink+v.du,downlink=t.downlink+v.dd,weighted_uplink=t.weighted_uplink+v.wu,weighted_downlink=t.weighted_downlink+v.wd,total_uplink=v.tu,total_downlink=v.td,last_uplink=v.lu,last_downlink=v.ld,attributed_username=v.username,updated_at=CURRENT_TIMESTAMP FROM (VALUES ` + typedValueGroups(nu, "bigint", "bigint", "bigint", "double precision", "double precision", "bigint", "bigint", "bigint", "bigint", "text") + `) AS v(id,du,dd,wu,wd,tu,td,lu,ld,username) WHERE t.id=v.id`
		if _, err := tx.ExecContext(ctx, q, updates...); err != nil {
			return err
		}
	}
	date := trafficLedgerDate(time.Now())
	if len(ledger) > 0 {
		args := make([]any, 0, len(ledger)*8)
		for _, d := range ledger {
			args = append(args, serverID, d.email, d.username, date, d.up, d.down, float64(d.up)*d.weight, float64(d.down)*d.weight)
		}
		q := `INSERT INTO traffic_daily_user_emails(server_id,email,attributed_username,date,uplink,downlink,weighted_uplink,weighted_downlink) SELECT * FROM (VALUES ` + typedValueGroups(len(ledger), "bigint", "text", "text", "text", "bigint", "bigint", "double precision", "double precision") + `) AS v(server_id,email,attributed_username,date,uplink,downlink,weighted_uplink,weighted_downlink) ON CONFLICT(server_id,email,attributed_username,date) DO UPDATE SET uplink=traffic_daily_user_emails.uplink+EXCLUDED.uplink,downlink=traffic_daily_user_emails.downlink+EXCLUDED.downlink,weighted_uplink=traffic_daily_user_emails.weighted_uplink+EXCLUDED.weighted_uplink,weighted_downlink=traffic_daily_user_emails.weighted_downlink+EXCLUDED.weighted_downlink,updated_at=CURRENT_TIMESTAMP`
		if _, err := tx.ExecContext(ctx, q, args...); err != nil {
			return err
		}
		type userNodeDelta struct {
			nodeID                             int64
			username                           string
			up, down, weightedUp, weightedDown float64
		}
		var userNodes []userNodeDelta
		for _, d := range ledger {
			if d.username == "" {
				continue
			}
			shares := d.shares
			if len(shares) == 0 {
				shares = []WeightedNodeShare{{NodeID: 0, RawShare: 1, Weight: d.weight}}
			}
			for _, share := range shares {
				if share.Weight <= 0 {
					continue
				}
				raw := share.RawShare
				if raw <= 0 {
					raw = 1
				}
				userNodes = append(userNodes, userNodeDelta{share.NodeID, d.username, float64(d.up) * raw, float64(d.down) * raw, float64(d.up) * share.Weight, float64(d.down) * share.Weight})
			}
		}
		if len(userNodes) > 0 {
			args := make([]any, 0, len(userNodes)*8)
			for _, d := range userNodes {
				args = append(args, serverID, d.nodeID, d.username, date, d.up, d.down, d.weightedUp, d.weightedDown)
			}
			q := `INSERT INTO traffic_daily_user_nodes(server_id,node_id,username,date,uplink,downlink,weighted_uplink,weighted_downlink) SELECT * FROM (VALUES ` + typedValueGroups(len(userNodes), "bigint", "bigint", "text", "text", "double precision", "double precision", "double precision", "double precision") + `) AS v(server_id,node_id,username,date,uplink,downlink,weighted_uplink,weighted_downlink) ON CONFLICT(server_id,node_id,username,date) DO UPDATE SET uplink=traffic_daily_user_nodes.uplink+EXCLUDED.uplink,downlink=traffic_daily_user_nodes.downlink+EXCLUDED.downlink,weighted_uplink=traffic_daily_user_nodes.weighted_uplink+EXCLUDED.weighted_uplink,weighted_downlink=traffic_daily_user_nodes.weighted_downlink+EXCLUDED.weighted_downlink,updated_at=CURRENT_TIMESTAMP`
			if _, err := tx.ExecContext(ctx, q, args...); err != nil {
				return err
			}
		}
	}
	return nil
}

func batchUserTrafficPostgres(ctx context.Context, tx *dialectTx, serverID int64, items []UserTrafficUpsert, restarted bool) error {
	if len(items) == 0 {
		return nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT id,username,total_uplink,total_downlink,last_uplink,last_downlink FROM user_traffic WHERE server_id=?`, serverID)
	if err != nil {
		return err
	}
	existing := map[string]trafficOld{}
	for rows.Next() {
		var o trafficOld
		var key string
		if err := rows.Scan(&o.id, &key, &o.totalUp, &o.totalDown, &o.lastUp, &o.lastDown); err != nil {
			rows.Close()
			return err
		}
		existing[key] = o
	}
	if err := rows.Close(); err != nil {
		return err
	}
	var inserts, updates []any
	type userLedgerDelta struct {
		username string
		up, down int64
	}
	var ledger []userLedgerDelta
	ni, nu := 0, 0
	for _, item := range items {
		if item.Username == "" {
			continue
		}
		o, ok := existing[item.Username]
		if !ok {
			ni++
			inserts = append(inserts, serverID, item.Username, item.Uplink, item.Downlink)
			continue
		}
		du, dd, tu, td := int64(0), int64(0), o.totalUp, o.totalDown
		if restarted {
			du, dd, tu, td = item.Uplink, item.Downlink, o.totalUp+o.lastUp, o.totalDown+o.lastDown
		} else {
			if item.Uplink > o.lastUp {
				du = item.Uplink - o.lastUp
			}
			if item.Downlink > o.lastDown {
				dd = item.Downlink - o.lastDown
			}
		}
		nu++
		updates = append(updates, o.id, du, dd, tu, td, item.Uplink, item.Downlink)
		if du != 0 || dd != 0 {
			ledger = append(ledger, userLedgerDelta{item.Username, du, dd})
		}
	}
	if ni > 0 {
		q := `INSERT INTO user_traffic (server_id,username,uplink,downlink,total_uplink,total_downlink,last_uplink,last_downlink,cycle_start,updated_at) SELECT v.server_id,v.username,0,0,0,0,v.lu,v.ld,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM (VALUES ` + typedValueGroups(ni, "bigint", "text", "bigint", "bigint") + `) AS v(server_id,username,lu,ld) ON CONFLICT(server_id,username) DO NOTHING`
		if _, err := tx.ExecContext(ctx, q, inserts...); err != nil {
			return err
		}
	}
	if nu > 0 {
		q := `UPDATE user_traffic AS t SET uplink=t.uplink+v.du,downlink=t.downlink+v.dd,total_uplink=v.tu,total_downlink=v.td,last_uplink=v.lu,last_downlink=v.ld,updated_at=CURRENT_TIMESTAMP FROM (VALUES ` + typedValueGroups(nu, "bigint", "bigint", "bigint", "bigint", "bigint", "bigint", "bigint") + `) AS v(id,du,dd,tu,td,lu,ld) WHERE t.id=v.id`
		if _, err := tx.ExecContext(ctx, q, updates...); err != nil {
			return err
		}
	}
	date := trafficLedgerDate(time.Now())
	if len(ledger) > 0 {
		args := make([]any, 0, len(ledger)*5)
		for _, d := range ledger {
			args = append(args, serverID, d.username, date, d.up, d.down)
		}
		q := `INSERT INTO traffic_daily_users(server_id,username,date,uplink,downlink) SELECT * FROM (VALUES ` + typedValueGroups(len(ledger), "bigint", "text", "text", "bigint", "bigint") + `) AS v(server_id,username,date,uplink,downlink) ON CONFLICT(server_id,username,date) DO UPDATE SET uplink=traffic_daily_users.uplink+EXCLUDED.uplink,downlink=traffic_daily_users.downlink+EXCLUDED.downlink,updated_at=CURRENT_TIMESTAMP`
		if _, err := tx.ExecContext(ctx, q, args...); err != nil {
			return err
		}
	}
	return nil
}
