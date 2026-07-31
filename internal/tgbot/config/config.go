// Package config defines the embedded TGBot runtime configuration. Persistence
// is owned by the master system_settings table; there is no standalone YAML,
// master address or master API-token configuration after the merge.
package config

type Config struct {
	Enabled bool
	// PublicBaseURL is the master UI address. SubscriptionBaseURL is used for
	// subscription links and falls back to PublicBaseURL when it is empty.
	PublicBaseURL       string
	SubscriptionBaseURL string
	TGBotToken          string
	AdminTGIDs          []int64
	HTTPTimeoutSeconds  int
	WebAppURL           string
	WebAppDevPreview    bool
}

func (c Config) IsAdmin(tgID int64) bool {
	for _, id := range c.AdminTGIDs {
		if id == tgID {
			return true
		}
	}
	return false
}
