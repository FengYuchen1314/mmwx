package bot

import (
	_ "embed"
	"net/http"
)

// Mini App 顶部 logo,内嵌到二进制(取自 ../miaomiaowux 的 mmwx_logo.png / mmwx_light.webp)。
// 不依赖外部 URL;路由放在 /api/tg-webapp/ 下,确保被现有 nginx 反代覆盖。
//
//go:embed assets/logo-light.png
var logoLight []byte

//go:embed assets/logo-dark.webp
var logoDark []byte

// anime 主题卡片的蕾丝花纹内边框(取自主控 public/images/anime-lace.svg,120×120 九宫格)。
//
//go:embed assets/anime-lace.svg
var animeLaceSVG []byte

func (s *Service) webAppLogoLight(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "image/jpeg") // mmwx_logo.png 实为 JPEG 数据
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(logoLight)
}

func (s *Service) webAppLogoDark(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "image/webp")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(logoDark)
}

func (s *Service) webAppLace(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "image/svg+xml")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(animeLaceSVG)
}
