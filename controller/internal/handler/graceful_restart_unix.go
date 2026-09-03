//go:build !windows

package handler

import (
	"os"
	"syscall"
)

// SignalGracefulRestart asks the service manager to restart the master after
// the process exits cleanly.
func SignalGracefulRestart() error {
	return syscall.Kill(os.Getpid(), syscall.SIGTERM)
}
