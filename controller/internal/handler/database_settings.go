package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"miaomiaowux/internal/storage"
)

type DatabaseSettingsHandler struct {
	repo              *storage.TrafficRepository
	dataDir           string
	migrationMu       sync.RWMutex
	migrationRunning  bool
	migrationProgress storage.DatabaseMigrationProgress
	migrationError    string
}

func (h *DatabaseSettingsHandler) MigrationProgress(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "方法不允许", http.StatusMethodNotAllowed)
		return
	}
	h.migrationMu.RLock()
	running, progress, migrationError := h.migrationRunning, h.migrationProgress, h.migrationError
	h.migrationMu.RUnlock()
	respondJSON(w, http.StatusOK, map[string]any{"success": true, "running": running, "progress": progress, "error": migrationError})
}

func NewDatabaseSettingsHandler(repo *storage.TrafficRepository, dataDir string) *DatabaseSettingsHandler {
	return &DatabaseSettingsHandler{repo: repo, dataDir: dataDir}
}

func (h *DatabaseSettingsHandler) Status(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "方法不允许", http.StatusMethodNotAllowed)
		return
	}
	status, err := h.repo.DatabaseStatus(r.Context())
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "message": err.Error()})
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"success": true, "status": status})
}

func (h *DatabaseSettingsHandler) Test(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "方法不允许", http.StatusMethodNotAllowed)
		return
	}
	cfg, ok := decodeDatabaseConfig(w, r)
	if !ok {
		return
	}
	h.fillCurrentPassword(&cfg)
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := storage.TestDatabaseConfig(ctx, cfg); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]any{"success": false, "message": err.Error()})
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"success": true, "message": "数据库连接与表结构检查成功"})
}

func (h *DatabaseSettingsHandler) Migrate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "方法不允许", http.StatusMethodNotAllowed)
		return
	}
	if storage.DatabaseConfigUsesEnvironment() {
		respondJSON(w, http.StatusConflict, map[string]any{"success": false, "message": "数据库连接正由 MMWX_DATABASE_* 环境变量管理，不能从页面迁移切换；请移除连接类变量后重启"})
		return
	}
	cfg, ok := decodeDatabaseConfig(w, r)
	if !ok {
		return
	}
	h.fillCurrentPassword(&cfg)
	h.migrationMu.Lock()
	if h.migrationRunning {
		h.migrationMu.Unlock()
		respondJSON(w, http.StatusConflict, map[string]any{"success": false, "message": "数据库迁移正在进行中"})
		return
	}
	h.migrationRunning = true
	h.migrationError = ""
	h.migrationProgress = storage.DatabaseMigrationProgress{Phase: "connecting"}
	h.migrationMu.Unlock()
	succeeded := false
	defer func() {
		h.migrationMu.Lock()
		h.migrationRunning = false
		if succeeded {
			h.migrationError = ""
		}
		h.migrationMu.Unlock()
	}()
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	report, err := h.repo.MigrateSQLiteToPostgresWithProgress(ctx, cfg, func(progress storage.DatabaseMigrationProgress) {
		h.migrationMu.Lock()
		h.migrationProgress = progress
		h.migrationMu.Unlock()
	})
	if err != nil {
		h.migrationMu.Lock()
		h.migrationError = err.Error()
		h.migrationMu.Unlock()
		respondJSON(w, http.StatusBadRequest, map[string]any{"success": false, "message": err.Error()})
		return
	}
	if err := storage.SaveDatabaseConfig(h.dataDir, cfg); err != nil {
		h.repo.ReleaseDatabaseMigrationGate()
		respondJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "message": "保存数据库配置失败: " + err.Error()})
		return
	}
	succeeded = true
	respondJSON(w, http.StatusOK, map[string]any{
		"success": true, "message": "迁移完成，主控正在切换到 PostgreSQL", "report": report, "restarting": true,
	})
	go func() {
		time.Sleep(500 * time.Millisecond)
		if err := SignalGracefulRestart(); err != nil {
			h.repo.ReleaseDatabaseMigrationGate()
		}
	}()
}

func (h *DatabaseSettingsHandler) fillCurrentPassword(cfg *storage.DatabaseConfig) {
	current := h.repo.DatabaseConfig()
	if cfg.Password == "" && current.Driver == "postgres" && cfg.Host == current.Host && cfg.Port == current.Port && cfg.Database == current.Database && cfg.Username == current.Username {
		cfg.Password = current.Password
	}
}

func decodeDatabaseConfig(w http.ResponseWriter, r *http.Request) (storage.DatabaseConfig, bool) {
	defer r.Body.Close()
	// password_configured is a read-only flag returned by DatabaseStatus.SafeView.
	// Older frontends spread that status object back into the test/migrate request.
	// Accept this one known presentation field while keeping DisallowUnknownFields
	// enabled so genuine request typos are still rejected.
	var request struct {
		storage.DatabaseConfig
		PasswordConfigured bool `json:"password_configured,omitempty"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]any{"success": false, "message": "数据库配置格式错误: " + err.Error()})
		return storage.DatabaseConfig{}, false
	}
	cfg := request.DatabaseConfig
	if strings.TrimSpace(cfg.Driver) == "" {
		cfg.Driver = "postgres"
	}
	if err := cfg.Validate(); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]any{"success": false, "message": err.Error()})
		return storage.DatabaseConfig{}, false
	}
	return cfg, true
}
