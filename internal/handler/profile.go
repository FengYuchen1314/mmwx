package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	"miaomiaowux/internal/auth"
	"miaomiaowux/internal/storage"
)

type profileResponse struct {
	Username         string `json:"username"`
	Email            string `json:"email"`
	Nickname         string `json:"nickname"`
	Avatar           string `json:"avatar_url"`
	Role             string `json:"role"`
	IsAdmin          bool   `json:"is_admin"`
	TelegramID       int64  `json:"telegram_id,omitempty"`
	TelegramUsername string `json:"telegram_username,omitempty"`
}

var errUnauthorized = errors.New("unauthorized")

func NewProfileHandler(repo *storage.TrafficRepository) http.Handler {
	if repo == nil {
		panic("profile handler requires repository")
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		username := auth.UsernameFromContext(r.Context())
		if username == "" {
			writeError(w, http.StatusUnauthorized, errUnauthorized)
			return
		}

		user, err := repo.GetUser(r.Context(), username)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		resp := profileResponse{
			Username: user.Username,
			Email:    user.Email,
			Nickname: user.Nickname,
			Avatar:   user.AvatarURL,
			Role:     user.Role,
			IsAdmin:  user.Role == storage.RoleAdmin,
		}
		if binding, exists := repo.GetUserTelegramBinding(r.Context(), user.Username); exists {
			resp.TelegramID = binding.TelegramID
			resp.TelegramUsername = binding.TelegramUsername
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
}
