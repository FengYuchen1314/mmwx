# MMWX Probe

妙妙屋 X（MiaoMiaoWuX）的独立服务器探针前端。项目将 React 静态页面、只读 API 代理和 WebSocket 代理部署到同一个 Cloudflare Worker，访客只接触探针域名，无需直接访问主控域名。

## 功能

- 卡片和列表两种服务器视图
- CPU、内存、硬盘、流量及实时网速
- 延迟、丢包率及 1h/6h/24h 趋势图
- WebSocket 实时更新，断线后自动回退到 HTTP 轮询
- 自动同步主控的 Pixel、Flat、Anime 默认主题
- Worker Secret 保护主控探针接口，浏览器无法读取访问密钥

## 工作方式

```text
浏览器 ──HTTPS/WS──> Cloudflare Worker ──携带 PROBE_TOKEN──> 妙妙屋 X 主控
```

Worker 仅代理三个固定路径，不接受访客指定上游地址，因此不会形成开放代理：

| 对外路径 | 主控路径 | 用途 |
| --- | --- | --- |
| `/api/probe` | `/api/public/probe-servers` | 服务器状态 |
| `/api/series` | `/api/public/probe-series` | 延迟与丢包率历史 |
| `/api/stream` | `/api/public/probe-ws` | 实时 WebSocket |

## 准备工作

- 已部署支持独立探针访问密钥的妙妙屋 X 主控
- Cloudflare 账户及可用的 Workers 服务
- Node.js 22 或更高版本、npm 10 或更高版本
- 主控具有可由 Cloudflare 访问的 HTTPS 地址

先进入主控的“系统设置 → 探针”，启用探针、选择展示服务器和指标，然后生成“独立探针访问密钥”。密钥明文只显示一次，请立即保存，切勿提交到 Git。

## Cloudflare Worker 部署

1. 克隆项目并安装依赖：

   ```bash
   git clone https://github.com/你的用户名/mmwx-probe.git
   cd mmwx-probe
   npm ci
   npx wrangler login
   ```

2. 编辑 `wrangler.jsonc`，将 `MMWX_ORIGIN` 改为主控地址：

   ```jsonc
   "vars": {
     "MMWX_ORIGIN": "https://panel.example.com"
   }
   ```

   地址必须是固定的 HTTPS 源站，不要包含路径或结尾斜杠。

3. 将主控生成的密钥保存为 Worker Secret：

   ```bash
   npx wrangler secret put PROBE_TOKEN
   ```

4. 构建并部署：

   ```bash
   npm run deploy
   ```

5. 打开 Wrangler 输出的 `workers.dev` 地址，确认列表、趋势图和实时更新正常。最后回到主控，开启“仅允许独立探针访问”。开启后，未携带 Worker 密钥直接访问主控探针接口会返回 `404`。

### 绑定自定义域名

在 Cloudflare Dashboard 中进入 **Workers & Pages → mmwx-probe → Settings → Domains & Routes**，添加自定义域名。DNS、TLS 和 WebSocket 均由 Cloudflare 处理，无需修改前端代码。

## 本地开发

复制本地配置，填写主控地址和同一份访问密钥：

```bash
cp wrangler.jsonc wrangler.local.jsonc
cp .dev.vars.example .dev.vars
```

编辑 `wrangler.local.jsonc` 中的 `MMWX_ORIGIN`，并在 `.dev.vars` 中填写：

```dotenv
PROBE_TOKEN=主控生成的访问密钥
```

分别启动 Worker 和 Vite：

```bash
# 终端 1
npx wrangler dev --config wrangler.local.jsonc

# 终端 2
npm run dev
```

访问 `http://localhost:5173`。Vite 会把 `/api/*` 转发到本地 Worker 的 `8787` 端口。

## 常用命令

```bash
npm run dev        # 启动 Vite 开发服务器
npm run typecheck  # TypeScript 类型检查
npm run build      # 生成 dist 生产文件
npm run preview    # 本地预览生产构建
npm run deploy     # 构建并部署到 Cloudflare Workers
```

## 更新与密钥轮换

更新代码后执行 `npm ci && npm run deploy`。轮换密钥时，先在主控生成新密钥，立即执行 `npx wrangler secret put PROBE_TOKEN` 并重新部署；在 Worker 更新完成前，探针可能短暂返回 `404`。主控只保存密钥的 SHA-256 哈希，无法找回旧密钥。

## 故障排查

- `503 Probe access secret is not configured`：尚未设置 `PROBE_TOKEN`。
- Worker 返回 `404`：Worker Secret 与主控生成的密钥不一致，或主控探针未启用。
- 页面无实时更新：检查 Cloudflare 与源站反向代理是否允许 WebSocket；页面会自动使用 HTTP 轮询。
- `MMWX_ORIGIN must use HTTPS`：生产源站不是 HTTPS。本地调试仅允许 `localhost` 或 `127.0.0.1`。
- 页面没有服务器：在主控探针设置中选择需要展示的服务器。

## 发布到 GitHub

如果当前目录尚未初始化为独立仓库：

```bash
git init
git add .
git commit -m "Initial release"
git branch -M main
git remote add origin https://github.com/你的用户名/mmwx-probe.git
git push -u origin main
```

提交前确认 `.dev.vars`、`wrangler.local.jsonc`、`node_modules/` 和 `dist/` 未被纳入版本控制。

## 许可证

本项目采用 [Miaomiaowu X Source Available License v1.0](LICENSE)。允许非商业使用、学习、修改和按许可证要求分发；商业使用需取得授权。
