package storage

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestConfirmRemoteServerRenewalIsIdempotent(t *testing.T) {
	repo, err := NewTrafficRepository(filepath.Join(t.TempDir(), "server-renewal.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	ctx := context.Background()
	expiry := time.Date(2030, 8, 14, 0, 0, 0, 0, time.UTC)
	result, err := repo.db.ExecContext(ctx, `INSERT INTO remote_servers(name,token,status,renewal_cycle,expires_at) VALUES(?,?,'connected','quarter',?)`, "renew-test", "renew-token", expiry)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := result.LastInsertId()
	server, processed, err := repo.ConfirmRemoteServerRenewal(ctx, id, "20300814")
	if err != nil || !processed {
		t.Fatalf("first confirmation: processed=%v err=%v", processed, err)
	}
	if got := server.ExpiresAt.Format("2006-01-02"); got != "2030-11-14" {
		t.Fatalf("new expiry=%s", got)
	}
	_, processed, err = repo.ConfirmRemoteServerRenewal(ctx, id, "20300814")
	if err != nil || processed {
		t.Fatalf("duplicate confirmation: processed=%v err=%v", processed, err)
	}
}
