package handler

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"miaomiaowux/internal/storage"
)

const speedTesterReleasesAPI = "https://api.github.com/repos/mmwx-group/mmwX-plugins/releases?per_page=30"

type speedTesterRelease struct {
	Version   string
	Tag       string
	Assets    map[string]string
	Checksums map[string]string
}

var speedTesterReleaseCache struct {
	sync.Mutex
	value   *speedTesterRelease
	fetched time.Time
}

func testerPlatform(t storage.SpeedTester) (string, string, bool) {
	var goos, arch string
	for _, c := range t.Caps {
		if strings.HasPrefix(c, "os:") {
			goos = strings.TrimPrefix(c, "os:")
		}
		if strings.HasPrefix(c, "arch:") {
			arch = strings.TrimPrefix(c, "arch:")
		}
	}
	return goos, arch, t.HasCap("update") && goos != "" && arch != ""
}

func speedTesterAssetName(goos, arch string) string {
	name := "mmwx-speedtester-" + goos + "-" + arch
	if goos == "windows" {
		name += ".exe"
	}
	return name
}

func normalizeTesterVersion(v string) string { return strings.TrimPrefix(strings.TrimSpace(v), "v") }

func latestSpeedTesterRelease(ctx context.Context) (*speedTesterRelease, error) {
	speedTesterReleaseCache.Lock()
	if speedTesterReleaseCache.value != nil && time.Since(speedTesterReleaseCache.fetched) < 5*time.Minute {
		v := speedTesterReleaseCache.value
		speedTesterReleaseCache.Unlock()
		return v, nil
	}
	speedTesterReleaseCache.Unlock()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, speedTesterReleasesAPI, nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "miaomiaowux")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub HTTP %d", resp.StatusCode)
	}
	var releases []struct {
		TagName    string `json:"tag_name"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
		Assets     []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&releases); err != nil {
		return nil, err
	}
	var rel *speedTesterRelease
	for _, r := range releases {
		if r.Draft || r.Prerelease || !strings.HasPrefix(r.TagName, "speedtest-v") {
			continue
		}
		rel = &speedTesterRelease{Version: strings.TrimPrefix(r.TagName, "speedtest-v"), Tag: r.TagName, Assets: map[string]string{}, Checksums: map[string]string{}}
		for _, a := range r.Assets {
			rel.Assets[a.Name] = a.URL
		}
		break
	}
	if rel == nil {
		return nil, errors.New("未找到 speedtest-v* 稳定版")
	}
	checksumURL := rel.Assets["checksums.txt"]
	if checksumURL == "" {
		return nil, errors.New("Release 缺少 checksums.txt")
	}
	creq, _ := http.NewRequestWithContext(ctx, http.MethodGet, checksumURL, nil)
	cresp, err := http.DefaultClient.Do(creq)
	if err != nil {
		return nil, err
	}
	defer cresp.Body.Close()
	if cresp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("下载 checksums.txt: HTTP %d", cresp.StatusCode)
	}
	s := bufio.NewScanner(io.LimitReader(cresp.Body, 1<<20))
	for s.Scan() {
		parts := strings.Fields(s.Text())
		if len(parts) >= 2 {
			rel.Checksums[strings.TrimPrefix(parts[len(parts)-1], "*")] = parts[0]
		}
	}
	if err := s.Err(); err != nil {
		return nil, err
	}
	speedTesterReleaseCache.Lock()
	speedTesterReleaseCache.value = rel
	speedTesterReleaseCache.fetched = time.Now()
	speedTesterReleaseCache.Unlock()
	return rel, nil
}

func (h *SpeedTestHandler) handleTesterUpdateInfo(w http.ResponseWriter, r *http.Request) {
	rel, err := latestSpeedTesterRelease(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, fmt.Errorf("检查测速端更新失败: %w", err))
		return
	}
	list, err := h.repo.ListSpeedTesters(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	items := make([]map[string]any, 0, len(list))
	outdated := 0
	for _, t := range list {
		_, _, supported := testerPlatform(t)
		available := normalizeTesterVersion(t.Version) == "" || compareSemver(normalizeTesterVersion(t.Version), rel.Version) < 0
		if available {
			outdated++
		}
		items = append(items, map[string]any{"id": t.ID, "name": t.Name, "version": t.Version, "online": h.testerWS != nil && h.testerWS.Online(t.ID), "update_supported": supported, "update_available": available})
	}
	respondJSON(w, http.StatusOK, map[string]any{"success": true, "latest_version": rel.Version, "has_update": outdated > 0, "outdated_count": outdated, "testers": items})
}

func (h *SpeedTestHandler) handleTesterUpdateAll(w http.ResponseWriter, r *http.Request) {
	if h.testerWS == nil {
		writeError(w, http.StatusServiceUnavailable, errors.New("测速端连接服务未启用"))
		return
	}
	rel, err := latestSpeedTesterRelease(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	list, err := h.repo.ListSpeedTesters(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	type result struct {
		ID     int64  `json:"id"`
		Name   string `json:"name,omitempty"`
		Status string `json:"status"`
		Error  string `json:"error,omitempty"`
	}
	results := make([]result, len(list))
	var wg sync.WaitGroup
	slots := make(chan struct{}, 3)
	for i, tester := range list {
		i, tester := i, tester
		results[i] = result{ID: tester.ID, Name: tester.Name}
		goos, arch, supported := testerPlatform(tester)
		if !supported {
			results[i].Status = "unsupported"
			continue
		}
		if compareSemver(normalizeTesterVersion(tester.Version), rel.Version) >= 0 {
			results[i].Status = "latest"
			continue
		}
		if !h.testerWS.Online(tester.ID) {
			results[i].Status = "offline"
			continue
		}
		asset := speedTesterAssetName(goos, arch)
		download, checksum := rel.Assets[asset], rel.Checksums[asset]
		if download == "" || checksum == "" {
			results[i].Status = "failed"
			results[i].Error = "Release 缺少 " + asset
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			slots <- struct{}{}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer cancel()
			if err := h.testerWS.DispatchUpdate(ctx, tester.ID, rel.Version, download, checksum); err != nil {
				<-slots
				results[i].Status = "failed"
				results[i].Error = err.Error()
				return
			}
			// 只限制同时下载/替换的数量；等待重连不占槽，否则测速端较多时 HTTP 会串行等待数分钟。
			<-slots
			deadline := time.Now().Add(90 * time.Second)
			for time.Now().Before(deadline) {
				time.Sleep(2 * time.Second)
				fresh, e := h.repo.ListSpeedTesters(ctx)
				if e != nil {
					continue
				}
				for _, x := range fresh {
					if x.ID == tester.ID && h.testerWS.Online(x.ID) && compareSemver(normalizeTesterVersion(x.Version), rel.Version) >= 0 {
						results[i].Status = "success"
						return
					}
				}
			}
			results[i].Status = "failed"
			results[i].Error = "更新后未在限时内以新版本重新连接"
		}()
	}
	wg.Wait()
	respondJSON(w, http.StatusOK, map[string]any{"success": true, "target_version": rel.Version, "results": results})
}
