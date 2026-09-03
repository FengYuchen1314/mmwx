package storage

import (
	"context"
	"path/filepath"
	"testing"
)

func TestUpdateRemoteServerHeartbeatReturnsPreviousOfflineNotificationState(t *testing.T) {
	repo, err := NewTrafficRepository(filepath.Join(t.TempDir(), "heartbeat-notify.db"))
	if err != nil {
		t.Fatalf("NewTrafficRepository: %v", err)
	}
	defer repo.Close()

	ctx := context.Background()
	_, err = repo.db.ExecContext(ctx, `
		INSERT INTO remote_servers (name, token, status, offline_notified)
		VALUES ('notified-server', 'notified-token', 'offline', 1),
		       ('debounced-server', 'debounced-token', 'offline', 0)`)
	if err != nil {
		t.Fatalf("insert remote servers: %v", err)
	}

	for _, tc := range []struct {
		name     string
		token    string
		notified bool
	}{
		{name: "notified offline cycle", token: "notified-token", notified: true},
		{name: "recovered within tolerance", token: "debounced-token", notified: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, err := repo.UpdateRemoteServerHeartbeatWithRestart(ctx, HeartbeatUpdate{Token: tc.token})
			if err != nil {
				t.Fatalf("UpdateRemoteServerHeartbeatWithRestart: %v", err)
			}
			if result.PreviousStatus != RemoteServerStatusOffline {
				t.Fatalf("PreviousStatus = %q, want %q", result.PreviousStatus, RemoteServerStatusOffline)
			}
			if result.PreviousOfflineNotified != tc.notified {
				t.Fatalf("PreviousOfflineNotified = %v, want %v", result.PreviousOfflineNotified, tc.notified)
			}

			var status string
			var notified bool
			if err := repo.db.QueryRowContext(ctx,
				`SELECT status, offline_notified FROM remote_servers WHERE token = ?`, tc.token,
			).Scan(&status, &notified); err != nil {
				t.Fatalf("query updated server: %v", err)
			}
			if status != RemoteServerStatusConnected || notified {
				t.Fatalf("updated state = (%q, %v), want (%q, false)", status, notified, RemoteServerStatusConnected)
			}
		})
	}
}
