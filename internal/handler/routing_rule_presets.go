package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"miaomiaowux/internal/auth"
	"miaomiaowux/internal/storage"
)

type routingRulePresetRequest struct {
	Name string         `json:"name"`
	Rule map[string]any `json:"rule"`
}

type routingRulePresetResponse struct {
	ID        int64          `json:"id"`
	Name      string         `json:"name"`
	Rule      map[string]any `json:"rule"`
	CreatedAt string         `json:"created_at"`
	UpdatedAt string         `json:"updated_at"`
}

func NewRoutingRulePresetsHandler(repo *storage.TrafficRepository) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		username := strings.TrimSpace(auth.UsernameFromContext(r.Context()))
		if username == "" {
			writeError(w, http.StatusUnauthorized, errors.New("unauthorized"))
			return
		}
		switch r.Method {
		case http.MethodGet:
			presets, err := repo.ListRoutingRulePresets(r.Context(), username)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err)
				return
			}
			response := make([]routingRulePresetResponse, 0, len(presets))
			for _, preset := range presets {
				var rule map[string]any
				if err := json.Unmarshal([]byte(preset.RuleJSON), &rule); err != nil {
					continue
				}
				response = append(response, routingRulePresetResponse{
					ID: preset.ID, Name: preset.Name, Rule: rule,
					CreatedAt: preset.CreatedAt.Format(timeLayout), UpdatedAt: preset.UpdatedAt.Format(timeLayout),
				})
			}
			respondJSON(w, http.StatusOK, response)
		case http.MethodPost:
			r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
			var request routingRulePresetRequest
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				writeError(w, http.StatusBadRequest, errors.New("无效的路由规则"))
				return
			}
			request.Name = strings.TrimSpace(request.Name)
			if len(request.Name) > 120 || len(request.Rule) == 0 {
				writeError(w, http.StatusBadRequest, errors.New("规则名称或内容无效"))
				return
			}
			if request.Name == "" {
				request.Name = routingRulePresetName(request.Rule)
			}
			if runes := []rune(request.Name); len(runes) > 120 {
				request.Name = string(runes[:120])
			}
			canonical, err := json.Marshal(request.Rule)
			if err != nil {
				writeError(w, http.StatusBadRequest, errors.New("无法序列化路由规则"))
				return
			}
			preset, err := repo.UpsertRoutingRulePreset(r.Context(), username, request.Name, string(canonical))
			if err != nil {
				writeError(w, http.StatusInternalServerError, err)
				return
			}
			respondJSON(w, http.StatusOK, routingRulePresetResponse{
				ID: preset.ID, Name: preset.Name, Rule: request.Rule,
				CreatedAt: preset.CreatedAt.Format(timeLayout), UpdatedAt: preset.UpdatedAt.Format(timeLayout),
			})
		case http.MethodDelete:
			id, err := strconv.ParseInt(strings.TrimSpace(r.URL.Query().Get("id")), 10, 64)
			if err != nil || id <= 0 {
				writeError(w, http.StatusBadRequest, errors.New("无效的规则预设 ID"))
				return
			}
			if err := repo.DeleteRoutingRulePreset(r.Context(), username, id); err != nil {
				if errors.Is(err, storage.ErrRoutingRulePresetNotFound) {
					writeError(w, http.StatusNotFound, err)
				} else {
					writeError(w, http.StatusInternalServerError, err)
				}
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		}
	})
}

const timeLayout = "2006-01-02 15:04:05"

func routingRulePresetName(rule map[string]any) string {
	if value, ok := rule["marktag"].(string); ok && strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	for _, field := range []string{"domain", "ip", "protocol", "inboundTag"} {
		if values, ok := rule[field].([]any); ok && len(values) > 0 {
			return field + ": " + strings.TrimSpace(toString(values[0]))
		}
	}
	return "自定义规则"
}

func toString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}
