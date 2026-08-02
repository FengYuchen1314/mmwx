package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"miaomiaowux/internal/auth"
	"miaomiaowux/internal/storage"
)

// RenewalNotifier 由内置 TGBot Manager 实现，负责发送带复制/审批按钮的消息。
type RenewalNotifier interface {
	NotifyRenewalRequest(context.Context, *storage.RenewalRequest) error
}

type RenewalService struct {
	repo   *storage.TrafficRepository
	assign *PackageAssignHandler
}

func NewRenewalService(repo *storage.TrafficRepository, assign *PackageAssignHandler) *RenewalService {
	return &RenewalService{repo: repo, assign: assign}
}

func (s *RenewalService) Submit(ctx context.Context, username, passphrase, source string, tgID int64) (*storage.RenewalRequest, error) {
	return s.repo.CreateRenewalRequest(ctx, username, passphrase, source, tgID)
}

func (s *RenewalService) Latest(ctx context.Context, username string) (*storage.RenewalRequest, error) {
	return s.repo.GetLatestRenewalRequest(ctx, username)
}

func (s *RenewalService) History(ctx context.Context, username string, limit int) ([]storage.RenewalRequest, error) {
	return s.repo.ListRenewalRequests(ctx, username, limit)
}

func (s *RenewalService) Approve(ctx context.Context, token string, adminTGID int64) (*storage.RenewalRequest, bool, error) {
	if s == nil || s.repo == nil || s.assign == nil {
		return nil, false, errors.New("renewal service not initialized")
	}
	claimed, err := s.repo.ClaimRenewalRequest(ctx, token, adminTGID)
	if err != nil {
		return nil, false, err
	}
	if !claimed {
		req, err := s.repo.GetRenewalRequestByToken(ctx, token, false)
		return req, false, err
	}
	req, err := s.repo.GetRenewalRequestByToken(ctx, token, false)
	if err != nil {
		return nil, true, err
	}
	user, err := s.repo.GetUser(ctx, req.Username)
	if err != nil {
		_ = s.repo.FinishRenewalRequest(ctx, token, storage.RenewalFailed, nil, err.Error())
		return req, true, err
	}
	base := time.Now()
	if user.PackageEndDate != nil && user.PackageEndDate.After(base) {
		base = *user.PackageEndDate
	} else if req.PreviousEndDate != nil && req.PreviousEndDate.After(base) {
		base = *req.PreviousEndDate
	}
	newEnd := base.AddDate(0, 0, req.RenewDays)
	resetDay := user.ResetDay
	if resetDay < 1 || resetDay > 31 {
		resetDay = base.Day()
		if resetDay > 28 {
			resetDay = 28
		}
	}
	if _, err = s.assign.AssignAndProvision(ctx, req.Username, req.PackageID, time.Now(), newEnd, true, resetDay); err != nil {
		_ = s.repo.FinishRenewalRequest(ctx, token, storage.RenewalFailed, nil, err.Error())
		return req, true, err
	}
	if err = s.repo.FinishRenewalRequest(ctx, token, storage.RenewalApproved, &newEnd, ""); err != nil {
		return req, true, err
	}
	req, err = s.repo.GetRenewalRequestByToken(ctx, token, false)
	return req, true, err
}

func (s *RenewalService) Reject(ctx context.Context, token string, adminTGID int64) (*storage.RenewalRequest, bool, error) {
	claimed, err := s.repo.ClaimRenewalRequest(ctx, token, adminTGID)
	if err != nil {
		return nil, false, err
	}
	if claimed {
		if err := s.repo.FinishRenewalRequest(ctx, token, storage.RenewalRejected, nil, ""); err != nil {
			return nil, true, err
		}
	}
	req, err := s.repo.GetRenewalRequestByToken(ctx, token, false)
	return req, claimed, err
}

type UserRenewalHandler struct {
	service  *RenewalService
	notifier RenewalNotifier
}

func NewUserRenewalHandler(service *RenewalService, notifier RenewalNotifier) http.Handler {
	return &UserRenewalHandler{service: service, notifier: notifier}
}

func (h *UserRenewalHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	username := strings.TrimSpace(auth.UsernameFromContext(r.Context()))
	if username == "" {
		writeJSONError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	switch r.Method {
	case http.MethodGet:
		requests, err := h.service.History(r.Context(), username, 20)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, err.Error())
			return
		}
		var latest *storage.RenewalRequest
		if len(requests) > 0 {
			latest = &requests[0]
		}
		writeJSON(w, http.StatusOK, map[string]any{"request": latest, "requests": requests})
	case http.MethodPost:
		var body struct {
			Passphrase string `json:"passphrase"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid body")
			return
		}
		req, err := h.service.Submit(r.Context(), username, body.Passphrase, "web", 0)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
		if h.notifier == nil {
			_ = h.service.repo.FinishRenewalRequest(r.Context(), req.RequestToken, storage.RenewalFailed, nil, "TGBot 未运行")
			writeJSONError(w, http.StatusServiceUnavailable, "TGBot 未运行")
			return
		}
		if err := h.notifier.NotifyRenewalRequest(context.WithoutCancel(r.Context()), req); err != nil {
			_ = h.service.repo.FinishRenewalRequest(r.Context(), req.RequestToken, storage.RenewalFailed, nil, err.Error())
			writeJSONError(w, http.StatusBadGateway, "续费申请通知发送失败")
			return
		}
		req.Passphrase = ""
		writeJSON(w, http.StatusCreated, map[string]any{"request": req})
	default:
		writeJSONError(w, http.StatusMethodNotAllowed, errors.New("method not allowed").Error())
	}
}
