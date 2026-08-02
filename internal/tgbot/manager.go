package tgbot

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"miaomiaowux/internal/auth"
	"miaomiaowux/internal/storage"
	"miaomiaowux/internal/tgbot/bot"
	"miaomiaowux/internal/tgbot/config"
	"miaomiaowux/internal/tgbot/mmwxclient"
)

const (
	settingEnabled    = "tgbot_enabled"
	settingToken      = "tgbot_token"
	settingAdminIDs   = "tgbot_admin_ids"
	settingDevPreview = "tgbot_webapp_dev_preview"
	settingBotURL     = "tgbot_url"
)

type Settings struct {
	Enabled       bool    `json:"enabled"`
	BotToken      string  `json:"bot_token"`
	AdminTGIDs    []int64 `json:"admin_tg_ids"`
	WebDevPreview bool    `json:"webapp_dev_preview"`
	Running       bool    `json:"running"`
	BotURL        string  `json:"bot_url"`
}

type Manager struct {
	mu      sync.Mutex
	repo    *storage.TrafficRepository
	tokens  *auth.TokenStore
	handler http.Handler
	service *bot.Service
	cancel  context.CancelFunc
	running bool
}

func NewManager(repo *storage.TrafficRepository, tokens *auth.TokenStore, handler http.Handler) *Manager {
	return &Manager{repo: repo, tokens: tokens, handler: handler}
}

// EnsurePublicBaseURL records the address observed by the settings request only
// when the administrator has not explicitly configured a master URL yet.
func (m *Manager) EnsurePublicBaseURL(ctx context.Context, observed string) error {
	current, _ := m.repo.GetSystemSetting(ctx, "master_url")
	if strings.TrimSpace(current) != "" || strings.TrimSpace(observed) == "" {
		return nil
	}
	return m.repo.SetSystemSetting(ctx, "master_url", strings.TrimRight(strings.TrimSpace(observed), "/"))
}

func (m *Manager) Load(ctx context.Context, revealToken bool) Settings {
	s := Settings{AdminTGIDs: []int64{}}
	s.Enabled = readBool(ctx, m.repo, settingEnabled)
	s.BotToken, _ = m.repo.GetSystemSetting(ctx, settingToken)
	if !revealToken && s.BotToken != "" {
		s.BotToken = mask(s.BotToken)
	}
	if raw, _ := m.repo.GetSystemSetting(ctx, settingAdminIDs); raw != "" {
		_ = json.Unmarshal([]byte(raw), &s.AdminTGIDs)
	}
	s.WebDevPreview = readBool(ctx, m.repo, settingDevPreview)
	s.BotURL, _ = m.repo.GetSystemSetting(ctx, settingBotURL)
	m.mu.Lock()
	s.Running = m.running
	m.mu.Unlock()
	return s
}

func (m *Manager) SaveAndRestart(ctx context.Context, next Settings) error {
	current := m.Load(ctx, true)
	if strings.Contains(next.BotToken, "****") {
		next.BotToken = current.BotToken
	}
	next.BotToken = strings.TrimSpace(next.BotToken)
	if next.Enabled && next.BotToken == "" {
		return errors.New("启用 TGBot 前请填写 Bot Token")
	}
	ids, _ := json.Marshal(next.AdminTGIDs)
	pairs := map[string]string{
		settingEnabled: strconv.FormatBool(next.Enabled), settingToken: next.BotToken,
		settingAdminIDs: string(ids), settingDevPreview: strconv.FormatBool(next.WebDevPreview),
	}
	for key, value := range pairs {
		if err := m.repo.SetSystemSetting(ctx, key, value); err != nil {
			return err
		}
	}
	return m.Restart(context.Background())
}

func (m *Manager) Restart(parent context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopLocked()
	s := m.loadUnlocked(parent)
	if !s.Enabled {
		return nil
	}
	adminUsername := ""
	users, err := m.repo.ListUsers(parent, 1000)
	if err != nil {
		return err
	}
	for _, user := range users {
		if user.Role == storage.RoleAdmin {
			adminUsername = user.Username
			break
		}
	}
	if adminUsername == "" {
		return errors.New("未找到管理员账号")
	}
	token, _, err := m.tokens.IssueWithTTL(adminUsername, 365*24*time.Hour)
	if err != nil {
		return err
	}
	masterURL, _ := m.repo.GetSystemSetting(parent, "master_url")
	masterURL = strings.TrimRight(strings.TrimSpace(masterURL), "/")
	if masterURL == "" {
		m.tokens.Revoke(token)
		return errors.New("请先配置主控公网地址，再启用 TGBot")
	}
	subscriptionURL, _ := m.repo.GetSystemSetting(parent, "subscription_url")
	subscriptionURL = strings.TrimRight(strings.TrimSpace(subscriptionURL), "/")
	if subscriptionURL == "" {
		subscriptionURL = masterURL
	}
	cfg := config.Config{
		Enabled: true, PublicBaseURL: masterURL, SubscriptionBaseURL: subscriptionURL, TGBotToken: s.BotToken,
		AdminTGIDs: s.AdminTGIDs, HTTPTimeoutSeconds: 30,
		WebAppURL: masterURL + "/tg-app", WebAppDevPreview: s.WebDevPreview,
	}
	client := mmwxclient.NewInProcess(m.handler, token, 30)
	service := bot.New(cfg, client)
	ctx, cancel := context.WithCancel(parent)
	if err := service.Start(ctx); err != nil {
		cancel()
		m.tokens.Revoke(token)
		return err
	}
	if botURL := service.BotURL(); botURL != "" {
		if err := m.repo.SetSystemSetting(parent, settingBotURL, botURL); err != nil {
			cancel()
			service.Stop()
			m.tokens.Revoke(token)
			return err
		}
	}
	m.cancel = func() { cancel(); service.Stop(); m.tokens.Revoke(token) }
	m.service = service
	m.running = true
	return nil
}

func (m *Manager) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopLocked()
}

func (m *Manager) stopLocked() {
	if m.cancel != nil {
		m.cancel()
	}
	m.cancel, m.service, m.running = nil, nil, false
}

func (m *Manager) loadUnlocked(ctx context.Context) Settings {
	s := Settings{AdminTGIDs: []int64{}}
	s.Enabled = readBool(ctx, m.repo, settingEnabled)
	s.BotToken, _ = m.repo.GetSystemSetting(ctx, settingToken)
	if raw, _ := m.repo.GetSystemSetting(ctx, settingAdminIDs); raw != "" {
		_ = json.Unmarshal([]byte(raw), &s.AdminTGIDs)
	}
	s.WebDevPreview = readBool(ctx, m.repo, settingDevPreview)
	return s
}

func (m *Manager) ServeWebApp(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	service := m.service
	m.mu.Unlock()
	if service == nil {
		http.Error(w, "TGBot is not enabled", http.StatusServiceUnavailable)
		return
	}
	service.ServeWebApp(w, r)
}

func (m *Manager) NotifyRenewalRequest(ctx context.Context, req *storage.RenewalRequest) error {
	m.mu.Lock()
	service := m.service
	m.mu.Unlock()
	if service == nil {
		return errors.New("TGBot 未运行")
	}
	previous := ""
	if req.PreviousEndDate != nil {
		previous = req.PreviousEndDate.Format(time.RFC3339)
	}
	return service.NotifyRenewalRequest(ctx, bot.RenewalNotice{
		Token: req.RequestToken, Username: req.Username, TelegramID: req.TelegramID,
		PackageName: req.PackageName, PreviousEndDate: previous, RenewDays: req.RenewDays,
		Source: req.Source, Passphrase: req.Passphrase,
	})
}

func readBool(ctx context.Context, repo *storage.TrafficRepository, key string) bool {
	v, _ := repo.GetSystemSetting(ctx, key)
	b, _ := strconv.ParseBool(v)
	return b
}

func mask(value string) string {
	if len(value) < 10 {
		return "****"
	}
	return value[:4] + "****" + value[len(value)-4:]
}
