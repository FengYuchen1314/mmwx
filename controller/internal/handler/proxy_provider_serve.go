package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"miaomiaowux/internal/logger"
	"miaomiaowux/internal/storage"
	"miaomiaowux/internal/util"

	"github.com/MMWOrg/mmwX-plugins/proxyparser"
	"gopkg.in/yaml.v3"
)

// GeoIP 缓存和 API 配置
const ipInfoToken = "cddae164b36656"

type geoIPResponse struct {
	IP          string `json:"ip"`
	CountryCode string `json:"country_code"`
}

var geoIPCache = sync.Map{} // 地图[字符串]字符串（ip -> 国家/地区代码）

// 订阅内容缓存（5分钟过期）
const subscriptionCacheTTL = 5 * time.Minute

// 拉取外部订阅时的单次读取上限,防超大 body OOM(订阅内容通常 <几 MB)
const maxSubscriptionBytes = 50 << 20 // 50MB

type subscriptionCacheEntry struct {
	content   []byte
	fetchedAt time.Time
}

var subscriptionCache = sync.Map{} // map[string]*subscriptionCacheEntry (url -> 条目)

// 失效指定URL的订阅内容缓存
func InvalidateSubscriptionContentCache(url string) {
	prefix := strings.TrimSpace(url) + "\x00"
	subscriptionCache.Range(func(key, _ any) bool {
		if value, ok := key.(string); ok && strings.HasPrefix(value, prefix) {
			subscriptionCache.Delete(key)
		}
		return true
	})
}

// ProxyProviderServeHandler serves the server-processed ("mmw") form of a
// Clash proxy-provider. The copied URL carries the stable subscription token;
// login sessions and API tokens are deliberately not accepted here.
type ProxyProviderServeHandler struct {
	repo  *storage.TrafficRepository
	fetch func(*storage.ExternalSubscription, *storage.ProxyProviderConfig) ([]byte, error)
}

// NewProxyProviderServeHandler handles GET
// /api/proxy-provider/{config_id}?token={subscription_token}.
func NewProxyProviderServeHandler(repo *storage.TrafficRepository) http.Handler {
	if repo == nil {
		panic("proxy provider serve handler requires repository")
	}
	return &ProxyProviderServeHandler{repo: repo, fetch: FetchAndFilterProxiesYAML}
}

func (h *ProxyProviderServeHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, errors.New("only GET is supported"))
		return
	}

	const prefix = "/api/proxy-provider/"
	rawID, ok := strings.CutPrefix(r.URL.Path, prefix)
	if !ok || rawID == "" || strings.Contains(rawID, "/") {
		writeError(w, http.StatusBadRequest, errors.New("invalid proxy provider path"))
		return
	}
	configID, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil || configID <= 0 {
		writeError(w, http.StatusBadRequest, errors.New("invalid proxy provider id"))
		return
	}

	token := strings.TrimSpace(r.URL.Query().Get("token"))
	username, tokenErr := h.repo.ValidateUserToken(r.Context(), token)
	if tokenErr != nil || strings.TrimSpace(username) == "" {
		writeError(w, http.StatusUnauthorized, errors.New("invalid subscription token"))
		return
	}

	settings, err := h.repo.GetUserSettings(r.Context(), username)
	if err != nil {
		// enable_proxy_provider has always defaulted to false in both the DB
		// schema and the user-config response. A historical user without a
		// settings row therefore remains opted out until they explicitly enable
		// the feature.
		if errors.Is(err, storage.ErrUserSettingsNotFound) {
			writeError(w, http.StatusNotFound, errors.New("proxy provider not found"))
			return
		}
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if !settings.EnableProxyProvider {
		// Match missing and foreign provider IDs so a disabled account cannot
		// use this endpoint to enumerate existing sequential config IDs.
		writeError(w, http.StatusNotFound, errors.New("proxy provider not found"))
		return
	}

	config, err := h.repo.GetProxyProviderConfig(r.Context(), configID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	// Return the same response for a missing config and a config owned by
	// another account so sequential IDs cannot be used for discovery.
	if config == nil || config.Username != username {
		writeError(w, http.StatusNotFound, errors.New("proxy provider config not found"))
		return
	}
	if strings.ToLower(strings.TrimSpace(config.ProcessMode)) != "mmw" {
		writeError(w, http.StatusBadRequest, errors.New("proxy provider is configured for client-side processing"))
		return
	}

	sub, err := h.repo.GetExternalSubscription(r.Context(), config.ExternalSubscriptionID, username)
	if err != nil {
		if errors.Is(err, storage.ErrExternalSubscriptionNotFound) {
			writeError(w, http.StatusNotFound, errors.New("external subscription not found"))
			return
		}
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	content, err := h.fetch(&sub, config)
	if err != nil {
		logger.Warn("[ProxyProviderServe] failed to build provider", "config_id", configID, "error", err)
		writeError(w, http.StatusBadGateway, errors.New("failed to fetch or process external subscription"))
		return
	}
	w.Header().Set("Content-Type", "application/yaml; charset=utf-8")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(content)
}

// 查询 IP 的国家代码
func getGeoIPCountryCode(ipOrHost string) string {
	if ipOrHost == "" {
		return ""
	}

	// 如果是域名，先解析为 IP
	ip := ipOrHost
	if net.ParseIP(ipOrHost) == nil {
		// 是域名，需要解析
		ips, err := net.LookupIP(ipOrHost)
		if err != nil || len(ips) == 0 {
			logger.Info("[GeoIP] 域名解析失败", "domain", ipOrHost, "error", err)
			return ""
		}
		ip = ips[0].String()
	}

	// 检查缓存
	if cached, ok := geoIPCache.Load(ip); ok {
		return cached.(string)
	}

	// 查询 API
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(fmt.Sprintf("https://api.ipinfo.io/lite/%s?token=%s", ip, ipInfoToken))
	if err != nil {
		logger.Info("[GeoIP] IP查询失败", "ip", ip, "error", err)
		// 缓存空结果避免重复查询
		geoIPCache.Store(ip, "")
		return ""
	}
	defer resp.Body.Close()

	var result geoIPResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		logger.Info("[GeoIP] 响应解析失败", "ip", ip, "error", err)
		geoIPCache.Store(ip, "")
		return ""
	}

	// 缓存结果
	countryCode := strings.ToUpper(result.CountryCode)
	geoIPCache.Store(ip, countryCode)
	logger.Info("[GeoIP] IP地理位置查询成功", "ip", ip, "country", countryCode)
	return countryCode
}

// 通过缓存获取订阅内容（5 分钟 TTL）
func fetchSubscriptionContent(sub *storage.ExternalSubscription) ([]byte, error) {
	return fetchSubscriptionContentWithHeaders(sub, "")
}

func fetchSubscriptionContentWithHeaders(sub *storage.ExternalSubscription, rawHeaders string) ([]byte, error) {
	if sub == nil {
		return nil, errors.New("external subscription is required")
	}
	userAgent := strings.TrimSpace(sub.UserAgent)
	if userAgent == "" {
		userAgent = "clash-meta/2.4.0"
	}
	// The same URL can return account-specific data according to User-Agent or
	// Authorization. Keep those variants isolated in the in-memory cache.
	cacheKey := strings.TrimSpace(sub.URL) + "\x00" + userAgent + "\x00" + strings.TrimSpace(rawHeaders)

	// 检查缓存
	if cached, ok := subscriptionCache.Load(cacheKey); ok {
		entry := cached.(*subscriptionCacheEntry)
		if time.Since(entry.fetchedAt) < subscriptionCacheTTL {
			logger.Info("[SubscriptionCache] 缓存命中", "url", sub.URL)
			return entry.content, nil
		}
		// 缓存过期，删除
		subscriptionCache.Delete(cacheKey)
	}

	logger.Info("[SubscriptionCache] 缓存未命中，正在拉取", "url", sub.URL)

	// SSRF 防护:sub.URL 来自 DB(用户创建的外部订阅),拉取前校验并用安全客户端拒绝内网/云元数据地址。
	if verr := validateFetchURL(sub.URL); verr != nil {
		return nil, verr
	}
	// 拉取订阅内容
	client := newSSRFSafeHTTPClient(30 * time.Second)
	req, err := http.NewRequest(http.MethodGet, sub.URL, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("User-Agent", userAgent)
	if err := applyProxyProviderRequestHeaders(req, rawHeaders); err != nil {
		return nil, err
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch subscription: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status code: %d", resp.StatusCode)
	}

	// 限制读取大小,防恶意/故障订阅源返回超大 body 触发 OOM(订阅内容通常 <几 MB)
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxSubscriptionBytes))
	if err != nil {
		return nil, fmt.Errorf("read response body: %w", err)
	}

	// 存入缓存
	subscriptionCache.Store(cacheKey, &subscriptionCacheEntry{
		content:   body,
		fetchedAt: time.Now(),
	})

	return body, nil
}

func applyProxyProviderRequestHeaders(req *http.Request, raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var values map[string]any
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return fmt.Errorf("invalid provider header json: %w", err)
	}
	if values == nil || len(values) > 32 {
		return errors.New("provider header must be a JSON object with at most 32 fields")
	}
	blocked := map[string]struct{}{
		"Connection": {}, "Content-Length": {}, "Host": {}, "Proxy-Connection": {},
		"Te": {}, "Trailer": {}, "Transfer-Encoding": {}, "Upgrade": {},
	}
	totalBytes := 0
	for key, rawValue := range values {
		key = http.CanonicalHeaderKey(strings.TrimSpace(key))
		if key == "" {
			continue
		}
		if _, denied := blocked[key]; denied {
			return fmt.Errorf("provider request header %s is not allowed", key)
		}
		var items []string
		switch value := rawValue.(type) {
		case string:
			items = []string{value}
		case []any:
			for _, item := range value {
				text, ok := item.(string)
				if !ok {
					return fmt.Errorf("provider request header %s must contain strings", key)
				}
				items = append(items, text)
			}
		default:
			return fmt.Errorf("provider request header %s must be a string or string array", key)
		}
		for index, value := range items {
			totalBytes += len(key) + len(value)
			if len(value) > 8192 || totalBytes > 32768 {
				return errors.New("provider request headers are too large")
			}
			if index == 0 {
				req.Header.Set(key, value)
			} else {
				req.Header.Add(key, value)
			}
		}
	}
	return nil
}

// preprocessSubscriptionContent 预处理订阅内容。
// URI 解析与内容类型检测统一委托给共享 module proxyparser。
// YAML 的实际解析仍由本地完成（module 不依赖 yaml）。
func preprocessSubscriptionContent(content []byte) ([]byte, error) {
	proxies, kind, decoded, err := proxyparser.Preprocess(content)
	if err != nil {
		return nil, err
	}
	switch kind {
	case proxyparser.ContentURIList:
		logger.Info("[预处理] 检测到 URI 列表，经 proxyparser 解析", "count", len(proxies))
		out, mErr := yaml.Marshal(map[string]any{"proxies": proxies})
		if mErr != nil {
			return nil, fmt.Errorf("URI 列表转 YAML 失败: %w", mErr)
		}
		return out, nil
	case proxyparser.ContentHTML:
		logger.Info("[预处理] 检测到 HTML 内容，跳过")
		return content, nil
	case proxyparser.ContentClashYAML:
		return decoded, nil
	default:
		return decoded, nil
	}
}

// 查找 YAML 文档中的代理节点
func findProxiesNode(root *yaml.Node) *yaml.Node {
	if root == nil {
		return nil
	}

	// 处理文档节点
	if root.Kind == yaml.DocumentNode && len(root.Content) > 0 {
		return findProxiesNode(root.Content[0])
	}

	// 句柄映射节点
	if root.Kind == yaml.MappingNode {
		for i := 0; i < len(root.Content)-1; i += 2 {
			keyNode := root.Content[i]
			valueNode := root.Content[i+1]
			if keyNode.Kind == yaml.ScalarNode && keyNode.Value == "proxies" {
				return valueNode
			}
		}
	}

	return nil
}

// 获取订阅内容并返回所有节点名称
func fetchSubscriptionNodeNames(sub *storage.ExternalSubscription) ([]string, error) {
	// 获取订阅内容（带缓存）
	body, err := fetchSubscriptionContent(sub)
	if err != nil {
		return nil, err
	}

	// 预处理内容（处理base64编码）
	body, err = preprocessSubscriptionContent(body)
	if err != nil {
		return nil, fmt.Errorf("preprocess subscription content: %w", err)
	}

	// 解析 YAML 内容
	var rootNode yaml.Node
	if err := yaml.Unmarshal(body, &rootNode); err != nil {
		return nil, fmt.Errorf("parse yaml: %w", err)
	}

	// 查找代理节点
	proxiesNode := findProxiesNode(&rootNode)
	if proxiesNode == nil || proxiesNode.Kind != yaml.SequenceNode {
		return nil, fmt.Errorf("no proxies found in subscription")
	}

	// 提取节点名称
	var nodeNames []string
	for _, proxyNode := range proxiesNode.Content {
		if proxyNode.Kind != yaml.MappingNode {
			continue
		}

		// 找到“姓名”字段
		for i := 0; i < len(proxyNode.Content)-1; i += 2 {
			keyNode := proxyNode.Content[i]
			valueNode := proxyNode.Content[i+1]
			if keyNode.Kind == yaml.ScalarNode && keyNode.Value == "name" && valueNode.Kind == yaml.ScalarNode {
				nodeNames = append(nodeNames, valueNode.Value)
				break
			}
		}
	}

	return nodeNames, nil
}

// NodeInfo 节点信息（名称和服务器地址）
type NodeInfo struct {
	Name   string `json:"name"`
	Server string `json:"server"`
}

// 获取订阅内容并返回带有名称和服务器的所有节点
func fetchSubscriptionNodes(sub *storage.ExternalSubscription) ([]NodeInfo, error) {
	// 获取订阅内容（带缓存）
	body, err := fetchSubscriptionContent(sub)
	if err != nil {
		return nil, err
	}

	// 预处理内容（处理base64编码）
	body, err = preprocessSubscriptionContent(body)
	if err != nil {
		return nil, fmt.Errorf("preprocess subscription content: %w", err)
	}

	// 解析 YAML 内容
	var rootNode yaml.Node
	if err := yaml.Unmarshal(body, &rootNode); err != nil {
		return nil, fmt.Errorf("parse yaml: %w", err)
	}

	// 查找代理节点
	proxiesNode := findProxiesNode(&rootNode)
	if proxiesNode == nil || proxiesNode.Kind != yaml.SequenceNode {
		return nil, fmt.Errorf("no proxies found in subscription")
	}

	// 提取节点信息（名称和服务器）
	var nodes []NodeInfo
	for _, proxyNode := range proxiesNode.Content {
		if proxyNode.Kind != yaml.MappingNode {
			continue
		}

		node := NodeInfo{}
		for i := 0; i < len(proxyNode.Content)-1; i += 2 {
			keyNode := proxyNode.Content[i]
			valueNode := proxyNode.Content[i+1]
			if keyNode.Kind == yaml.ScalarNode && valueNode.Kind == yaml.ScalarNode {
				switch keyNode.Value {
				case "name":
					node.Name = valueNode.Value
				case "server":
					node.Server = valueNode.Value
				}
			}
		}
		if node.Name != "" {
			nodes = append(nodes, node)
		}
	}

	return nodes, nil
}

// checkFilterMatches 检查过滤器/排除过滤器/geo-ip-过滤器是否与任何节点匹配
// 返回匹配节点的数量
func checkFilterMatches(sub *storage.ExternalSubscription, filter, excludeFilter, geoIPFilter string) (int, error) {
	// 获取节点
	nodes, err := fetchSubscriptionNodes(sub)
	if err != nil {
		return 0, err
	}

	logger.Info("[checkFilterMatches] 订阅节点信息", "sub_name", sub.Name, "node_count", len(nodes), "filter", filter, "exclude_filter", excludeFilter, "geo_ip_filter", geoIPFilter)

	// 编译正则表达式
	var filterRegex, excludeRegex *regexp.Regexp

	if filter != "" {
		filterRegex, err = regexp.Compile(filter)
		if err != nil {
			logger.Info("[checkFilterMatches] 无效的过滤正则表达式", "error", err)
			return 0, fmt.Errorf("invalid filter regex: %w", err)
		}
	}

	if excludeFilter != "" {
		excludeRegex, err = regexp.Compile(excludeFilter)
		if err != nil {
			logger.Info("[checkFilterMatches] 无效的排除过滤正则表达式", "error", err)
			return 0, fmt.Errorf("invalid exclude-filter regex: %w", err)
		}
	}

	// 构建 GeoIP 过滤国家代码地图
	geoIPCountryCodes := make(map[string]bool)
	if geoIPFilter != "" {
		for _, code := range strings.Split(geoIPFilter, ",") {
			geoIPCountryCodes[strings.TrimSpace(strings.ToUpper(code))] = true
		}
	}

	// 计算匹配节点数
	matchCount := 0
	for _, node := range nodes {
		// 首先应用排除过滤器（删除匹配的名称）
		if excludeRegex != nil && excludeRegex.MatchString(node.Name) {
			continue
		}

		// 应用过滤器和 GeoIP 匹配
		if filterRegex != nil {
			if filterRegex.MatchString(node.Name) {
				// 节点名称与过滤器正则表达式匹配，计算它
				matchCount++
				continue
			}

			// 节点名称不匹配，请检查 GeoIP（如果可用）
			if len(geoIPCountryCodes) > 0 && node.Server != "" {
				countryCode := getGeoIPCountryCode(node.Server)
				if countryCode != "" && geoIPCountryCodes[countryCode] {
					// IP位置匹配，统计一下
					matchCount++
					continue
				}
			}
			// 正则表达式和 GeoIP 都不匹配，跳过此节点
			continue
		}

		// 没有过滤器正则表达式，只有 GeoIP 过滤器
		if len(geoIPCountryCodes) > 0 {
			if node.Server != "" {
				countryCode := getGeoIPCountryCode(node.Server)
				if countryCode != "" && geoIPCountryCodes[countryCode] {
					matchCount++
				}
			}
			continue
		}

		// 根本不过滤，计算所有节点
		matchCount++
	}

	logger.Info("[checkFilterMatches] 匹配结果", "filter", filter, "geo_ip_filter", geoIPFilter, "match_count", matchCount)
	return matchCount, nil
}

// FetchAndFilterProxiesYAML fetches one owned external subscription and emits
// the compact document format required by a Clash proxy-provider.
func FetchAndFilterProxiesYAML(sub *storage.ExternalSubscription, config *storage.ProxyProviderConfig) ([]byte, error) {
	if sub == nil || config == nil {
		return nil, errors.New("subscription and provider config are required")
	}
	body, err := fetchSubscriptionContentWithHeaders(sub, config.Header)
	if err != nil {
		return nil, err
	}
	body, err = preprocessSubscriptionContent(body)
	if err != nil {
		return nil, fmt.Errorf("preprocess subscription content: %w", err)
	}

	var root yaml.Node
	if err := yaml.Unmarshal(body, &root); err != nil {
		return nil, fmt.Errorf("parse subscription yaml: %w", err)
	}
	proxies := findProxiesNode(&root)
	if proxies == nil || proxies.Kind != yaml.SequenceNode {
		return nil, errors.New("subscription contains no proxies list")
	}

	filtered, err := filterProxyProviderNodes(proxies, config)
	if err != nil {
		return nil, err
	}
	if err := applyProxyProviderOverrides(filtered, config.Override); err != nil {
		return nil, err
	}
	for index, proxy := range filtered.Content {
		if proxy.Kind == yaml.MappingNode {
			filtered.Content[index] = util.ReorderProxyNode(proxy)
		}
	}

	output := &yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{
		Kind: yaml.MappingNode,
		Content: []*yaml.Node{
			{Kind: yaml.ScalarNode, Value: "proxies"},
			filtered,
		},
	}}}
	encoded, err := MarshalYAMLWithIndent(output)
	if err != nil {
		return nil, fmt.Errorf("encode proxy provider yaml: %w", err)
	}
	return []byte(RemoveUnicodeEscapeQuotes(string(encoded))), nil
}

func filterProxyProviderNodes(proxies *yaml.Node, config *storage.ProxyProviderConfig) (*yaml.Node, error) {
	result := &yaml.Node{Kind: yaml.SequenceNode, Content: make([]*yaml.Node, 0, len(proxies.Content))}

	var include, exclude *regexp.Regexp
	var err error
	if pattern := strings.TrimSpace(config.Filter); pattern != "" {
		include, err = regexp.Compile(pattern)
		if err != nil {
			return nil, fmt.Errorf("invalid include filter: %w", err)
		}
	}
	if pattern := strings.TrimSpace(config.ExcludeFilter); pattern != "" {
		exclude, err = regexp.Compile(pattern)
		if err != nil {
			return nil, fmt.Errorf("invalid exclude filter: %w", err)
		}
	}

	excludedTypes := make(map[string]struct{})
	for _, proxyType := range strings.Split(config.ExcludeType, ",") {
		if proxyType = strings.ToLower(strings.TrimSpace(proxyType)); proxyType != "" {
			excludedTypes[proxyType] = struct{}{}
		}
	}
	geoCountries := make(map[string]struct{})
	for _, country := range strings.Split(config.GeoIPFilter, ",") {
		if country = strings.ToUpper(strings.TrimSpace(country)); country != "" {
			geoCountries[country] = struct{}{}
		}
	}

	for _, proxy := range proxies.Content {
		if proxy.Kind != yaml.MappingNode {
			continue
		}
		name := util.GetNodeFieldValue(proxy, "name")
		if exclude != nil && exclude.MatchString(name) {
			continue
		}
		if _, blocked := excludedTypes[strings.ToLower(util.GetNodeFieldValue(proxy, "type"))]; blocked {
			continue
		}

		nameMatched := include != nil && include.MatchString(name)
		geoMatched := false
		if len(geoCountries) > 0 {
			country := getGeoIPCountryCode(util.GetNodeFieldValue(proxy, "server"))
			_, geoMatched = geoCountries[country]
		}
		if include != nil || len(geoCountries) > 0 {
			if !nameMatched && !geoMatched {
				continue
			}
		}
		result.Content = append(result.Content, proxy)
	}
	return result, nil
}

func applyProxyProviderOverrides(proxies *yaml.Node, raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var overrides map[string]any
	if err := json.Unmarshal([]byte(raw), &overrides); err != nil {
		return fmt.Errorf("invalid provider override json: %w", err)
	}
	if overrides == nil {
		return errors.New("provider override must be a JSON object")
	}
	for _, proxy := range proxies.Content {
		if proxy.Kind != yaml.MappingNode {
			continue
		}
		for key, value := range overrides {
			key = strings.TrimSpace(key)
			if key != "" {
				util.SetNodeField(proxy, key, value)
			}
		}
	}
	return nil
}
