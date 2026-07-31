package handler

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/MMWOrg/mmwX-plugins/proxyparser/substore"
)

func TestUpdateSnellOptionsInJSONPreservesUnselectedOptions(t *testing.T) {
	raw := `{"type":"snell","name":"test","udp":true}`
	tfo := false
	if !updateSnellOptionsInJSON(&raw, &tfo, nil) {
		t.Fatal("expected config to change")
	}

	var got map[string]any
	if err := json.Unmarshal([]byte(raw), &got); err != nil {
		t.Fatal(err)
	}
	if got["tfo"] != false || got["udp"] != true {
		t.Fatalf("unexpected options after update: %#v", got)
	}
}

func TestUpdateSnellOptionsInJSONSupportsExplicitFalse(t *testing.T) {
	raw := `{"type":"snell","tfo":true,"udp":true}`
	udp := false
	if !updateSnellOptionsInJSON(&raw, nil, &udp) {
		t.Fatal("expected config to change")
	}

	var got map[string]any
	if err := json.Unmarshal([]byte(raw), &got); err != nil {
		t.Fatal(err)
	}
	if got["udp"] != false || got["tfo"] != true {
		t.Fatalf("unexpected options after update: %#v", got)
	}
}

func TestUpdateSnellOptionsInJSONIgnoresOtherProtocols(t *testing.T) {
	raw := `{"type":"ss","udp":true}`
	want := raw
	tfo := true
	if updateSnellOptionsInJSON(&raw, &tfo, nil) || raw != want {
		t.Fatalf("non-Snell config changed to %s", raw)
	}
}

func TestNormalizeSnellVersionForSurgeProducer(t *testing.T) {
	proxy := substore.Proxy{
		"name": "snell-v6", "type": "snell", "server": "1.2.3.4",
		"port": float64(443), "psk": "secret", "version": float64(6),
	}
	normalizeSurgeProxyNumbers(proxy)
	line, err := substore.NewSurgeProducer().ProduceOne(proxy, "", nil)
	if err != nil {
		t.Fatalf("ProduceOne: %v", err)
	}
	if !strings.Contains(line, "version=6") || strings.Contains(line, "%!") {
		t.Fatalf("Snell version 类型未正确归一: %s", line)
	}
}

// mihomo 遇 snell v6 是整份配置拒载,过滤器须同时删节点与组引用,且不误伤 v4/v5。
func TestFilterSnellV6FromClashYAML(t *testing.T) {
	in := `proxies:
  - name: hk-v6
    type: snell
    server: a.example.com
    port: 1
    psk: p1
    version: 6
    mode: default
  - name: hk-v4
    type: snell
    server: a.example.com
    port: 2
    psk: p2
    version: 4
  - name: jp-vless
    type: vless
    server: b.example.com
    port: 3
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - hk-v6
      - hk-v4
      - jp-vless
  - name: ONLY6
    type: select
    proxies:
      - hk-v6
rules:
  - MATCH,PROXY
`
	out := string(filterSnellV6FromClashYAML([]byte(in)))
	if strings.Contains(out, "hk-v6") {
		t.Errorf("v6 节点及引用应被移除:\n%s", out)
	}
	if !strings.Contains(out, "hk-v4") || !strings.Contains(out, "jp-vless") {
		t.Errorf("v4/vless 节点不应误伤:\n%s", out)
	}
	// 组被删空 → 补 DIRECT(空 proxies 的组同样让 mihomo 拒载)
	if !strings.Contains(out, "ONLY6") || !strings.Contains(out, "DIRECT") {
		t.Errorf("删空的组应补 DIRECT:\n%s", out)
	}
	if !strings.Contains(out, "MATCH,PROXY") {
		t.Errorf("rules 应原样保留:\n%s", out)
	}
}

// 无 v6 节点时必须原样返回(零改动,不重排不重整格式)。
func TestFilterSnellV6NoOpWhenAbsent(t *testing.T) {
	in := "proxies:\n  - name: a\n    type: vless\n    server: x\n    port: 1\n"
	if got := string(filterSnellV6FromClashYAML([]byte(in))); got != in {
		t.Errorf("无 v6 时应原样返回,得到:\n%s", got)
	}
	// 解析失败 fail-open
	bad := "::: not yaml {{{"
	if got := string(filterSnellV6FromClashYAML([]byte(bad))); got != bad {
		t.Error("解析失败应原样返回")
	}
}
