package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"miaomiaowux/internal/storage"
	"miaomiaowux/internal/taskrun"
)

// OrphanXrayClientCleaner 每天凌晨扫一次:清理 xray inbound 上已无主的 client(email)。
//
// 触发场景:
//   - 用户删除时某 server 离线 / push 失败 → db.users / db.user_subaccounts 已删,
//     但 agent 端 xray config 仍残留对应 client → 该 email 上的流量会被记到孤行,
//     更糟的是 vmess/trojan UUID 仍可被原客户端复用,绕过套餐过期 / 流量超额 / 黑名单。
//
// 白名单(以下任一命中则保留):
//   - 空 email 或 "_admin__" 前缀(系统占位)
//   - user_subaccounts.email 任意一行(无论 is_active) — 续费恢复期间凭据要保留
//   - nodes.routed_admin_email(routed 出站的 admin 占位)
//   - ResolveUsernameByEmail 命中 + 反查 users 表存在的 username
//   - 内置 tag "api" 上的全部 client(不扫这条 inbound)
//
// 时机:每天本地时间 03:30 — 跟 startDailySnapshotTask(0:00 跑)错峰,降低 sqlite 锁竞争,
// 且仍在业务低峰。
//
// 数据源:server_xray_config_snapshots.current — 即主控 push agent 配置时 snapshot 的 JSON,
// 不直接打 agent /api/child/inbounds GET(避免 agent 离线/弱网时阻塞清理)。
// 实际 remove 会调 remoteManage.forwardToRemoteServer → WS-first / HTTP fallback,agent 离线
// 时单台失败不阻塞其它 server 处理。
type OrphanXrayClientCleaner struct {
	repo         *storage.TrafficRepository
	remoteManage *RemoteManageHandler
}

func NewOrphanXrayClientCleaner(repo *storage.TrafficRepository, rm *RemoteManageHandler) *OrphanXrayClientCleaner {
	return &OrphanXrayClientCleaner{repo: repo, remoteManage: rm}
}

// Start starts one startup repair after five minutes, then runs at 03:30 every
// day. The startup pass is important after upgrading from a version that may
// already have left duplicate clients preventing Xray from starting.
func (c *OrphanXrayClientCleaner) Start(ctx context.Context) {
	go c.loop(ctx)
}

func (c *OrphanXrayClientCleaner) loop(ctx context.Context) {
	if c.repo == nil || c.remoteManage == nil {
		log.Printf("[OrphanXrayClientCleaner] repo or remoteManage nil, scheduler skipped")
		return
	}

	const startupDelay = 5 * time.Minute
	log.Printf("[OrphanXrayClientCleaner] scheduler started, startup repair in %s", startupDelay)
	firstTimer := time.NewTimer(startupDelay)
	select {
	case <-ctx.Done():
		firstTimer.Stop()
		return
	case <-firstTimer.C:
		c.recordedRun(ctx)
	}
	for {
		now := time.Now()
		target := time.Date(now.Year(), now.Month(), now.Day(), 3, 30, 0, 0, now.Location())
		if !target.After(now) {
			target = target.AddDate(0, 0, 1)
		}
		timer := time.NewTimer(time.Until(target))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			c.recordedRun(ctx)
		}
	}
}

// recordedRun 跑一次清理并记入 task_runs（P3）。
func (c *OrphanXrayClientCleaner) recordedRun(ctx context.Context) {
	taskrun.Record(ctx, "orphan_xray_cleaner", func() (string, error) {
		return c.runOnce(ctx)
	})
}

func (c *OrphanXrayClientCleaner) runOnce(ctx context.Context) (string, error) {
	start := time.Now()
	log.Printf("[OrphanXrayClientCleaner] scan started")

	// 1) 白名单收集
	users, err := c.repo.ListUsers(ctx, 0)
	if err != nil {
		log.Printf("[OrphanXrayClientCleaner] list users failed: %v", err)
		return "", err
	}
	usernameSet := make(map[string]bool, len(users))
	for _, u := range users {
		usernameSet[u.Username] = true
	}

	subaccounts, err := c.repo.ListAllSubaccounts(ctx)
	if err != nil {
		log.Printf("[OrphanXrayClientCleaner] list subaccounts failed: %v", err)
		return "", err
	}

	servers, err := c.repo.ListRemoteServers(ctx)
	if err != nil {
		log.Printf("[OrphanXrayClientCleaner] list servers failed: %v", err)
		return "", err
	}

	allNodes, err := c.repo.ListAllNodes(ctx)
	if err != nil {
		log.Printf("[OrphanXrayClientCleaner] list nodes failed: %v", err)
		return "", err
	}
	nodesByID := make(map[int64]storage.Node, len(allNodes))
	serverIDByName := make(map[string]int64, len(servers))
	for _, n := range allNodes {
		nodesByID[n.ID] = n
	}
	for _, s := range servers {
		serverIDByName[s.Name] = s.ID
	}

	// Parse every trustworthy snapshot once. Besides avoiding repeated JSON
	// work, this gives us the authoritative inbound set used to purge DB
	// subaccounts whose parent inbound no longer exists.
	type inboundSnapshot struct {
		clients []map[string]interface{}
	}
	snapshots := make(map[int64]map[string]inboundSnapshot, len(servers))
	for _, srv := range servers {
		snap, serr := c.repo.GetCurrentXraySnapshot(ctx, srv.ID)
		if serr != nil || snap == nil || snap.ConfigJSON == "" {
			continue
		}
		var cfg struct {
			Inbounds []struct {
				Tag      string `json:"tag"`
				Settings struct {
					Clients []map[string]interface{} `json:"clients"`
				} `json:"settings"`
			} `json:"inbounds"`
		}
		if jerr := json.Unmarshal([]byte(snap.ConfigJSON), &cfg); jerr != nil {
			log.Printf("[OrphanXrayClientCleaner] server=%d parse snapshot failed: %v", srv.ID, jerr)
			continue
		}
		byTag := make(map[string]inboundSnapshot, len(cfg.Inbounds))
		for _, ib := range cfg.Inbounds {
			byTag[ib.Tag] = inboundSnapshot{clients: ib.Settings.Clients}
		}
		snapshots[srv.ID] = byTag
	}

	// First repair the DB side. A subaccount is valid only while its routed node,
	// server and parent inbound all exist. A missing snapshot means "unknown"
	// (server may be offline), so it is deliberately not treated as deletion.
	subaccountEmails := make(map[string]string, len(subaccounts))
	subaccountByEmail := make(map[string]storage.SubaccountRef, len(subaccounts))
	var dbSubaccountsRemoved int
	for _, sa := range subaccounts {
		node, nodeOK := nodesByID[sa.RoutedNodeID]
		invalid := !nodeOK || node.NodeType != "routed"
		if !invalid {
			if serverID, ok := serverIDByName[node.OriginalServer]; ok {
				if byTag, snapshotKnown := snapshots[serverID]; snapshotKnown {
					_, inboundExists := byTag[node.InboundTag]
					invalid = !inboundExists
				}
			} else {
				invalid = true
			}
		}
		if invalid {
			if derr := c.repo.DeleteUserSubaccountByIdentity(ctx, sa.RoutedNodeID, sa.Email); derr != nil {
				log.Printf("[OrphanXrayClientCleaner] delete stale subaccount node=%d email=%s failed: %v", sa.RoutedNodeID, sa.Email, derr)
			} else {
				dbSubaccountsRemoved++
			}
			continue
		}
		subaccountEmails[sa.Email] = sa.Username
		subaccountByEmail[sa.Email] = sa
	}

	// 2) 收集 routed_admin_email(占位 admin client,routed_owner='shared' 时存在)
	routedAdminEmails, err := c.repo.ListRoutedAdminEmails(ctx)
	if err != nil {
		log.Printf("[OrphanXrayClientCleaner] list routed admin emails failed (continue): %v", err)
		routedAdminEmails = make(map[string]bool)
	}

	shouldKeep := func(email string) bool {
		if email == "" {
			return true
		}
		if _, ok := subaccountEmails[email]; ok {
			return true
		}
		if routedAdminEmails[email] {
			return true
		}
		// Routed identities are DB-authoritative. Never fall back to parsing their
		// username: that was the bug which kept test-routed:* forever after its
		// user_subaccounts row had gone away.
		if looksLikeRoutedClientEmail(email) {
			return false
		}
		username := c.repo.ResolveUsernameByEmail(ctx, email)
		if username == "" {
			return false
		}
		return usernameSet[username]
	}

	// 3) 遍历 snapshot。相同 inbound+email 出现多次时先全部移除，再只加回
	// 第一份凭据；这样即使旧的 routed 批处理重复执行，也不会把 Xray 留在
	// "User already exists"、无法启动的状态。
	var totalScanned, totalOrphan, totalRemoved, totalFailed, totalDeduplicated int
	for _, srv := range servers {
		byTag, ok := snapshots[srv.ID]
		if !ok {
			continue
		}
		for tag, ib := range byTag {
			if tag == "" || tag == "api" {
				continue
			}
			grouped := make(map[string][]map[string]interface{}, len(ib.clients))
			for _, client := range ib.clients {
				email, _ := client["email"].(string)
				totalScanned++
				grouped[email] = append(grouped[email], client)
			}
			for email, copies := range grouped {
				keep := shouldKeep(email)
				if keep && len(copies) == 1 {
					continue
				}
				if !keep {
					totalOrphan += len(copies)
				} else {
					totalDeduplicated += len(copies) - 1
				}
				// Remove once per copy: agent remove-client removes one matching
				// credential at a time. For duplicates, add exactly one copy back.
				rmCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
				var removeErr error
				for range copies {
					if err := removeClientFromInbound(rmCtx, c.remoteManage, srv.ID, tag, email); err != nil {
						removeErr = err
						break
					}
					totalRemoved++
				}
				if removeErr == nil && keep {
					restore := copies[0]
					// For routed clients, DB is authoritative. The first duplicate in
					// the file may be the stale UUID while user_subaccounts contains
					// the credential already distributed in subscriptions.
					if ref, exists := subaccountByEmail[email]; exists {
						if sub, serr := c.repo.GetUserSubaccount(rmCtx, ref.RoutedNodeID, ref.Username); serr == nil && sub != nil {
							var dbCredential map[string]interface{}
							if json.Unmarshal([]byte(sub.CredentialJSON), &dbCredential) == nil && dbCredential != nil {
								restore = dbCredential
							}
						}
					}
					removeErr = addClientToInbound(rmCtx, c.remoteManage, srv.ID, tag, restore)
				}
				cancel()
				if removeErr != nil {
					log.Printf("[OrphanXrayClientCleaner] remove FAILED server=%d tag=%s email=%s: %v",
						srv.ID, tag, email, removeErr)
					totalFailed++
					continue
				}
				log.Printf("[OrphanXrayClientCleaner] reconciled server=%d tag=%s email=%s copies=%d keep=%v",
					srv.ID, tag, email, len(copies), keep)
			}
		}
	}

	log.Printf("[OrphanXrayClientCleaner] scan done in %s: scanned=%d orphan=%d deduplicated=%d removed=%d stale_subaccounts=%d failed=%d",
		time.Since(start).Round(time.Millisecond), totalScanned, totalOrphan, totalDeduplicated, totalRemoved, dbSubaccountsRemoved, totalFailed)
	return fmt.Sprintf("scanned=%d orphan=%d deduplicated=%d removed=%d stale_subaccounts=%d failed=%d",
		totalScanned, totalOrphan, totalDeduplicated, totalRemoved, dbSubaccountsRemoved, totalFailed), nil
}

func looksLikeRoutedClientEmail(email string) bool {
	if strings.HasPrefix(email, "_admin__") || strings.Contains(email, "-routed:") {
		return true
	}
	return strings.Count(email, "__") >= 2
}
