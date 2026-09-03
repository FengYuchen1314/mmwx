package handler

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"mmw-agent/internal/constants"
)

type nginxRuntime struct {
	Installed  bool   `json:"installed"`
	Running    bool   `json:"running"`
	Binary     string `json:"binary,omitempty"`
	ConfigPath string `json:"config_path,omitempty"`
	ConfigDir  string `json:"config_dir,omitempty"`
	PIDPath    string `json:"pid_path,omitempty"`
	Manager    string `json:"manager"`
	CanManage  bool   `json:"can_manage"`
	ManagedDir string `json:"managed_dir,omitempty"`
	Reason     string `json:"reason,omitempty"`
}

func findNginxBinary() string {
	for _, bin := range constants.NginxBinarySearchPaths {
		if p, err := exec.LookPath(bin); err == nil {
			return p
		}
	}
	return ""
}

func commandExists(name string) bool { _, err := exec.LookPath(name); return err == nil }

func detectNginxManager() string {
	switch {
	case commandExists("systemctl") && isSystemdRunning():
		return "systemd"
	case commandExists("rc-service"):
		return "openrc"
	case commandExists("service"):
		return "sysv"
	case fileExecutable("/etc/init.d/nginx"):
		return "initd"
	case commandExists("supervisorctl"):
		return "supervisor"
	default:
		return "command"
	}
}

func isSystemdRunning() bool {
	info, err := os.Stat("/run/systemd/system")
	return err == nil && info.IsDir()
}

func fileExecutable(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Mode()&0o111 != 0
}

func inspectNginxRuntime() nginxRuntime {
	bin := findNginxBinary()
	rt := nginxRuntime{Installed: bin != "", Binary: bin, Manager: detectNginxManager()}
	if bin == "" {
		return rt
	}
	out, _ := exec.Command(bin, "-V").CombinedOutput()
	flags := string(out)
	value := func(name string) string {
		re := regexp.MustCompile(`--` + regexp.QuoteMeta(name) + `=([^\s]+)`)
		if match := re.FindStringSubmatch(flags); len(match) == 2 {
			return match[1]
		}
		return ""
	}
	rt.ConfigPath = value("conf-path")
	if rt.ConfigPath == "" {
		for _, candidate := range constants.DefaultNginxConfigPaths {
			if _, err := os.Stat(candidate); err == nil {
				rt.ConfigPath = candidate
				break
			}
		}
	}
	if rt.ConfigPath != "" {
		rt.ConfigDir = filepath.Dir(rt.ConfigPath)
		if data, err := os.ReadFile(rt.ConfigPath); err == nil {
			conf := string(data)
			switch {
			case strings.Contains(conf, "servers/*.conf") || strings.Contains(conf, "servers/*"):
				rt.ManagedDir = filepath.Join(rt.ConfigDir, "servers")
			case strings.Contains(conf, "conf.d/*.conf") || strings.Contains(conf, "conf.d/*"):
				rt.ManagedDir = filepath.Join(rt.ConfigDir, "conf.d")
			}
			rt.CanManage = rt.ManagedDir != ""
			if !rt.CanManage {
				rt.Reason = "nginx 主配置未 include servers/*.conf"
			}
		}
	}
	rt.PIDPath = value("pid-path")
	rt.Running = nginxIsActive()
	return rt
}

func nginxManagedServerDir() string {
	if dir := inspectNginxRuntime().ManagedDir; dir != "" {
		return dir
	}
	if confDir := detectNginxConfDirFromBinary(); confDir != "" {
		return filepath.Join(confDir, "servers")
	}
	return filepath.Join(constants.NginxPrimaryPrefixDir, "servers")
}

func nginxIsActive() bool {
	if commandExists("pgrep") && exec.Command("pgrep", "-x", "nginx").Run() == nil {
		return true
	}
	switch detectNginxManager() {
	case "systemd":
		return exec.Command("systemctl", "is-active", "--quiet", "nginx").Run() == nil
	case "openrc":
		return exec.Command("rc-service", "nginx", "status").Run() == nil
	case "sysv":
		return exec.Command("service", "nginx", "status").Run() == nil
	case "initd":
		return exec.Command("/etc/init.d/nginx", "status").Run() == nil
	case "supervisor":
		out, err := exec.Command("supervisorctl", "status", "nginx").CombinedOutput()
		return err == nil && strings.Contains(string(out), "RUNNING")
	default:
		return false
	}
}

func runNginxServiceAction(action string) error {
	var cmd *exec.Cmd
	switch detectNginxManager() {
	case "systemd":
		cmd = exec.Command("systemctl", action, "nginx")
	case "openrc":
		cmd = exec.Command("rc-service", "nginx", action)
	case "sysv":
		cmd = exec.Command("service", "nginx", action)
	case "initd":
		cmd = exec.Command("/etc/init.d/nginx", action)
	case "supervisor":
		cmd = exec.Command("supervisorctl", action, "nginx")
	default:
		return fmt.Errorf("no service manager")
	}
	log.Printf("[NginxManager] manager=%s action=%s command=%q", detectNginxManager(), action, strings.Join(cmd.Args, " "))
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %s: %w", strings.Join(cmd.Args, " "), strings.TrimSpace(string(out)), err)
	}
	return nil
}

func nginxTest() error {
	bin := findNginxBinary()
	if bin == "" {
		return fmt.Errorf("nginx not installed")
	}
	out, err := exec.Command(bin, "-t").CombinedOutput()
	if err != nil {
		return fmt.Errorf("nginx -t: %s: %w", strings.TrimSpace(string(out)), err)
	}
	return nil
}

func nginxReload() error {
	if err := nginxTest(); err != nil {
		return err
	}
	if bin := findNginxBinary(); bin != "" && nginxIsActive() {
		log.Printf("[NginxManager] manager=command action=reload command=%q", bin+" -s reload")
		if out, err := exec.Command(bin, "-s", "reload").CombinedOutput(); err == nil {
			return nil
		} else if serviceErr := runNginxServiceAction("reload"); serviceErr == nil {
			return nil
		} else {
			return fmt.Errorf("nginx reload: %s: %w", strings.TrimSpace(string(out)), err)
		}
	}
	return nginxStart()
}

func nginxStart() error {
	if nginxIsActive() {
		return nil
	}
	if err := nginxTest(); err != nil {
		return err
	}
	if err := runNginxServiceAction("start"); err == nil {
		return nil
	}
	bin := findNginxBinary()
	if bin == "" {
		return fmt.Errorf("nginx not installed")
	}
	out, err := exec.Command(bin).CombinedOutput()
	log.Printf("[NginxManager] manager=command action=start command=%q", bin)
	if err != nil {
		return fmt.Errorf("start nginx command: %s: %w", strings.TrimSpace(string(out)), err)
	}
	return nil
}

func nginxStop() error {
	if !nginxIsActive() {
		return nil
	}
	if bin := findNginxBinary(); bin != "" {
		if err := exec.Command(bin, "-s", "quit").Run(); err == nil {
			return nil
		}
	}
	return runNginxServiceAction("stop")
}

// installNginxPackage is the minimal-init fallback for NAT/Alpine images where
// the full MMWX installer cannot reach its systemctl step. It intentionally
// uses argv commands rather than a shell and only runs after the normal
// installer failed without leaving an nginx binary behind.
func installNginxPackage() error {
	var commands [][]string
	switch {
	case commandExists("apk"):
		commands = [][]string{{"apk", "add", "--no-cache", "nginx"}}
	case commandExists("apt-get"):
		commands = [][]string{{"apt-get", "update"}, {"apt-get", "install", "-y", "nginx"}}
	case commandExists("dnf"):
		commands = [][]string{{"dnf", "install", "-y", "nginx"}}
	case commandExists("yum"):
		commands = [][]string{{"yum", "install", "-y", "nginx"}}
	case commandExists("pacman"):
		commands = [][]string{{"pacman", "-Sy", "--noconfirm", "nginx"}}
	default:
		return fmt.Errorf("no supported package manager")
	}
	for _, args := range commands {
		out, err := exec.Command(args[0], args[1:]...).CombinedOutput()
		if err != nil {
			return fmt.Errorf("%s: %s: %w", strings.Join(args, " "), strings.TrimSpace(string(out)), err)
		}
	}
	if findNginxBinary() == "" {
		return fmt.Errorf("package manager completed but nginx binary was not found")
	}
	return nil
}
