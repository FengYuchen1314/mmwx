package storage

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const DatabaseConfigFilename = "database.json"
const DatabaseRestoreRollbackFilename = "database.restore-rollback.json"

var databaseEnvironmentKeys = []string{
	"MMWX_DATABASE_DRIVER", "MMWX_DATABASE_PATH", "MMWX_DATABASE_HOST",
	"MMWX_DATABASE_PORT", "MMWX_DATABASE_NAME", "MMWX_DATABASE_USER", "MMWX_DATABASE_PASSWORD",
	"MMWX_DATABASE_SSLMODE",
}

func DatabaseConfigUsesEnvironment() bool {
	for _, key := range databaseEnvironmentKeys {
		if strings.TrimSpace(os.Getenv(key)) != "" {
			return true
		}
	}
	return false
}

// DatabaseConfig 保存在持久化 data 目录中。密码只允许写入，不应通过管理 API 明文返回。
type DatabaseConfig struct {
	Driver       string `json:"driver"`
	Path         string `json:"path,omitempty"`
	Host         string `json:"host,omitempty"`
	Port         int    `json:"port,omitempty"`
	Database     string `json:"database,omitempty"`
	Username     string `json:"username,omitempty"`
	Password     string `json:"password,omitempty"`
	SSLMode      string `json:"ssl_mode,omitempty"`
	MaxOpenConns int    `json:"max_open_conns,omitempty"`
	MaxIdleConns int    `json:"max_idle_conns,omitempty"`
}

func DefaultDatabaseConfig(dataDir string) DatabaseConfig {
	return DatabaseConfig{Driver: "sqlite", Path: filepath.Join(dataDir, "mmwx.db"), MaxOpenConns: sqliteMaxOpenConns, MaxIdleConns: sqliteMaxIdleConns}
}

// LoadDatabaseConfig 的优先级为环境变量 > database.json > 默认 SQLite。
// 兼容历史 DATABASE_PATH；新部署优先使用 MMWX_DATABASE_*。
func LoadDatabaseConfig(dataDir string) (DatabaseConfig, string, error) {
	cfg := DefaultDatabaseConfig(dataDir)
	configPath := filepath.Join(dataDir, DatabaseConfigFilename)
	loadedFile := false
	if raw, err := os.ReadFile(configPath); err == nil {
		loadedFile = true
		if err := json.Unmarshal(raw, &cfg); err != nil {
			return DatabaseConfig{}, configPath, fmt.Errorf("parse %s: %w", configPath, err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return DatabaseConfig{}, configPath, err
	}
	applyDatabaseEnv(&cfg)
	if !loadedFile {
		cfg.Path = preferPopulatedCanonicalSQLite(dataDir, cfg.Path)
	}
	// 早期裸机安装脚本把数据库放在 /etc/mmwx/mmwx.db，而新布局统一到
	// /etc/mmwx/data。升级时若未显式配置，优先沿用确实存在的旧文件。
	if !loadedFile && strings.TrimSpace(os.Getenv("DATABASE_PATH")) == "" && strings.TrimSpace(os.Getenv("MMWX_DATABASE_PATH")) == "" {
		legacyPath := filepath.Join(filepath.Dir(dataDir), "mmwx.db")
		canonicalPath := filepath.Join(dataDir, "mmwx.db")
		if _, canonicalErr := os.Stat(canonicalPath); errors.Is(canonicalErr, os.ErrNotExist) {
			if _, legacyErr := os.Stat(legacyPath); legacyErr == nil {
				cfg.Path = legacyPath
			}
		}
	}
	if err := cfg.Validate(); err != nil {
		return DatabaseConfig{}, configPath, err
	}
	return cfg, configPath, nil
}

// preferPopulatedCanonicalSQLite repairs one historical installer layout:
// old units permanently exported DATABASE_PATH=/etc/mmwx/mmwx.db, while the
// current persistent directory is /etc/mmwx/data. A binary-only upgrade keeps
// that stale environment and otherwise starts an empty setup database. Never
// override a populated explicit database; switch only when the legacy DB has
// no users and the canonical DB demonstrably does.
func preferPopulatedCanonicalSQLite(dataDir, configuredPath string) string {
	legacyPath := filepath.Clean(filepath.Join(filepath.Dir(dataDir), "mmwx.db"))
	canonicalPath := filepath.Clean(filepath.Join(dataDir, "mmwx.db"))
	if filepath.Clean(configuredPath) != legacyPath || legacyPath == canonicalPath {
		return configuredPath
	}
	legacyUsers, legacyOK := sqliteUserCount(legacyPath)
	canonicalUsers, canonicalOK := sqliteUserCount(canonicalPath)
	if canonicalOK && canonicalUsers > 0 && (!legacyOK || legacyUsers == 0) {
		return canonicalPath
	}
	return configuredPath
}

func sqliteUserCount(path string) (int64, bool) {
	if _, err := os.Stat(path); err != nil {
		return 0, false
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?mode=ro")
	if err != nil {
		return 0, false
	}
	defer db.Close()
	var count int64
	if err := db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count); err != nil {
		return 0, false
	}
	return count, true
}

func applyDatabaseEnv(cfg *DatabaseConfig) {
	set := func(key string, dst *string) {
		if v, ok := os.LookupEnv(key); ok && strings.TrimSpace(v) != "" {
			*dst = strings.TrimSpace(v)
		}
	}
	set("MMWX_DATABASE_DRIVER", &cfg.Driver)
	set("MMWX_DATABASE_PATH", &cfg.Path)
	if v := strings.TrimSpace(os.Getenv("DATABASE_PATH")); v != "" && strings.TrimSpace(os.Getenv("MMWX_DATABASE_PATH")) == "" {
		cfg.Path = v
	}
	set("MMWX_DATABASE_HOST", &cfg.Host)
	set("MMWX_DATABASE_NAME", &cfg.Database)
	set("MMWX_DATABASE_USER", &cfg.Username)
	set("MMWX_DATABASE_PASSWORD", &cfg.Password)
	set("MMWX_DATABASE_SSLMODE", &cfg.SSLMode)
	if v, err := strconv.Atoi(os.Getenv("MMWX_DATABASE_PORT")); err == nil && v > 0 {
		cfg.Port = v
	}
	if v, err := strconv.Atoi(os.Getenv("MMWX_DATABASE_MAX_OPEN_CONNS")); err == nil && v > 0 {
		cfg.MaxOpenConns = v
	}
	if v, err := strconv.Atoi(os.Getenv("MMWX_DATABASE_MAX_IDLE_CONNS")); err == nil && v >= 0 {
		cfg.MaxIdleConns = v
	}
}

func (c *DatabaseConfig) normalize() {
	c.Driver = strings.ToLower(strings.TrimSpace(c.Driver))
	if c.Driver == "postgresql" || c.Driver == "pgsql" {
		c.Driver = "postgres"
	}
	if c.Driver == "" {
		c.Driver = "sqlite"
	}
	if c.Driver == "postgres" {
		c.Path = ""
	}
	if c.Port == 0 {
		c.Port = 5432
	}
	if c.SSLMode == "" {
		c.SSLMode = "prefer"
	}
	if c.MaxOpenConns <= 0 {
		if c.Driver == "postgres" {
			c.MaxOpenConns = 30
		} else {
			c.MaxOpenConns = sqliteMaxOpenConns
		}
	}
	if c.MaxIdleConns < 0 {
		c.MaxIdleConns = 0
	}
	if c.MaxIdleConns == 0 && c.Driver == "postgres" {
		c.MaxIdleConns = 10
	}
}

func (c *DatabaseConfig) Validate() error {
	c.normalize()
	switch c.Driver {
	case "sqlite":
		if strings.TrimSpace(c.Path) == "" {
			return errors.New("SQLite database path is required")
		}
	case "postgres":
		if strings.TrimSpace(c.Host) == "" || strings.TrimSpace(c.Database) == "" || strings.TrimSpace(c.Username) == "" {
			return errors.New("PostgreSQL host, database and username are required")
		}
		if c.Port < 1 || c.Port > 65535 {
			return errors.New("invalid PostgreSQL port")
		}
		switch c.SSLMode {
		case "disable", "allow", "prefer", "require", "verify-ca", "verify-full":
		default:
			return errors.New("invalid PostgreSQL ssl_mode")
		}
	default:
		return fmt.Errorf("unsupported database driver %q", c.Driver)
	}
	if c.MaxIdleConns > c.MaxOpenConns {
		return errors.New("max_idle_conns cannot exceed max_open_conns")
	}
	return nil
}

func SaveDatabaseConfig(dataDir string, cfg DatabaseConfig) error {
	return saveDatabaseConfigFile(filepath.Join(dataDir, DatabaseConfigFilename), cfg)
}

func SaveDatabaseRestoreRollback(dataDir string, cfg DatabaseConfig) error {
	return saveDatabaseConfigFile(filepath.Join(dataDir, DatabaseRestoreRollbackFilename), cfg)
}

func LoadDatabaseRestoreRollback(dataDir string) (DatabaseConfig, error) {
	raw, err := os.ReadFile(filepath.Join(dataDir, DatabaseRestoreRollbackFilename))
	if err != nil {
		return DatabaseConfig{}, err
	}
	var cfg DatabaseConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return DatabaseConfig{}, err
	}
	if err := cfg.Validate(); err != nil {
		return DatabaseConfig{}, err
	}
	return cfg, nil
}

func ClearDatabaseRestoreRollback(dataDir string) error {
	err := os.Remove(filepath.Join(dataDir, DatabaseRestoreRollbackFilename))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func saveDatabaseConfigFile(target string, cfg DatabaseConfig) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0600); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0600); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, target); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func (c DatabaseConfig) SafeView() map[string]any {
	c.normalize()
	return map[string]any{"driver": c.Driver, "path": c.Path, "host": c.Host, "port": c.Port, "database": c.Database, "username": c.Username, "ssl_mode": c.SSLMode, "max_open_conns": c.MaxOpenConns, "max_idle_conns": c.MaxIdleConns, "password_configured": c.Password != ""}
}
