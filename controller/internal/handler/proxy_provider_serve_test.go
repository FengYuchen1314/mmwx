package handler

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"miaomiaowux/internal/storage"

	"gopkg.in/yaml.v3"
)

type proxyProviderServeFixture struct {
	repo          *storage.TrafficRepository
	handler       *ProxyProviderServeHandler
	aliceToken    string
	aliceMMWID    int64
	aliceClientID int64
	bobMMWID      int64
}

func newProxyProviderServeFixture(t *testing.T) proxyProviderServeFixture {
	return newProxyProviderServeFixtureWithSettings(t, true)
}

func newProxyProviderServeFixtureWithSettings(t *testing.T, createEnabledSettings bool) proxyProviderServeFixture {
	t.Helper()
	repo := newFrontendContractTestRepo(t)
	ctx := context.Background()

	for _, username := range []string{"alice", "bob"} {
		if err := repo.CreateUser(ctx, username, username+"@example.test", username, "hash", storage.RoleUser, ""); err != nil {
			t.Fatalf("CreateUser(%s): %v", username, err)
		}
	}
	if createEnabledSettings {
		for _, username := range []string{"alice", "bob"} {
			if err := repo.UpsertUserSettings(ctx, storage.UserSettings{
				Username:             username,
				KeepNodeName:         true,
				UseNewTemplateSystem: true,
				EnableProxyProvider:  true,
			}); err != nil {
				t.Fatalf("UpsertUserSettings(%s): %v", username, err)
			}
		}
	}

	aliceToken, err := repo.GetOrCreateUserToken(ctx, "alice")
	if err != nil {
		t.Fatalf("GetOrCreateUserToken(alice): %v", err)
	}

	aliceSubID, err := repo.CreateExternalSubscription(ctx, storage.ExternalSubscription{
		Username: "alice",
		Name:     "alice-source",
		URL:      "https://alice.example.test/subscription.yaml",
	})
	if err != nil {
		t.Fatalf("CreateExternalSubscription(alice): %v", err)
	}
	bobSubID, err := repo.CreateExternalSubscription(ctx, storage.ExternalSubscription{
		Username: "bob",
		Name:     "bob-source",
		URL:      "https://bob.example.test/subscription.yaml",
	})
	if err != nil {
		t.Fatalf("CreateExternalSubscription(bob): %v", err)
	}

	createConfig := func(config storage.ProxyProviderConfig) int64 {
		t.Helper()
		id, createErr := repo.CreateProxyProviderConfig(ctx, &config)
		if createErr != nil {
			t.Fatalf("CreateProxyProviderConfig(%s): %v", config.Name, createErr)
		}
		return id
	}

	aliceMMWID := createConfig(storage.ProxyProviderConfig{
		Username:               "alice",
		ExternalSubscriptionID: aliceSubID,
		Name:                   "alice-mmw",
		Type:                   "http",
		ProcessMode:            "mmw",
		Filter:                 `^(keep|drop)-`,
		ExcludeFilter:          `^drop-`,
		Override:               `{"server":"override.example","udp":true}`,
	})
	aliceClientID := createConfig(storage.ProxyProviderConfig{
		Username:               "alice",
		ExternalSubscriptionID: aliceSubID,
		Name:                   "alice-client",
		Type:                   "http",
		ProcessMode:            "client",
	})
	bobMMWID := createConfig(storage.ProxyProviderConfig{
		Username:               "bob",
		ExternalSubscriptionID: bobSubID,
		Name:                   "bob-mmw",
		Type:                   "http",
		ProcessMode:            "mmw",
	})

	return proxyProviderServeFixture{
		repo:          repo,
		handler:       NewProxyProviderServeHandler(repo).(*ProxyProviderServeHandler),
		aliceToken:    aliceToken,
		aliceMMWID:    aliceMMWID,
		aliceClientID: aliceClientID,
		bobMMWID:      bobMMWID,
	}
}

func serveProxyProvider(handler http.Handler, method, target string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(method, target, nil))
	return recorder
}

func TestProxyProviderServeRejectsNonGetAndMalformedPaths(t *testing.T) {
	fixture := newProxyProviderServeFixture(t)
	validTarget := fmt.Sprintf("/api/proxy-provider/%d?token=%s", fixture.aliceMMWID, fixture.aliceToken)

	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodHead} {
		t.Run(method, func(t *testing.T) {
			response := serveProxyProvider(fixture.handler, method, validTarget)
			if response.Code != http.StatusMethodNotAllowed {
				t.Fatalf("status=%d body=%s, want %d", response.Code, response.Body.String(), http.StatusMethodNotAllowed)
			}
		})
	}

	for _, path := range []string{
		"/api/proxy-provider/",
		"/api/proxy-provider/not-a-number",
		"/api/proxy-provider/0",
		"/api/proxy-provider/-1",
		"/api/proxy-provider/1/extra",
		"/wrong-prefix/1",
	} {
		t.Run(path, func(t *testing.T) {
			response := serveProxyProvider(fixture.handler, http.MethodGet, path+"?token="+fixture.aliceToken)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s, want %d", response.Code, response.Body.String(), http.StatusBadRequest)
			}
		})
	}
}

func TestProxyProviderServeRequiresSubscriptionToken(t *testing.T) {
	fixture := newProxyProviderServeFixture(t)
	response := serveProxyProvider(
		fixture.handler,
		http.MethodGet,
		fmt.Sprintf("/api/proxy-provider/%d", fixture.aliceMMWID),
	)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s, want %d", response.Code, response.Body.String(), http.StatusUnauthorized)
	}
}

func TestProxyProviderServeRequiresEnabledUserSetting(t *testing.T) {
	assertHidden := func(t *testing.T, fixture proxyProviderServeFixture) {
		t.Helper()
		fetchCalled := false
		fixture.handler.fetch = func(*storage.ExternalSubscription, *storage.ProxyProviderConfig) ([]byte, error) {
			fetchCalled = true
			return []byte("proxies: []\n"), nil
		}
		response := serveProxyProvider(
			fixture.handler,
			http.MethodGet,
			fmt.Sprintf("/api/proxy-provider/%d?token=%s", fixture.aliceMMWID, fixture.aliceToken),
		)
		if response.Code != http.StatusNotFound {
			t.Fatalf("status=%d body=%s, want %d", response.Code, response.Body.String(), http.StatusNotFound)
		}
		if fetchCalled {
			t.Fatal("disabled provider request reached the fetch function")
		}
	}

	t.Run("missing historical settings row keeps the false default", func(t *testing.T) {
		assertHidden(t, newProxyProviderServeFixtureWithSettings(t, false))
	})

	t.Run("explicitly disabled", func(t *testing.T) {
		fixture := newProxyProviderServeFixture(t)
		settings, err := fixture.repo.GetUserSettings(context.Background(), "alice")
		if err != nil {
			t.Fatalf("GetUserSettings(alice): %v", err)
		}
		settings.EnableProxyProvider = false
		if err := fixture.repo.UpsertUserSettings(context.Background(), settings); err != nil {
			t.Fatalf("disable provider setting: %v", err)
		}
		assertHidden(t, fixture)
	})
}

func TestProxyProviderServeHidesCrossUserConfigs(t *testing.T) {
	fixture := newProxyProviderServeFixture(t)
	fetchCalled := false
	fixture.handler.fetch = func(*storage.ExternalSubscription, *storage.ProxyProviderConfig) ([]byte, error) {
		fetchCalled = true
		return []byte("proxies: []\n"), nil
	}

	response := serveProxyProvider(
		fixture.handler,
		http.MethodGet,
		fmt.Sprintf("/api/proxy-provider/%d?token=%s", fixture.bobMMWID, fixture.aliceToken),
	)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s, want %d", response.Code, response.Body.String(), http.StatusNotFound)
	}
	if fetchCalled {
		t.Fatal("cross-user request reached the provider fetch function")
	}
}

func TestProxyProviderServeRejectsClientMode(t *testing.T) {
	fixture := newProxyProviderServeFixture(t)
	fetchCalled := false
	fixture.handler.fetch = func(*storage.ExternalSubscription, *storage.ProxyProviderConfig) ([]byte, error) {
		fetchCalled = true
		return []byte("proxies: []\n"), nil
	}

	response := serveProxyProvider(
		fixture.handler,
		http.MethodGet,
		fmt.Sprintf("/api/proxy-provider/%d?token=%s", fixture.aliceClientID, fixture.aliceToken),
	)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s, want %d", response.Code, response.Body.String(), http.StatusBadRequest)
	}
	if fetchCalled {
		t.Fatal("client-mode request reached the provider fetch function")
	}
}

func TestProxyProviderServeMMWFiltersExcludesAndOverrides(t *testing.T) {
	fixture := newProxyProviderServeFixture(t)
	fixture.handler.fetch = func(_ *storage.ExternalSubscription, config *storage.ProxyProviderConfig) ([]byte, error) {
		const source = `proxies:
  - {name: keep-one, type: ss, server: keep.example, port: 443}
  - {name: drop-one, type: ss, server: drop.example, port: 443}
  - {name: outside-filter, type: ss, server: outside.example, port: 443}
`
		var root yaml.Node
		if err := yaml.Unmarshal([]byte(source), &root); err != nil {
			return nil, err
		}
		filtered, err := filterProxyProviderNodes(findProxiesNode(&root), config)
		if err != nil {
			return nil, err
		}
		if err := applyProxyProviderOverrides(filtered, config.Override); err != nil {
			return nil, err
		}
		output := &yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{
			Kind: yaml.MappingNode,
			Content: []*yaml.Node{
				{Kind: yaml.ScalarNode, Value: "proxies"},
				filtered,
			},
		}}}
		return yaml.Marshal(output)
	}

	response := serveProxyProvider(
		fixture.handler,
		http.MethodGet,
		fmt.Sprintf("/api/proxy-provider/%d?token=%s", fixture.aliceMMWID, fixture.aliceToken),
	)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s, want %d", response.Code, response.Body.String(), http.StatusOK)
	}
	if contentType := response.Header().Get("Content-Type"); contentType != "application/yaml; charset=utf-8" {
		t.Fatalf("Content-Type=%q", contentType)
	}

	var payload struct {
		Proxies []map[string]any `yaml:"proxies"`
	}
	if err := yaml.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response YAML: %v\n%s", err, response.Body.String())
	}
	if len(payload.Proxies) != 1 {
		t.Fatalf("proxies=%#v, want exactly one included, non-excluded proxy", payload.Proxies)
	}
	proxy := payload.Proxies[0]
	if proxy["name"] != "keep-one" || proxy["server"] != "override.example" || proxy["udp"] != true {
		t.Fatalf("filter/exclude/override result=%#v", proxy)
	}
}

func TestProxyProviderServeReturnsBadGatewayForFetchFailure(t *testing.T) {
	fixture := newProxyProviderServeFixture(t)
	fixture.handler.fetch = func(*storage.ExternalSubscription, *storage.ProxyProviderConfig) ([]byte, error) {
		return nil, errors.New("upstream secret failure")
	}

	response := serveProxyProvider(
		fixture.handler,
		http.MethodGet,
		fmt.Sprintf("/api/proxy-provider/%d?token=%s", fixture.aliceMMWID, fixture.aliceToken),
	)
	if response.Code != http.StatusBadGateway {
		t.Fatalf("status=%d body=%s, want %d", response.Code, response.Body.String(), http.StatusBadGateway)
	}
	if strings.Contains(response.Body.String(), "upstream secret failure") {
		t.Fatalf("upstream error leaked to client: %s", response.Body.String())
	}
}
