package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"

	"golang.org/x/crypto/bcrypt"

	"miaomiaowux/internal/storage"
)

func newSetupTestRepository(t *testing.T) *storage.TrafficRepository {
	t.Helper()
	repo, err := storage.NewTrafficRepository(filepath.Join(t.TempDir(), "setup.db"))
	if err != nil {
		t.Fatalf("create repository: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	return repo
}

func setupRequestForTest(t *testing.T, h http.Handler, payload map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/setup/init", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestInitialSetupValidatesRegistrationFields(t *testing.T) {
	repo := newSetupTestRepository(t)
	h := NewInitialSetupHandler(repo, t.TempDir())

	tests := []struct {
		name    string
		payload map[string]any
	}{
		{"invalid username", map[string]any{"username": "a_b", "password": "password123"}},
		{"short password", map[string]any{"username": "owner", "password": "short"}},
		{"invalid email", map[string]any{"username": "owner", "password": "password123", "email": "not-an-email"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if rec := setupRequestForTest(t, h, tc.payload); rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusBadRequest, rec.Body.String())
			}
		})
	}
}

func TestInitialSetupCreatesOnlyOneAdministratorAndPreservesPassword(t *testing.T) {
	repo := newSetupTestRepository(t)
	h := NewInitialSetupHandler(repo, t.TempDir())
	password := "  strong-password  "

	rec := setupRequestForTest(t, h, map[string]any{
		"username": "owner-1",
		"password": password,
		"nickname": "站长",
		"email":    "owner@example.com",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusCreated, rec.Body.String())
	}

	user, err := repo.GetUser(context.Background(), "owner-1")
	if err != nil {
		t.Fatalf("load user: %v", err)
	}
	if user.Role != storage.RoleAdmin || !user.IsActive {
		t.Fatalf("created user is not an active administrator: %#v", user)
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		t.Fatalf("stored password differs from submitted password: %v", err)
	}
	if got := repo.GetPrimaryAdminUsername(context.Background()); got != "owner-1" {
		t.Fatalf("primary administrator = %q, want owner-1", got)
	}

	second := setupRequestForTest(t, h, map[string]any{"username": "owner-2", "password": "password456"})
	if second.Code != http.StatusConflict {
		t.Fatalf("second setup status = %d, want %d; body=%s", second.Code, http.StatusConflict, second.Body.String())
	}
}

func TestSetupStatusTracksFirstRun(t *testing.T) {
	repo := newSetupTestRepository(t)
	statusHandler := NewSetupStatusHandler(repo)

	requestStatus := func() bool {
		rec := httptest.NewRecorder()
		statusHandler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/setup/status", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("status endpoint returned %d", rec.Code)
		}
		var response setupStatusResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
			t.Fatalf("decode status: %v", err)
		}
		return response.NeedsSetup
	}

	if !requestStatus() {
		t.Fatal("empty repository should require setup")
	}
	setup := setupRequestForTest(t, NewInitialSetupHandler(repo, t.TempDir()), map[string]any{
		"username": "owner",
		"password": "password123",
	})
	if setup.Code != http.StatusCreated {
		t.Fatalf("setup status = %d; body=%s", setup.Code, setup.Body.String())
	}
	if requestStatus() {
		t.Fatal("initialized repository should not require setup")
	}
}

func TestInitialSetupSerializesConcurrentRegistrations(t *testing.T) {
	repo := newSetupTestRepository(t)
	h := NewInitialSetupHandler(repo, t.TempDir())

	start := make(chan struct{})
	statuses := make(chan int, 2)
	var wg sync.WaitGroup
	for _, username := range []string{"owner-a", "owner-b"} {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			<-start
			statuses <- setupRequestForTest(t, h, map[string]any{"username": name, "password": "password123"}).Code
		}(username)
	}
	close(start)
	wg.Wait()
	close(statuses)

	created, conflicted := 0, 0
	for status := range statuses {
		switch status {
		case http.StatusCreated:
			created++
		case http.StatusConflict:
			conflicted++
		default:
			t.Fatalf("unexpected setup status: %d", status)
		}
	}
	if created != 1 || conflicted != 1 {
		t.Fatalf("created=%d conflicted=%d, want one of each", created, conflicted)
	}

	users, err := repo.ListUsers(context.Background(), 10)
	if err != nil {
		t.Fatalf("list users: %v", err)
	}
	if len(users) != 1 {
		t.Fatalf("user count=%d, want 1", len(users))
	}
}
