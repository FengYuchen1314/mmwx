package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

// 更新分发 CDN(Cloudflare R2 + CDN):把面板/agent 的「版本检查 + 二进制下载」从 GitHub 迁到
// 自建 CDN,绕开 api.github.com 的 60 次/小时限流。域名写死在代码(不走环境变量),默认开启;
// admin 可在系统设置里关闭 CDN 加速 → 回退直连 GitHub。
//
// R2 布局(bucket 根,经自定义域名 https://dl.miaomiaowux.com 暴露):
//
//	/miaomiaowux/version.json          面板最新版本元数据
//	/miaomiaowux/mmwx-linux-amd64      面板二进制(命名与 GitHub release asset 一致)
//	/miaomiaowux/mmwx-windows-amd64.exe ...
//	/mmw-agent/version.json            agent 最新版本元数据
//	/mmw-agent/mmw-agent-linux-amd64   agent 二进制
//
// version.json 由 GitHub Actions 在发版时自动生成上传(见 .github/workflows/publish-cdn.yml)。

// updateCDNBaseURL 是写死的更新 CDN 域名(无尾斜杠)。
const updateCDNBaseURL = "https://dl.miaomiaowux.com"

// updateCDNEnabled 是 CDN 加速总开关,默认开启;main.go 启动时按 DB(system_settings: update_cdn_enabled)覆盖,
// admin 改系统设置时经 SetUpdateCDNEnabled 同步。
var updateCDNEnabled atomic.Bool

func init() { updateCDNEnabled.Store(true) }

// SetUpdateCDNEnabled 设置 CDN 加速开关(启动加载 / admin 改设置时调用)。
func SetUpdateCDNEnabled(enabled bool) { updateCDNEnabled.Store(enabled) }

// UpdateCDNEnabled 返回当前开关状态(供系统设置回显)。
func UpdateCDNEnabled() bool { return updateCDNEnabled.Load() }

// UpdateCDNBase 返回更新 CDN 的 base URL;开关关闭时返回空 → 走 GitHub。
func UpdateCDNBase() string {
	if updateCDNEnabled.Load() {
		return updateCDNBaseURL
	}
	return ""
}

// cdnVersionMeta 是 R2 上 {project}/version.json 的格式。version 必填,其余可选(供 UI 展示/跳转)。
type cdnVersionMeta struct {
	Version string `json:"version"`  // 版本号(带不带 v 前缀都行,消费方统一去 v)
	Tag     string `json:"tag"`      // release tag,如 v0.3.7
	Notes   string `json:"notes"`    // release notes
	HTMLURL string `json:"html_url"` // GitHub release 页,供 UI「查看详情」跳转
}

// fetchCDNVersion 拉取 {cdn}/{project}/version.json。project 为 "miaomiaowux" 或 "mmw-agent"。
func fetchCDNVersion(cdn, project string) (*cdnVersionMeta, error) {
	url := cdn + "/" + project + "/version.json"
	client := &http.Client{Timeout: 8 * time.Second}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "miaomiaowux-updater")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("cdn version.json 状态码 %d", resp.StatusCode)
	}
	var meta cdnVersionMeta
	if err := json.NewDecoder(resp.Body).Decode(&meta); err != nil {
		return nil, fmt.Errorf("解析 version.json: %w", err)
	}
	if strings.TrimSpace(meta.Version) == "" {
		return nil, fmt.Errorf("version.json 缺 version 字段")
	}
	return &meta, nil
}
