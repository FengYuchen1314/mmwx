package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"miaomiaowux/internal/storage"
)

func TestAnnouncementCreateInstanceNodeTargeting(t *testing.T) {
	repo, err := storage.NewTrafficRepository(filepath.Join(t.TempDir(), "announcement.db"))
	if err != nil {
		t.Fatalf("NewTrafficRepository: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })

	node, err := repo.CreateNode(context.Background(), storage.Node{
		Username:    "admin",
		NodeName:    "target-node",
		Protocol:    "vless",
		ClashConfig: "{}",
		Enabled:     true,
	})
	if err != nil {
		t.Fatalf("CreateNode: %v", err)
	}

	handler := NewAnnouncementHandler(repo, nil)
	post := func(payload map[string]any) *httptest.ResponseRecorder {
		t.Helper()
		body, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("Marshal: %v", err)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/admin/announcements", bytes.NewReader(body))
		rec := httptest.NewRecorder()
		handler.ServeAdmin(rec, req)
		return rec
	}

	for _, announcementType := range []string{AnnounceTypeNodeBlocked, AnnounceTypeNodeRecovered} {
		rec := post(map[string]any{"type": announcementType, "body": "node notice"})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s without node_id status = %d, body = %s", announcementType, rec.Code, rec.Body.String())
		}
	}

	rec := post(map[string]any{"type": AnnounceTypeNodeBlocked, "body": "missing node", "node_id": node.ID + 999})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing node status = %d, body = %s", rec.Code, rec.Body.String())
	}

	rec = post(map[string]any{"type": AnnounceTypeNodeBlocked, "body": "targeted", "node_id": node.ID, "via_miniapp": true})
	if rec.Code != http.StatusOK {
		t.Fatalf("targeted announcement status = %d, body = %s", rec.Code, rec.Body.String())
	}

	rec = post(map[string]any{"type": AnnounceTypeGeneral, "body": "global", "node_id": node.ID, "via_miniapp": true})
	if rec.Code != http.StatusOK {
		t.Fatalf("general announcement status = %d, body = %s", rec.Code, rec.Body.String())
	}

	items, err := repo.ListActiveAnnouncements(context.Background(), false)
	if err != nil {
		t.Fatalf("ListActiveAnnouncements: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("announcements = %d, want 2", len(items))
	}
	for _, item := range items {
		switch item.Type {
		case AnnounceTypeNodeBlocked:
			if item.NodeID != node.ID {
				t.Fatalf("targeted node_id = %d, want %d", item.NodeID, node.ID)
			}
		case AnnounceTypeGeneral:
			if item.NodeID != 0 {
				t.Fatalf("general node_id = %d, want 0", item.NodeID)
			}
		}
	}
}
