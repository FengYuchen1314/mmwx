package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"

	"miaomiaowux/internal/auth"
	"miaomiaowux/internal/storage"
)

func TestValidateManagedInboundAllowsOnlyProductProfiles(t *testing.T) {
	tests := []struct {
		name    string
		inbound map[string]interface{}
		wantErr bool
	}{
		{
			name: "vless reality vision",
			inbound: map[string]interface{}{
				"protocol":       "vless",
				"settings":       map[string]interface{}{"clients": []interface{}{map[string]interface{}{"id": "id", "flow": "xtls-rprx-vision"}}},
				"streamSettings": map[string]interface{}{"network": "tcp", "security": "reality"},
			},
		},
		{
			name: "vless xhttp reality xmux",
			inbound: map[string]interface{}{
				"protocol":       "vless",
				"settings":       map[string]interface{}{"clients": []interface{}{map[string]interface{}{"id": "id"}}},
				"streamSettings": map[string]interface{}{"network": "xhttp", "security": "reality", "xhttpSettings": map[string]interface{}{"xmux": map[string]interface{}{}}},
			},
		},
		{
			name: "anytls shadowtls",
			inbound: map[string]interface{}{
				"protocol":      "anytls",
				"settings":      map[string]interface{}{"users": []interface{}{map[string]interface{}{"password": "secret"}}},
				"mmwxShadowTLS": map[string]interface{}{"enabled": true, "handshake": "www.cloudflare.com:443", "password": "shadow-secret"},
			},
		},
		{
			name: "mieru tcp",
			inbound: map[string]interface{}{
				"protocol": "mieru",
				"settings": map[string]interface{}{"transport": "TCP", "users": []interface{}{map[string]interface{}{"username": "u", "password": "p"}}},
			},
		},
		{
			name: "socks5 password",
			inbound: map[string]interface{}{
				"protocol": "socks",
				"settings": map[string]interface{}{"auth": "password", "accounts": []interface{}{map[string]interface{}{"user": "u", "pass": "p"}}},
			},
		},
		{
			name: "vless ws is rejected",
			inbound: map[string]interface{}{
				"protocol":       "vless",
				"settings":       map[string]interface{}{"clients": []interface{}{map[string]interface{}{"id": "id"}}},
				"streamSettings": map[string]interface{}{"network": "ws", "security": "reality"},
			},
			wantErr: true,
		},
		{
			name: "trojan is rejected",
			inbound: map[string]interface{}{
				"protocol": "trojan",
				"settings": map[string]interface{}{"clients": []interface{}{map[string]interface{}{"password": "p"}}},
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateManagedInbound(tt.inbound)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ValidateManagedInbound() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func newFrontendContractTestRepo(t *testing.T) *storage.TrafficRepository {
	t.Helper()
	repo, err := storage.NewTrafficRepository(filepath.Join(t.TempDir(), "frontend-contracts.db"))
	if err != nil {
		t.Fatalf("NewTrafficRepository: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	return repo
}

func requestAs(req *http.Request, username string) *http.Request {
	return req.WithContext(auth.ContextWithUsername(req.Context(), username))
}

func newPasswordContractTestHandler(t *testing.T, password string) (http.Handler, *auth.Manager) {
	t.Helper()
	repo := newFrontendContractTestRepo(t)
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	if err := repo.CreateUser(context.Background(), "password-user", "", "Password User", string(hash), storage.RoleUser, ""); err != nil {
		t.Fatalf("create user: %v", err)
	}
	manager, err := auth.NewManager(repo)
	if err != nil {
		t.Fatalf("create auth manager: %v", err)
	}
	return NewPasswordHandler(manager), manager
}

func performPasswordChange(t *testing.T, h http.Handler, current, next string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]string{
		"current_password": current,
		"new_password":     next,
	})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/user/password", bytes.NewReader(body))
	req = requestAs(req, "password-user")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestPasswordChangePreservesLeadingAndTrailingWhitespace(t *testing.T) {
	const current = " old password "
	const next = " new password "
	h, manager := newPasswordContractTestHandler(t, current)

	rec := performPasswordChange(t, h, current, next)
	if rec.Code != http.StatusOK {
		t.Fatalf("change password status = %d, body = %s", rec.Code, rec.Body.String())
	}

	ok, err := manager.Authenticate(context.Background(), "password-user", next)
	if err != nil || !ok {
		t.Fatalf("exact new password did not authenticate: ok=%v err=%v", ok, err)
	}
	ok, err = manager.Authenticate(context.Background(), "password-user", strings.TrimSpace(next))
	if err != nil {
		t.Fatalf("authenticate trimmed password: %v", err)
	}
	if ok {
		t.Fatal("trimmed new password unexpectedly authenticated")
	}
}

func TestPasswordChangeEnforcesCharacterAndBcryptByteLimits(t *testing.T) {
	const current = "current password"
	tests := []struct {
		name       string
		password   string
		wantStatus int
	}{
		{name: "seven characters", password: "1234567", wantStatus: http.StatusBadRequest},
		{name: "four multibyte characters", password: "密码密码", wantStatus: http.StatusBadRequest},
		{name: "all whitespace", password: "        ", wantStatus: http.StatusBadRequest},
		{name: "seventy two bytes", password: strings.Repeat("密", 24), wantStatus: http.StatusOK},
		{name: "seventy three bytes", password: strings.Repeat("a", 73), wantStatus: http.StatusBadRequest},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h, manager := newPasswordContractTestHandler(t, current)
			rec := performPasswordChange(t, h, current, tc.password)
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d, body = %s", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if tc.wantStatus == http.StatusOK {
				ok, err := manager.Authenticate(context.Background(), "password-user", tc.password)
				if err != nil || !ok {
					t.Fatalf("accepted password did not authenticate: ok=%v err=%v", ok, err)
				}
			}
		})
	}
}

func TestSubscribeFileResponseAndDescriptionPatchContract(t *testing.T) {
	repo := newFrontendContractTestRepo(t)
	ctx := context.Background()
	if err := repo.CreateUser(ctx, "subscriber", "", "", "hash", storage.RoleUser, ""); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	created, err := repo.CreateSubscribeFile(ctx, storage.SubscribeFile{
		Name:        "editable",
		Description: "keep me",
		URL:         "https://example.com/subscription",
		Type:        storage.SubscribeTypeImport,
		Filename:    "editable.yaml",
		CreatedBy:   "subscriber",
	})
	if err != nil {
		t.Fatalf("CreateSubscribeFile: %v", err)
	}

	h := NewSubscribeFilesHandler(repo)
	patchURL := "/api/admin/subscribe-files/" + strconv.FormatInt(created.ID, 10)

	// Omitting description is PATCH semantics: preserve the stored value.
	req := httptest.NewRequest(http.MethodPatch, patchURL, bytes.NewBufferString(`{"name":"renamed"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, requestAs(req, "subscriber"))
	if rec.Code != http.StatusOK {
		t.Fatalf("PATCH without description status=%d body=%s", rec.Code, rec.Body.String())
	}
	stored, err := repo.GetSubscribeFileByID(ctx, created.ID)
	if err != nil {
		t.Fatalf("GetSubscribeFileByID: %v", err)
	}
	if stored.Description != "keep me" {
		t.Fatalf("omitted description changed to %q", stored.Description)
	}

	// An explicitly empty description must clear it.
	req = httptest.NewRequest(http.MethodPatch, patchURL, bytes.NewBufferString(`{"description":""}`))
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, requestAs(req, "subscriber"))
	if rec.Code != http.StatusOK {
		t.Fatalf("PATCH empty description status=%d body=%s", rec.Code, rec.Body.String())
	}
	var updated struct {
		File subscribeFileDTO `json:"file"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &updated); err != nil {
		t.Fatalf("decode update response: %v", err)
	}
	if updated.File.Description != "" {
		t.Fatalf("response description=%q, want empty", updated.File.Description)
	}
	if updated.File.URL != "https://example.com/subscription" {
		t.Fatalf("response url=%q", updated.File.URL)
	}
	stored, err = repo.GetSubscribeFileByID(ctx, created.ID)
	if err != nil {
		t.Fatalf("GetSubscribeFileByID after clear: %v", err)
	}
	if stored.Description != "" {
		t.Fatalf("explicit empty description stored as %q", stored.Description)
	}

	// Create still accepts a JSON string description and returns the same DTO contract.
	createBody := `{"name":"created-via-api","description":"created description","url":"https://example.com/new-subscription","type":"import","filename":"created-via-api.yaml"}`
	req = httptest.NewRequest(http.MethodPost, "/api/admin/subscribe-files", bytes.NewBufferString(createBody))
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, requestAs(req, "subscriber"))
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST create status=%d body=%s", rec.Code, rec.Body.String())
	}
	var createdResponse struct {
		File subscribeFileDTO `json:"file"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &createdResponse); err != nil {
		t.Fatalf("decode create response: %v", err)
	}
	if createdResponse.File.Description != "created description" || createdResponse.File.URL != "https://example.com/new-subscription" {
		t.Fatalf("create response contract mismatch: %+v", createdResponse.File)
	}

	// The list uses the same DTO and must include the source URL for editing.
	req = httptest.NewRequest(http.MethodGet, "/api/admin/subscribe-files", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, requestAs(req, "subscriber"))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET list status=%d body=%s", rec.Code, rec.Body.String())
	}
	var listed struct {
		Files []subscribeFileDTO `json:"files"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode list response: %v", err)
	}
	urls := make(map[string]bool, len(listed.Files))
	for _, file := range listed.Files {
		urls[file.URL] = true
	}
	if !urls["https://example.com/subscription"] || !urls["https://example.com/new-subscription"] {
		t.Fatalf("list response missing url: %+v", listed.Files)
	}
}

func TestTempSubscriptionPagePermissions(t *testing.T) {
	repo := newFrontendContractTestRepo(t)
	ctx := context.Background()
	if err := repo.CreateUser(ctx, "generator-user", "", "", "hash", storage.RoleUser, ""); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	h := NewTempSubscriptionHandler(repo)

	tests := []struct {
		name       string
		pages      string
		wantStatus int
	}{
		{name: "generator only", pages: `["generator"]`, wantStatus: http.StatusOK},
		{name: "legacy nodes", pages: `["nodes"]`, wantStatus: http.StatusOK},
		{name: "unrelated permission", pages: `["templates"]`, wantStatus: http.StatusForbidden},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := repo.SetSystemSetting(ctx, settingUserPeracmPages, tt.pages); err != nil {
				t.Fatalf("SetSystemSetting: %v", err)
			}
			req := httptest.NewRequest(http.MethodPost, "/api/admin/temp-subscription", bytes.NewBufferString(`{"proxies":[{"name":"demo"}]}`))
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, requestAs(req, "generator-user"))
			if rec.Code != tt.wantStatus {
				t.Fatalf("status=%d want=%d body=%s", rec.Code, tt.wantStatus, rec.Body.String())
			}
		})
	}
}

func TestAdminTemplateUpdatePreservesOwner(t *testing.T) {
	repo := newFrontendContractTestRepo(t)
	ctx := context.Background()
	if err := repo.CreateUser(ctx, "owner", "", "", "hash", storage.RoleUser, ""); err != nil {
		t.Fatalf("Create owner: %v", err)
	}
	if err := repo.CreateUser(ctx, "administrator", "", "", "hash", storage.RoleAdmin, ""); err != nil {
		t.Fatalf("Create administrator: %v", err)
	}
	id, err := repo.CreateTemplate(ctx, storage.Template{
		Name:      "owned-template",
		Category:  "clash",
		CreatedBy: "owner",
	})
	if err != nil {
		t.Fatalf("CreateTemplate: %v", err)
	}

	body := `{"name":"admin-edited","category":"clash","template_url":"https://example.com/template"}`
	req := httptest.NewRequest(http.MethodPut, "/api/admin/templates/"+strconv.FormatInt(id, 10), bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	NewTemplateHandler(repo).ServeHTTP(rec, requestAs(req, "administrator"))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT template status=%d body=%s", rec.Code, rec.Body.String())
	}

	var response templateResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.CreatedBy != "owner" {
		t.Fatalf("response owner=%q want owner", response.CreatedBy)
	}
	updated, err := repo.GetTemplateByID(ctx, id)
	if err != nil {
		t.Fatalf("GetTemplateByID: %v", err)
	}
	if updated.CreatedBy != "owner" {
		t.Fatalf("stored owner=%q want owner", updated.CreatedBy)
	}
}

func TestRecoveryCodeIsConsumedOnceAndKeepsTOTPEnabled(t *testing.T) {
	repo := newFrontendContractTestRepo(t)
	ctx := context.Background()
	if err := repo.CreateUser(ctx, "recovery-user", "", "", "hash", storage.RoleUser, ""); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := repo.SetUserTOTPSecret(ctx, "recovery-user", "totp-secret"); err != nil {
		t.Fatalf("SetUserTOTPSecret: %v", err)
	}
	plain, hashed, err := auth.GenerateRecoveryCodes(2)
	if err != nil {
		t.Fatalf("GenerateRecoveryCodes: %v", err)
	}
	hashedJSON, err := json.Marshal(hashed)
	if err != nil {
		t.Fatalf("marshal recovery codes: %v", err)
	}
	if err := repo.EnableUserTOTP(ctx, "recovery-user", string(hashedJSON)); err != nil {
		t.Fatalf("EnableUserTOTP: %v", err)
	}

	tokens := auth.NewTokenStore(time.Hour)
	pending := auth.NewTwoFactorPendingStore(time.Hour)
	h := NewRecoveryLoginHandler(tokens, repo, pending)
	login := func(code string) int {
		t.Helper()
		pendingToken, issueErr := pending.Issue("recovery-user", false)
		if issueErr != nil {
			t.Fatalf("issue pending token: %v", issueErr)
		}
		body, marshalErr := json.Marshal(map[string]string{
			"two_factor_token": pendingToken,
			"recovery_code":    code,
		})
		if marshalErr != nil {
			t.Fatalf("marshal login request: %v", marshalErr)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/login/recovery", bytes.NewReader(body))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}

	if got := login(plain[0]); got != http.StatusOK {
		t.Fatalf("first recovery login status=%d, want %d", got, http.StatusOK)
	}
	if got := login(plain[0]); got != http.StatusUnauthorized {
		t.Fatalf("reused recovery login status=%d, want %d", got, http.StatusUnauthorized)
	}

	user, err := repo.GetUser(ctx, "recovery-user")
	if err != nil {
		t.Fatalf("GetUser: %v", err)
	}
	if !user.TOTPEnabled || user.TOTPSecret != "totp-secret" {
		t.Fatalf("recovery login changed TOTP state: enabled=%v secret=%q", user.TOTPEnabled, user.TOTPSecret)
	}
	remaining, err := parseRecoveryCodes(user.RecoveryCodes)
	if err != nil {
		t.Fatalf("parse stored recovery codes: %v", err)
	}
	if len(remaining) != 1 || remaining[0] != hashed[1] {
		t.Fatalf("remaining recovery codes=%v, want only the unused code", remaining)
	}
}

func TestConsumeUserRecoveryCodesCASAllowsOnlyOneConcurrentWinner(t *testing.T) {
	repo := newFrontendContractTestRepo(t)
	ctx := context.Background()
	if err := repo.CreateUser(ctx, "recovery-race", "", "", "hash", storage.RoleUser, ""); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := repo.SetUserTOTPSecret(ctx, "recovery-race", "race-secret"); err != nil {
		t.Fatalf("SetUserTOTPSecret: %v", err)
	}
	_, hashed, err := auth.GenerateRecoveryCodes(2)
	if err != nil {
		t.Fatalf("GenerateRecoveryCodes: %v", err)
	}
	previous, err := json.Marshal(hashed)
	if err != nil {
		t.Fatalf("marshal previous recovery codes: %v", err)
	}
	remaining, err := json.Marshal(hashed[1:])
	if err != nil {
		t.Fatalf("marshal remaining recovery codes: %v", err)
	}
	if err := repo.EnableUserTOTP(ctx, "recovery-race", string(previous)); err != nil {
		t.Fatalf("EnableUserTOTP: %v", err)
	}

	type result struct {
		consumed bool
		err      error
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	for range 2 {
		go func() {
			<-start
			consumed, consumeErr := repo.ConsumeUserRecoveryCodes(ctx, "recovery-race", string(previous), string(remaining))
			results <- result{consumed: consumed, err: consumeErr}
		}()
	}
	close(start)

	winners := 0
	for range 2 {
		got := <-results
		if got.err != nil {
			t.Fatalf("ConsumeUserRecoveryCodes: %v", got.err)
		}
		if got.consumed {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("concurrent CAS winners=%d, want 1", winners)
	}

	user, err := repo.GetUser(ctx, "recovery-race")
	if err != nil {
		t.Fatalf("GetUser: %v", err)
	}
	if !user.TOTPEnabled || user.TOTPSecret != "race-secret" || user.RecoveryCodes != string(remaining) {
		t.Fatalf("unexpected stored TOTP state: enabled=%v secret=%q codes=%q", user.TOTPEnabled, user.TOTPSecret, user.RecoveryCodes)
	}
}

func TestSilentModeShortCodeAlphabet(t *testing.T) {
	tests := []struct {
		code string
		want bool
	}{
		{code: "AbC123", want: true},
		{code: "file_user", want: true},
		{code: "file-user", want: true},
		{code: "file/user", want: false},
		{code: "file.user", want: false},
		{code: "file user", want: false},
		{code: "短码", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.code, func(t *testing.T) {
			if got := isAlphanumericPath(tt.code); got != tt.want {
				t.Fatalf("isAlphanumericPath(%q) = %v, want %v", tt.code, got, tt.want)
			}
		})
	}
}

func TestActiveAnnouncementsKeepNodeTargeting(t *testing.T) {
	repo := newFrontendContractTestRepo(t)
	ctx := context.Background()
	for _, user := range []struct{ name, role string }{{"alice", storage.RoleUser}, {"admin", storage.RoleAdmin}} {
		if err := repo.CreateUser(ctx, user.name, "", user.name, "hash", user.role, ""); err != nil {
			t.Fatal(err)
		}
	}
	nodeA, err := repo.CreateNode(ctx, storage.Node{Username: "admin", NodeName: "node-a", Protocol: "ss", ClashConfig: `{"name":"node-a"}`, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	nodeB, err := repo.CreateNode(ctx, storage.Node{Username: "admin", NodeName: "node-b", Protocol: "ss", ClashConfig: `{"name":"node-b"}`, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	pkgID, err := repo.CreatePackage(ctx, storage.Package{Name: "package-a", Nodes: []int64{nodeA.ID}})
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.AssignPackageToUser(ctx, "alice", pkgID, time.Now(), time.Now().Add(24*time.Hour), false, 1); err != nil {
		t.Fatal(err)
	}
	for _, item := range []storage.Announcement{
		{Type: AnnounceTypeNodeBlocked, Title: "node-a", Body: "a", NodeID: nodeA.ID, ViaBot: true, ViaMiniapp: true},
		{Type: AnnounceTypeNodeBlocked, Title: "node-b", Body: "b", NodeID: nodeB.ID, ViaBot: true, ViaMiniapp: true},
	} {
		if _, err := repo.CreateAnnouncement(ctx, item); err != nil {
			t.Fatal(err)
		}
	}

	pending, err := repo.ListPendingBotAnnouncements(ctx)
	if err != nil || len(pending) != 2 || pending[0].NodeID == 0 || pending[1].NodeID == 0 {
		t.Fatalf("pending announcements lost node targeting: %#v, %v", pending, err)
	}

	visibleFor := func(username string) []storage.Announcement {
		t.Helper()
		req := requestAs(httptest.NewRequest(http.MethodGet, "/api/announcements/active", nil), username)
		rec := httptest.NewRecorder()
		NewAnnouncementHandler(repo, nil).GetActive(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		var payload struct {
			Announcements []storage.Announcement `json:"announcements"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		return payload.Announcements
	}
	if got := visibleFor("alice"); len(got) != 1 || got[0].NodeID != nodeA.ID {
		t.Fatalf("alice saw announcements outside her package: %#v", got)
	}
	if got := visibleFor("admin"); len(got) != 2 {
		t.Fatalf("admin should retain the full view: %#v", got)
	}
}

func TestCreateRemoteServerPersistsNodeEntryPolicy(t *testing.T) {
	repo := newFrontendContractTestRepo(t)
	body := bytes.NewBufferString(`{"name":"edge-a","connection_mode":"websocket","lock_entry_ip":true,"port_range_min":21000,"port_range_max":21999}`)
	req := httptest.NewRequest(http.MethodPost, "http://panel.example/api/admin/remote-servers/create", body)
	rec := httptest.NewRecorder()
	NewXrayServerHandler(repo, nil, nil).CreateRemoteServer(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var payload RemoteServerResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.Success || payload.Server == nil || payload.Server.ID <= 0 {
		t.Fatalf("unexpected create response: %#v", payload)
	}
	stored, err := repo.GetRemoteServer(context.Background(), payload.Server.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !stored.LockEntryIP || stored.PortRangeMin != 21000 || stored.PortRangeMax != 21999 {
		t.Fatalf("node entry policy was not persisted: lock=%v range=%d-%d", stored.LockEntryIP, stored.PortRangeMin, stored.PortRangeMax)
	}
}

func TestSubscribeFilenameRejectsTraversalForEveryCreatePath(t *testing.T) {
	for _, filename := range []string{"../escape.yaml", `folder\\escape.yaml`, "..\\escape.yml", "folder/file.yml"} {
		t.Run(filename, func(t *testing.T) {
			if _, err := sanitizeSubscribeFilename(filename); err == nil {
				t.Fatalf("sanitizeSubscribeFilename(%q) unexpectedly succeeded", filename)
			}
		})
	}
}
