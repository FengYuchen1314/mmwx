package handler

import (
	"context"
	"path/filepath"
	"testing"

	"miaomiaowux/internal/storage"
)

func TestPackageNodeNameOverridesPersistByNodeID(t *testing.T) {
	repo, err := storage.NewTrafficRepository(filepath.Join(t.TempDir(), "names.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	ctx := context.Background()
	n1, err := repo.CreateNode(ctx, storage.Node{Username: "admin", NodeName: "same", Protocol: "ss", ClashConfig: `{"name":"same"}`, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	n2, err := repo.CreateNode(ctx, storage.Node{Username: "admin", NodeName: "same", Protocol: "ss", ClashConfig: `{"name":"same"}`, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	pkgID, err := repo.CreatePackage(ctx, storage.Package{
		Name: "named", TrafficLimitBytes: 1 << 30, Nodes: []int64{n1.ID, n2.ID},
		NodeNameOverrides: map[int64]string{n1.ID: "Hong Kong", n2.ID: "Japan", 999999: "stale"},
	})
	if err != nil {
		t.Fatal(err)
	}
	pkg, err := repo.GetPackage(ctx, pkgID)
	if err != nil {
		t.Fatal(err)
	}
	if pkg.NodeNameOverrides[n1.ID] != "Hong Kong" || pkg.NodeNameOverrides[n2.ID] != "Japan" {
		t.Fatalf("overrides crossed nodes: %#v", pkg.NodeNameOverrides)
	}
	if _, ok := pkg.NodeNameOverrides[999999]; ok {
		t.Fatal("stale node override must not be persisted")
	}
	pkg.Nodes = []int64{n2.ID}
	if err := repo.UpdatePackage(ctx, *pkg); err != nil {
		t.Fatal(err)
	}
	pkg, err = repo.GetPackage(ctx, pkgID)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := pkg.NodeNameOverrides[n1.ID]; ok {
		t.Fatal("removed node override must be cleaned")
	}
}

func TestApplyPackageNameOverrideUsesNodeID(t *testing.T) {
	pkg := &storage.Package{NodeNameOverrides: map[int64]string{11: "Hong Kong", 12: "Japan"}}
	p1 := map[string]any{"name": "same"}
	p2 := map[string]any{"name": "same"}
	applyPackageNameOverride(p1, storage.Node{ID: 11}, pkg)
	applyPackageNameOverride(p2, storage.Node{ID: 12}, pkg)
	if p1["name"] != "Hong Kong" || p2["name"] != "Japan" {
		t.Fatalf("overrides crossed nodes: %#v %#v", p1, p2)
	}
}

func TestPackageNameOverridePrecedesMultiplierPrefix(t *testing.T) {
	pkg := &storage.Package{NodeNameOverrides: map[int64]string{11: "Hong Kong"}, NodeMultipliers: map[int64]float64{11: 2}}
	proxy := map[string]any{"name": "original"}
	node := storage.Node{ID: 11, NodeName: "original"}
	applyPackageNameOverride(proxy, node, pkg)
	applyMultiplierPrefix(proxy, node, pkg, &storage.SystemConfig{NodeNameMultiplierPrefixEnabled: true})
	if got := proxy["name"]; got != "「2」Hong Kong" {
		t.Fatalf("final name = %q", got)
	}
}

// 客户反馈:套餐短链接订阅里链式节点没注入 dialer-proxy,导致它跟原节点实际走同一条链路。
// injectDialerProxyRefs 是套餐订阅 / serveAllNodes 两条路径共用的注入核心,这里钉住它的两个关键行为:
//  1. 引用目标节点在本次输出里的**最终名字**(套餐倍率前缀会改名,必须引用改名后的);
//  2. 目标不在本次输出(被过滤 / 未加入套餐)→ 绝不写 dialer-proxy(否则 Mihomo 悬空引用报错)。
func TestInjectDialerProxyRefsUsesFinalNameAndSkipsDangling(t *testing.T) {
	// 节点 1 = 链式节点(chain → 节点 2);节点 2 = 落地出口,被倍率改名为 "「2」HK";
	// 节点 3 = 链式节点,但目标 99 不在输出里(未加入套餐)。
	chain := map[string]any{"name": "香港V6"}
	exit := map[string]any{"name": "「2」HK"} // 已被 applyMultiplierPrefix 改名后的最终名
	dangling := map[string]any{"name": "上海"}

	finalName := map[int64]string{
		1: "香港V6",
		2: "「2」HK",
		3: "上海",
		// 99 缺席
	}
	refs := []dialerRef{
		{proxy: chain, target: 2},
		{proxy: dangling, target: 99},
	}

	injectDialerProxyRefs(refs, finalName)

	if got := chain["dialer-proxy"]; got != "「2」HK" {
		t.Errorf("链式节点应引用目标的最终(改名后)名字 「2」HK,得到 %v", got)
	}
	if _, ok := dangling["dialer-proxy"]; ok {
		t.Errorf("目标缺席时不能注入 dialer-proxy(会产生悬空引用),但被注入了: %v", dangling["dialer-proxy"])
	}
	_ = exit
}

// 客户反馈:全局 API token 解析出的虚拟用户名 api-token-admin 被 userIsAdmin 误判为非管理员
// (GetUser 查不到 → /api/admin/nodes 返回空列表)。这两个分支在 GetUser 之前返回,不碰 repo。
func TestUserIsAdminRecognizesAPITokenAdmin(t *testing.T) {
	if !userIsAdmin(t.Context(), nil, "api-token-admin") {
		t.Error("api-token-admin 应被识别为管理员")
	}
	if userIsAdmin(t.Context(), nil, "") {
		t.Error("空用户名不应是管理员")
	}
}
