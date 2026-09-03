package storage

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strings"
	"sync"
)

// dialectDB keeps the existing repository code readable while adapting the
// small SQL dialect differences between SQLite and PostgreSQL in one place.
// New queries should still use portable SQL whenever possible.
type dialectDB struct {
	*sql.DB
	driver string
	writes *sync.RWMutex
}

type dialectTx struct {
	*sql.Tx
	driver string
	writes *sync.RWMutex
	done   sync.Once
}

type dialectConn struct {
	*sql.Conn
	driver string
	writes *sync.RWMutex
}

type dialectStmt struct {
	*sql.Stmt
	tx       *sql.Tx
	driver   string
	isInsert bool
}

type postgresResult struct {
	sql.Result
	id  int64
	err error
}

func (r postgresResult) LastInsertId() (int64, error) { return r.id, r.err }

func isInsertStatement(query string) bool {
	return strings.HasPrefix(strings.ToUpper(strings.TrimSpace(query)), "INSERT ")
}

func insertHasGeneratedID(query string) bool {
	match := insertTable.FindStringSubmatch(query)
	return len(match) == 2 && generatedIDTables[strings.ToLower(match[1])]
}

var (
	autoincrementPrimaryKey = regexp.MustCompile(`(?i)INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT`)
	integerType             = regexp.MustCompile(`(?i)\bINTEGER\b`)
	insertOrIgnore          = regexp.MustCompile(`(?i)^\s*INSERT\s+OR\s+IGNORE\s+`)
	pragmaTableInfo         = regexp.MustCompile(`(?i)^\s*PRAGMA\s+table_info\((?:'|\")?([a-zA-Z0-9_]+)(?:'|\")?\)\s*;?\s*$`)
	insertTable             = regexp.MustCompile(`(?i)^\s*INSERT(?:\s+OR\s+\w+)?\s+INTO\s+["']?([a-zA-Z0-9_]+)`)
	parameterizedIsNot      = regexp.MustCompile(`(?i)\bIS\s+NOT\s+\?`)
	parameterizedIs         = regexp.MustCompile(`(?i)\bIS\s+\?`)
)

var generatedIDTables = map[string]bool{
	"announcements": true, "batch_inbounds": true, "batch_outbounds": true,
	"certificates": true, "custom_rules": true, "dns_providers": true,
	"external_subscriptions": true, "nodes": true, "override_scripts": true,
	"packages": true, "proxy_provider_configs": true, "remote_servers": true,
	"routing_rule_presets":         true,
	"server_xray_config_snapshots": true, "shared_servers": true,
	"speed_test_results": true, "speed_testers": true, "subscribe_files": true,
	"subscription_links": true, "task_runs": true, "templates": true,
	"user_subaccounts": true, "xray_servers": true,
}

func adaptSQL(driver, query string) string {
	if driver != "postgres" {
		return query
	}
	q := query
	if strings.EqualFold(strings.TrimSpace(q), "BEGIN IMMEDIATE") {
		return "BEGIN"
	}
	if match := pragmaTableInfo.FindStringSubmatch(q); len(match) == 2 {
		table := match[1]
		return fmt.Sprintf(`SELECT c.ordinal_position - 1 AS cid, c.column_name, c.data_type,
			CASE WHEN c.is_nullable = 'NO' THEN 1 ELSE 0 END AS not_null,
			c.column_default,
			CASE WHEN EXISTS (
				SELECT 1 FROM information_schema.table_constraints tc
				JOIN information_schema.key_column_usage kcu
				  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
				WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = current_schema()
				  AND tc.table_name = '%s' AND kcu.column_name = c.column_name
			) THEN 1 ELSE 0 END AS pk
			FROM information_schema.columns c
			WHERE c.table_schema = current_schema() AND c.table_name = '%s'
			ORDER BY c.ordinal_position`, table, table)
	}
	q = autoincrementPrimaryKey.ReplaceAllString(q, "BIGSERIAL PRIMARY KEY")
	// SQLite INTEGER values are signed 64-bit. Keep the same range in
	// PostgreSQL; using its 32-bit INTEGER silently breaks Telegram IDs,
	// traffic byte counters and timestamps during migration or later writes.
	q = integerType.ReplaceAllString(q, "BIGINT")
	q = regexp.MustCompile(`(?i)\bBLOB\b`).ReplaceAllString(q, "BYTEA")
	q = regexp.MustCompile(`(?i)\bIFNULL\s*\(`).ReplaceAllString(q, "COALESCE(")
	q = regexp.MustCompile(`(?i)json_valid\(([^)]+)\)\s*=\s*1`).ReplaceAllString(q, `(trim($1) ~ '^[\[{]')`)
	q = regexp.MustCompile(`(?i)json_extract\(([^,]+),\s*'\$\.([a-zA-Z0-9_-]+)'\)`).ReplaceAllString(q, `(CASE WHEN trim($1) ~ '^[\[{]' THEN (($1)::jsonb ->> '$2') ELSE NULL END)`)
	q = regexp.MustCompile(`(?i)json_set\(([^,]+),\s*'\$\.([a-zA-Z0-9_-]+)',\s*\?\)`).ReplaceAllString(q, `jsonb_set(($1)::jsonb, '{$2}', to_jsonb(?::text))::text`)
	q = strings.ReplaceAll(q, "datetime('now')", "CURRENT_TIMESTAMP")
	q = strings.ReplaceAll(q, "datetime('now', '+' || ? || ' days')", "(CURRENT_TIMESTAMP + (? || ' days')::interval)")
	// SQLite allows null-safe parameter comparisons such as `value IS ?` and
	// `value IS NOT ?`. PostgreSQL does not accept `IS $1`/`IS NOT $1`; its
	// equivalent operators are IS [NOT] DISTINCT FROM. Do this before rebinding
	// so future repository queries cannot reproduce the runtime SQLSTATE 42601.
	q = parameterizedIsNot.ReplaceAllString(q, "IS DISTINCT FROM ?")
	q = parameterizedIs.ReplaceAllString(q, "IS NOT DISTINCT FROM ?")
	q = regexp.MustCompile(`(?is)^\s*INSERT\s+OR\s+REPLACE\s+INTO\s+traffic_threshold_notified\s*\(server_id,\s*notified_at\)\s*VALUES\s*\(\?,\s*CURRENT_TIMESTAMP\)`).ReplaceAllString(q,
		`INSERT INTO traffic_threshold_notified (server_id, notified_at) VALUES (?, CURRENT_TIMESTAMP) ON CONFLICT (server_id) DO UPDATE SET notified_at = EXCLUDED.notified_at`)
	q = strings.ReplaceAll(q, `instr(?, username || '__')`, `strpos(?, username || '__')`)
	q = replacePostgresScalarMax(q)
	if insertOrIgnore.MatchString(q) {
		q = insertOrIgnore.ReplaceAllString(q, "INSERT ")
		trimmed := strings.TrimSpace(q)
		semicolon := strings.HasSuffix(trimmed, ";")
		trimmed = strings.TrimSuffix(trimmed, ";")
		q = trimmed + " ON CONFLICT DO NOTHING"
		if semicolon {
			q += ";"
		}
	}
	return rebindPostgres(q)
}

// SQLite uses MAX(a, b) as a scalar function while PostgreSQL reserves MAX
// for a one-argument aggregate and calls the scalar equivalent GREATEST.
// Detect a comma at the top level of each MAX call so aggregate MAX(expr)
// remains untouched, including when either scalar argument is nested SQL.
func replacePostgresScalarMax(query string) string {
	var result strings.Builder
	for index := 0; index < len(query); {
		if index+4 <= len(query) && strings.EqualFold(query[index:index+4], "MAX(") && (index == 0 || !isSQLIdentifierByte(query[index-1])) {
			depth, commaDepthOne := 0, false
			inSingle := false
			end := -1
			for cursor := index + 3; cursor < len(query); cursor++ {
				switch query[cursor] {
				case '\'':
					if inSingle && cursor+1 < len(query) && query[cursor+1] == '\'' {
						cursor++
						continue
					}
					inSingle = !inSingle
				case '(':
					if !inSingle {
						depth++
					}
				case ')':
					if !inSingle {
						depth--
						if depth == 0 {
							end = cursor
							cursor = len(query)
						}
					}
				case ',':
					if !inSingle && depth == 1 {
						commaDepthOne = true
					}
				}
			}
			if end >= 0 && commaDepthOne {
				result.WriteString("GREATEST(")
				result.WriteString(query[index+4 : end+1])
				index = end + 1
				continue
			}
		}
		result.WriteByte(query[index])
		index++
	}
	return result.String()
}

func isSQLIdentifierByte(value byte) bool {
	return value == '_' || value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z' || value >= '0' && value <= '9'
}

// rebindPostgres replaces placeholders outside SQL string literals. The
// repository historically uses SQLite's ?, while pgx expects $1, $2, ... .
func rebindPostgres(query string) string {
	var b strings.Builder
	b.Grow(len(query) + 8)
	arg := 1
	inSingle, inDouble := false, false
	for i := 0; i < len(query); i++ {
		ch := query[i]
		switch ch {
		case '\'':
			if !inDouble {
				if inSingle && i+1 < len(query) && query[i+1] == '\'' {
					b.WriteByte(ch)
					b.WriteByte(query[i+1])
					i++
					continue
				}
				inSingle = !inSingle
			}
		case '"':
			if !inSingle {
				inDouble = !inDouble
			}
		case '?':
			if !inSingle && !inDouble {
				fmt.Fprintf(&b, "$%d", arg)
				arg++
				continue
			}
		}
		b.WriteByte(ch)
	}
	return b.String()
}

func normalizeArgs(driver string, args []any) []any {
	if driver != "postgres" {
		return args
	}
	out := make([]any, len(args))
	for i, arg := range args {
		if value, ok := arg.(bool); ok {
			if value {
				out[i] = 1
			} else {
				out[i] = 0
			}
		} else {
			out[i] = arg
		}
	}
	return out
}

func (d *dialectDB) Exec(query string, args ...any) (sql.Result, error) {
	return d.ExecContext(context.Background(), query, args...)
}
func (d *dialectDB) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	d.writes.RLock()
	defer d.writes.RUnlock()
	return d.execContext(ctx, query, args...)
}

func (d *dialectDB) execContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	adapted := adaptSQL(d.driver, query)
	if d.driver != "postgres" || !insertHasGeneratedID(adapted) {
		return d.DB.ExecContext(ctx, adapted, normalizeArgs(d.driver, args)...)
	}
	conn, err := d.DB.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	result, err := conn.ExecContext(ctx, adapted, normalizeArgs(d.driver, args)...)
	if err != nil {
		return nil, err
	}
	var id int64
	idErr := conn.QueryRowContext(ctx, "SELECT LASTVAL()").Scan(&id)
	return postgresResult{Result: result, id: id, err: idErr}, nil
}
func (d *dialectDB) Query(query string, args ...any) (*sql.Rows, error) {
	return d.DB.Query(adaptSQL(d.driver, query), normalizeArgs(d.driver, args)...)
}
func (d *dialectDB) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return d.DB.QueryContext(ctx, adaptSQL(d.driver, query), normalizeArgs(d.driver, args)...)
}
func (d *dialectDB) QueryRow(query string, args ...any) *sql.Row {
	return d.DB.QueryRow(adaptSQL(d.driver, query), normalizeArgs(d.driver, args)...)
}
func (d *dialectDB) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	return d.DB.QueryRowContext(ctx, adaptSQL(d.driver, query), normalizeArgs(d.driver, args)...)
}
func (d *dialectDB) Begin() (*dialectTx, error) {
	d.writes.RLock()
	tx, err := d.DB.Begin()
	if err != nil {
		d.writes.RUnlock()
		return nil, err
	}
	return &dialectTx{Tx: tx, driver: d.driver, writes: d.writes}, nil
}
func (d *dialectDB) BeginTx(ctx context.Context, opts *sql.TxOptions) (*dialectTx, error) {
	d.writes.RLock()
	tx, err := d.DB.BeginTx(ctx, opts)
	if err != nil {
		d.writes.RUnlock()
		return nil, err
	}
	return &dialectTx{Tx: tx, driver: d.driver, writes: d.writes}, nil
}
func (d *dialectDB) Conn(ctx context.Context) (*dialectConn, error) {
	conn, err := d.DB.Conn(ctx)
	return &dialectConn{Conn: conn, driver: d.driver, writes: d.writes}, err
}

func (t *dialectTx) finish() { t.done.Do(func() { t.writes.RUnlock() }) }
func (t *dialectTx) Commit() error {
	err := t.Tx.Commit()
	t.finish()
	return err
}
func (t *dialectTx) Rollback() error {
	err := t.Tx.Rollback()
	t.finish()
	return err
}

func (t *dialectTx) Exec(query string, args ...any) (sql.Result, error) {
	return t.ExecContext(context.Background(), query, args...)
}
func (t *dialectTx) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	adapted := adaptSQL(t.driver, query)
	result, err := t.Tx.ExecContext(ctx, adapted, normalizeArgs(t.driver, args)...)
	if err != nil || t.driver != "postgres" || !insertHasGeneratedID(adapted) {
		return result, err
	}
	var id int64
	idErr := t.Tx.QueryRowContext(ctx, "SELECT LASTVAL()").Scan(&id)
	return postgresResult{Result: result, id: id, err: idErr}, nil
}
func (t *dialectTx) Query(query string, args ...any) (*sql.Rows, error) {
	return t.Tx.Query(adaptSQL(t.driver, query), normalizeArgs(t.driver, args)...)
}
func (t *dialectTx) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return t.Tx.QueryContext(ctx, adaptSQL(t.driver, query), normalizeArgs(t.driver, args)...)
}
func (t *dialectTx) QueryRow(query string, args ...any) *sql.Row {
	return t.Tx.QueryRow(adaptSQL(t.driver, query), normalizeArgs(t.driver, args)...)
}
func (t *dialectTx) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	return t.Tx.QueryRowContext(ctx, adaptSQL(t.driver, query), normalizeArgs(t.driver, args)...)
}
func (t *dialectTx) Prepare(query string) (*dialectStmt, error) {
	adapted := adaptSQL(t.driver, query)
	stmt, err := t.Tx.Prepare(adapted)
	if err != nil {
		return nil, err
	}
	return &dialectStmt{Stmt: stmt, tx: t.Tx, driver: t.driver, isInsert: insertHasGeneratedID(adapted)}, nil
}
func (t *dialectTx) PrepareContext(ctx context.Context, query string) (*dialectStmt, error) {
	adapted := adaptSQL(t.driver, query)
	stmt, err := t.Tx.PrepareContext(ctx, adapted)
	if err != nil {
		return nil, err
	}
	return &dialectStmt{Stmt: stmt, tx: t.Tx, driver: t.driver, isInsert: insertHasGeneratedID(adapted)}, nil
}

func (s *dialectStmt) Exec(args ...any) (sql.Result, error) {
	return s.ExecContext(context.Background(), args...)
}
func (s *dialectStmt) ExecContext(ctx context.Context, args ...any) (sql.Result, error) {
	result, err := s.Stmt.ExecContext(ctx, normalizeArgs(s.driver, args)...)
	if err != nil || s.driver != "postgres" || !s.isInsert {
		return result, err
	}
	var id int64
	idErr := s.tx.QueryRowContext(ctx, "SELECT LASTVAL()").Scan(&id)
	return postgresResult{Result: result, id: id, err: idErr}, nil
}

func (c *dialectConn) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	c.writes.RLock()
	defer c.writes.RUnlock()
	adapted := adaptSQL(c.driver, query)
	result, err := c.Conn.ExecContext(ctx, adapted, normalizeArgs(c.driver, args)...)
	if err != nil || c.driver != "postgres" || !insertHasGeneratedID(adapted) {
		return result, err
	}
	var id int64
	idErr := c.Conn.QueryRowContext(ctx, "SELECT LASTVAL()").Scan(&id)
	return postgresResult{Result: result, id: id, err: idErr}, nil
}
func (c *dialectConn) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return c.Conn.QueryContext(ctx, adaptSQL(c.driver, query), normalizeArgs(c.driver, args)...)
}
func (c *dialectConn) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	return c.Conn.QueryRowContext(ctx, adaptSQL(c.driver, query), normalizeArgs(c.driver, args)...)
}
func (c *dialectConn) BeginTx(ctx context.Context, opts *sql.TxOptions) (*dialectTx, error) {
	c.writes.RLock()
	tx, err := c.Conn.BeginTx(ctx, opts)
	if err != nil {
		c.writes.RUnlock()
		return nil, err
	}
	return &dialectTx{Tx: tx, driver: c.driver, writes: c.writes}, nil
}
