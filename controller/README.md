# MMWX Controller

MMWX Controller 是带内嵌 Vite 管理界面的 Go 控制面。生产构建会先编译 `web/`，再通过 `go:embed` 将静态资源写入单个服务端二进制；根路径及前端页面路由由该二进制直接托管，健康检查端点为 `GET /healthz`。

## 能力

- 管理 Controller、远程 Agent、Xray 配置、节点、订阅、用户和证书
- 提供 HTTP API、WebSocket 与 `/mcp` 管理端点
- 提供 SPA history fallback，并将 `data/public` 中的普通文件安全映射到 `/public/`
- 支持 VLESS + REALITY + Vision、VLESS + XHTTP + REALITY + XMUX、AnyTLS + ShadowTLS、Mieru 和 SOCKS5
- 不包含会员版本功能，也不限制用户数、服务器数和节点数
- 首次安装通过公开初始化 API 创建首个管理员；后续注册和管理通过 API 完成

## 运行

GitHub Actions 会生成各平台二进制文件和 `ghcr.io/fengyuchen1314/mmwx-controller` 镜像。默认监听端口为 `12889`。

```bash
./mmwx-controller-linux-amd64
```

Docker 示例：

```bash
docker run -d \
  --name mmwx-controller \
  --network host \
  --restart unless-stopped \
  -v "$(pwd)/data:/app/data" \
  -v "$(pwd)/subscribes:/app/subscribes" \
  ghcr.io/fengyuchen1314/mmwx-controller:latest
```

持久化目录为 `/app/data` 和 `/app/subscribes`。仓库的发布工作流只发布构建结果，不会自动连接或更新任何 VPS。

## 开发

需要 Go 1.26，以及满足 Vite 要求的 Node.js（20.19+ 或 22.12+）。后端入口为 `./cmd/server`，手工构建顺序如下：

```bash
cd web
npm ci --no-audit --no-fund
npm run build
cd ..
go test ./internal/handler ./internal/license ./internal/mcp ./cmd/server
go build ./cmd/server
```

也可以直接运行 `./build.sh`（Linux/macOS）或 `build.bat`（Windows），脚本会先刷新嵌入式前端产物，再构建各平台后端。

## 免责声明

本项目仅供合法用途。使用者应自行遵守所在地法律法规。
