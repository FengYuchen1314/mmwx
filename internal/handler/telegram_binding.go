package handler

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"miaomiaowux/internal/auth"
	"miaomiaowux/internal/storage"
)

// TelegramBindingHandler provides a web-facing binding flow. Users may only
// manage their own account; administrators can specify another username.
type TelegramBindingHandler struct {
	repo *storage.TrafficRepository
}

func NewTelegramBindingHandler(repo *storage.TrafficRepository) http.Handler {
	return &TelegramBindingHandler{repo: repo}
}

func (h *TelegramBindingHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	actor := auth.UsernameFromContext(r.Context())
	if actor == "" {
		writeError(w, http.StatusUnauthorized, errors.New("unauthorized"))
		return
	}
	target, ok := h.resolveTarget(r, actor)
	if !ok {
		writeError(w, http.StatusForbidden, errors.New("只能管理自己的 Telegram 绑定"))
		return
	}

	switch r.Method {
	case http.MethodGet:
		h.writeStatus(w, r, target)
	case http.MethodPost:
		h.createBindInvite(w, r, actor, target)
	case http.MethodDelete:
		h.unbind(w, r, actor, target)
	default:
		writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
	}
}

func (h *TelegramBindingHandler) resolveTarget(r *http.Request, actor string) (string, bool) {
	target := strings.TrimSpace(r.URL.Query().Get("username"))
	if target == "" {
		target = actor
	}
	user, err := h.repo.GetUser(r.Context(), actor)
	if err != nil {
		return "", false
	}
	return target, target == actor || user.Role == storage.RoleAdmin
}

func (h *TelegramBindingHandler) writeStatus(w http.ResponseWriter, r *http.Request, username string) {
	if _, err := h.repo.GetUser(r.Context(), username); err != nil {
		writeError(w, http.StatusNotFound, errors.New("用户不存在"))
		return
	}
	binding, _ := h.repo.GetUserTelegramBinding(r.Context(), username)
	botURL, _ := h.repo.GetSystemSetting(r.Context(), "tgbot_url")
	respondJSON(w, http.StatusOK, map[string]any{
		"username": username, "bound": binding.TelegramID != 0,
		"telegram_id": binding.TelegramID, "telegram_username": binding.TelegramUsername,
		"bot_url": strings.TrimSpace(botURL),
	})
}

func (h *TelegramBindingHandler) createBindInvite(w http.ResponseWriter, r *http.Request, actor, username string) {
	if _, err := h.repo.GetUser(r.Context(), username); err != nil {
		writeError(w, http.StatusNotFound, errors.New("用户不存在"))
		return
	}
	if h.repo.GetTelegramIDByUsername(r.Context(), username) != 0 {
		writeError(w, http.StatusConflict, errors.New("该用户已绑定 Telegram，请先解绑"))
		return
	}
	if err := h.repo.RevokeActiveBindInvitesForUser(r.Context(), username); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	expiresAt := time.Now().Add(24 * time.Hour)
	code, err := h.repo.CreateInviteCode(r.Context(), storage.InviteCode{
		Kind: "bind", BindUsername: username, CreatedBy: actor, MaxUses: 1,
		ExpiresAt: &expiresAt, Remark: "用户列表/个人菜单创建的 Telegram 绑定码",
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	_ = h.repo.WriteTGAudit(r.Context(), storage.TGAudit{Username: username, Action: "bind_invite", Detail: "created_by=" + actor})
	botURL, _ := h.repo.GetSystemSetting(r.Context(), "tgbot_url")
	respondJSON(w, http.StatusOK, map[string]any{
		"success": true, "code": code, "command": "/start " + code,
		"expires_at": expiresAt.Format(time.RFC3339), "bot_url": strings.TrimSpace(botURL),
	})
}

func (h *TelegramBindingHandler) unbind(w http.ResponseWriter, r *http.Request, actor, username string) {
	tgID := h.repo.GetTelegramIDByUsername(r.Context(), username)
	if tgID == 0 {
		writeError(w, http.StatusConflict, errors.New("该用户尚未绑定 Telegram"))
		return
	}
	if err := h.repo.UnbindTelegram(r.Context(), username); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	_ = h.repo.WriteTGAudit(r.Context(), storage.TGAudit{TGID: tgID, Username: username, Action: "unbind", Detail: "web actor=" + actor})
	respondJSON(w, http.StatusOK, map[string]any{"success": true})
}
