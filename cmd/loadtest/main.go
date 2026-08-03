// Command loadtest 是一个临时的主控压测 harness:用真实的 storage(sqlite WAL)+
// traffic.Collector + handler.RemoteTrafficHandler,起 N 个模拟 agent 并发向
// POST /api/remote/traffic 高频上报流量,观测 WAL 增长 / checkpoint 效果 / 上报延迟。
// 与主控完全同一套写库路径(明文 token 上报,未开强制加密)。测完即删,勿入库。
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"miaomiaowux/internal/handler"
	"miaomiaowux/internal/storage"
	"miaomiaowux/internal/traffic"
	"miaomiaowux/internal/version"
)

func main() {
	agents := flag.Int("agents", 200, "模拟 agent 数量")
	interval := flag.Duration("interval", 15*time.Second, "每个 agent 的上报间隔")
	users := flag.Int("users", 80, "每次上报携带的 user(email)条数")
	inbounds := flag.Int("inbounds", 8, "每次上报的 inbound tag 数(outbound 同数)")
	duration := flag.Duration("duration", 10*time.Minute, "压测总时长")
	ckpt := flag.Duration("ckpt", 300*time.Second, "WAL checkpoint 间隔(真实主控=5min)")
	dir := flag.String("dir", "", "DB 目录(默认临时目录,测完自行清理)")
	driver := flag.String("driver", "sqlite", "数据库类型: sqlite 或 postgres")
	pgHost := flag.String("pg-host", "127.0.0.1", "PostgreSQL 主机")
	pgPort := flag.Int("pg-port", 55432, "PostgreSQL 端口")
	pgDatabase := flag.String("pg-database", "mmwx_loadtest", "PostgreSQL 数据库名(必须为空)")
	pgUser := flag.String("pg-user", "mmwx", "PostgreSQL 用户")
	pgPassword := flag.String("pg-password", "mmwx-loadtest", "PostgreSQL 密码")
	flag.Parse()

	if *dir == "" {
		d, err := os.MkdirTemp("", "mmwx-load-")
		if err != nil {
			log.Fatal(err)
		}
		*dir = d
	}
	dbPath := filepath.Join(*dir, "mmwx.db")
	config := storage.DatabaseConfig{Driver: "sqlite", Path: dbPath}
	if *driver == "postgres" {
		config = storage.DatabaseConfig{Driver: "postgres", Host: *pgHost, Port: *pgPort, Database: *pgDatabase, Username: *pgUser, Password: *pgPassword, SSLMode: "disable", MaxOpenConns: 50, MaxIdleConns: 20}
	}
	log.Printf("DB driver=%s target=%s", config.Driver, config.SafeView())

	repo, err := storage.NewTrafficRepositoryFromConfig(config)
	if err != nil {
		log.Fatalf("open repo: %v", err)
	}
	ctx := context.Background()

	// 建 N 个 remote_server 拿 token(明文上报只需 Name+Token)
	tokens := make([]string, *agents)
	for i := 0; i < *agents; i++ {
		tok := fmt.Sprintf("loadtok-%06d", i)
		s := &storage.RemoteServer{Name: fmt.Sprintf("load-%06d", i), Token: tok}
		if err := repo.CreateRemoteServer(ctx, s); err != nil {
			log.Fatalf("create server %d: %v", i, err)
		}
		tokens[i] = tok
	}
	log.Printf("已建 %d 个模拟 server", *agents)

	collector := traffic.NewCollector(repo)
	crypto := handler.NewCryptoConfig(nil, nil) // identity=nil → 明文路径
	h := handler.NewRemoteTrafficHandler(repo, collector, crypto)
	srv := httptest.NewServer(h)
	defer srv.Close()
	url := srv.URL + "/api/remote/traffic"

	// 指标
	var reports, errs, http4xx int64
	var latMu sync.Mutex
	lats := make([]float64, 0, 1<<20) // ms

	runCtx, cancel := context.WithTimeout(ctx, *duration)
	defer cancel()

	// checkpoint 巡检(与主控 startWALCheckpointTask 同逻辑)
	var ckptTrunc, ckptPassive int64
	var lastRemaining int64
	go func() {
		tk := time.NewTicker(*ckpt)
		defer tk.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-tk.C:
				truncated, remaining, err := repo.CheckpointBestEffort()
				if err != nil {
					log.Printf("[ckpt] err: %v", err)
					continue
				}
				atomic.StoreInt64(&lastRemaining, int64(remaining))
				if truncated {
					atomic.AddInt64(&ckptTrunc, 1)
					log.Printf("[ckpt] TRUNCATE ok, wal 截回 0")
				} else {
					atomic.AddInt64(&ckptPassive, 1)
					log.Printf("[ckpt] 抢不到窗口,PASSIVE 推进,剩余 %d 帧未截断", remaining)
				}
			}
		}
	}()

	// 采样器:每秒打印 WAL/DB 大小、速率、延迟、内存
	sampleDone := make(chan struct{})
	var walPeak int64
	go func() {
		defer close(sampleDone)
		tk := time.NewTicker(1 * time.Second)
		defer tk.Stop()
		start := time.Now()
		var lastReports int64
		fmt.Printf("\n%5s %8s %9s %9s %8s %8s %8s %7s %6s\n",
			"t(s)", "reports", "rate/s", "wal(MB)", "db(MB)", "p50ms", "p99ms", "errs", "goroutine")
		for {
			select {
			case <-runCtx.Done():
				return
			case <-tk.C:
				el := time.Since(start).Seconds()
				r := atomic.LoadInt64(&reports)
				rate := r - lastReports
				lastReports = r
				wal := fileSizeMB(dbPath + "-wal")
				db := fileSizeMB(dbPath)
				if status, err := repo.DatabaseStatus(context.Background()); err == nil {
					db = float64(status.Size) / 1024 / 1024
					wal = float64(status.WALSize) / 1024 / 1024
				}
				if w := int64(wal * 1024 * 1024); w > walPeak {
					walPeak = w
				}
				p50, p99 := percentiles(&latMu, &lats)
				fmt.Printf("%5.0f %8d %9d %9.2f %8.2f %8.1f %8.1f %7d %6d\n",
					el, r, rate, wal, db, p50, p99, atomic.LoadInt64(&errs), runtime.NumGoroutine())
			}
		}
	}()

	// 起 agent
	var wg sync.WaitGroup
	for i := 0; i < *agents; i++ {
		wg.Add(1)
		go func(id int, tok string) {
			defer wg.Done()
			client := &http.Client{Timeout: 30 * time.Second}
			// 起始抖动,避免齐步上报
			jitter := time.Duration(rand.Int63n(int64(*interval)))
			select {
			case <-runCtx.Done():
				return
			case <-time.After(jitter):
			}
			tk := time.NewTicker(*interval)
			defer tk.Stop()
			var cum int64 // cumulative 计数器(单调递增)
			report := func() {
				cum += 1_000_000 + rand.Int63n(9_000_000) // 每轮 1~10MB 增量
				body := buildBody(id, cum, *users, *inbounds)
				req, _ := http.NewRequestWithContext(runCtx, http.MethodPost, url, bytes.NewReader(body))
				req.Header.Set("User-Agent", version.AgentUserAgent)
				req.Header.Set("X-Remote-Token", tok)
				req.Header.Set("Content-Type", "application/json")
				t0 := time.Now()
				resp, err := client.Do(req)
				lat := time.Since(t0)
				if err != nil {
					atomic.AddInt64(&errs, 1)
					return
				}
				io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
				if resp.StatusCode != http.StatusOK {
					atomic.AddInt64(&errs, 1)
					atomic.AddInt64(&http4xx, 1)
					return
				}
				atomic.AddInt64(&reports, 1)
				latMu.Lock()
				lats = append(lats, float64(lat.Microseconds())/1000.0)
				latMu.Unlock()
			}
			report() // 首次立即上报一次
			for {
				select {
				case <-runCtx.Done():
					return
				case <-tk.C:
					report()
				}
			}
		}(i, tokens[i])
	}

	<-runCtx.Done()
	wg.Wait()
	<-sampleDone

	// 收尾:再做一次 TRUNCATE checkpoint 看能否收干净
	finalTrunc, finalRem, _ := repo.CheckpointBestEffort()

	p50, p99 := percentiles(&latMu, &lats)
	finalDB, finalWAL := fileSizeMB(dbPath), fileSizeMB(dbPath+"-wal")
	if status, err := repo.DatabaseStatus(context.Background()); err == nil {
		finalDB = float64(status.Size) / 1024 / 1024
		finalWAL = float64(status.WALSize) / 1024 / 1024
	}
	fmt.Printf("\n========== 压测结果 ==========\n")
	fmt.Printf("参数: driver=%s agents=%d interval=%v users=%d inbounds=%d duration=%v ckpt=%v\n",
		config.Driver, *agents, *interval, *users, *inbounds, *duration, *ckpt)
	fmt.Printf("成功上报: %d  失败: %d (其中非200: %d)\n", atomic.LoadInt64(&reports), atomic.LoadInt64(&errs), atomic.LoadInt64(&http4xx))
	fmt.Printf("上报延迟: p50=%.1fms p99=%.1fms\n", p50, p99)
	fmt.Printf("WAL 峰值: %.2f MB   收尾 DB: %.2f MB   收尾 WAL: %.2f MB\n",
		float64(walPeak)/1024/1024, finalDB, finalWAL)
	fmt.Printf("checkpoint: TRUNCATE成功 %d 次  PASSIVE(抢窗失败) %d 次\n",
		atomic.LoadInt64(&ckptTrunc), atomic.LoadInt64(&ckptPassive))
	fmt.Printf("收尾 TRUNCATE: truncated=%v remaining=%d 帧\n", finalTrunc, finalRem)
	fmt.Printf("DB 目录(测完请删): %s\n", *dir)
}

func buildBody(id int, cum int64, users, inbounds int) []byte {
	st := &traffic.XrayStats{
		Inbound:  make(map[string]traffic.TrafficData, inbounds),
		Outbound: make(map[string]traffic.TrafficData, inbounds),
		User:     make(map[string]traffic.TrafficData, users),
	}
	for j := 0; j < inbounds; j++ {
		tag := fmt.Sprintf("in-%d-%d", id, j)
		st.Inbound[tag] = traffic.TrafficData{Uplink: cum, Downlink: cum}
		st.Outbound[fmt.Sprintf("out-%d-%d", id, j)] = traffic.TrafficData{Uplink: cum, Downlink: cum}
	}
	for j := 0; j < users; j++ {
		email := fmt.Sprintf("u%d@s%d", j, id)
		st.User[email] = traffic.TrafficData{Uplink: cum, Downlink: cum}
	}
	req := handler.RemoteTrafficRequest{
		Stats:  st,
		System: &handler.RemoteSystemTraffic{RxTotal: cum, TxTotal: cum, BootTimeUnix: 1700000000},
	}
	b, _ := json.Marshal(req)
	return b
}

func fileSizeMB(p string) float64 {
	fi, err := os.Stat(p)
	if err != nil {
		return 0
	}
	return float64(fi.Size()) / 1024 / 1024
}

func percentiles(mu *sync.Mutex, lats *[]float64) (p50, p99 float64) {
	mu.Lock()
	cp := make([]float64, len(*lats))
	copy(cp, *lats)
	mu.Unlock()
	if len(cp) == 0 {
		return 0, 0
	}
	sort.Float64s(cp)
	return cp[len(cp)*50/100], cp[min(len(cp)*99/100, len(cp)-1)]
}
