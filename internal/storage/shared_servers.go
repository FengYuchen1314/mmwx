package storage

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// shared_servers: 拥有方把某台 remote_server 分享给其他妙妙屋X主控的令牌记录。
// 分享令牌明文只在创建时返回一次,库里只存 sha256 哈希。

type SharedServer struct {
	ID        int64      `json:"id"`
	ServerID  int64      `json:"server_id"`
	Label     string     `json:"label"`
	CreatedAt time.Time  `json:"created_at"`
	RevokedAt *time.Time `json:"revoked_at,omitempty"`
}

func (r *TrafficRepository) ensureSharedServersTable(ctx context.Context) error {
	if r == nil || r.db == nil {
		return errors.New("traffic repository not initialized")
	}
	_, err := r.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS shared_servers (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		server_id INTEGER NOT NULL,
		token_hash TEXT NOT NULL UNIQUE,
		label TEXT NOT NULL DEFAULT '',
		created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
		revoked_at TIMESTAMP
	)`)
	return err
}

// CreateSharedServer 记录一条分享(token 哈希由调用方算好传入)。
func (r *TrafficRepository) CreateSharedServer(ctx context.Context, serverID int64, tokenHash, label string) (int64, error) {
	if err := r.ensureSharedServersTable(ctx); err != nil {
		return 0, err
	}
	res, err := r.db.ExecContext(ctx,
		`INSERT INTO shared_servers (server_id, token_hash, label, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
		serverID, tokenHash, label)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// GetSharedServerByTokenHash 用于联邦鉴权:由 token 哈希解析出有效(未吊销)的分享及其 server_id。
func (r *TrafficRepository) GetSharedServerByTokenHash(ctx context.Context, tokenHash string) (SharedServer, error) {
	var s SharedServer
	if err := r.ensureSharedServersTable(ctx); err != nil {
		return s, err
	}
	var revoked sql.NullTime
	err := r.db.QueryRowContext(ctx,
		`SELECT id, server_id, label, created_at, revoked_at FROM shared_servers WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
		tokenHash).Scan(&s.ID, &s.ServerID, &s.Label, &s.CreatedAt, &revoked)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return s, ErrSharedServerNotFound
		}
		return s, err
	}
	if revoked.Valid {
		s.RevokedAt = &revoked.Time
	}
	return s, nil
}

// ListSharedServers 列出某 server 的分享(含已吊销,供管理界面展示)。
func (r *TrafficRepository) ListSharedServers(ctx context.Context, serverID int64) ([]SharedServer, error) {
	if err := r.ensureSharedServersTable(ctx); err != nil {
		return nil, err
	}
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, server_id, label, created_at, revoked_at FROM shared_servers WHERE server_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
		serverID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []SharedServer
	for rows.Next() {
		var s SharedServer
		var revoked sql.NullTime
		if err := rows.Scan(&s.ID, &s.ServerID, &s.Label, &s.CreatedAt, &revoked); err != nil {
			return nil, err
		}
		if revoked.Valid {
			s.RevokedAt = &revoked.Time
		}
		list = append(list, s)
	}
	return list, rows.Err()
}

// RevokeSharedServer 吊销一条分享(消费方立即失效)。
func (r *TrafficRepository) RevokeSharedServer(ctx context.Context, id int64) error {
	if err := r.ensureSharedServersTable(ctx); err != nil {
		return err
	}
	_, err := r.db.ExecContext(ctx, `UPDATE shared_servers SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?`, id)
	return err
}

// ===== 联邦入站溯源 =====
// 拥有方记录"某个分享(share_id)的接收方经联邦在本服务器 agent 上创建了哪些入站(tag)",
// 吊销分享时据此从 agent 删掉这些入站,让接收方的节点随之失效(否则吊销后仍能连)。

func (r *TrafficRepository) ensureSharedInboundsTable(ctx context.Context) error {
	if r == nil || r.db == nil {
		return errors.New("traffic repository not initialized")
	}
	_, err := r.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS shared_server_inbounds (
		share_id    INTEGER NOT NULL,
		server_id   INTEGER NOT NULL,
		inbound_tag TEXT NOT NULL,
		created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
		UNIQUE(share_id, inbound_tag)
	)`)
	return err
}

// RecordSharedInbound 记录一条联邦入站(接收方经该分享在 agent 上加的入站)。幂等。
func (r *TrafficRepository) RecordSharedInbound(ctx context.Context, shareID, serverID int64, tag string) error {
	if err := r.ensureSharedInboundsTable(ctx); err != nil {
		return err
	}
	_, err := r.db.ExecContext(ctx,
		`INSERT OR IGNORE INTO shared_server_inbounds (share_id, server_id, inbound_tag) VALUES (?, ?, ?)`,
		shareID, serverID, tag)
	return err
}

// UnrecordSharedInbound 删除一条联邦入站溯源(接收方经联邦删了该入站时)。
func (r *TrafficRepository) UnrecordSharedInbound(ctx context.Context, shareID int64, tag string) error {
	if err := r.ensureSharedInboundsTable(ctx); err != nil {
		return err
	}
	_, err := r.db.ExecContext(ctx,
		`DELETE FROM shared_server_inbounds WHERE share_id = ? AND inbound_tag = ?`, shareID, tag)
	return err
}

// ListSharedInboundTags 列出某分享溯源到的全部入站 tag(吊销时据此删 agent 入站)。
func (r *TrafficRepository) ListSharedInboundTags(ctx context.Context, shareID int64) ([]string, error) {
	if err := r.ensureSharedInboundsTable(ctx); err != nil {
		return nil, err
	}
	rows, err := r.db.QueryContext(ctx,
		`SELECT inbound_tag FROM shared_server_inbounds WHERE share_id = ?`, shareID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tags []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		tags = append(tags, t)
	}
	return tags, rows.Err()
}

// GetSharedServerServerID 按分享 id 取其 server_id(吊销时删 agent 入站要用)。
func (r *TrafficRepository) GetSharedServerServerID(ctx context.Context, shareID int64) (int64, error) {
	if err := r.ensureSharedServersTable(ctx); err != nil {
		return 0, err
	}
	var sid int64
	err := r.db.QueryRowContext(ctx, `SELECT server_id FROM shared_servers WHERE id = ? LIMIT 1`, shareID).Scan(&sid)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrSharedServerNotFound
	}
	return sid, err
}

// ClearSharedInbounds 清掉某分享的全部入站溯源(吊销后)。
func (r *TrafficRepository) ClearSharedInbounds(ctx context.Context, shareID int64) error {
	if err := r.ensureSharedInboundsTable(ctx); err != nil {
		return err
	}
	_, err := r.db.ExecContext(ctx, `DELETE FROM shared_server_inbounds WHERE share_id = ?`, shareID)
	return err
}
