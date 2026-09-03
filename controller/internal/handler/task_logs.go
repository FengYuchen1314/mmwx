package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"miaomiaowux/internal/storage"
)

// TaskLogHandler 提供定时任务运行记录查询，admin 专用。
//
//	GET /api/admin/tasks/runs?task=&status=&limit=&offset=  运行记录（后端分页）
//	GET /api/admin/tasks/types                              任务类型清单（下拉筛选用）
type TaskLogHandler struct {
	repo        *storage.TrafficRepository
	returnRoute *ReturnRouteTester
}

func NewTaskLogHandler(repo *storage.TrafficRepository, returnRoute ...*ReturnRouteTester) *TaskLogHandler {
	h := &TaskLogHandler{repo: repo}
	if len(returnRoute) > 0 {
		h.returnRoute = returnRoute[0]
	}
	return h
}

// taskType 是一个任务的机器名 + 中文显示名。前端筛选下拉的唯一数据源，避免前端硬编码漂移。
type taskType struct {
	Name  string `json:"name"`
	Label string `json:"label"`
}

// 与各任务 taskrun.Record 里传的机器名一一对应。
var taskTypes = []taskType{
	{"traffic_collector", "流量采集"},
	{"speed_collector", "测速采集"},
	{"traffic_enforcer", "流量限制执行"},
	{"server_traffic_reset_guard", "服务器流量重置兜底"},
	{"daily_snapshot", "每日快照"},
	{"traffic_snapshot_backfill", "历史流量快照迁移"},
	{"traffic_ledger_audit", "流量账本校准"},
	{"orphan_xray_cleaner", "孤儿客户端清理"},
	{"notify_daily_traffic", "每日流量推送"},
	{"ddns_reconciler", "DDNS 重试"},
	{"cert_renewal", "证书续期"},
	{"node_tls_fingerprint_backfill", "节点证书指纹补全"},
	{"probe_quality_alert", "探针质量告警"},
	{returnRouteTaskName, "三网回程测试"},
}

func (h *TaskLogHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/admin/tasks/")
	switch path {
	case "run":
		if r.Method != http.MethodPost || h.returnRoute == nil {
			http.Error(w, "Not found", http.StatusNotFound)
			return
		}
		var req struct {
			Task      string  `json:"task"`
			ServerIDs []int64 `json:"server_ids"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, errors.New("请求格式无效"))
			return
		}
		if req.Task != returnRouteTaskName {
			writeError(w, http.StatusBadRequest, errors.New("该任务不支持手动运行"))
			return
		}
		id, err := h.returnRoute.RunAsync(req.ServerIDs)
		if err != nil {
			writeError(w, http.StatusConflict, err)
			return
		}
		respondJSON(w, http.StatusAccepted, map[string]any{"run_id": id})
	case "types":
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		respondJSON(w, http.StatusOK, map[string]any{"types": taskTypes})
	case "runs":
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		task := strings.TrimSpace(r.URL.Query().Get("task"))
		status := strings.TrimSpace(r.URL.Query().Get("status"))
		limit := atoiDefault(r.URL.Query().Get("limit"), 200)
		offset := atoiDefault(r.URL.Query().Get("offset"), 0)
		runs, err := h.repo.ListTaskRuns(r.Context(), task, status, limit, offset)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		if runs == nil {
			runs = []storage.TaskRun{}
		}
		respondJSON(w, http.StatusOK, map[string]any{"runs": runs})
	default:
		http.Error(w, "Not found", http.StatusNotFound)
	}
}
