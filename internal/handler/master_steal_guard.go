package handler

import (
	"context"
	"net"
	"net/url"
	"strings"
	"time"

	"miaomiaowux/internal/storage"
)

const masterHTTPSStealMessage = "主控已启用 HTTPS，同机 Agent 不能开启偷自己，否则会抢占 443 导致主控无法访问"

func masterHTTPSEnabled(ctx context.Context, repo *storage.TrafficRepository) bool {
	masterURL, _ := repo.GetSystemSetting(ctx, "master_url")
	externalHTTPS, _ := repo.GetSystemSetting(ctx, "external_https")
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(masterURL)), "https://") || externalHTTPS == "1"
}

func hostnameOnly(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	parsed, err := url.Parse(value)
	if err == nil && parsed.Hostname() != "" {
		return strings.TrimSuffix(strings.ToLower(parsed.Hostname()), ".")
	}
	parsed, err = url.Parse("//" + value)
	if err == nil {
		return strings.TrimSuffix(strings.ToLower(parsed.Hostname()), ".")
	}
	return ""
}

// serverTargetsMasterHost is an early, conservative same-host check used before
// the Agent can report same_host_as_master. It accepts an exact hostname match,
// or a literal server IP present in the master's DNS answers. Two unrelated
// hostnames are deliberately not compared by resolved IP because CDN domains
// commonly share edge addresses.
func serverTargetsMasterHost(ctx context.Context, repo *storage.TrafficRepository, candidates ...string) bool {
	masterURL, _ := repo.GetSystemSetting(ctx, "master_url")
	masterHost := hostnameOnly(masterURL)
	if masterHost == "" {
		return false
	}
	for _, candidate := range candidates {
		if host := hostnameOnly(candidate); host != "" && host == masterHost {
			return true
		}
	}
	lookupCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	masterIPs, err := net.DefaultResolver.LookupHost(lookupCtx, masterHost)
	if err != nil || len(masterIPs) == 0 {
		return false
	}
	set := make(map[string]struct{}, len(masterIPs))
	for _, ip := range masterIPs {
		set[ip] = struct{}{}
	}
	for _, candidate := range candidates {
		host := hostnameOnly(candidate)
		if net.ParseIP(host) == nil {
			continue
		}
		if _, ok := set[host]; ok {
			return true
		}
	}
	return false
}

func forbidMasterHTTPSSteal(ctx context.Context, repo *storage.TrafficRepository, server *storage.RemoteServer) bool {
	if server == nil || !masterHTTPSEnabled(ctx, repo) {
		return false
	}
	return server.SameHostAsMaster || serverTargetsMasterHost(ctx, repo,
		server.PullAddress, server.IPAddress, server.Domain)
}
