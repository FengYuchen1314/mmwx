package storage

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
)

// 联邦入站溯源 round-trip:记录/去重/列出/删除/清空 + 按 share_id 隔离。
// 支撑「吊销分享时删接收方创建的 agent 入站」——溯源必须准确、且不同分享互不影响。
func TestSharedInboundTracking(t *testing.T) {
	repo, err := NewTrafficRepository(filepath.Join(t.TempDir(), "si.db"))
	if err != nil {
		t.Fatalf("new repo: %v", err)
	}
	ctx := context.Background()

	// share 1: 记两个 tag(其中一个重复,应幂等去重)
	must := func(e error) {
		if e != nil {
			t.Fatalf("unexpected err: %v", e)
		}
	}
	must(repo.RecordSharedInbound(ctx, 1, 100, "tag-a"))
	must(repo.RecordSharedInbound(ctx, 1, 100, "tag-b"))
	must(repo.RecordSharedInbound(ctx, 1, 100, "tag-a")) // 重复,UNIQUE 幂等
	// share 2: 另一分享,独立
	must(repo.RecordSharedInbound(ctx, 2, 100, "tag-c"))

	tags1, err := repo.ListSharedInboundTags(ctx, 1)
	must(err)
	if len(tags1) != 2 {
		t.Fatalf("share1 应有 2 个 tag(去重后),实际 %d: %v", len(tags1), tags1)
	}

	// 删一个 tag(接收方经联邦删入站)
	must(repo.UnrecordSharedInbound(ctx, 1, "tag-a"))
	tags1, _ = repo.ListSharedInboundTags(ctx, 1)
	if len(tags1) != 1 || tags1[0] != "tag-b" {
		t.Fatalf("删 tag-a 后 share1 应只剩 tag-b,实际 %v", tags1)
	}

	// share 2 不受 share 1 操作影响
	tags2, _ := repo.ListSharedInboundTags(ctx, 2)
	if len(tags2) != 1 || tags2[0] != "tag-c" {
		t.Fatalf("share2 应独立保留 tag-c,实际 %v", tags2)
	}

	// serverID 反查
	sid, err := repo.GetSharedServerServerID(ctx, 0) // 不存在的 share
	if err == nil {
		t.Fatalf("不存在的 share 应报错,实际 sid=%d", sid)
	}

	// 吊销:清空 share1 溯源
	must(repo.ClearSharedInbounds(ctx, 1))
	tags1, _ = repo.ListSharedInboundTags(ctx, 1)
	if len(tags1) != 0 {
		t.Fatalf("ClearSharedInbounds 后 share1 应为空,实际 %v", tags1)
	}
	// share2 仍在
	tags2, _ = repo.ListSharedInboundTags(ctx, 2)
	if len(tags2) != 1 {
		t.Fatalf("清 share1 不应影响 share2,实际 %v", tags2)
	}
}

// 修改物理入站时，批量刷新只能更新父节点；routed 子节点必须随后用自己的
// 凭据重建，不能先被父节点配置覆盖。
func TestInboundUpdateKeepsRoutedChildForDedicatedRefresh(t *testing.T) {
	repo, err := NewTrafficRepository(filepath.Join(t.TempDir(), "routed-refresh.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	ctx := context.Background()
	parent, err := repo.CreateNode(ctx, Node{Username: "admin", NodeName: "parent", Protocol: "vless", ClashConfig: `{"name":"parent","server":"old","port":443}`, ParsedConfig: `{"old":true}`, Enabled: true, OriginalServer: "S", InboundTag: "in-1"})
	if err != nil {
		t.Fatal(err)
	}
	parentID := parent.ID
	child, err := repo.CreateRoutedNode(ctx, RoutedNodeDetail{
		Node:              Node{Username: "admin", NodeName: "child", Protocol: "vless", ClashConfig: `{"name":"child","server":"old","port":443,"uuid":"child-id"}`, ParsedConfig: `{"old":true}`, Enabled: true, OriginalServer: "S", InboundTag: "in-1", NodeType: "routed", ParentNodeID: &parentID},
		RoutedOutboundTag: "routed:test", RoutedRuleMarktag: "route-test", RoutedAdminCredential: `{"id":"child-id"}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	parentConfig := `{"name":"parent","server":"new","port":8443,"uuid":"parent-id"}`
	if err := repo.UpdateNodeByInboundTag(ctx, "S", "in-1", parentConfig, "v4"); err != nil {
		t.Fatal(err)
	}
	beforeRefresh, err := repo.GetNodeByID(ctx, child.ID)
	if err != nil {
		t.Fatal(err)
	}
	var before map[string]any
	_ = json.Unmarshal([]byte(beforeRefresh.ClashConfig), &before)
	if before["server"] != "old" || before["uuid"] != "child-id" {
		t.Fatalf("routed child was overwritten by physical update: %#v", before)
	}
	childConfig := `{"name":"child","server":"new","port":8443,"uuid":"child-id"}`
	if err := repo.UpdateRoutedNodeProxyConfigs(ctx, child.ID, `{"transport":"new"}`, childConfig, "vless"); err != nil {
		t.Fatal(err)
	}
	after, err := repo.GetNodeByID(ctx, child.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.ClashConfig != childConfig || after.ParsedConfig != `{"transport":"new"}` || after.NodeName != "child" {
		t.Fatalf("routed child refresh incomplete: %#v", after)
	}
}
