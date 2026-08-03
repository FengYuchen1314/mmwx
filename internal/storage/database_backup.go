package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	modernsqlite "modernc.org/sqlite"
)

// QuickCheck 对当前数据库执行轻量完整性检查。返回 nil 才允许生成/替换备份。
func (r *TrafficRepository) QuickCheck(ctx context.Context) error {
	if r == nil || r.db == nil {
		return fmt.Errorf("database is not initialized")
	}
	if r.config.Driver == "postgres" {
		if err := r.db.PingContext(ctx); err != nil {
			return fmt.Errorf("postgresql health check: %w", err)
		}
		return nil
	}
	return quickCheckDB(ctx, r.db.DB)
}

func quickCheckDB(ctx context.Context, db *sql.DB) error {
	rows, err := db.QueryContext(ctx, "PRAGMA quick_check")
	if err != nil {
		return fmt.Errorf("sqlite quick_check: %w", err)
	}
	defer rows.Close()
	var problems []string
	for rows.Next() {
		var result string
		if err := rows.Scan(&result); err != nil {
			return fmt.Errorf("scan sqlite quick_check: %w", err)
		}
		if !strings.EqualFold(strings.TrimSpace(result), "ok") {
			problems = append(problems, result)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("sqlite quick_check rows: %w", err)
	}
	if len(problems) > 0 {
		return fmt.Errorf("sqlite quick_check failed: %s", strings.Join(problems, "; "))
	}
	return nil
}

// BackupDatabase 使用 SQLite Online Backup API 创建包含 WAL 已提交内容的一致性
// 快照。复制按小批页面执行，避免 VACUUM INTO 长时间占用主库；快照通过
// quick_check 后才替换唯一正式备份，失败时保留上一次可用备份。
func (r *TrafficRepository) BackupDatabase(ctx context.Context, backupPath string) error {
	if r != nil && r.config.Driver == "postgres" {
		return errors.New("SQLite online backup is unavailable for PostgreSQL")
	}
	if strings.TrimSpace(backupPath) == "" {
		return fmt.Errorf("backup path is empty")
	}
	if err := r.QuickCheck(ctx); err != nil {
		return fmt.Errorf("source database is unhealthy, keeping previous backup: %w", err)
	}
	abs, err := filepath.Abs(backupPath)
	if err != nil {
		return fmt.Errorf("resolve backup path: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return fmt.Errorf("create backup directory: %w", err)
	}
	tmp := abs + ".tmp"
	_ = os.Remove(tmp)
	if err := onlineBackup(ctx, r.db.DB, tmp); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("online database backup: %w", err)
	}
	if err := quickCheckSQLiteFile(ctx, tmp); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("validate new backup: %w", err)
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("secure new backup permissions: %w", err)
	}
	if err := replaceFileKeepingOldOnFailure(tmp, abs); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("publish database backup: %w", err)
	}
	return nil
}

func onlineBackup(ctx context.Context, db *sql.DB, dstPath string) error {
	type backuper interface {
		NewBackup(string) (*modernsqlite.Backup, error)
	}

	conn, err := db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("acquire source connection: %w", err)
	}
	defer conn.Close()

	return conn.Raw(func(driverConn any) error {
		backupDriver, ok := driverConn.(backuper)
		if !ok {
			return fmt.Errorf("sqlite driver does not support online backup")
		}
		backup, err := backupDriver.NewBackup(dstPath)
		if err != nil {
			return fmt.Errorf("initialize backup: %w", err)
		}
		finished := false
		defer func() {
			if !finished {
				_ = backup.Finish()
			}
		}()

		for {
			if err := ctx.Err(); err != nil {
				return err
			}
			more, err := backup.Step(256)
			if err != nil {
				return fmt.Errorf("copy backup pages: %w", err)
			}
			if !more {
				finished = true
				if err := backup.Finish(); err != nil {
					return fmt.Errorf("finish backup: %w", err)
				}
				return nil
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(5 * time.Millisecond):
			}
		}
	})
}

func quickCheckSQLiteFile(ctx context.Context, path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(abs)+"?mode=ro&_pragma=query_only(1)")
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	return quickCheckDB(ctx, db)
}

func replaceFileKeepingOldOnFailure(src, dst string) error {
	old := dst + ".old"
	_ = os.Remove(old)
	if _, err := os.Stat(dst); err == nil {
		if err := os.Rename(dst, old); err != nil {
			return err
		}
	}
	if err := os.Rename(src, dst); err != nil {
		if _, statErr := os.Stat(old); statErr == nil {
			_ = os.Rename(old, dst)
		}
		return err
	}
	_ = os.Remove(old)
	return nil
}

// OpenTrafficRepositoryWithRecovery 正常打开主库；若初始化或 quick_check 失败，则先校验
// 最近备份，归档故障主库及 WAL/SHM，复制备份后重试。归档始终保留，便于后续 .recover。
func OpenTrafficRepositoryWithRecovery(path, backupPath string) (*TrafficRepository, bool, error) {
	repo, err := NewTrafficRepository(path)
	if err == nil {
		return repo, false, nil
	}
	originalErr := err
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if checkErr := quickCheckSQLiteFile(ctx, backupPath); checkErr != nil {
		return nil, false, fmt.Errorf("open primary database: %v; backup unavailable or invalid: %w", originalErr, checkErr)
	}

	absPath, _ := filepath.Abs(path)
	archiveDir := filepath.Join(filepath.Dir(absPath), "database-recovery-"+time.Now().Format("20060102-150405"))
	if err := os.MkdirAll(archiveDir, 0o700); err != nil {
		return nil, false, fmt.Errorf("open primary database: %v; create recovery archive: %w", originalErr, err)
	}
	type movedFile struct{ from, to string }
	var moved []movedFile
	rollbackArchive := func() {
		for i := len(moved) - 1; i >= 0; i-- {
			_ = os.Rename(moved[i].to, moved[i].from)
		}
	}
	for _, candidate := range []string{absPath, absPath + "-wal", absPath + "-shm"} {
		if _, statErr := os.Stat(candidate); statErr == nil {
			archived := filepath.Join(archiveDir, filepath.Base(candidate))
			if moveErr := os.Rename(candidate, archived); moveErr != nil {
				rollbackArchive()
				return nil, false, fmt.Errorf("archive damaged database file %s: %w", candidate, moveErr)
			}
			moved = append(moved, movedFile{from: candidate, to: archived})
		}
	}
	if err := copyFile(backupPath, absPath+".restore-tmp"); err != nil {
		rollbackArchive()
		return nil, false, fmt.Errorf("copy database backup for recovery: %w", err)
	}
	if err := os.Rename(absPath+".restore-tmp", absPath); err != nil {
		_ = os.Remove(absPath + ".restore-tmp")
		rollbackArchive()
		return nil, false, fmt.Errorf("activate recovered database: %w", err)
	}
	repo, retryErr := NewTrafficRepository(absPath)
	if retryErr != nil {
		return nil, false, fmt.Errorf("primary database failed (%v); backup restore retry failed: %w; damaged files archived at %s", originalErr, retryErr, archiveDir)
	}
	return repo, true, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	_ = os.Remove(dst)
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	syncErr := out.Sync()
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}
