package handler

import (
	"context"

	"miaomiaowux/internal/license"
	"miaomiaowux/internal/storage"
)

// licenseUserQuotaExceeded is retained only because both the administrator
// and Telegram registration paths share this helper. This distribution has no
// edition, activation, user quota, or license-backed capacity limit.
func licenseUserQuotaExceeded(ctx context.Context, repo *storage.TrafficRepository, manager *license.Manager) (string, bool) {
	_ = ctx
	_ = repo
	_ = manager
	return "", false
}
