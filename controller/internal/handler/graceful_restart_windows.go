//go:build windows

package handler

import "errors"

// Windows has no Unix SIGTERM/self-kill equivalent. HTTPS recovery is a
// service-manager operation and cannot safely force an in-process restart here.
func SignalGracefulRestart() error {
	return errors.New("graceful self-restart is not supported on Windows")
}
