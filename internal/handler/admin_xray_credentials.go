package handler

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"miaomiaowux/internal/auth"
	"miaomiaowux/internal/storage"
)

// NewAdminXrayCredentialResetHandler rotates only the currently authenticated
// administrator's Xray credentials. Client emails stay unchanged so traffic
// attribution and routed rules remain valid.
func NewAdminXrayCredentialResetHandler(repo *storage.TrafficRepository, rm *RemoteManageHandler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, errors.New("only POST is supported"))
			return
		}
		username := strings.TrimSpace(auth.UsernameFromContext(r.Context()))
		user, err := repo.GetUser(r.Context(), username)
		if err != nil || user.Role != storage.RoleAdmin {
			writeError(w, http.StatusForbidden, errors.New("administrator account required"))
			return
		}
		if rm == nil {
			writeError(w, http.StatusServiceUnavailable, errors.New("remote management is unavailable"))
			return
		}

		updated, err := resetAdminXrayCredentials(r.Context(), repo, rm, user)
		if err != nil {
			writeError(w, http.StatusBadGateway, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "updated", "credentials_updated": updated})
	})
}

func resetAdminXrayCredentials(ctx context.Context, repo *storage.TrafficRepository, rm *RemoteManageHandler, admin storage.User) (int, error) {
	configs, err := repo.GetUserInboundConfigs(ctx, admin.Username)
	if err != nil {
		return 0, fmt.Errorf("list administrator inbound credentials: %w", err)
	}
	nodes, err := repo.ListAllNodes(ctx)
	if err != nil {
		return 0, fmt.Errorf("list nodes: %w", err)
	}

	updated := 0
	// Migration data may register the same routed administrator client in both
	// tables. Rotate each remote client only once, then reuse the generated value
	// for every database reference to it.
	rotatedRemote := make(map[string]map[string]interface{})
	for _, cfg := range configs {
		oldCred := map[string]interface{}{}
		if err := json.Unmarshal([]byte(cfg.CredentialJSON), &oldCred); err != nil {
			return updated, fmt.Errorf("decode credential for server %d inbound %s: %w", cfg.ServerID, cfg.InboundTag, err)
		}
		remoteKey := xrayCredentialRemoteKey(cfg.ServerID, cfg.InboundTag, oldCred)
		newCred := rotatedRemote[remoteKey]
		didRemoteRotate := false
		if newCred == nil {
			newCred, err = rotateXrayCredential(cfg.Protocol, oldCred)
			if err != nil {
				return updated, fmt.Errorf("rotate credential for server %d inbound %s: %w", cfg.ServerID, cfg.InboundTag, err)
			}
			if err := replaceInboundClientCredential(ctx, rm, cfg.ServerID, cfg.InboundTag, oldCred, newCred); err != nil {
				return updated, fmt.Errorf("update Xray client on server %d inbound %s: %w", cfg.ServerID, cfg.InboundTag, err)
			}
			rotatedRemote[remoteKey] = newCred
			didRemoteRotate = true
		}
		newJSONBytes, _ := json.Marshal(newCred)
		newJSON := string(newJSONBytes)
		if err := repo.UpdateUserInboundCredentialJSONByID(ctx, cfg.ID, newJSON); err != nil {
			if didRemoteRotate {
				_ = replaceInboundClientCredential(ctx, rm, cfg.ServerID, cfg.InboundTag, newCred, oldCred)
			}
			return updated, fmt.Errorf("save administrator inbound credential: %w", err)
		}

		for _, node := range nodes {
			if node.NodeType == "routed" || node.Username != admin.Username || node.InboundTag != cfg.InboundTag {
				continue
			}
			server, serr := repo.GetRemoteServerByName(ctx, node.OriginalServer)
			if serr != nil || server.ID != cfg.ServerID || !clashUsesCredential(node.ClashConfig, cfg.Protocol, oldCred) {
				continue
			}
			clash := cloneClashWithCredential(node.ClashConfig, cfg.Protocol, newCred, node.NodeName)
			if err := repo.UpdateNodeClashCredential(ctx, node.ID, clash); err != nil {
				return updated, fmt.Errorf("update node %d credential: %w", node.ID, err)
			}
		}
		updated++
	}

	subaccounts, err := repo.ListUserSubaccounts(ctx, admin.Username)
	if err != nil {
		return updated, fmt.Errorf("list administrator routed subaccounts: %w", err)
	}
	for _, sa := range subaccounts {
		routed, err := repo.GetRoutedNodeDetail(ctx, sa.RoutedNodeID)
		if err != nil || routed.ParentNodeID == nil {
			return updated, fmt.Errorf("load routed node %d: %w", sa.RoutedNodeID, err)
		}
		parent, err := repo.GetNodeByID(ctx, *routed.ParentNodeID)
		if err != nil {
			return updated, fmt.Errorf("load parent node for routed node %d: %w", sa.RoutedNodeID, err)
		}
		server, err := repo.GetRemoteServerByName(ctx, parent.OriginalServer)
		if err != nil {
			return updated, fmt.Errorf("resolve server for routed node %d: %w", sa.RoutedNodeID, err)
		}
		oldCred := map[string]interface{}{}
		if err := json.Unmarshal([]byte(sa.CredentialJSON), &oldCred); err != nil {
			return updated, fmt.Errorf("decode routed credential %d: %w", sa.ID, err)
		}
		remoteKey := xrayCredentialRemoteKey(server.ID, parent.InboundTag, oldCred)
		newCred := rotatedRemote[remoteKey]
		didRemoteRotate := false
		if newCred == nil {
			newCred, err = rotateXrayCredential(parent.Protocol, oldCred)
			if err != nil {
				return updated, fmt.Errorf("rotate routed credential %d: %w", sa.ID, err)
			}
		}
		if sa.IsActive && rotatedRemote[remoteKey] == nil {
			if err := replaceInboundClientCredential(ctx, rm, server.ID, parent.InboundTag, oldCred, newCred); err != nil {
				return updated, fmt.Errorf("update routed Xray client %d: %w", sa.ID, err)
			}
			rotatedRemote[remoteKey] = newCred
			didRemoteRotate = true
		}
		newJSONBytes, _ := json.Marshal(newCred)
		newJSON := string(newJSONBytes)
		sa.CredentialJSON = newJSON
		if _, err := repo.UpsertUserSubaccount(ctx, sa); err != nil {
			if didRemoteRotate {
				_ = replaceInboundClientCredential(ctx, rm, server.ID, parent.InboundTag, newCred, oldCred)
			}
			return updated, fmt.Errorf("save routed credential %d: %w", sa.ID, err)
		}
		clash := cloneClashWithCredential(routed.ClashConfig, parent.Protocol, newCred, routed.NodeName)
		if routed.RoutedAdminEmail == sa.Email {
			if err := repo.UpdateRoutedAdminCredential(ctx, routed.ID, newJSON, clash); err != nil {
				return updated, fmt.Errorf("update routed node %d: %w", routed.ID, err)
			}
		} else if err := repo.UpdateNodeClashCredential(ctx, routed.ID, clash); err != nil {
			return updated, fmt.Errorf("update routed node %d: %w", routed.ID, err)
		}
		updated++
	}
	return updated, nil
}

func xrayCredentialRemoteKey(serverID int64, inboundTag string, credential map[string]interface{}) string {
	identity := fmt.Sprint(credential["email"])
	if identity == "" || identity == "<nil>" {
		identity = fmt.Sprint(credential["user"])
	}
	if identity == "" || identity == "<nil>" {
		identity = fmt.Sprint(credential["username"])
	}
	return fmt.Sprintf("%d\x00%s\x00%s", serverID, inboundTag, identity)
}

func replaceInboundClientCredential(ctx context.Context, rm *RemoteManageHandler, serverID int64, inboundTag string, oldCred, newCred map[string]interface{}) error {
	removeBody, _ := json.Marshal(map[string]interface{}{"action": "remove-client", "tag": inboundTag, "client": oldCred})
	if _, err := rm.forwardToRemoteServer(ctx, serverID, http.MethodPost, "/api/child/inbounds", removeBody); err != nil {
		return fmt.Errorf("remove old client: %w", err)
	}
	addBody, _ := json.Marshal(map[string]interface{}{"action": "add-client", "tag": inboundTag, "client": newCred})
	if _, err := rm.forwardToRemoteServer(ctx, serverID, http.MethodPost, "/api/child/inbounds", addBody); err != nil {
		rollbackBody, _ := json.Marshal(map[string]interface{}{"action": "add-client", "tag": inboundTag, "client": oldCred})
		_, _ = rm.forwardToRemoteServer(ctx, serverID, http.MethodPost, "/api/child/inbounds", rollbackBody)
		return fmt.Errorf("add new client: %w", err)
	}
	return nil
}

func rotateXrayCredential(protocol string, old map[string]interface{}) (map[string]interface{}, error) {
	credential := cloneMap(old)
	switch strings.ToLower(protocol) {
	case "vless", "vmess":
		credential["id"] = uuid.NewString()
	case "trojan", "anytls", "mieru":
		credential["password"] = uuid.NewString()
	case "snell":
		credential["psk"] = uuid.NewString()
	case "hysteria", "hysteria2", "hy2":
		credential["auth"] = uuid.NewString()
	case "shadowsocks", "ss":
		length := 16
		if decoded, err := base64.StdEncoding.DecodeString(fmt.Sprint(old["password"])); err == nil && len(decoded) > 0 {
			length = len(decoded)
		}
		key := make([]byte, length)
		if _, err := rand.Read(key); err != nil {
			return nil, err
		}
		credential["password"] = base64.StdEncoding.EncodeToString(key)
	case "socks", "http":
		credential["pass"] = strings.ReplaceAll(uuid.NewString(), "-", "")[:16]
	default:
		return nil, fmt.Errorf("unsupported protocol %q", protocol)
	}
	return credential, nil
}

func clashUsesCredential(clashJSON, protocol string, credential map[string]interface{}) bool {
	var clash map[string]interface{}
	if json.Unmarshal([]byte(clashJSON), &clash) != nil {
		return false
	}
	switch strings.ToLower(protocol) {
	case "vless", "vmess":
		return fmt.Sprint(clash["uuid"]) == fmt.Sprint(credential["id"])
	case "trojan", "anytls":
		return fmt.Sprint(clash["password"]) == fmt.Sprint(credential["password"])
	case "snell":
		return fmt.Sprint(clash["psk"]) == fmt.Sprint(credential["psk"])
	case "hysteria", "hysteria2", "hy2":
		return fmt.Sprint(clash["password"]) == fmt.Sprint(credential["auth"])
	case "shadowsocks", "ss":
		return strings.HasSuffix(fmt.Sprint(clash["password"]), ":"+fmt.Sprint(credential["password"])) || fmt.Sprint(clash["password"]) == fmt.Sprint(credential["password"])
	}
	return false
}
