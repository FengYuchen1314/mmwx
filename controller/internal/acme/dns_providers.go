package acme

import (
	"fmt"
	"os"

	"github.com/go-acme/lego/v4/challenge"
	"github.com/go-acme/lego/v4/providers/dns/alidns"
	"github.com/go-acme/lego/v4/providers/dns/cloudflare"
	"github.com/go-acme/lego/v4/providers/dns/dnspod"
	"github.com/go-acme/lego/v4/providers/dns/godaddy"
	"github.com/go-acme/lego/v4/providers/dns/namesilo"
	"github.com/go-acme/lego/v4/providers/dns/tencentcloud"
)

// 支持的 DNS 提供商类型及其所需的环境变量映射。
var DNSProviderEnvKeys = map[string][]string{
	"cloudflare":   {"CF_API_EMAIL", "CF_API_KEY", "CF_DNS_API_TOKEN"},
	"alidns":       {"ALICLOUD_ACCESS_KEY", "ALICLOUD_SECRET_KEY"},
	"tencentcloud": {"TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY"},
	"dnspod":       {"DNSPOD_API_KEY"},
	"namesilo":     {"NAMESILO_API_KEY"},
	"godaddy":      {"GODADDY_API_KEY", "GODADDY_API_SECRET"},
}

var dnsProviderCredentialSets = map[string][][]string{
	"cloudflare":   {{"CF_DNS_API_TOKEN"}, {"CF_API_EMAIL", "CF_API_KEY"}},
	"alidns":       {{"ALICLOUD_ACCESS_KEY", "ALICLOUD_SECRET_KEY"}},
	"tencentcloud": {{"TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY"}},
	"dnspod":       {{"DNSPOD_API_KEY"}},
	"namesilo":     {{"NAMESILO_API_KEY"}},
	"godaddy":      {{"GODADDY_API_KEY", "GODADDY_API_SECRET"}},
}

// ValidateDNSCredentials verifies that a supported provider has one complete
// credential set. Credential names deliberately match lego's environment
// variables exactly so invalid aliases are rejected when saved, not at renewal.
func ValidateDNSCredentials(providerType string, credentials map[string]string) error {
	sets, ok := dnsProviderCredentialSets[providerType]
	if !ok {
		return fmt.Errorf("unsupported DNS provider type: %s", providerType)
	}
	for _, set := range sets {
		complete := true
		for _, key := range set {
			if credentials[key] == "" {
				complete = false
				break
			}
		}
		if complete {
			return nil
		}
	}
	return fmt.Errorf("incomplete credentials for DNS provider %s", providerType)
}

// NewDNSProviderByName 按名称创建 DNS 质询提供程序。
// 仅导入我们支持的特定提供程序以避免依赖膨胀。
func NewDNSProviderByName(name string) (challenge.Provider, error) {
	switch name {
	case "cloudflare":
		return cloudflare.NewDNSProvider()
	case "alidns":
		return alidns.NewDNSProvider()
	case "tencentcloud":
		return tencentcloud.NewDNSProvider()
	case "dnspod":
		return dnspod.NewDNSProvider()
	case "namesilo":
		return namesilo.NewDNSProvider()
	case "godaddy":
		return godaddy.NewDNSProvider()
	default:
		return nil, fmt.Errorf("unsupported DNS provider: %s", name)
	}
}

// SetDNSCredentialEnv 从给定提供程序的凭据映射中设置环境变量。
// 返回一个清除变量的清理函数。
func SetDNSCredentialEnv(providerType string, credentials map[string]string) (cleanup func(), err error) {
	keys, ok := DNSProviderEnvKeys[providerType]
	if !ok {
		return nil, fmt.Errorf("unsupported DNS provider type: %s", providerType)
	}
	if err := ValidateDNSCredentials(providerType, credentials); err != nil {
		return nil, err
	}

	var setKeys []string
	for _, key := range keys {
		if val, exists := credentials[key]; exists && val != "" {
			os.Setenv(key, val)
			setKeys = append(setKeys, key)
		}
	}

	cleanup = func() {
		for _, key := range setKeys {
			os.Unsetenv(key)
		}
	}
	return cleanup, nil
}

// CA 目录 URL 常量
const (
	CALetsEncrypt        = "letsencrypt"
	CALetsEncryptStaging = "letsencrypt-staging"
)

var CADirectoryURLs = map[string]string{
	CALetsEncrypt:        "https://acme-v02.api.letsencrypt.org/directory",
	CALetsEncryptStaging: "https://acme-staging-v02.api.letsencrypt.org/directory",
}

// 返回给定提供程序名称的 ACME 目录 URL。
func ResolveCADirectoryURL(provider string, staging bool) string {
	if staging {
		if url, ok := CADirectoryURLs[provider+"-staging"]; ok {
			return url
		}
		if url, ok := CADirectoryURLs[provider+"-test"]; ok {
			return url
		}
		return CADirectoryURLs[CALetsEncryptStaging]
	}
	if url, ok := CADirectoryURLs[provider]; ok {
		return url
	}
	return CADirectoryURLs[CALetsEncrypt]
}
