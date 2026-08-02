package storage

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	RenewalPending    = "pending"
	RenewalProcessing = "processing"
	RenewalApproved   = "approved"
	RenewalRejected   = "rejected"
	RenewalFailed     = "failed"
)

type RenewalRequest struct {
	ID              int64      `json:"id"`
	RequestToken    string     `json:"request_token,omitempty"`
	Username        string     `json:"username"`
	TelegramID      int64      `json:"telegram_id,omitempty"`
	PackageID       int64      `json:"package_id"`
	PackageName     string     `json:"package_name"`
	PreviousEndDate *time.Time `json:"previous_end_date,omitempty"`
	RenewDays       int        `json:"renew_days"`
	Passphrase      string     `json:"-"`
	Source          string     `json:"source"`
	Status          string     `json:"status"`
	ReviewedBy      int64      `json:"reviewed_by,omitempty"`
	ReviewedAt      *time.Time `json:"reviewed_at,omitempty"`
	NewEndDate      *time.Time `json:"new_end_date,omitempty"`
	ErrorMessage    string     `json:"error_message,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

func renewalToken() (string, error) {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func (r *TrafficRepository) CreateRenewalRequest(ctx context.Context, username, passphrase, source string, telegramID int64) (*RenewalRequest, error) {
	username, passphrase = strings.TrimSpace(username), strings.TrimSpace(passphrase)
	if username == "" || passphrase == "" || len([]rune(passphrase)) > 256 {
		return nil, errors.New("口令长度必须在 1..256 个字符之间")
	}
	if strings.ContainsAny(passphrase, "\r\n") {
		return nil, errors.New("口令不能包含换行")
	}
	if source != "tg-miniapp" {
		source = "web"
	}
	var packageID int64
	var packageName string
	var previousEnd sql.NullString
	var cycleDays int
	err := r.db.QueryRowContext(ctx, `
		SELECT COALESCE(u.package_id, u.last_package_id, 0), COALESCE(p.name, ''),
		       COALESCE(u.package_end_date, u.last_package_end_date), COALESCE(p.cycle_days, 0)
		FROM users u
		LEFT JOIN packages p ON p.id = COALESCE(u.package_id, u.last_package_id)
		WHERE u.username = ?`, username).Scan(&packageID, &packageName, &previousEnd, &cycleDays)
	if err != nil {
		return nil, fmt.Errorf("resolve renewal package: %w", err)
	}
	if packageID <= 0 || packageName == "" || cycleDays <= 0 {
		return nil, errors.New("没有可续费的最近套餐")
	}
	if telegramID == 0 {
		telegramID = r.GetTelegramIDByUsername(ctx, username)
	}
	if telegramID == 0 {
		return nil, errors.New("请先绑定 Telegram 后再申请续费")
	}
	token, err := renewalToken()
	if err != nil {
		return nil, err
	}
	_, err = r.db.ExecContext(ctx, `
		INSERT INTO renewal_requests
		(request_token, username, telegram_id, package_id, package_name, previous_end_date, renew_days, passphrase, source, status)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`, token, username, telegramID, packageID, packageName, nullableParsedTime(previousEnd), cycleDays, passphrase, source)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return nil, errors.New("已有待审核的续费申请")
		}
		return nil, fmt.Errorf("create renewal request: %w", err)
	}
	return r.GetRenewalRequestByToken(ctx, token, true)
}

func nullableParsedTime(v sql.NullString) any {
	if parsed := parseNullTimeString(v); parsed != nil {
		return *parsed
	}
	return nil
}

func scanRenewal(row interface{ Scan(...any) error }, includeSecret bool) (*RenewalRequest, error) {
	var q RenewalRequest
	var prev, reviewed, newEnd sql.NullString
	var secret string
	err := row.Scan(&q.ID, &q.RequestToken, &q.Username, &q.TelegramID, &q.PackageID, &q.PackageName,
		&prev, &q.RenewDays, &secret, &q.Source, &q.Status, &q.ReviewedBy, &reviewed, &newEnd,
		&q.ErrorMessage, &q.CreatedAt, &q.UpdatedAt)
	if err != nil {
		return nil, err
	}
	q.PreviousEndDate = parseNullTimeString(prev)
	q.ReviewedAt = parseNullTimeString(reviewed)
	q.NewEndDate = parseNullTimeString(newEnd)
	if includeSecret {
		q.Passphrase = secret
	}
	return &q, nil
}

const renewalSelect = `SELECT id, request_token, username, telegram_id, package_id, package_name,
 previous_end_date, renew_days, passphrase, source, status, reviewed_by, reviewed_at, new_end_date,
 COALESCE(error_message, ''), created_at, updated_at FROM renewal_requests`

func (r *TrafficRepository) GetRenewalRequestByToken(ctx context.Context, token string, includeSecret bool) (*RenewalRequest, error) {
	q, err := scanRenewal(r.db.QueryRowContext(ctx, renewalSelect+` WHERE request_token = ?`, token), includeSecret)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("续费申请不存在")
	}
	return q, err
}

func (r *TrafficRepository) GetLatestRenewalRequest(ctx context.Context, username string) (*RenewalRequest, error) {
	q, err := scanRenewal(r.db.QueryRowContext(ctx, renewalSelect+` WHERE username = ? ORDER BY id DESC LIMIT 1`, username), false)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return q, err
}

func (r *TrafficRepository) ListRenewalRequests(ctx context.Context, username string, limit int) ([]RenewalRequest, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	rows, err := r.db.QueryContext(ctx, renewalSelect+` WHERE username = ? ORDER BY id DESC LIMIT ?`, username, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]RenewalRequest, 0, limit)
	for rows.Next() {
		req, scanErr := scanRenewal(rows, false)
		if scanErr != nil {
			return nil, scanErr
		}
		out = append(out, *req)
	}
	return out, rows.Err()
}

func (r *TrafficRepository) ClaimRenewalRequest(ctx context.Context, token string, adminTGID int64) (bool, error) {
	res, err := r.db.ExecContext(ctx, `UPDATE renewal_requests SET status='processing', reviewed_by=?, updated_at=CURRENT_TIMESTAMP WHERE request_token=? AND status='pending'`, adminTGID, token)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

func (r *TrafficRepository) FinishRenewalRequest(ctx context.Context, token, status string, newEnd *time.Time, detail string) error {
	if status != RenewalApproved && status != RenewalRejected && status != RenewalFailed && status != RenewalPending {
		return errors.New("invalid renewal status")
	}
	_, err := r.db.ExecContext(ctx, `UPDATE renewal_requests SET status=?, new_end_date=?, error_message=?, passphrase='', reviewed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE request_token=?`, status, newEnd, detail, token)
	return err
}
