package handler

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/MMWOrg/mmwX-plugins/proxyparser/substore"
)

// normalizeSurgeProxyNumbers 把 JSON 解码产生的 float64 整数转回 int。
// proxyparser v0.1.5 的 Surge Snell producer 用 %d 输出 version，若直接传
// float64(6) 会生成 version=%!d(float64=6)。这里在应用边界统一归一，
// 同时兼容 YAML/JSON 带来的 int、float 和字符串数字。
func normalizeSurgeProxyNumbers(proxy substore.Proxy) {
	if proxy == nil || !strings.EqualFold(strings.TrimSpace(valueAsString(proxy["type"])), "snell") {
		return
	}
	if version, ok := integerValue(proxy["version"]); ok {
		proxy["version"] = version
	}
}

func normalizeSurgeProxies(proxies []substore.Proxy) {
	for _, proxy := range proxies {
		normalizeSurgeProxyNumbers(proxy)
	}
}

func integerValue(value any) (int, bool) {
	switch v := value.(type) {
	case int:
		return v, true
	case int8:
		return int(v), true
	case int16:
		return int(v), true
	case int32:
		return int(v), true
	case int64:
		return int(v), int64(int(v)) == v
	case uint:
		return int(v), uint(int(v)) == v
	case uint8:
		return int(v), true
	case uint16:
		return int(v), true
	case uint32:
		return int(v), uint32(int(v)) == v
	case uint64:
		return int(v), uint64(int(v)) == v
	case float32:
		return integerString(strconv.FormatFloat(float64(v), 'f', -1, 32))
	case float64:
		return integerString(strconv.FormatFloat(v, 'f', -1, 64))
	case json.Number:
		return integerString(v.String())
	case string:
		return integerString(v)
	default:
		return 0, false
	}
}

func integerString(value string) (int, bool) {
	v, err := strconv.Atoi(strings.TrimSpace(value))
	return v, err == nil
}

func valueAsString(value any) string {
	v, _ := value.(string)
	return v
}
