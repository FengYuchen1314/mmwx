package handler

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"strings"

	"miaomiaowux/internal/storage"
)

const probeExternalTokenHeader = "X-MMwx-Probe-Token"

// RequireProbeExternalAccess 在“仅允许独立探针访问”开启时保护全部探针数据端点。
// 未授权统一返回 404，避免泄露接口存在性。关闭时保持旧公开探针行为。
func RequireProbeExternalAccess(repo *storage.TrafficRepository, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		only, _ := repo.GetSystemSetting(r.Context(), probeExternalOnlyKey)
		if only != "1" {
			next.ServeHTTP(w, r)
			return
		}

		storedHex, _ := repo.GetSystemSetting(r.Context(), probeExternalTokenHashKey)
		stored, err := hex.DecodeString(strings.TrimSpace(storedHex))
		provided := sha256.Sum256([]byte(r.Header.Get(probeExternalTokenHeader)))
		if err != nil || len(stored) != sha256.Size || subtle.ConstantTimeCompare(stored, provided[:]) != 1 {
			http.NotFound(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}
