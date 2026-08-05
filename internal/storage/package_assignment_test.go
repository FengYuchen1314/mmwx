package storage

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestAssignPackagePreservesOverrideOnlyForSamePackage(t *testing.T) {
	repo, err := NewTrafficRepository(filepath.Join(t.TempDir(), "package-assignment.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = repo.Close() })

	ctx := context.Background()
	if err := repo.CreateUser(ctx, "renew-user", "", "", "hash", RoleUser, ""); err != nil {
		t.Fatal(err)
	}
	firstID, err := repo.CreatePackage(ctx, Package{Name: "first", CycleDays: 30})
	if err != nil {
		t.Fatal(err)
	}
	secondID, err := repo.CreatePackage(ctx, Package{Name: "second", CycleDays: 30})
	if err != nil {
		t.Fatal(err)
	}

	now := time.Now()
	if err := repo.AssignPackageToUser(ctx, "renew-user", firstID, now, now.AddDate(0, 1, 0), false, 1); err != nil {
		t.Fatal(err)
	}
	limit := int64(123456)
	if err := repo.UpdateUserTrafficLimitOverride(ctx, "renew-user", &limit); err != nil {
		t.Fatal(err)
	}

	// Renewing the same package must retain the per-user override.
	if err := repo.AssignPackageToUser(ctx, "renew-user", firstID, now, now.AddDate(0, 2, 0), false, 1); err != nil {
		t.Fatal(err)
	}
	user, err := repo.GetUser(ctx, "renew-user")
	if err != nil {
		t.Fatal(err)
	}
	if user.TrafficLimitOverride == nil || *user.TrafficLimitOverride != limit {
		t.Fatalf("same-package renewal lost override: %v", user.TrafficLimitOverride)
	}

	// Switching packages must clear the override.
	if err := repo.AssignPackageToUser(ctx, "renew-user", secondID, now, now.AddDate(0, 1, 0), false, 1); err != nil {
		t.Fatal(err)
	}
	user, err = repo.GetUser(ctx, "renew-user")
	if err != nil {
		t.Fatal(err)
	}
	if user.TrafficLimitOverride != nil {
		t.Fatalf("package switch retained override: %v", *user.TrafficLimitOverride)
	}
}

func TestAssignNewPackageStartsTrafficAtZeroButRenewalPreservesCycle(t *testing.T) {
	repo, err := NewTrafficRepository(filepath.Join(t.TempDir(), "package-new-cycle.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	ctx := context.Background()
	if err := repo.CreateUser(ctx, "fresh-user", "", "", "hash", RoleUser, ""); err != nil {
		t.Fatal(err)
	}
	pkgID, err := repo.CreatePackage(ctx, Package{Name: "test", CycleDays: 30})
	if err != nil {
		t.Fatal(err)
	}
	// 用户绑定套餐前已有历史流量。
	if err := repo.UpsertUserEmailTraffic(ctx, 1, "fresh-user__vless", 0, 0, false, 1, "fresh-user"); err != nil {
		t.Fatal(err)
	}
	if err := repo.UpsertUserEmailTraffic(ctx, 1, "fresh-user__vless", 100, 100, false, 1, "fresh-user"); err != nil {
		t.Fatal(err)
	}
	if used, _ := repo.GetUserBillableTraffic(ctx, "fresh-user"); used != 200 {
		t.Fatalf("pre-assign traffic = %d, want 200", used)
	}
	now := time.Now()
	if err := repo.AssignPackageToUser(ctx, "fresh-user", pkgID, now, now.AddDate(0, 1, 0), false, 1); err != nil {
		t.Fatal(err)
	}
	if used, _ := repo.GetUserBillableTraffic(ctx, "fresh-user"); used != 0 {
		t.Fatalf("new package inherited historical traffic: %d", used)
	}
	if err := repo.UpsertUserEmailTraffic(ctx, 1, "fresh-user__vless", 150, 150, false, 1, "fresh-user"); err != nil {
		t.Fatal(err)
	}
	if used, _ := repo.GetUserBillableTraffic(ctx, "fresh-user"); used != 100 {
		t.Fatalf("new package delta = %d, want 100", used)
	}
	if err := repo.AssignPackageToUser(ctx, "fresh-user", pkgID, now, now.AddDate(0, 2, 0), false, 1); err != nil {
		t.Fatal(err)
	}
	if used, _ := repo.GetUserBillableTraffic(ctx, "fresh-user"); used != 100 {
		t.Fatalf("same-package renewal reset current cycle: %d", used)
	}
}

func TestNewMonthlyPackagePeriodDoesNotPrecedePackageStart(t *testing.T) {
	repo, err := NewTrafficRepository(filepath.Join(t.TempDir(), "package-period.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	ctx := context.Background()
	if err := repo.CreateUser(ctx, "period-user", "", "", "hash", RoleUser, ""); err != nil {
		t.Fatal(err)
	}
	pkgID, err := repo.CreatePackage(ctx, Package{Name: "monthly", CycleDays: 365})
	if err != nil {
		t.Fatal(err)
	}
	// reset_day=1, but a newly assigned package starts today. Its first traffic
	// period must start today rather than at the first day of this month.
	start := time.Now().Add(-time.Minute).Truncate(time.Second)
	if err := repo.AssignPackageToUser(ctx, "period-user", pkgID, start, start.AddDate(1, 0, 0), true, 1); err != nil {
		t.Fatal(err)
	}
	periodStart, _, err := repo.GetUserPackagePeriod(ctx, "period-user")
	if err != nil {
		t.Fatal(err)
	}
	if periodStart == nil || periodStart.Before(start) {
		t.Fatalf("period starts before package assignment: got %v, package start %v", periodStart, start)
	}
}
