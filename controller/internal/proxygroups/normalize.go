package proxygroups

import (
	"encoding/json"
	"fmt"
	"net/url"
	"path"
	"strings"
)

const (
	defaultRuleProviderType     = "http"
	defaultRuleProviderFormat   = "mrs"
	defaultRuleProviderInterval = 86400
	defaultPreset               = "comprehensive"
	metaRulesBaseURL            = "https://gh-proxy.com/https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta"
)

// RuleProviderConfig 表示一个规则提供者配置
type RuleProviderConfig struct {
	Key      string `json:"key"`
	Behavior string `json:"behavior"`
	Type     string `json:"type"`
	Format   string `json:"format"`
	URL      string `json:"url"`
	Path     string `json:"path"`
	Interval int    `json:"interval"`
}

// ProxyGroupCategory 表示一个预置代理组分类
type ProxyGroupCategory struct {
	Name       string               `json:"name"`
	Label      string               `json:"label"`
	Emoji      string               `json:"emoji"`
	Icon       string               `json:"icon"`
	RuleName   string               `json:"rule_name"`
	GroupLabel string               `json:"group_label"`
	Presets    []string             `json:"presets"`
	SiteRules  []RuleProviderConfig `json:"site_rules"`
	IPRules    []RuleProviderConfig `json:"ip_rules"`
}

// NormalizeConfig 规范化代理组配置并补齐默认值
func NormalizeConfig(data []byte) ([]byte, error) {
	if len(strings.TrimSpace(string(data))) == 0 {
		data = []byte("[]")
	}

	var categories []ProxyGroupCategory
	if err := json.Unmarshal(data, &categories); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidConfig, err)
	}

	for i := range categories {
		normalizeCategory(&categories[i])
	}
	categories = mergeDuplicateCategories(categories)

	normalized, err := json.Marshal(categories)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidConfig, err)
	}
	return normalized, nil
}

// mergeDuplicateCategories 合并重复的分类标识或最终代理组名称。
// 部分历史 proxy-groups-lite.json 曾把 Tiktok 误写成 name=social，导致前端两个复选框
// 共用同一个选中键；另一些自定义源可能用不同 name 生成相同 group_label，最终产生重复代理组。
// 保留首次出现分类的展示信息，并合并后续分类的规则与 presets，既避免重复又不丢规则。
func mergeDuplicateCategories(categories []ProxyGroupCategory) []ProxyGroupCategory {
	result := make([]ProxyGroupCategory, 0, len(categories))
	byName := make(map[string]int, len(categories))
	byGroup := make(map[string]int, len(categories))
	for _, category := range categories {
		nameKey := strings.ToLower(category.Name)
		groupKey := strings.ToLower(category.GroupLabel)
		index, duplicateName := byName[nameKey]
		duplicate := duplicateName
		if !duplicateName && groupKey != "" {
			index, duplicate = byGroup[groupKey]
		}
		if duplicate {
			mergeCategory(&result[index], category)
			if nameKey != "" {
				byName[nameKey] = index
			}
			// name 重复通常意味着后续条目写错了标识（历史 Tiktok/name=social 即如此），
			// 不要把它不同的 group_label 也绑定到原分类，否则会吞掉后面的正确 Tiktok 分类。
			if !duplicateName && groupKey != "" {
				byGroup[groupKey] = index
			}
			continue
		}
		index = len(result)
		result = append(result, category)
		if nameKey != "" {
			byName[nameKey] = index
		}
		if groupKey != "" {
			byGroup[groupKey] = index
		}
	}
	return result
}

func mergeCategory(target *ProxyGroupCategory, source ProxyGroupCategory) {
	target.Presets = appendUniqueStrings(target.Presets, source.Presets...)
	target.SiteRules = appendUniqueRules(target.SiteRules, source.SiteRules...)
	target.IPRules = appendUniqueRules(target.IPRules, source.IPRules...)
}

func appendUniqueStrings(values []string, additions ...string) []string {
	seen := make(map[string]bool, len(values)+len(additions))
	for _, value := range values {
		seen[value] = true
	}
	for _, value := range additions {
		if !seen[value] {
			values = append(values, value)
			seen[value] = true
		}
	}
	return values
}

func appendUniqueRules(rules []RuleProviderConfig, additions ...RuleProviderConfig) []RuleProviderConfig {
	seen := make(map[string]bool, len(rules)+len(additions))
	for _, rule := range rules {
		seen[rule.Key+"\x00"+rule.Behavior] = true
	}
	for _, rule := range additions {
		key := rule.Key + "\x00" + rule.Behavior
		if !seen[key] {
			rules = append(rules, rule)
			seen[key] = true
		}
	}
	return rules
}

func normalizeCategory(category *ProxyGroupCategory) {
	category.Name = strings.TrimSpace(category.Name)
	category.Label = strings.TrimSpace(category.Label)
	category.Emoji = strings.TrimSpace(category.Emoji)
	category.Icon = strings.TrimSpace(category.Icon)
	category.RuleName = strings.TrimSpace(category.RuleName)
	category.GroupLabel = strings.TrimSpace(category.GroupLabel)

	if category.Emoji == "" {
		category.Emoji = category.Icon
	}
	if category.Icon == "" {
		category.Icon = category.Emoji
	}

	if category.RuleName == "" {
		switch {
		case category.Name != "":
			category.RuleName = category.Name
		case category.Label != "":
			category.RuleName = category.Label
		}
	}

	if category.GroupLabel == "" {
		switch {
		case category.Emoji != "" && category.Label != "":
			category.GroupLabel = category.Emoji + " " + category.Label
		case category.Label != "":
			category.GroupLabel = category.Label
		default:
			category.GroupLabel = category.RuleName
		}
	}

	if category.Presets == nil {
		category.Presets = []string{defaultPreset}
	}
	if category.SiteRules == nil {
		category.SiteRules = []RuleProviderConfig{}
	}
	if category.IPRules == nil {
		category.IPRules = []RuleProviderConfig{}
	}

	for i := range category.SiteRules {
		normalizeRuleProvider(&category.SiteRules[i], "domain", "geosite")
	}
	for i := range category.IPRules {
		normalizeRuleProvider(&category.IPRules[i], "ipcidr", "geoip")
	}
}

func normalizeRuleProvider(rule *RuleProviderConfig, defaultBehavior, remoteCategory string) {
	rule.Key = strings.TrimSpace(rule.Key)
	rule.Behavior = strings.TrimSpace(rule.Behavior)
	rule.Type = strings.TrimSpace(rule.Type)
	rule.Format = strings.TrimSpace(rule.Format)
	rule.URL = strings.TrimSpace(rule.URL)
	rule.Path = strings.TrimSpace(rule.Path)

	if rule.Key == "" {
		rule.Key = inferRuleKey(rule.URL, rule.Path)
	}
	if rule.Behavior == "" {
		rule.Behavior = defaultBehavior
	}
	if rule.Type == "" {
		rule.Type = defaultRuleProviderType
	}
	if rule.Format == "" {
		rule.Format = inferRuleFormat(rule.URL, rule.Path)
	}
	if rule.Interval <= 0 {
		rule.Interval = defaultRuleProviderInterval
	}
	if rule.Path == "" && rule.Key != "" {
		rule.Path = fmt.Sprintf("./ruleset/%s.%s", rule.Key, rule.Format)
	}
	if rule.URL == "" && rule.Key != "" && rule.Format == defaultRuleProviderFormat {
		rule.URL = fmt.Sprintf("%s/geo/%s/%s.mrs", metaRulesBaseURL, remoteCategory, rule.Key)
	}
}

func inferRuleFormat(urlValue, pathValue string) string {
	ext := strings.ToLower(strings.TrimPrefix(path.Ext(pathValue), "."))
	if ext == "" {
		if parsed, err := url.Parse(urlValue); err == nil {
			ext = strings.ToLower(strings.TrimPrefix(path.Ext(parsed.Path), "."))
		}
	}
	switch ext {
	case "yaml", "yml":
		return "yaml"
	case "txt", "text":
		return "text"
	case "mrs":
		return "mrs"
	default:
		return defaultRuleProviderFormat
	}
}

func inferRuleKey(urlValue, pathValue string) string {
	extractBaseName := func(value string) string {
		if value == "" {
			return ""
		}
		base := path.Base(value)
		ext := path.Ext(base)
		if ext != "" {
			base = strings.TrimSuffix(base, ext)
		}
		return strings.TrimSpace(base)
	}

	if key := extractBaseName(pathValue); key != "" {
		return key
	}
	if parsed, err := url.Parse(urlValue); err == nil {
		if key := extractBaseName(parsed.Path); key != "" {
			return key
		}
	}
	return ""
}
