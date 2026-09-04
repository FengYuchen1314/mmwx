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
It intentionally contains no VPS deployment job; published releases never
modify an existing server automatically.

The controller exposes `/healthz` for health checks, `/api/*` for the HTTP API,
`/mcp` for agent tooling, and the embedded management console at `/`. Client-side
console routes use an SPA fallback while unknown API and asset paths remain 404.
