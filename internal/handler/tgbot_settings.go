package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	inttgbot "miaomiaowux/internal/tgbot"
)

type TGBotSettingsHandler struct{ manager *inttgbot.Manager }

func NewTGBotSettingsHandler(manager *inttgbot.Manager) http.Handler {
	return &TGBotSettingsHandler{manager: manager}
}

func (h *TGBotSettingsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.manager == nil {
		writeError(w, http.StatusServiceUnavailable, errors.New("TGBot manager unavailable"))
		return
	}
	switch r.Method {
	case http.MethodGet:
		respondJSON(w, http.StatusOK, h.manager.Load(r.Context(), false))
	case http.MethodPut, http.MethodPost:
		var settings inttgbot.Settings
		if err := json.NewDecoder(r.Body).Decode(&settings); err != nil {
			writeError(w, http.StatusBadRequest, errors.New("invalid JSON"))
			return
		}
		if err := h.manager.EnsurePublicBaseURL(r.Context(), observedPublicBaseURL(r)); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		if err := h.manager.SaveAndRestart(r.Context(), settings); err != nil {
			writeError(w, http.StatusBadGateway, err)
			return
		}
		respondJSON(w, http.StatusOK, h.manager.Load(r.Context(), false))
	default:
		writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
	}
}

func observedPublicBaseURL(r *http.Request) string {
	host := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Host"), ",")[0])
	if host == "" {
		host = strings.TrimSpace(r.Host)
	}
	if host == "" || strings.ContainsAny(host, "\r\n/\\") {
		return ""
	}
	proto := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0])
	if proto != "http" && proto != "https" {
		if r.TLS != nil {
			proto = "https"
		} else {
			proto = "http"
		}
	}
	return proto + "://" + host
}
