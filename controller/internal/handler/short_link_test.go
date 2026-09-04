package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"miaomiaowux/internal/auth"
	"miaomiaowux/internal/storage"
)

type shortLinkTestFixture struct {
	repo          *storage.TrafficRepository
	handler       *shortLinkHandler
	file          storage.SubscribeFile
	userShortCode string
	served        int
}

func newShortLinkTestFixture(t *testing.T) *shortLinkTestFixture {
	t.Helper()
	repo := newFrontendContractTestRepo(t)
	ctx := context.Background()

	if err := repo.CreateUser(ctx, "alice", "alice@example.test", "Alice", "hash", storage.RoleUser, ""); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if _, err := repo.GetOrCreateUserToken(ctx, "alice"); err != nil {
		t.Fatalf("GetOrCreateUserToken: %v", err)
	}
	userShortCode, err := repo.GetEffectiveUserShortCode(ctx, "alice")
	if err != nil {
		t.Fatalf("GetEffectiveUserShortCode: %v", err)
	}
	file, err := repo.CreateSubscribeFile(ctx, storage.SubscribeFile{
		Name:      "Alice package",
		Type:      storage.SubscribeTypePackage,
		Filename:  "alice-package.yaml",
		CreatedBy: "alice",
	})
	if err != nil {
		t.Fatalf("CreateSubscribeFile: %v", err)
	}
	subscribeDir := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(subscribeDir, file.Filename),
		[]byte("proxies: []\nproxy-groups: []\nrules: []\n"),
		0o600,
	); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	fixture := &shortLinkTestFixture{
		repo:          repo,
		file:          file,
		userShortCode: userShortCode,
	}
	packageHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fixture.served++
		if got := auth.UsernameFromContext(r.Context()); got != "alice" {
			t.Errorf("package username = %q, want alice", got)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	fixture.handler = NewShortLinkHandler(
		repo,
		NewSubscriptionHandlerConcrete(repo, subscribeDir),
		packageHandler,
	)
	return fixture
}

func (f *shortLinkTestFixture) setSwitches(t *testing.T, global, user bool) {
	t.Helper()
	ctx := context.Background()
	cfg, err := f.repo.GetSystemConfig(ctx)
	if err != nil {
		t.Fatalf("GetSystemConfig: %v", err)
	}
	cfg.EnableShortLink = global
	if err := f.repo.UpdateSystemConfig(ctx, cfg); err != nil {
		t.Fatalf("UpdateSystemConfig: %v", err)
	}
	if err := f.repo.UpsertUserSettings(ctx, storage.UserSettings{
		Username:        "alice",
		EnableShortLink: user,
	}); err != nil {
		t.Fatalf("UpsertUserSettings: %v", err)
	}
}

func TestShortLinkHandlerRequiresGlobalAndUserSwitches(t *testing.T) {
	fixture := newShortLinkTestFixture(t)

	tests := []struct {
		name                string
		global              bool
		user                bool
		wantDirectStatus    int
		wantCompositeStatus int
		wantServed          int
	}{
		{name: "both enabled", global: true, user: true, wantDirectStatus: http.StatusNoContent, wantCompositeStatus: http.StatusOK, wantServed: 1},
		{name: "global disabled", global: false, user: true, wantDirectStatus: http.StatusNotFound, wantCompositeStatus: http.StatusNotFound, wantServed: 0},
		{name: "user disabled", global: true, user: false, wantDirectStatus: http.StatusNotFound, wantCompositeStatus: http.StatusNotFound, wantServed: 0},
	}

	// Exercise both accepted formats: the direct file code and the generated
	// file-code + user-code form returned by the subscription list.
	codes := map[string]string{
		"direct":    fixture.file.FileShortCode,
		"composite": fixture.file.FileShortCode + fixture.userShortCode,
	}
	for format, code := range codes {
		for _, tt := range tests {
			t.Run(format+"/"+tt.name, func(t *testing.T) {
				fixture.setSwitches(t, tt.global, tt.user)
				fixture.served = 0
				recorder := httptest.NewRecorder()
				request := httptest.NewRequest(http.MethodGet, "/x/"+code, nil)
				fixture.handler.ServeHTTP(recorder, request)
				wantStatus := tt.wantDirectStatus
				if format == "composite" {
					wantStatus = tt.wantCompositeStatus
				}
				if recorder.Code != wantStatus {
					t.Fatalf("status = %d, body = %q, want %d", recorder.Code, recorder.Body.String(), wantStatus)
				}
				wantServed := tt.wantServed
				if format == "composite" {
					wantServed = 0
				}
				if fixture.served != wantServed {
					t.Fatalf("package handler calls = %d, want %d", fixture.served, wantServed)
				}
			})
		}
	}
}

func TestSubscriptionListRequiresGlobalAndUserSwitchesForShortURLs(t *testing.T) {
	fixture := newShortLinkTestFixture(t)
	ctx := context.Background()
	if err := fixture.repo.AssignSubscriptionToUser(ctx, "alice", fixture.file.ID); err != nil {
		t.Fatalf("AssignSubscriptionToUser: %v", err)
	}
	if err := fixture.repo.SetSystemSetting(ctx, "subscription_url", "https://subs.example.test"); err != nil {
		t.Fatalf("SetSystemSetting: %v", err)
	}
	h := NewSubscriptionListHandler(fixture.repo)

	tests := []struct {
		name           string
		global         bool
		user           bool
		wantShort      bool
		wantPathPrefix string
	}{
		{name: "both enabled", global: true, user: true, wantShort: true, wantPathPrefix: "https://subs.example.test/x/"},
		{name: "global disabled", global: false, user: true, wantPathPrefix: "https://subs.example.test/api/package/subscribe?"},
		{name: "user disabled", global: true, user: false, wantPathPrefix: "https://subs.example.test/api/package/subscribe?"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fixture.setSwitches(t, tt.global, tt.user)
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/api/subscriptions", nil)
			request = request.WithContext(auth.ContextWithUsername(request.Context(), "alice"))
			h.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %q", recorder.Code, recorder.Body.String())
			}

			var response struct {
				UserShortCode string `json:"user_short_code"`
				Subscriptions []struct {
					FileShortCode   string `json:"file_short_code"`
					CustomShortCode string `json:"custom_short_code"`
					URL             string `json:"url"`
				} `json:"subscriptions"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if len(response.Subscriptions) != 1 {
				t.Fatalf("subscriptions = %d, want 1: %s", len(response.Subscriptions), recorder.Body.String())
			}
			item := response.Subscriptions[0]
			if !strings.HasPrefix(item.URL, tt.wantPathPrefix) {
				t.Fatalf("url = %q, want prefix %q", item.URL, tt.wantPathPrefix)
			}
			if tt.wantShort {
				if response.UserShortCode == "" || item.FileShortCode == "" {
					t.Fatalf("enabled response omitted short codes: %s", recorder.Body.String())
				}
				return
			}
			if response.UserShortCode != "" || item.FileShortCode != "" || item.CustomShortCode != "" {
				t.Fatalf("disabled response exposed short codes: %s", recorder.Body.String())
			}
		})
	}
}
