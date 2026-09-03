package handler

import "testing"

func TestBuildInboundProducesEachSupportedProfile(t *testing.T) {
	for _, profile := range SupportedProtocolProfiles() {
		t.Run(profile.ID, func(t *testing.T) {
			inbound, credentials, err := buildInbound(&buildInboundRequest{
				Profile:    profile.ID,
				Port:       443,
				ServerName: "www.cloudflare.com",
				Dest:       "www.cloudflare.com:443",
			})
			if err != nil {
				t.Fatalf("buildInbound() error = %v", err)
			}
			if err := ValidateManagedInbound(inbound); err != nil {
				t.Fatalf("built inbound violates policy: %v", err)
			}
			if len(credentials) == 0 {
				t.Fatal("expected generated credentials")
			}
		})
	}
}

func TestBuildInboundRejectsLegacyProtocolInput(t *testing.T) {
	_, _, err := buildInbound(&buildInboundRequest{Protocol: "trojan", Port: 443})
	if err == nil {
		t.Fatal("legacy protocol-only request should be rejected")
	}
}
