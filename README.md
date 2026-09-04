# MMWX

MMWX contains the Go control plane, its embedded React/Vite management UI, the
managed Agent, and the paired Xray runtime fork. The controller serves the UI
and API from the same binary.

## 项目来源与二次开发声明

本项目基于 [iluobei/miaomiaowuX](https://github.com/iluobei/miaomiaowuX)
的公开源代码进行二次开发，是与原项目及原作者无隶属关系的非官方修改版，亦不代表原作者对本项目的认可或背书。
原作者和其他贡献者的历史提交署名及版权信息予以保留。

原项目的 `controller/LICENSE` 将其定义为 Source Available Software，并明确说明该许可证并非
OSI 认可的开源许可证；使用、修改和分发本项目时仍须遵守该许可证及各组成部分各自的许可证。

### 许可证边界

- `controller/web/**` 是基于 Remnawave Frontend 设计系统重建的 Web 应用，按
  `AGPL-3.0-only` 提供；上游版本、修改日期和对应源码入口见
  `controller/web/NOTICE.md` 与 `controller/web/LICENCE`。
- `controller/internal/web/dist/**` 是上述 Web 应用的生成物，沿用同一 AGPL 边界。
- `controller/` 的其余 Go 后端继续适用 `controller/LICENSE`（MSAL-1.0）。前端通过 HTTP API
  与后端通信；发布二进制只是把静态前端字节作为独立 Web 作品聚合进分发包，不改变各自的许可边界。
- Agent、Xray fork 及第三方依赖仍分别适用各自目录中的许可证。前端直接依赖声明见
  `controller/web/THIRD_PARTY_NOTICES.md`。

任何网络部署都应向访问者提供实际运行版本的完整对应源码。若计划商业分发、托管或改变当前
“独立 Web 作品 + HTTP API”的边界，应先取得适用权利人的许可并完成法律审查。

本仓库的主要修改包括：整合 Controller、Agent 与配套 Xray runtime；将协议范围调整为
VLESS + REALITY + Vision、VLESS + XHTTP + REALITY + XMUX、AnyTLS + ShadowTLS、Mieru
和 SOCKS5；并根据当前 Controller API 重建了内嵌 Web 管理端，覆盖管理员与普通用户流程。

## Layout

- `controller/` — Go control plane API and embedded web console
- `controller/web/` — React/Vite web console source
- `agent/` — managed server Agent and ShadowTLS sidecar supervisor
- `xray-core/` — paired Xray runtime fork

Every commit pushed to `main` is built and released by GitHub Actions. Release versions
follow `v0.1.<GitHub run number>`; this is a monotonic SemVer patch sequence
without automated source commits or release loops.

The root workflow validates all three components, publishes controller and
Agent images to GHCR, and uploads cross-platform binaries to GitHub Releases.
Production is not changed automatically: after a release succeeds, the manual
`Deploy production VPS` workflow verifies the immutable release image, connects
with the restricted deployment key, preserves bind-mounted data, and checks the
public application and its bundled assets.

The controller exposes `/healthz` for health checks, `/api/*` for the HTTP API,
`/mcp` for agent tooling, and the embedded management console at `/`. Client-side
console routes use an SPA fallback while unknown API and asset paths remain 404.
