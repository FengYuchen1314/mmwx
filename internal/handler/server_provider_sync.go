package handler

import (
	"context"
	"log"
	"net"
	"strings"
	"time"

	"miaomiaowux/internal/license"
	"miaomiaowux/internal/storage"
)

// StartServerProviderSync periodically refreshes provider metadata from the
// license service. Region is only auto-filled when empty, so an administrator's
// manually selected flag is never overwritten.
func StartServerProviderSync(ctx context.Context, repo *storage.TrafficRepository, manager *license.Manager) {
	if repo == nil || manager == nil {
		return
	}
	run := func() {
		servers, err := repo.ListRemoteServers(ctx)
		if err != nil {
			log.Printf("[ProviderSync] list servers: %v", err)
			return
		}
		for _, server := range servers {
			ip := strings.TrimSpace(server.IPAddress)
			if net.ParseIP(ip) == nil {
				continue
			}
			lookupCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			region, err := manager.ResolveIPRegion(lookupCtx, ip)
			cancel()
			if err != nil {
				continue
			}
			if server.Region == "" && region.Flag() != "" {
				_ = repo.UpdateRemoteServerProbeMeta(ctx, server.ID, region.Flag(), server.RenewalPrice, server.RenewalCycle, server.RenewalCurrency, server.ExpiresAt)
			}
			if err := repo.UpdateRemoteServerProvider(ctx, server.ID, region.ProviderName, region.ProviderURL); err != nil {
				log.Printf("[ProviderSync] update server %d: %v", server.ID, err)
			}
		}
	}
	timer := time.NewTimer(time.Minute)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return
	case <-timer.C:
		run()
	}
	ticker := time.NewTicker(12 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			run()
		}
	}
}
