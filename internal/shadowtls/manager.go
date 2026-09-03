// Package shadowtls supervises the ShadowTLS server process that fronts an
// AnyTLS inbound.  ShadowTLS is not an Xray transport, so keeping it here
// avoids silently writing unknown fields into Xray and pretending the feature
// works when it does not.
package shadowtls

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const DefaultBinary = "/usr/local/bin/shadow-tls"

type Config struct {
	Tag          string
	PublicPort   int
	InternalPort int
	Handshake    string
	Password     string
}

type process struct {
	config Config
	cmd    *exec.Cmd
}

type Manager struct {
	mu      sync.Mutex
	binary  string
	running map[string]*process
}

func New(binary string) *Manager {
	if strings.TrimSpace(binary) == "" {
		binary = DefaultBinary
	}
	return &Manager{binary: binary, running: make(map[string]*process)}
}

// Prepare rewrites an AnyTLS inbound to listen on a loopback port and retains
// the public port in mmwxShadowTLS.  It is intentionally called before Xray is
// started; only the ShadowTLS process ever binds the public port.
func Prepare(inbound map[string]interface{}) (Config, bool, error) {
	if strings.ToLower(strings.TrimSpace(asString(inbound["protocol"]))) != "anytls" {
		return Config{}, false, nil
	}
	ext, _ := inbound["mmwxShadowTLS"].(map[string]interface{})
	if ext == nil || ext["enabled"] != true {
		return Config{}, false, fmt.Errorf("AnyTLS 必须通过 ShadowTLS 暴露")
	}

	tag := strings.TrimSpace(asString(inbound["tag"]))
	if tag == "" {
		return Config{}, false, fmt.Errorf("AnyTLS + ShadowTLS inbound requires a tag")
	}
	handshake := strings.TrimSpace(asString(ext["handshake"]))
	password := strings.TrimSpace(asString(ext["password"]))
	if handshake == "" || password == "" {
		return Config{}, false, fmt.Errorf("AnyTLS + ShadowTLS requires handshake and password")
	}

	publicPort := asPort(ext["public_port"])
	if publicPort == 0 {
		publicPort = asPort(inbound["port"])
	}
	if publicPort < 1 || publicPort > 65535 {
		return Config{}, false, fmt.Errorf("invalid ShadowTLS public port")
	}
	internalPort := asPort(ext["internal_port"])
	if internalPort == 0 {
		var err error
		internalPort, err = reserveLoopbackPort()
		if err != nil {
			return Config{}, false, fmt.Errorf("reserve ShadowTLS backend port: %w", err)
		}
	}
	if internalPort == publicPort {
		return Config{}, false, fmt.Errorf("ShadowTLS backend port must differ from its public port")
	}

	inbound["listen"] = "127.0.0.1"
	inbound["port"] = internalPort
	ext["public_port"] = publicPort
	ext["internal_port"] = internalPort
	inbound["mmwxShadowTLS"] = ext
	return Config{Tag: tag, PublicPort: publicPort, InternalPort: internalPort, Handshake: handshake, Password: password}, true, nil
}

func (m *Manager) Start(config Config) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if current := m.running[config.Tag]; current != nil {
		if current.config == config && current.cmd.Process != nil {
			return nil
		}
		m.stopLocked(config.Tag)
	}
	if err := m.EnsureAvailable(); err != nil {
		return err
	}
	cmd := exec.Command(
		m.binary,
		"--v3",
		"server",
		"--listen", net.JoinHostPort("0.0.0.0", strconv.Itoa(config.PublicPort)),
		"--server", net.JoinHostPort("127.0.0.1", strconv.Itoa(config.InternalPort)),
		"--tls", config.Handshake,
		"--password", config.Password,
	)
	cmd.Env = append(os.Environ(), "RUST_LOG=error")
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start ShadowTLS: %w", err)
	}
	p := &process{config: config, cmd: cmd}
	m.running[config.Tag] = p
	go func() {
		_ = cmd.Wait()
		m.mu.Lock()
		if m.running[config.Tag] == p {
			delete(m.running, config.Tag)
		}
		m.mu.Unlock()
	}()
	return nil
}

func (m *Manager) Stop(tag string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopLocked(tag)
}

func (m *Manager) StopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for tag := range m.running {
		m.stopLocked(tag)
	}
}

func (m *Manager) EnsureAvailable() error {
	info, err := os.Stat(m.binary)
	if err != nil || info.IsDir() {
		return fmt.Errorf("ShadowTLS binary is unavailable at %s", m.binary)
	}
	if info.Mode()&0o111 == 0 {
		return fmt.Errorf("ShadowTLS binary is not executable at %s", m.binary)
	}
	return nil
}

func (m *Manager) stopLocked(tag string) {
	p := m.running[tag]
	if p == nil || p.cmd.Process == nil {
		delete(m.running, tag)
		return
	}
	_ = p.cmd.Process.Signal(os.Interrupt)
	go func(cmd *exec.Cmd) {
		time.Sleep(3 * time.Second)
		if cmd.ProcessState == nil || !cmd.ProcessState.Exited() {
			_ = cmd.Process.Kill()
		}
	}(p.cmd)
	delete(m.running, tag)
}

// BinaryPath is surfaced in the child capability response so the controller
// can fail early rather than add an AnyTLS rule that cannot be served.
func (m *Manager) BinaryPath() string { return filepath.Clean(m.binary) }

func asString(v interface{}) string {
	s, _ := v.(string)
	return s
}

func asPort(v interface{}) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	case string:
		p, _ := strconv.Atoi(strings.TrimSpace(n))
		return p
	default:
		return 0
	}
}

func reserveLoopbackPort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer listener.Close()
	_, portRaw, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(portRaw)
}
