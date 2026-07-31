package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"miaomiaowux/internal/notify"
	"miaomiaowux/internal/storage"
	"miaomiaowux/internal/taskrun"
)

const (
	probeQualityConfigKey = "probe_quality_alert_config"
	probeQualityStateKey  = "probe_quality_alert_states"
)

type ProbeQualityAlertConfig struct {
	Enabled            bool    `json:"enabled"`
	JitterThresholdMs  int64   `json:"jitter_threshold_ms"`
	LossThresholdPct   float64 `json:"loss_threshold_pct"`
	WindowMinutes      int     `json:"window_minutes"`
	MinSamples         int     `json:"min_samples"`
	TriggerConsecutive int     `json:"trigger_consecutive"`
	RecoverConsecutive int     `json:"recover_consecutive"`
	CooldownMinutes    int     `json:"cooldown_minutes"`
}

func DefaultProbeQualityAlertConfig() ProbeQualityAlertConfig {
	return ProbeQualityAlertConfig{
		JitterThresholdMs: 80, LossThresholdPct: 20, WindowMinutes: 5,
		MinSamples: 5, TriggerConsecutive: 2, RecoverConsecutive: 2, CooldownMinutes: 30,
	}
}

func LoadProbeQualityAlertConfig(ctx context.Context, repo *storage.TrafficRepository) ProbeQualityAlertConfig {
	cfg := DefaultProbeQualityAlertConfig()
	raw, _ := repo.GetSystemSetting(ctx, probeQualityConfigKey)
	if strings.TrimSpace(raw) != "" {
		_ = json.Unmarshal([]byte(raw), &cfg)
	}
	normalizeProbeQualityConfig(&cfg)
	return cfg
}

func SaveProbeQualityAlertConfig(ctx context.Context, repo *storage.TrafficRepository, cfg ProbeQualityAlertConfig) error {
	normalizeProbeQualityConfig(&cfg)
	data, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	return repo.SetSystemSetting(ctx, probeQualityConfigKey, string(data))
}

func normalizeProbeQualityConfig(cfg *ProbeQualityAlertConfig) {
	if cfg.JitterThresholdMs < 1 {
		cfg.JitterThresholdMs = 80
	}
	if cfg.LossThresholdPct <= 0 || cfg.LossThresholdPct > 100 {
		cfg.LossThresholdPct = 20
	}
	if cfg.WindowMinutes < 2 || cfg.WindowMinutes > 60 {
		cfg.WindowMinutes = 5
	}
	if cfg.MinSamples < 2 || cfg.MinSamples > 1000 {
		cfg.MinSamples = 5
	}
	if cfg.TriggerConsecutive < 1 || cfg.TriggerConsecutive > 10 {
		cfg.TriggerConsecutive = 2
	}
	if cfg.RecoverConsecutive < 1 || cfg.RecoverConsecutive > 10 {
		cfg.RecoverConsecutive = 2
	}
	if cfg.CooldownMinutes < 1 || cfg.CooldownMinutes > 1440 {
		cfg.CooldownMinutes = 30
	}
}

type probeQualityAlertState struct {
	Alerting    bool  `json:"alerting"`
	BadCount    int   `json:"bad_count"`
	GoodCount   int   `json:"good_count"`
	FirstBadAt  int64 `json:"first_bad_at"`
	LastNotify  int64 `json:"last_notify"`
	LastUpdated int64 `json:"last_updated"`
}

type ProbeQualityAlertScheduler struct {
	repo  *storage.TrafficRepository
	store *ProbeMetricsStore
}

func NewProbeQualityAlertScheduler(repo *storage.TrafficRepository, store *ProbeMetricsStore) *ProbeQualityAlertScheduler {
	return &ProbeQualityAlertScheduler{repo: repo, store: store}
}

func (s *ProbeQualityAlertScheduler) Start(ctx context.Context) {
	if s == nil || s.repo == nil || s.store == nil {
		return
	}
	s.runRecorded(ctx)
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.runRecorded(ctx)
		}
	}
}

func (s *ProbeQualityAlertScheduler) runRecorded(ctx context.Context) {
	taskrun.Record(ctx, "probe_quality_alert", func() (string, error) {
		return s.RunOnce(ctx, time.Now())
	})
}

func (s *ProbeQualityAlertScheduler) loadStates(ctx context.Context) map[string]probeQualityAlertState {
	out := map[string]probeQualityAlertState{}
	raw, _ := s.repo.GetSystemSetting(ctx, probeQualityStateKey)
	if raw != "" {
		_ = json.Unmarshal([]byte(raw), &out)
	}
	return out
}

func (s *ProbeQualityAlertScheduler) saveStates(ctx context.Context, states map[string]probeQualityAlertState) error {
	data, err := json.Marshal(states)
	if err != nil {
		return err
	}
	return s.repo.SetSystemSetting(ctx, probeQualityStateKey, string(data))
}

func (s *ProbeQualityAlertScheduler) RunOnce(ctx context.Context, now time.Time) (string, error) {
	cfg := LoadProbeQualityAlertConfig(ctx, s.repo)
	if !cfg.Enabled {
		return "探针质量告警未启用", nil
	}

	var selected []int64
	rawIDs, _ := s.repo.GetSystemSetting(ctx, probeDisguiseServerIDsKey)
	_ = json.Unmarshal([]byte(rawIDs), &selected)
	if len(selected) == 0 {
		return "未选择探针服务器", nil
	}
	selectedSet := make(map[int64]bool, len(selected))
	for _, id := range selected {
		selectedSet[id] = true
	}
	servers, err := s.repo.ListRemoteServers(ctx)
	if err != nil {
		return "", err
	}
	globalRaw, _ := s.repo.GetSystemSetting(ctx, probeDisguisePingTargetsKey)
	overrideRaw, _ := s.repo.GetSystemSetting(ctx, probeDisguisePingTargetsOverrideKey)
	resolver := newProbeTargetResolver(globalRaw, overrideRaw)
	states := s.loadStates(ctx)
	activeKeys := map[string]bool{}
	checked, alerts, recoveries := 0, 0, 0
	n := GetNotifier()

	for _, server := range servers {
		if !selectedSet[server.ID] || server.Status != "connected" {
			continue
		}
		meta := resolver.For(server.ID)
		statsByTarget := s.store.QualityStats(server.ID, time.Duration(cfg.WindowMinutes)*time.Minute, now)
		keys := make([]string, 0, len(statsByTarget))
		for key := range statsByTarget {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, targetKey := range keys {
			target, configured := meta[targetKey]
			if !configured {
				continue
			}
			stats := statsByTarget[targetKey]
			if stats.Samples < cfg.MinSamples || now.Unix()-stats.LastAt > int64(cfg.WindowMinutes*60) {
				continue
			}
			checked++
			stateKey := strconv.FormatInt(server.ID, 10) + "|" + targetKey
			activeKeys[stateKey] = true
			state := states[stateKey]
			badJitter := stats.Success >= 3 && stats.JitterMs >= cfg.JitterThresholdMs
			badLoss := stats.LossPct >= cfg.LossThresholdPct
			bad := badJitter || badLoss
			if bad {
				state.GoodCount = 0
				state.BadCount++
				if state.FirstBadAt == 0 {
					state.FirstBadAt = now.Unix()
				}
				due := !state.Alerting && state.BadCount >= cfg.TriggerConsecutive
				reminder := state.Alerting && now.Unix()-state.LastNotify >= int64(cfg.CooldownMinutes*60)
				if (due || reminder) && n != nil {
					if enabled, _ := n.CheckEnabled(notify.EventProbeQualityAlert); enabled {
						message := formatProbeQualityAlert(server.Name, target.Label, stats, cfg, state.FirstBadAt, now)
						if err := n.Send(ctx, notify.Event{Type: notify.EventProbeQualityAlert, Title: "⚠️ 探针网络质量异常", Message: message}); err != nil {
							return "", err
						}
						state.Alerting, state.LastNotify = true, now.Unix()
						alerts++
					}
				}
			} else {
				state.BadCount = 0
				if state.Alerting {
					state.GoodCount++
					if state.GoodCount >= cfg.RecoverConsecutive && n != nil {
						if enabled, _ := n.CheckEnabled(notify.EventProbeQualityRecover); enabled {
							message := formatProbeQualityRecovery(server.Name, target.Label, stats, state.FirstBadAt, now)
							if err := n.Send(ctx, notify.Event{Type: notify.EventProbeQualityRecover, Title: "✅ 探针网络质量已恢复", Message: message}); err != nil {
								return "", err
							}
							recoveries++
							state = probeQualityAlertState{}
						}
					}
				} else {
					state.GoodCount, state.FirstBadAt = 0, 0
				}
			}
			state.LastUpdated = now.Unix()
			states[stateKey] = state
		}
	}
	for key, state := range states {
		if !activeKeys[key] && !state.Alerting && now.Unix()-state.LastUpdated > 86400 {
			delete(states, key)
		}
	}
	if err := s.saveStates(ctx, states); err != nil {
		return "", err
	}
	return fmt.Sprintf("检查目标=%d 告警=%d 恢复=%d", checked, alerts, recoveries), nil
}

func escapeProbeNotify(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `_`, `\_`, `*`, `\*`, "`", "\\`", "[", `\[`)
	return replacer.Replace(value)
}

func formatProbeQualityAlert(server, target string, stats ProbeQualityStats, cfg ProbeQualityAlertConfig, firstBad int64, now time.Time) string {
	return fmt.Sprintf("服务器：%s\n目标：%s\n延迟：P50 %dms / P95 %dms\n波动：%dms（阈值 %dms）\n丢包率：%.1f%%（%d/%d）\n持续时间：约 %s",
		escapeProbeNotify(server), escapeProbeNotify(target), stats.P50Ms, stats.P95Ms,
		stats.JitterMs, cfg.JitterThresholdMs, stats.LossPct, stats.Failed, stats.Samples,
		formatProbeAlertDuration(firstBad, now))
}

func formatProbeQualityRecovery(server, target string, stats ProbeQualityStats, firstBad int64, now time.Time) string {
	return fmt.Sprintf("服务器：%s\n目标：%s\n当前波动：%dms\n当前丢包率：%.1f%%\n故障持续：约 %s",
		escapeProbeNotify(server), escapeProbeNotify(target), stats.JitterMs, stats.LossPct,
		formatProbeAlertDuration(firstBad, now))
}

func formatProbeAlertDuration(firstBad int64, now time.Time) string {
	if firstBad <= 0 {
		return "未知"
	}
	d := now.Sub(time.Unix(firstBad, 0)).Round(time.Minute)
	if d < time.Minute {
		d = time.Minute
	}
	return d.String()
}
