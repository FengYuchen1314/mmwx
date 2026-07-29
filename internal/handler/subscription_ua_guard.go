package handler

import (
	"errors"
	"net/http"
	"sync/atomic"
)

// blockUnknownSubscriptionUA is process-wide because subscription handlers are
// shared by direct links, short links and package subscriptions. The setting is
// initialized at startup and updated immediately when the admin saves it.
var blockUnknownSubscriptionUA atomic.Bool

func SetBlockUnknownSubscriptionUA(enabled bool) {
	blockUnknownSubscriptionUA.Store(enabled)
}

func subscriptionUAAllowed(ua string) bool {
	return detectClientTypeFromUA(ua) != ""
}

// rejectBlockedSubscriptionUA returns true after writing the response when the
// strict UA policy is enabled and the caller is not a recognized proxy client.
func rejectBlockedSubscriptionUA(w http.ResponseWriter, r *http.Request) bool {
	if !blockUnknownSubscriptionUA.Load() || subscriptionUAAllowed(r.Header.Get("User-Agent")) {
		return false
	}
	w.Header().Set("Cache-Control", "no-store")
	writeError(w, http.StatusForbidden, errors.New("subscription access is only available to supported proxy clients"))
	return true
}
