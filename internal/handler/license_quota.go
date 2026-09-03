package handler

import "context"

// ReconcileServerQuota remains a no-op compatibility hook for server lifecycle
// callers. All connected servers are authorized; there is no licensed server
// capacity in this distribution.
func (h *RemoteWSHandler) ReconcileServerQuota(ctx context.Context) {
	_ = h
	_ = ctx
}

// reconcileOne likewise intentionally does not send an authorization gate
// when an Agent connects.
func (h *RemoteWSHandler) reconcileOne(serverID int64) {
	_ = h
	_ = serverID
}
