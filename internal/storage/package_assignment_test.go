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
