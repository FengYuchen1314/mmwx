package storage

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

const maxRoutingRulePresets = 20

var ErrRoutingRulePresetNotFound = errors.New("routing rule preset not found")

type RoutingRulePreset struct {
	ID        int64     `json:"id"`
	Username  string    `json:"-"`
	Name      string    `json:"name"`
	RuleJSON  string    `json:"rule_json"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (r *TrafficRepository) ListRoutingRulePresets(ctx context.Context, username string) ([]RoutingRulePreset, error) {
	username = strings.TrimSpace(username)
	if username == "" {
		return nil, errors.New("username is required")
	}
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, username, name, rule_json, created_at, updated_at
		FROM routing_rule_presets WHERE username = ?
		ORDER BY updated_at DESC, id DESC LIMIT ?`, username, maxRoutingRulePresets)
	if err != nil {
		return nil, fmt.Errorf("list routing rule presets: %w", err)
	}
	defer rows.Close()
	presets := make([]RoutingRulePreset, 0)
	for rows.Next() {
		var preset RoutingRulePreset
		if err := rows.Scan(&preset.ID, &preset.Username, &preset.Name, &preset.RuleJSON, &preset.CreatedAt, &preset.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan routing rule preset: %w", err)
		}
		presets = append(presets, preset)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate routing rule presets: %w", err)
	}
	return presets, nil
}

// UpsertRoutingRulePreset saves a canonical JSON rule, moves an existing rule
// to the top, and keeps only the newest presets for this user.
func (r *TrafficRepository) UpsertRoutingRulePreset(ctx context.Context, username, name, ruleJSON string) (*RoutingRulePreset, error) {
	username = strings.TrimSpace(username)
	name = strings.TrimSpace(name)
	ruleJSON = strings.TrimSpace(ruleJSON)
	if username == "" || name == "" || ruleJSON == "" {
		return nil, errors.New("username, name and rule are required")
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin routing rule preset upsert: %w", err)
	}
	defer tx.Rollback()
	now := time.Now().UTC()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO routing_rule_presets (username, name, rule_json, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(username, rule_json) DO UPDATE SET
			name = excluded.name, updated_at = excluded.updated_at`, username, name, ruleJSON, now, now); err != nil {
		return nil, fmt.Errorf("upsert routing rule preset: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM routing_rule_presets
		WHERE username = ? AND id NOT IN (
			SELECT id FROM routing_rule_presets WHERE username = ?
			ORDER BY updated_at DESC, id DESC LIMIT ?
		)`, username, username, maxRoutingRulePresets); err != nil {
		return nil, fmt.Errorf("prune routing rule presets: %w", err)
	}
	var preset RoutingRulePreset
	if err := tx.QueryRowContext(ctx, `
		SELECT id, username, name, rule_json, created_at, updated_at
		FROM routing_rule_presets WHERE username = ? AND rule_json = ?`, username, ruleJSON).
		Scan(&preset.ID, &preset.Username, &preset.Name, &preset.RuleJSON, &preset.CreatedAt, &preset.UpdatedAt); err != nil {
		return nil, fmt.Errorf("read routing rule preset: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit routing rule preset: %w", err)
	}
	return &preset, nil
}

func (r *TrafficRepository) DeleteRoutingRulePreset(ctx context.Context, username string, id int64) error {
	username = strings.TrimSpace(username)
	if username == "" || id <= 0 {
		return errors.New("username and preset id are required")
	}
	result, err := r.db.ExecContext(ctx, `DELETE FROM routing_rule_presets WHERE id = ? AND username = ?`, id, username)
	if err != nil {
		return fmt.Errorf("delete routing rule preset: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("routing rule preset rows affected: %w", err)
	}
	if rows == 0 {
		return ErrRoutingRulePresetNotFound
	}
	return nil
}
