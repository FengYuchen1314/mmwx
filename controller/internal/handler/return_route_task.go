package handler

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	"miaomiaowux/internal/storage"
)

const returnRouteTaskName = "return_route_test"

type returnRouteTarget struct {
	Carrier string `json:"carrier"`
	Region  string `json:"region"`
	Host    string `json:"host"`
	Port    int    `json:"port"`
}

type returnRouteAgentResult struct {
	Carrier   string `json:"carrier"`
	Region    string `json:"region"`
	Target    string `json:"target"`
	Success   bool   `json:"success"`
	RouteType string `json:"route_type"`
	Reason    string `json:"reason"`
	Error     string `json:"error"`
	EntryHop  *struct {
		IP  string `json:"ip"`
		ASN string `json:"asn"`
	} `json:"entry_hop"`
}

type returnRouteAgentResponse struct {
	Success bool                     `json:"success"`
	Results []returnRouteAgentResult `json:"results"`
}

// The endpoints follow NetQuality's public three-carrier target convention.
// A task picks one independently for each carrier, so only three traces run on
// each server. Keeping the pool on the master lets it evolve without an agent
// upgrade.
var returnRouteRegions = []string{"bj", "sh", "gd", "sc", "zj", "js", "sd", "hb", "hn", "fj"}

var returnRouteRegionNames = map[string]string{
	"bj": "北京", "sh": "上海", "gd": "广东", "sc": "四川", "zj": "浙江",
	"js": "江苏", "sd": "山东", "hb": "湖北", "hn": "湖南", "fj": "福建",
}

var returnRouteCarrierSuffix = map[string]string{
	"telecom": "ct", "unicom": "cu", "mobile": "cm",
}

type ReturnRouteTester struct {
	repo    *storage.TrafficRepository
	rm      *RemoteManageHandler
	running atomic.Bool
}

func NewReturnRouteTester(repo *storage.TrafficRepository, rm *RemoteManageHandler) *ReturnRouteTester {
	return &ReturnRouteTester{repo: repo, rm: rm}
}

func (t *ReturnRouteTester) Start(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		lastDate := ""
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				// One low-traffic daily run. Restarting during this minute remains
				// harmless because the in-memory guard prevents overlap.
				date := now.Format("2006-01-02")
				if now.Hour() == 4 && now.Minute() == 20 && date != lastDate {
					lastDate = date
					enabled, _ := t.repo.GetSystemSetting(ctx, probeDisguiseShowReturnRouteKey)
					if enabled != "1" {
						log.Printf("[ReturnRoute] scheduled run skipped: probe return-route display is disabled")
						continue
					}
					_, _ = t.runAsync(nil, false)
				}
			}
		}
	}()
}

func (t *ReturnRouteTester) RunAsync(serverIDs []int64) (int64, error) {
	return t.runAsync(serverIDs, true)
}

func (t *ReturnRouteTester) runAsync(serverIDs []int64, requireAllSupported bool) (int64, error) {
	var err error
	serverIDs, err = t.probeServerIDs(context.Background(), serverIDs)
	if err != nil {
		return 0, err
	}
	if len(serverIDs) == 0 {
		return 0, errors.New("探针未配置展示服务器，没有可检测的 Agent")
	}
	if names, err := t.unsupportedConnectedAgents(context.Background(), serverIDs); err != nil {
		return 0, err
	} else if requireAllSupported && len(names) > 0 {
		return 0, fmt.Errorf("以下服务器的 Agent 版本过低，请先升级 Agent：%s", strings.Join(names, "、"))
	}
	if !t.running.CompareAndSwap(false, true) {
		return 0, errors.New("三网回程测试正在运行")
	}
	runID, err := t.repo.StartTaskRun(context.Background(), returnRouteTaskName, "任务已创建，正在等待 Agent 返回")
	if err != nil {
		t.running.Store(false)
		return 0, err
	}
	go t.run(context.Background(), runID, serverIDs)
	return runID, nil
}

// probeServerIDs returns the exact set of servers exposed by the probe. A
// caller-provided list can only narrow that set; it can never make this task
// trace a hidden server. An empty configured list therefore means no work,
// rather than the historical "all servers" behavior.
func (t *ReturnRouteTester) probeServerIDs(ctx context.Context, requested []int64) ([]int64, error) {
	raw, err := t.repo.GetSystemSetting(ctx, probeDisguiseServerIDsKey)
	if err != nil {
		return nil, fmt.Errorf("读取探针展示服务器失败: %w", err)
	}
	var configured []int64
	if strings.TrimSpace(raw) != "" {
		if err := json.Unmarshal([]byte(raw), &configured); err != nil {
			return nil, fmt.Errorf("探针展示服务器配置无效: %w", err)
		}
	}
	allowed := make(map[int64]bool, len(configured))
	for _, id := range configured {
		if id > 0 {
			allowed[id] = true
		}
	}
	requestedSet := make(map[int64]bool, len(requested))
	for _, id := range requested {
		if id > 0 {
			requestedSet[id] = true
		}
	}
	result := make([]int64, 0, len(allowed))
	for id := range allowed {
		if len(requestedSet) == 0 || requestedSet[id] {
			result = append(result, id)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result, nil
}

func (t *ReturnRouteTester) unsupportedConnectedAgents(ctx context.Context, serverIDs []int64) ([]string, error) {
	servers, err := t.repo.ListRemoteServers(ctx)
	if err != nil {
		return nil, err
	}
	selected := map[int64]bool{}
	for _, id := range serverIDs {
		selected[id] = true
	}
	names := make([]string, 0)
	for _, server := range servers {
		if !selected[server.ID] {
			continue
		}
		if server.IsFederated || server.Status != storage.RemoteServerStatusConnected {
			continue
		}
		if t.rm == nil || t.rm.wsHandler == nil {
			names = append(names, server.Name)
			continue
		}
		conn, ok := t.rm.wsHandler.GetConnectionByServerID(server.ID)
		if !ok || !conn.Capabilities.ReturnRouteTest {
			names = append(names, server.Name)
		}
	}
	sort.Strings(names)
	return names, nil
}

func (t *ReturnRouteTester) run(ctx context.Context, runID int64, serverIDs []int64) {
	started := time.Now()
	defer t.running.Store(false)
	servers, err := t.repo.ListRemoteServers(ctx)
	if err != nil {
		_ = t.repo.FinishTaskRun(ctx, runID, time.Since(started).Milliseconds(), "error", err.Error())
		return
	}
	selected := map[int64]bool{}
	for _, id := range serverIDs {
		selected[id] = true
	}
	targets := randomReturnRouteTargets()
	type outcome struct {
		name, detail string
		ok           bool
	}
	jobs := make(chan storage.RemoteServer)
	out := make(chan outcome, len(servers))
	workers := 3
	for i := 0; i < workers; i++ {
		go func() {
			for server := range jobs {
				out <- t.testServer(ctx, server, targets)
			}
		}()
	}
	count := 0
	for _, server := range servers {
		if !selected[server.ID] {
			continue
		}
		if server.IsFederated {
			continue
		}
		count++
		jobs <- server
	}
	close(jobs)
	results := make([]outcome, 0, count)
	for i := 0; i < count; i++ {
		results = append(results, <-out)
	}
	sort.Slice(results, func(i, j int) bool { return results[i].name < results[j].name })
	okCount := 0
	parts := make([]string, 0, len(results))
	for _, r := range results {
		if r.ok {
			okCount++
		}
		parts = append(parts, r.name+": "+r.detail)
	}
	status := "ok"
	if count == 0 {
		status = "error"
		parts = append(parts, "没有可检测的 Agent")
	} else if okCount == 0 {
		status = "error"
	}
	detail := fmt.Sprintf("成功 %d/%d；%s", okCount, count, strings.Join(parts, "；"))
	_ = t.repo.FinishTaskRun(ctx, runID, time.Since(started).Milliseconds(), status, detail)
}

func (t *ReturnRouteTester) testServer(ctx context.Context, server storage.RemoteServer, targets []returnRouteTarget) (o struct {
	name, detail string
	ok           bool
}) {
	o.name = server.Name
	if server.Status != storage.RemoteServerStatusConnected {
		o.detail = "离线，已跳过"
		return
	}
	if t.rm != nil && t.rm.wsHandler != nil {
		if conn, ok := t.rm.wsHandler.GetConnectionByServerID(server.ID); ok && !conn.Capabilities.ReturnRouteTest {
			o.detail = "Agent 版本过低，请先升级 Agent"
			return
		}
	}
	payload, _ := json.Marshal(map[string]any{"ip_version": 4, "timeout_seconds": 30, "targets": targets})
	callCtx, cancel := context.WithTimeout(ctx, 100*time.Second)
	defer cancel()
	body, err := t.rm.ForwardToAgent(callCtx, server.ID, http.MethodPost, "/api/child/network/return-route-test", payload)
	if err != nil {
		o.detail = "调用失败: " + err.Error()
		return
	}
	var response returnRouteAgentResponse
	if err := json.Unmarshal(body, &response); err != nil {
		o.detail = "Agent 返回无效: " + err.Error()
		return
	}
	items := make([]string, 0, len(response.Results))
	carrierLabel := map[string]string{"telecom": "电信", "unicom": "联通", "mobile": "移动"}
	for _, r := range response.Results {
		label := carrierLabel[r.Carrier] + "(" + r.Region + ")"
		routeType := strings.TrimSpace(r.RouteType)
		if routeType == "" {
			routeType = "Unknown"
		}
		entryIP, entryASN := "", ""
		if r.EntryHop != nil {
			entryIP, entryASN = r.EntryHop.IP, r.EntryHop.ASN
		}
		if err := t.repo.UpsertServerReturnRoute(ctx, storage.ServerReturnRoute{
			ServerID: server.ID, Carrier: r.Carrier, Region: r.Region,
			RouteType: routeType, EntryIP: entryIP, EntryASN: entryASN,
			Reason: r.Reason, TestedAt: time.Now(),
		}); err != nil {
			log.Printf("[ReturnRoute] persist server=%d carrier=%s: %v", server.ID, r.Carrier, err)
		}
		if !r.Success {
			items = append(items, label+"失败:"+r.Error)
			continue
		}
		o.ok = true
		entry := ""
		if r.EntryHop != nil {
			entry = fmt.Sprintf(" %s/AS%s", r.EntryHop.IP, r.EntryHop.ASN)
		}
		item := label + "=" + routeType + entry
		if routeType == "Unknown" && r.Reason != "" {
			item += " [" + r.Reason + "]"
		}
		items = append(items, item)
	}
	o.detail = strings.Join(items, ", ")
	return
}

func randomReturnRouteTargets() []returnRouteTarget {
	seed := make([]byte, 8)
	_, _ = rand.Read(seed)
	n := binary.LittleEndian.Uint64(seed)
	carriers := []string{"telecom", "unicom", "mobile"}
	result := make([]returnRouteTarget, 0, 3)
	for i, carrier := range carriers {
		code := returnRouteRegions[int((n+uint64(i*7))%uint64(len(returnRouteRegions)))]
		result = append(result, returnRouteTarget{
			Carrier: carrier, Region: returnRouteRegionNames[code],
			Host: fmt.Sprintf("%s-%s-v4.ip.zstaticcdn.com", code, returnRouteCarrierSuffix[carrier]), Port: 80,
		})
	}
	return result
}

func (t *ReturnRouteTester) LogTargets() {
	log.Printf("[ReturnRoute] scheduled daily at 04:20 when probe return-route display is enabled, three carrier targets per connected agent")
}
