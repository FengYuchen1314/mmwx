package handler

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"miaomiaowux/internal/storage"
)

var postgresClientInstallMu sync.Mutex

// NewBackupDownloadHandler 返回一个创建并下载 ZIP 备份的处理程序。
// 该处理程序需要管理员身份验证。
func NewBackupDownloadHandler(repo *storage.TrafficRepository, dataDir string) http.Handler {
	if repo == nil {
		panic("backup download handler requires repository")
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			writeBackupError(w, http.StatusMethodNotAllowed, errors.New("only GET or POST is supported"))
			return
		}
		isPostgres := repo.DatabaseDriver() == "postgres"
		// PostgreSQL 数据库体积可能很大，因此仅在管理员明确勾选时导出。
		// SQLite 数据库位于 data/ 中，保持原有的完整备份行为。
		includeDatabase := !isPostgres || r.URL.Query().Get("include_database") == "true"

		// SQLite 先 checkpoint；PostgreSQL 由 pg_dump 自己建立一致性快照。
		if !isPostgres {
			if err := repo.Checkpoint(); err != nil {
				writeBackupError(w, http.StatusInternalServerError, fmt.Errorf("failed to checkpoint database: %w", err))
				return
			}
		}
		if includeDatabase {
			if err := repo.QuickCheck(r.Context()); err != nil {
				writeBackupError(w, http.StatusInternalServerError, fmt.Errorf("数据库健康检查失败: %w", err))
				return
			}
		}

		// data/ 同时包含 SQLite、ACME/上传证书及已持久化的自签证书(data/certs)。
		// certificates 表还保存 PEM/私钥作为文件副本损坏时的兜底。
		// 先把 zip 打进内存再输出，打包错误仍能正常回 4xx/5xx。
		var zipBuf bytes.Buffer
		zipWriter := zip.NewWriter(&zipBuf)
		if isPostgres && includeDatabase {
			dump, err := createPostgresDump(r.Context(), repo.DatabaseConfig())
			if err != nil {
				_ = zipWriter.Close()
				writeBackupError(w, http.StatusInternalServerError, err)
				return
			}
			if err := addBytesToZip(zipWriter, "database/postgres.dump", dump); err != nil {
				writeBackupError(w, http.StatusInternalServerError, fmt.Errorf("打包 PostgreSQL 数据失败: %w", err))
				return
			}
			manifest, _ := json.MarshalIndent(map[string]any{
				"format": "mmwx-database-backup-v1", "driver": "postgres",
				"created_at": time.Now().Format(time.RFC3339), "dump_format": "custom",
			}, "", "  ")
			if err := addBytesToZip(zipWriter, "database/manifest.json", append(manifest, '\n')); err != nil {
				writeBackupError(w, http.StatusInternalServerError, fmt.Errorf("打包数据库元数据失败: %w", err))
				return
			}
		}
		if err := addDirToZip(zipWriter, dataDir, "data"); err != nil {
			writeBackupError(w, http.StatusInternalServerError, fmt.Errorf("打包 data 失败: %w", err))
			return
		}
		subscribeDir := filepath.Join(filepath.Dir(dataDir), "subscribes")
		if err := addOptionalDirToZip(zipWriter, subscribeDir, "subscribes"); err != nil {
			writeBackupError(w, http.StatusInternalServerError, fmt.Errorf("打包 subscribes 失败: %w", err))
			return
		}
		if err := zipWriter.Close(); err != nil {
			writeBackupError(w, http.StatusInternalServerError, fmt.Errorf("finalize zip: %w", err))
			return
		}

		filename := fmt.Sprintf("miaomiaowux-backup-%s.zip", time.Now().Format("20060102-150405"))
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%s", filename))
		_, _ = w.Write(zipBuf.Bytes())
	})
}

func addOptionalDirToZip(zipWriter *zip.Writer, srcDir, baseInZip string) error {
	if _, err := os.Stat(srcDir); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	return addDirToZip(zipWriter, srcDir, baseInZip)
}

func createPostgresDump(ctx context.Context, cfg storage.DatabaseConfig) ([]byte, error) {
	major, err := postgresServerMajor(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("读取 PostgreSQL 服务端版本失败: %w", err)
	}
	bin, err := ensurePostgresClientTool(ctx, "pg_dump", major)
	if err != nil {
		return nil, err
	}
	dumpCtx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(dumpCtx, bin,
		"--format=custom", "--compress=6", "--no-owner", "--no-privileges",
		"--host", cfg.Host, "--port", strconv.Itoa(cfg.Port),
		"--username", cfg.Username, "--dbname", cfg.Database,
	)
	cmd.Env = append(os.Environ(), "PGPASSWORD="+cfg.Password, "PGSSLMODE="+cfg.SSLMode)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	dump, err := cmd.Output()
	if err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return nil, fmt.Errorf("PostgreSQL 备份失败: %s", message)
	}
	if len(dump) < 5 || string(dump[:5]) != "PGDMP" {
		return nil, errors.New("PostgreSQL 备份失败：pg_dump 未返回有效的 custom dump")
	}
	return dump, nil
}

// ensurePostgresClientTool locates an official PostgreSQL client tool and, on
// a privileged bare-metal installation, installs the client package on demand.
func ensurePostgresClientTool(ctx context.Context, tool, major string) (string, error) {
	if _, err := strconv.Atoi(major); err != nil || len(major) < 2 || len(major) > 3 {
		return "", fmt.Errorf("无效的 PostgreSQL 主版本: %q", major)
	}
	if path, ok := compatiblePostgresTool(tool, major); ok {
		return path, nil
	}

	postgresClientInstallMu.Lock()
	defer postgresClientInstallMu.Unlock()
	if path, ok := compatiblePostgresTool(tool, major); ok {
		return path, nil
	}

	type installStep struct {
		name string
		args []string
	}
	var steps []installStep
	switch {
	case commandExists("apt-get"):
		steps = []installStep{
			{name: "apt-get", args: []string{"update", "-qq"}},
			{name: "apt-get", args: []string{"install", "-y", "postgresql-client-" + major}},
		}
	case commandExists("apk"):
		steps = []installStep{{name: "apk", args: []string{"add", "--no-cache", "postgresql" + major + "-client"}}}
	case commandExists("dnf"):
		steps = []installStep{{name: "dnf", args: []string{"install", "-y", "postgresql" + major}}}
	case commandExists("yum"):
		steps = []installStep{{name: "yum", args: []string{"install", "-y", "postgresql" + major}}}
	case commandExists("pacman"):
		steps = []installStep{{name: "pacman", args: []string{"-Sy", "--noconfirm", "postgresql"}}}
	default:
		return "", fmt.Errorf("未找到 %s，且无法识别系统包管理器；请安装与数据库服务端同版本或更高版本的 PostgreSQL client", tool)
	}

	installCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	for _, step := range steps {
		cmd := exec.CommandContext(installCtx, step.name, step.args...)
		cmd.Env = append(os.Environ(), "DEBIAN_FRONTEND=noninteractive")
		output, err := cmd.CombinedOutput()
		if err != nil {
			// An unrelated third-party apt source may be expired while Debian's
			// cached indexes remain usable. Continue to the actual install step.
			if step.name == "apt-get" && len(step.args) > 0 && step.args[0] == "update" {
				continue
			}
			// Debian/Ubuntu LTS repositories can be older than the configured
			// PostgreSQL server. Add the
			// official PostgreSQL repository and install the exact client major.
			if step.name == "apt-get" && installPostgresClientFromPGDG(installCtx, major) == nil {
				continue
			}
			detail := strings.TrimSpace(string(output))
			if detail == "" {
				detail = err.Error()
			}
			return "", fmt.Errorf("未找到 %s，自动安装 PostgreSQL client 失败（主控进程可能没有 root 权限）: %s", tool, detail)
		}
	}

	path, ok := compatiblePostgresTool(tool, major)
	if !ok {
		return "", fmt.Errorf("PostgreSQL client 安装完成，但未找到可用的 PG%s %s", major, tool)
	}
	return path, nil
}

func installPostgresClientFromPGDG(ctx context.Context, major string) error {
	prerequisites := exec.CommandContext(ctx, "apt-get", "install", "-y", "ca-certificates", "curl", "gnupg")
	prerequisites.Env = append(os.Environ(), "DEBIAN_FRONTEND=noninteractive")
	if output, err := prerequisites.CombinedOutput(); err != nil {
		return fmt.Errorf("安装 PGDG 软件源依赖失败: %s", strings.TrimSpace(string(output)))
	}
	osRelease, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return err
	}
	codename := ""
	for _, line := range strings.Split(string(osRelease), "\n") {
		if strings.HasPrefix(line, "VERSION_CODENAME=") {
			codename = strings.Trim(strings.TrimPrefix(line, "VERSION_CODENAME="), `"'`)
			break
		}
	}
	if codename == "" || strings.ContainsAny(codename, " /\\\t\r\n") {
		return errors.New("无法识别 Debian/Ubuntu VERSION_CODENAME")
	}
	if err := os.MkdirAll("/usr/share/postgresql-common/pgdg", 0755); err != nil {
		return err
	}
	keyFile, err := os.CreateTemp("", "mmwx-pgdg-key-*.asc")
	if err != nil {
		return err
	}
	keyPath := keyFile.Name()
	_ = keyFile.Close()
	defer os.Remove(keyPath)
	if output, err := exec.CommandContext(ctx, "curl", "-fsSL", "-o", keyPath, "https://www.postgresql.org/media/keys/ACCC4CF8.asc").CombinedOutput(); err != nil {
		return fmt.Errorf("下载 PGDG 签名密钥失败: %s", strings.TrimSpace(string(output)))
	}
	keyring := "/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg"
	if output, err := exec.CommandContext(ctx, "gpg", "--dearmor", "--yes", "--output", keyring, keyPath).CombinedOutput(); err != nil {
		return fmt.Errorf("导入 PGDG 签名密钥失败: %s", strings.TrimSpace(string(output)))
	}
	sourcePath := "/etc/apt/sources.list.d/pgdg.list"
	source := fmt.Sprintf("deb [signed-by=%s] https://apt.postgresql.org/pub/repos/apt %s-pgdg main\n", keyring, codename)
	if err := os.WriteFile(sourcePath, []byte(source), 0644); err != nil {
		return err
	}
	update := exec.CommandContext(ctx, "apt-get", "update",
		"-o", "Dir::Etc::sourcelist=sources.list.d/pgdg.list",
		"-o", "Dir::Etc::sourceparts=-",
		"-o", "APT::Get::List-Cleanup=0")
	if output, err := update.CombinedOutput(); err != nil {
		return fmt.Errorf("更新 PGDG 软件源失败: %s", strings.TrimSpace(string(output)))
	}
	install := exec.CommandContext(ctx, "apt-get", "install", "-y", "postgresql-client-"+major)
	install.Env = append(os.Environ(), "DEBIAN_FRONTEND=noninteractive")
	if output, err := install.CombinedOutput(); err != nil {
		return fmt.Errorf("安装 PostgreSQL %s client 失败: %s", major, strings.TrimSpace(string(output)))
	}
	return nil
}

func compatiblePostgresTool(tool, major string) (string, bool) {
	paths := []string{filepath.Join("/usr/lib/postgresql", major, "bin", tool)}
	if path, err := exec.LookPath(tool); err == nil {
		paths = append(paths, path)
	}
	for _, path := range paths {
		output, err := exec.Command(path, "--version").CombinedOutput()
		if err == nil && strings.Contains(string(output), " "+major+".") {
			return path, true
		}
	}
	return "", false
}

func postgresServerMajor(ctx context.Context, cfg storage.DatabaseConfig) (string, error) {
	db, err := sql.Open("pgx", postgresConfigDSN(cfg))
	if err != nil {
		return "", err
	}
	defer db.Close()
	var versionNum int
	if err := db.QueryRowContext(ctx, `SHOW server_version_num`).Scan(&versionNum); err != nil {
		return "", err
	}
	major := versionNum / 10000
	if major < 10 || major > 99 {
		return "", fmt.Errorf("无法识别 server_version_num=%d", versionNum)
	}
	return strconv.Itoa(major), nil
}

func commandExists(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func addBytesToZip(writer *zip.Writer, name string, data []byte) error {
	header := &zip.FileHeader{Name: name, Method: zip.Store}
	header.SetModTime(time.Now())
	dst, err := writer.CreateHeader(header)
	if err != nil {
		return err
	}
	_, err = dst.Write(data)
	return err
}

// NewBackupRestoreHandler 返回一个从备份恢复的处理程序。
// 备份以普通 ZIP 格式上传，不需要密码。
// 该处理程序需要管理员身份验证。
func NewBackupRestoreHandler(repo *storage.TrafficRepository, dataDir string) http.Handler {
	if repo == nil {
		panic("backup restore handler requires repository")
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeBackupError(w, http.StatusMethodNotAllowed, errors.New("only POST is supported"))
			return
		}
		result, err := restoreFromRequest(w, r, repo, dataDir)
		if err != nil {
			return // restoreFromRequest 内部已写错误响应
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"message":    "备份恢复成功，主控正在重启",
			"restarting": strconv.FormatBool(result.databaseSwitched),
		})
		if result.databaseSwitched {
			go func() {
				time.Sleep(500 * time.Millisecond)
				_ = SignalGracefulRestart()
			}()
		}
	})
}

// NewSetupRestoreBackupHandler 返回用于在初始设置期间恢复备份的处理程序。
// 该处理程序不需要身份验证，但仅在系统未初始化(无用户)时可用。
func NewSetupRestoreBackupHandler(repo *storage.TrafficRepository, dataDir string) http.Handler {
	if repo == nil {
		panic("setup restore backup handler requires repository")
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeBackupError(w, http.StatusMethodNotAllowed, errors.New("only POST is supported"))
			return
		}

		// 关键安全检查：仅在不存在用户时允许
		users, err := repo.ListUsers(r.Context(), 1)
		if err != nil {
			writeBackupError(w, http.StatusInternalServerError, err)
			return
		}
		if len(users) > 0 {
			writeBackupError(w, http.StatusForbidden, errors.New("系统已初始化，无法使用此接口恢复备份"))
			return
		}

		result, err := restoreFromRequest(w, r, repo, dataDir)
		if err != nil {
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"message":    "备份恢复成功，请刷新页面后登录",
			"restarting": strconv.FormatBool(result.databaseSwitched),
		})
		if result.databaseSwitched {
			go func() {
				time.Sleep(500 * time.Millisecond)
				_ = SignalGracefulRestart()
			}()
		}
	})
}

type backupRestoreResult struct {
	databaseSwitched bool
}

// restoreFromRequest 读取上传的备份(加密或旧明文),解密(如需要)后提取到 data/ 与 subscribes/。
// 出错时已写好响应并返回非 nil,调用方据此直接 return。
func restoreFromRequest(w http.ResponseWriter, r *http.Request, repo *storage.TrafficRepository, dataDir string) (backupRestoreResult, error) {
	// PostgreSQL custom dump 通常远大于旧 SQLite 备份。
	r.Body = http.MaxBytesReader(w, r.Body, 1<<30)

	file, _, err := r.FormFile("backup")
	if err != nil {
		writeBackupError(w, http.StatusBadRequest, fmt.Errorf("failed to read backup file: %w", err))
		return backupRestoreResult{}, err
	}
	defer file.Close()

	data, err := io.ReadAll(file)
	if err != nil {
		writeBackupError(w, http.StatusInternalServerError, fmt.Errorf("failed to read backup file: %w", err))
		return backupRestoreResult{}, err
	}

	if isLegacyEncryptedBackup(data) {
		passphrase := r.FormValue("passphrase")
		if passphrase == "" {
			err := errors.New("这是旧版加密备份，请填写原备份密码")
			writeBackupError(w, http.StatusBadRequest, err)
			return backupRestoreResult{}, err
		}
		plain, decryptErr := decryptLegacyBackup(data, passphrase)
		if decryptErr != nil {
			writeBackupError(w, http.StatusBadRequest, decryptErr)
			return backupRestoreResult{}, decryptErr
		}
		data = plain
	}

	dump, hasPostgresDump, err := postgresDumpFromBackup(data)
	if err != nil {
		writeBackupError(w, http.StatusBadRequest, err)
		return backupRestoreResult{}, err
	}
	if hasPostgresDump {
		if repo.DatabaseDriver() != "postgres" {
			err := errors.New("PostgreSQL 数据库备份只能恢复到已配置 PostgreSQL 的主控")
			writeBackupError(w, http.StatusConflict, err)
			return backupRestoreResult{}, err
		}
		if storage.DatabaseConfigUsesEnvironment() {
			err := errors.New("数据库连接由 MMWX_DATABASE_* 环境变量管理，无法安全切换到恢复数据库；请改用 database.json 配置后重试")
			writeBackupError(w, http.StatusConflict, err)
			return backupRestoreResult{}, err
		}
		newConfig, restoreErr := restorePostgresToStaging(r.Context(), dump, repo.DatabaseConfig())
		if restoreErr != nil {
			writeBackupError(w, http.StatusInternalServerError, restoreErr)
			return backupRestoreResult{}, restoreErr
		}
		// PostgreSQL 模式绝不能从备份覆盖 database.json，否则会重新指向
		// 制作备份时的数据库，绕过已验证的新库。
		if err := extractBackupFromBytesForRuntime(data, true, dataDir); err != nil {
			dropPostgresDatabase(repo.DatabaseConfig(), newConfig.Database)
			writeBackupError(w, http.StatusInternalServerError, fmt.Errorf("failed to extract backup: %w", err))
			return backupRestoreResult{}, err
		}
		if err := storage.SaveDatabaseRestoreRollback(dataDir, repo.DatabaseConfig()); err != nil {
			dropPostgresDatabase(repo.DatabaseConfig(), newConfig.Database)
			writeBackupError(w, http.StatusInternalServerError, fmt.Errorf("保存数据库恢复回滚配置失败: %w", err))
			return backupRestoreResult{}, err
		}
		if err := storage.SaveDatabaseConfig(dataDir, newConfig); err != nil {
			_ = storage.ClearDatabaseRestoreRollback(dataDir)
			dropPostgresDatabase(repo.DatabaseConfig(), newConfig.Database)
			writeBackupError(w, http.StatusInternalServerError, fmt.Errorf("切换恢复数据库失败: %w", err))
			return backupRestoreResult{}, err
		}
		return backupRestoreResult{databaseSwitched: true}, nil
	}

	if err := extractBackupFromBytesForRuntime(data, repo.DatabaseDriver() == "postgres", dataDir); err != nil {
		writeBackupError(w, http.StatusInternalServerError, fmt.Errorf("failed to extract backup: %w", err))
		return backupRestoreResult{}, err
	}
	return backupRestoreResult{}, nil
}

// 递归地将目录添加到 zip writer
func addDirToZip(zipWriter *zip.Writer, srcDir, baseInZip string) error {
	return filepath.Walk(srcDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		// 跳过目录（它们是隐式创建的）
		if info.IsDir() {
			return nil
		}

		// 跳过隐藏文件和特殊文件
		if strings.HasPrefix(info.Name(), ".") {
			return nil
		}

		relPath, err := filepath.Rel(srcDir, path)
		if err != nil {
			return err
		}
		zipPath := filepath.Join(baseInZip, relPath)

		// 创建具有适当修改时间的文件头
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		// zip 规范用正斜杠作路径分隔符;Windows 上 filepath.Join 产出反斜杠,
		// 若不转换,恢复端按 "data/" / "subscribes/" 前缀匹配不到 → 误判"备份无效"。
		header.Name = filepath.ToSlash(zipPath)
		header.Method = zip.Deflate

		writer, err := zipWriter.CreateHeader(header)
		if err != nil {
			return err
		}

		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()

		_, err = io.Copy(writer, f)
		return err
	})
}

func postgresDumpFromBackup(data []byte) ([]byte, bool, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, false, fmt.Errorf("failed to open zip: %w", err)
	}
	var dumpFile *zip.File
	var manifestFound bool
	for _, file := range zr.File {
		name := strings.ReplaceAll(file.Name, "\\", "/")
		switch name {
		case "database/manifest.json":
			manifestFound = true
		case "database/postgres.dump":
			dumpFile = file
		}
	}
	if dumpFile == nil {
		return nil, false, nil
	}
	if !manifestFound {
		return nil, false, errors.New("PostgreSQL 备份缺少 database/manifest.json")
	}
	if dumpFile.UncompressedSize64 > 1<<30 {
		return nil, false, errors.New("PostgreSQL dump 解压后超过 1 GiB 限制")
	}
	rc, err := dumpFile.Open()
	if err != nil {
		return nil, false, fmt.Errorf("打开 PostgreSQL dump 失败: %w", err)
	}
	defer rc.Close()
	dump, err := io.ReadAll(io.LimitReader(rc, (1<<30)+1))
	if err != nil {
		return nil, false, fmt.Errorf("读取 PostgreSQL dump 失败: %w", err)
	}
	if len(dump) < 5 || string(dump[:5]) != "PGDMP" {
		return nil, false, errors.New("PostgreSQL dump 文件头无效")
	}
	return dump, true, nil
}

func restorePostgresToStaging(ctx context.Context, dump []byte, cfg storage.DatabaseConfig) (storage.DatabaseConfig, error) {
	major, err := postgresServerMajor(ctx, cfg)
	if err != nil {
		return storage.DatabaseConfig{}, fmt.Errorf("读取 PostgreSQL 服务端版本失败: %w", err)
	}
	bin, err := ensurePostgresClientTool(ctx, "pg_restore", major)
	if err != nil {
		return storage.DatabaseConfig{}, err
	}
	tmp, err := os.CreateTemp("", "mmwx-postgres-restore-*.dump")
	if err != nil {
		return storage.DatabaseConfig{}, fmt.Errorf("创建恢复临时文件失败: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return storage.DatabaseConfig{}, err
	}
	if _, err := tmp.Write(dump); err != nil {
		tmp.Close()
		return storage.DatabaseConfig{}, fmt.Errorf("写入恢复临时文件失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return storage.DatabaseConfig{}, err
	}

	checkCtx, cancelCheck := context.WithTimeout(ctx, 2*time.Minute)
	defer cancelCheck()
	check := exec.CommandContext(checkCtx, bin, "--list", tmpPath)
	if output, err := check.CombinedOutput(); err != nil {
		return storage.DatabaseConfig{}, fmt.Errorf("pg_restore 校验备份失败: %s", strings.TrimSpace(string(output)))
	}

	adminDB, err := sql.Open("pgx", postgresConfigDSN(cfg))
	if err != nil {
		return storage.DatabaseConfig{}, fmt.Errorf("连接 PostgreSQL 失败: %w", err)
	}
	defer adminDB.Close()
	if err := adminDB.PingContext(ctx); err != nil {
		return storage.DatabaseConfig{}, fmt.Errorf("连接 PostgreSQL 失败: %w", err)
	}
	stageName := postgresRestoreDatabaseName(cfg.Database)
	if _, err := adminDB.ExecContext(ctx, `CREATE DATABASE `+quotePostgresIdentifier(stageName)+` TEMPLATE template0`); err != nil {
		if isCreateDatabasePermissionError(err) {
			if grantErr := tryGrantLocalPostgresCreatedb(ctx, cfg); grantErr == nil {
				_, err = adminDB.ExecContext(ctx, `CREATE DATABASE `+quotePostgresIdentifier(stageName)+` TEMPLATE template0`)
			} else {
				return storage.DatabaseConfig{}, fmt.Errorf("创建恢复数据库失败，且本机自动授予 CREATEDB 权限失败: %v；原始错误: %w", grantErr, err)
			}
		}
		if err != nil {
			return storage.DatabaseConfig{}, fmt.Errorf("创建恢复数据库失败（远程数据库请由管理员为 %s 授予 CREATEDB 权限）: %w", cfg.Username, err)
		}
	}
	dropStage := true
	defer func() {
		if dropStage {
			_, _ = adminDB.ExecContext(context.Background(), `DROP DATABASE IF EXISTS `+quotePostgresIdentifier(stageName)+` WITH (FORCE)`)
		}
	}()

	restoreCtx, cancelRestore := context.WithTimeout(ctx, 30*time.Minute)
	defer cancelRestore()
	cmd := exec.CommandContext(restoreCtx, bin,
		"--exit-on-error", "--no-owner", "--no-privileges", "--single-transaction",
		"--host", cfg.Host, "--port", strconv.Itoa(cfg.Port),
		"--username", cfg.Username, "--dbname", stageName, tmpPath,
	)
	cmd.Env = append(os.Environ(), "PGPASSWORD="+cfg.Password, "PGSSLMODE="+cfg.SSLMode)
	if output, err := cmd.CombinedOutput(); err != nil {
		return storage.DatabaseConfig{}, fmt.Errorf("PostgreSQL 恢复失败: %s", strings.TrimSpace(string(output)))
	}

	newConfig := cfg
	newConfig.Database = stageName
	verifyRepo, err := storage.NewTrafficRepositoryFromConfig(newConfig)
	if err != nil {
		return storage.DatabaseConfig{}, fmt.Errorf("验证恢复数据库失败: %w", err)
	}
	verifyCtx, cancelVerify := context.WithTimeout(ctx, 30*time.Second)
	_, usersErr := verifyRepo.ListUsers(verifyCtx, 1)
	cancelVerify()
	closeErr := verifyRepo.Close()
	if usersErr != nil {
		return storage.DatabaseConfig{}, fmt.Errorf("验证恢复数据库用户表失败: %w", usersErr)
	}
	if closeErr != nil {
		return storage.DatabaseConfig{}, fmt.Errorf("关闭恢复数据库验证连接失败: %w", closeErr)
	}
	dropStage = false
	return newConfig, nil
}

func isCreateDatabasePermissionError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "sqlstate 42501") || strings.Contains(message, "permission denied to create database")
}

// tryGrantLocalPostgresCreatedb removes the command-line step for the common
// bare-metal setup. It deliberately works only for a loopback PostgreSQL and a
// root master process, using PostgreSQL's local peer-authenticated OS account;
// no database superuser password is requested, transmitted, or stored.
func tryGrantLocalPostgresCreatedb(ctx context.Context, cfg storage.DatabaseConfig) error {
	host := strings.TrimSpace(strings.ToLower(cfg.Host))
	if host != "127.0.0.1" && host != "localhost" && host != "::1" && !strings.HasPrefix(host, "/") {
		return errors.New("数据库不是本机地址")
	}
	if os.Geteuid() != 0 {
		return errors.New("主控进程不是 root，无法切换到 postgres 系统账号")
	}
	runuser, err := exec.LookPath("runuser")
	if err != nil {
		return errors.New("系统缺少 runuser")
	}
	major, err := postgresServerMajor(ctx, cfg)
	if err != nil {
		return err
	}
	psql := filepath.Join("/usr/lib/postgresql", major, "bin", "psql")
	if _, err := os.Stat(psql); err != nil {
		psql, err = exec.LookPath("psql")
		if err != nil {
			return errors.New("系统缺少 psql")
		}
	}
	grantCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	statement := `ALTER ROLE ` + quotePostgresIdentifier(cfg.Username) + ` CREATEDB`
	cmd := exec.CommandContext(grantCtx, runuser, "-u", "postgres", "--", psql,
		"--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--dbname", "postgres", "--command", statement)
	if output, err := cmd.CombinedOutput(); err != nil {
		detail := strings.TrimSpace(string(output))
		if detail == "" {
			detail = err.Error()
		}
		return errors.New(detail)
	}
	return nil
}

func postgresConfigDSN(cfg storage.DatabaseConfig) string {
	u := &url.URL{Scheme: "postgres", Host: fmt.Sprintf("%s:%d", cfg.Host, cfg.Port), Path: cfg.Database}
	u.User = url.UserPassword(cfg.Username, cfg.Password)
	query := u.Query()
	query.Set("sslmode", cfg.SSLMode)
	u.RawQuery = query.Encode()
	return u.String()
}

func postgresRestoreDatabaseName(current string) string {
	base := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' {
			return r
		}
		return '_'
	}, current)
	now := time.Now()
	suffix := now.Format("_restore_20060102_150405_") + fmt.Sprintf("%06d", now.Nanosecond()/1000)
	maxBase := 63 - len(suffix)
	if len(base) > maxBase {
		base = base[:maxBase]
	}
	if base == "" {
		base = "mmwx"
	}
	return base + suffix
}

func dropPostgresDatabase(cfg storage.DatabaseConfig, database string) {
	db, err := sql.Open("pgx", postgresConfigDSN(cfg))
	if err != nil {
		return
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, _ = db.ExecContext(ctx, `DROP DATABASE IF EXISTS `+quotePostgresIdentifier(database)+` WITH (FORCE)`)
}

func quotePostgresIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

// extractBackupFromBytes 从内存中的 zip 字节提取备份。
func extractBackupFromBytes(data []byte) error {
	return extractBackupFromBytesWithOptions(data, false)
}

func extractBackupFromBytesWithOptions(data []byte, skipDatabaseConfig bool) error {
	return extractBackupFromBytesForRuntime(data, skipDatabaseConfig, "data")
}

func extractBackupFromBytesForRuntime(data []byte, skipDatabaseConfig bool, dataDir string) error {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return fmt.Errorf("failed to open zip: %w", err)
	}
	return extractZipReaderWithOptions(zr, skipDatabaseConfig, dataDir)
}

// extractZipReader 把 zip 内容提取到 data/ 与 subscribes/(其余路径忽略,并防路径穿越)。
func extractZipReader(reader *zip.Reader) error {
	return extractZipReaderWithOptions(reader, false, "data")
}

func extractZipReaderWithOptions(reader *zip.Reader, skipDatabaseConfig bool, dataDir string) error {
	// 首先验证 zip 内容
	hasData := false
	hasSubscribes := false
	for _, f := range reader.File {
		// 显式把反斜杠换成正斜杠:兼容旧版在 Windows 上生成的备份(zip 内路径为 data\...)。
		// 注意不能用 filepath.ToSlash —— 它只在 Windows 生效,Linux 主控恢复 Windows 备份时不处理反斜杠。
		name := strings.ReplaceAll(f.Name, "\\", "/")
		if skipDatabaseConfig && name == "data/"+storage.DatabaseConfigFilename {
			continue
		}
		if strings.HasPrefix(name, "data/") {
			hasData = true
		}
		if strings.HasPrefix(name, "subscribes/") {
			hasSubscribes = true
		}
	}

	if !hasData && !hasSubscribes {
		return errors.New("备份文件格式无效：缺少 data 或 subscribes 目录")
	}

	for _, f := range reader.File {
		// 显式换掉反斜杠(兼容旧 Windows 备份);filepath.ToSlash 在 Linux 不处理反斜杠,故不能用。
		name := strings.ReplaceAll(f.Name, "\\", "/")
		if skipDatabaseConfig && name == "data/"+storage.DatabaseConfigFilename {
			continue
		}

		// 安全检查：防止路径穿越
		if strings.Contains(name, "..") {
			continue
		}

		// 只提取 data/ 和 subscribes/ 目录
		if !strings.HasPrefix(name, "data/") && !strings.HasPrefix(name, "subscribes/") {
			continue
		}

		var destPath string
		if strings.HasPrefix(name, "data/") {
			destPath = filepath.Join(dataDir, filepath.FromSlash(strings.TrimPrefix(name, "data/")))
		} else {
			subscribeDir := filepath.Join(filepath.Dir(dataDir), "subscribes")
			destPath = filepath.Join(subscribeDir, filepath.FromSlash(strings.TrimPrefix(name, "subscribes/")))
		}

		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(destPath, 0755); err != nil {
				return fmt.Errorf("failed to create directory %s: %w", destPath, err)
			}
			continue
		}

		// 确保父目录存在
		if err := os.MkdirAll(filepath.Dir(destPath), 0755); err != nil {
			return fmt.Errorf("failed to create parent directory for %s: %w", destPath, err)
		}

		srcFile, err := f.Open()
		if err != nil {
			return fmt.Errorf("failed to open zip file %s: %w", f.Name, err)
		}

		mode := f.Mode().Perm()
		if mode == 0 {
			mode = 0644
		}
		lowerBase := strings.ToLower(filepath.Base(destPath))
		if strings.HasSuffix(lowerBase, ".key") || lowerBase == "privkey.pem" {
			mode = 0600
		}
		tmpFile, err := os.CreateTemp(filepath.Dir(destPath), ".mmwx-restore-*")
		if err != nil {
			srcFile.Close()
			return fmt.Errorf("failed to create temporary file for %s: %w", destPath, err)
		}
		tmpPath := tmpFile.Name()
		_, err = io.Copy(tmpFile, srcFile)
		srcFile.Close()
		if syncErr := tmpFile.Sync(); err == nil {
			err = syncErr
		}
		if closeErr := tmpFile.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			_ = os.Remove(tmpPath)
			return fmt.Errorf("failed to extract file %s: %w", f.Name, err)
		}
		if err := os.Chmod(tmpPath, mode); err != nil {
			_ = os.Remove(tmpPath)
			return fmt.Errorf("failed to restore permissions for %s: %w", f.Name, err)
		}
		if err := os.Rename(tmpPath, destPath); err != nil {
			_ = os.Remove(tmpPath)
			return fmt.Errorf("failed to replace file %s: %w", f.Name, err)
		}
	}

	return nil
}

func writeBackupError(w http.ResponseWriter, status int, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"error": err.Error(),
	})
}
