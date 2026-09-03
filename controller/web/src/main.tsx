import { FormEvent, ReactNode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api, asList, clearToken, JsonObject, publicApi, readToken, saveToken } from './api'
import './style.css'

type Profile = { username?: string; nickname?: string; avatar_url?: string; role?: string; is_admin?: boolean }
type Traffic = { metrics?: { total_used_gb?: number; total_remaining_gb?: number; usage_percentage?: number }; history?: { date?: string; used_gb?: number }[] }
type Server = { id: number; name: string; status?: string; ip_address?: string; pull_address?: string; current_upload_speed?: number; current_download_speed?: number; xray_running?: boolean; ws_connected?: boolean; inbounds?: unknown[] }
type Node = { id?: number | string; name?: string; tag?: string; protocol?: string; server?: string; address?: string; port?: number; enabled?: boolean }
type User = { id?: number | string; username?: string; nickname?: string; email?: string; role?: string; is_active?: boolean; package_name?: string; traffic_used?: number }
type Package = { id?: number | string; name?: string; traffic_limit_gb?: number; duration_days?: number; speed_limit_mbps?: number; description?: string }
type Subscription = { id?: number | string; name?: string; username?: string; url?: string; type?: string; updated_at?: string }
type ProfileOption = { id: string; label: string; protocol: string }

const protocols: ProfileOption[] = [
  { id: 'vless-reality-vision', label: 'VLESS + REALITY + Vision', protocol: 'vless' },
  { id: 'vless-xhttp-reality-xmux', label: 'VLESS + XHTTP + REALITY + XMUX', protocol: 'vless' },
  { id: 'anytls-shadowtls', label: 'AnyTLS + ShadowTLS', protocol: 'anytls' },
  { id: 'mieru', label: 'Mieru', protocol: 'mieru' },
  { id: 'socks5', label: 'SOCKS5', protocol: 'socks' },
]

const nav = [
  { path: '/', label: '流量信息', icon: 'chart' },
  { path: '/subscription', label: '订阅链接', icon: 'link' },
  { path: '/generator', label: '生成订阅', icon: 'spark' },
  { path: '/nodes', label: '节点管理', icon: 'nodes' },
  { path: '/xray-servers', label: '服务管理', icon: 'server' },
  { path: '/users', label: '用户管理', icon: 'users' },
  { path: '/packages', label: '套餐管理', icon: 'package' },
]

const moreNav = [
  { path: '/templates', label: '模板管理', icon: 'file' },
  { path: '/subscribe-files', label: '订阅管理', icon: 'folder' },
  { path: '/custom-rules', label: '覆写管理', icon: 'sliders' },
  { path: '/logs', label: '日志管理', icon: 'terminal' },
  { path: '/system-settings', label: '系统设置', icon: 'settings' },
]

const iconPaths: Record<string, string> = {
  chart: 'M4 19V9m6 10V5m6 14v-7m4 7H2', link: 'M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1',
  spark: 'm12 3-1.7 4.3L6 9l4.3 1.7L12 15l1.7-4.3L18 9l-4.3-1.7L12 3Zm-6 9-.9 2.1L3 15l2.1.9L6 18l.9-2.1L9 15l-2.1-.9L6 12Z',
  nodes: 'M5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm14 0a2 2 0 1 0 0-4 2 2 0 0 0 0 0 4ZM12 21a2 2 0 1 0 0-4 2 2 0 0 0 0 0 4ZM7 5h10M6 7l5 10m7-10-5 10',
  server: 'M4 5h16v6H4V5Zm0 8h16v6H4v-6Zm3-5h.01M7 16h.01', users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m7-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 10v-2a4 4 0 0 0-3-3.87m-2-11.96a4 4 0 0 1 0 7.75',
  package: 'M21 8 12 3 3 8l9 5 9-5Zm-18 4 9 5 9-5M3 16l9 5 9-5', file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6M8 13h8m-8 4h6',
  folder: 'M3 5h6l2 2h10v12H3V5Z', sliders: 'M4 6h16M4 12h16M4 18h16M8 4v4m8 2v4m-5 2v4', terminal: 'm4 6 5 5-5 5m7 0h9', settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8.5-3.5-.1-1.3 2-1.6-2-3.4-2.5 1a9 9 0 0 0-2.2-1.3L15.3 3h-4L11 5.4a9 9 0 0 0-2.2 1.3l-2.5-1-2 3.4 2 1.6L6.2 12l.1 1.3-2 1.6 2 3.4 2.5-1a9 9 0 0 0 2.2 1.3l.3 2.4h4l.4-2.4a9 9 0 0 0 2.2-1.3l2.5 1 2-3.4-2-1.6.1-1.3Z',
  plus: 'M12 5v14M5 12h14', refresh: 'M20 6v5h-5M4 18v-5h5m10.5-2A8 8 0 0 0 6 7.5L4 11m16 2-2 3.5A8 8 0 0 1 4.5 14', search: 'm21 21-4.4-4.4m2.4-5.6a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z', sun: 'M12 4V2m0 20v-2m8-8h2M2 12h2m14-6 1.4-1.4M4.6 19.4 6 18m12 0 1.4 1.4M4.6 4.6 6 6m10 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  logout: 'M10 17l5-5-5-5m5 5H3m9-9h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7', chevron: 'm9 18 6-6-6-6', menu: 'M4 7h16M4 12h16M4 17h16', eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', copy: 'M8 8h12v12H8V8Zm-4 8V4h12', check: 'm5 12 4 4L19 6', close: 'm6 6 12 12M18 6 6 18',
}

function Icon({ name, size = 17 }: { name: string; size?: number }) {
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name] ?? iconPaths.spark} /></svg>
}

function Logo() {
  return <span className="logo" aria-hidden="true"><svg viewBox="0 0 44 44"><path d="M9 18 7 7l11 6c3-1 6-1 9 0l10-6-2 12c3 3 4 7 3 11-2 7-8 10-16 10S8 36 6 30c-1-5 0-9 3-12Z" fill="#f29a72"/><path d="M13 19c5-5 14-5 19 0l-2 11c-2 5-13 5-16 0l-1-11Z" fill="#fff7f0"/><circle cx="16" cy="24" r="1.7" fill="#3a231b"/><circle cx="29" cy="24" r="1.7" fill="#3a231b"/><path d="m20 29 2 2 2-2m-2 2v3" stroke="#3a231b" strokeWidth="1.4" fill="none" strokeLinecap="round"/></svg></span>
}

function Button({ children, variant = 'primary', icon, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; icon?: string }) {
  return <button {...props} className={`btn ${variant} ${props.className ?? ''}`}>{icon && <Icon name={icon} />}{children}</button>
}

function PageHeader({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return <div className="page-header"><div><h1>{title}</h1><p>{description}</p></div>{actions && <div className="page-actions">{actions}</div>}</div>
}

function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`pixel-card ${className}`}>{children}</section>
}

function Empty({ icon = 'folder', title, text }: { icon?: string; title: string; text: string }) {
  return <div className="empty"><span className="empty-icon"><Icon name={icon} size={25} /></span><strong>{title}</strong><p>{text}</p></div>
}

function Spinner({ full = false }: { full?: boolean }) {
  return <div className={full ? 'splash' : 'loading'}><Logo/><span>正在加载…</span></div>
}

function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`notice ${error ? 'error' : ''}`}>{children}</div>
}

function Modal({ title, description, onClose, children }: { title: string; description?: string; onClose: () => void; children: ReactNode }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal" role="dialog" aria-modal="true"><div className="modal-head"><div><h2>{title}</h2>{description && <p>{description}</p>}</div><Button variant="ghost" onClick={onClose} aria-label="关闭"><Icon name="close" /></Button></div>{children}</div></div>
}

function AuthPage({ onAuthenticated }: { onAuthenticated: (profile?: Profile) => void }) {
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)
  const [username, setUsername] = useState('')
  const [nickname, setNickname] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { publicApi<{ needs_setup: boolean }>('/api/setup/status').then((data) => setNeedsSetup(data.needs_setup)).catch(() => setNeedsSetup(false)) }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try {
      if (needsSetup) {
        await publicApi('/api/setup/init', { method: 'POST', body: JSON.stringify({ username, password, nickname: nickname || username, email }) })
      }
      const result = await publicApi<{ token?: string; error?: string; username?: string; nickname?: string; role?: string; is_admin?: boolean }>('/api/login', { method: 'POST', body: JSON.stringify({ username, password, remember_me: remember }) })
      if (!result.token) throw new Error(result.error ?? '登录失败')
      saveToken(result.token, remember)
      onAuthenticated(result)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败') } finally { setBusy(false) }
  }

  if (needsSetup === null) return <Spinner full />
  return <main className="auth-shell"><button className="language">文 <span>简体中文</span><Icon name="chevron" size={14}/></button><form className="auth-card" onSubmit={submit}><div className="auth-title"><Logo/><h1>{needsSetup ? '初始化妙妙屋 X' : '登录妙妙屋 X'}</h1><p>{needsSetup ? '创建首位管理员后即可开始使用' : '欢迎回来，请登录管理面板'}</p></div><label><span>用户名</span><input required autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="请输入用户名" /></label>{needsSetup && <div className="field-row"><label><span>昵称</span><input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="可选" /></label><label><span>邮箱</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="可选" /></label></div>}<label><span>密码</span><input required minLength={needsSetup ? 8 : undefined} type="password" autoComplete={needsSetup ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="请输入密码" /></label>{!needsSetup && <label className="remember"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /><span>记住登录状态</span></label>}{error && <Notice error>{error}</Notice>}<Button type="submit" disabled={busy}>{busy ? '请稍候…' : needsSetup ? '完成初始化' : '登录'}</Button></form><footer>MMWX · OPEN CONTROL PANEL</footer></main>
}

function App() {
  const [authenticated, setAuthenticated] = useState(Boolean(readToken()))
  const [profile, setProfile] = useState<Profile | null>(null)
  const [checking, setChecking] = useState(Boolean(readToken()))

  useEffect(() => {
    const unauthorized = () => { clearToken(); setAuthenticated(false); setProfile(null) }
    window.addEventListener('mmwx:unauthorized', unauthorized)
    return () => window.removeEventListener('mmwx:unauthorized', unauthorized)
  }, [])
  useEffect(() => {
    if (!authenticated) { setChecking(false); return }
    api<Profile>('/api/user/profile').then(setProfile).catch(() => { clearToken(); setAuthenticated(false) }).finally(() => setChecking(false))
  }, [authenticated])

  if (checking) return <Spinner full />
  if (!authenticated) return <AuthPage onAuthenticated={(next) => { setProfile(next ?? null); setAuthenticated(true) }} />
  return <Shell profile={profile ?? {}} onLogout={() => { clearToken(); setAuthenticated(false) }} />
}

function Shell({ profile, onLogout }: { profile: Profile; onLogout: () => void }) {
  const [path, setPath] = useState(window.location.pathname)
  const [dark, setDark] = useState(() => localStorage.getItem('mmwx_theme') === 'dark')
  const [moreOpen, setMoreOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('mmwx_theme', dark ? 'dark' : 'light') }, [dark])
  useEffect(() => { const pop = () => setPath(window.location.pathname); window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop) }, [])
  const go = (next: string) => { history.pushState({}, '', next); setPath(next); setMoreOpen(false); setMobileOpen(false); window.scrollTo({ top: 0, behavior: 'smooth' }) }
  const active = (item: string) => item === '/' ? path === '/' : path.startsWith(item)
  return <><header className="topbar"><button className="mobile-menu" onClick={() => setMobileOpen(!mobileOpen)} aria-label="菜单"><Icon name="menu" /></button><button className="brand" onClick={() => go('/')}><Logo/><strong>妙妙屋 X</strong></button><nav className={mobileOpen ? 'nav open' : 'nav'}>{nav.map((item) => <button key={item.path} className={active(item.path) ? 'active' : ''} onClick={() => go(item.path)}><Icon name={item.icon}/>{item.label}</button>)}<div className="more-wrap"><button className={moreNav.some((item) => active(item.path)) ? 'active' : ''} onClick={() => setMoreOpen(!moreOpen)}><Icon name="menu"/>更多<Icon name="chevron" size={13}/></button>{moreOpen && <div className="more-menu">{moreNav.map((item) => <button key={item.path} onClick={() => go(item.path)}><Icon name={item.icon}/><span>{item.label}</span></button>)}</div>}</div></nav><div className="top-actions"><button className="icon-button" onClick={() => setDark(!dark)} aria-label="切换主题"><Icon name={dark ? 'sun' : 'moon'} /></button><div className="user-menu"><span className="avatar">{(profile.nickname || profile.username || 'A').slice(0, 1).toUpperCase()}</span><div><strong>{profile.nickname || profile.username || '管理员'}</strong><small>ADMIN</small></div><button className="logout" onClick={onLogout} title="退出登录"><Icon name="logout"/></button></div></div></header><main className="content"><Route path={path} go={go} /></main></>
}

function Route({ path, go }: { path: string; go: (path: string) => void }) {
  if (path === '/') return <Dashboard go={go}/>
  if (path.startsWith('/xray-servers')) return <ServersPage />
  if (path.startsWith('/nodes')) return <NodesPage go={go}/>
  if (path.startsWith('/users')) return <UsersPage />
  if (path.startsWith('/packages')) return <PackagesPage />
  if (path.startsWith('/subscription')) return <SubscriptionsPage />
  if (path.startsWith('/generator')) return <GeneratorPage />
  if (path.startsWith('/templates')) return <LibraryPage title="模板管理" description="管理订阅转换模板" endpoint="/api/admin/templates" keys={['templates']} action="新建模板" />
  if (path.startsWith('/subscribe-files')) return <LibraryPage title="订阅管理" description="管理本地订阅文件与外部订阅" endpoint="/api/admin/subscribe-files" keys={['files', 'subscriptions']} action="添加订阅" />
  if (path.startsWith('/custom-rules')) return <LibraryPage title="覆写管理" description="管理 DNS、规则、规则集与脚本覆写" endpoint="/api/admin/custom-rules" keys={['rules', 'items']} action="新建覆写" />
  if (path.startsWith('/logs')) return <LogsPage />
  if (path.startsWith('/system-settings')) return <SettingsPage />
  return <Card><Empty title="页面不存在" text="这个地址没有对应的管理页面。" /></Card>
}

function Dashboard({ go }: { go: (path: string) => void }) {
  const [traffic, setTraffic] = useState<Traffic>({})
  const [servers, setServers] = useState<Server[]>([])
  const [nodes, setNodes] = useState<Node[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true)
    const [a, b, c, d] = await Promise.allSettled([api<Traffic>('/api/traffic/summary'), api<unknown>('/api/admin/remote-servers'), api<unknown>('/api/admin/nodes'), api<unknown>('/api/admin/users')])
    if (a.status === 'fulfilled') setTraffic(a.value)
    if (b.status === 'fulfilled') setServers(asList<Server>(b.value, ['servers']))
    if (c.status === 'fulfilled') setNodes(asList<Node>(c.value, ['nodes']))
    if (d.status === 'fulfilled') setUsers(asList<User>(d.value, ['users']))
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])
  const online = servers.filter((server) => server.ws_connected || server.status === 'online').length
  const speedUp = servers.reduce((sum, server) => sum + Number(server.current_upload_speed || 0), 0)
  const speedDown = servers.reduce((sum, server) => sum + Number(server.current_download_speed || 0), 0)
  const history = traffic.history ?? []
  const max = Math.max(1, ...history.map((item) => Number(item.used_gb || 0)))
  return <><PageHeader title="流量信息" description="查看整个面板的实时运行状态" actions={<Button variant="secondary" icon="refresh" onClick={() => void load()}>刷新数据</Button>} /><div className="metric-grid"><Metric icon="server" label="服务器" value={loading ? '—' : String(servers.length)} sub={`${online} 台在线 · 不限数量`} tone="peach"/><Metric icon="nodes" label="节点" value={loading ? '—' : String(nodes.length)} sub="仅显示受支持协议 · 不限数量" tone="blue"/><Metric icon="users" label="用户" value={loading ? '—' : String(users.length)} sub="不限制可创建用户数" tone="green"/><Metric icon="chart" label="实时网速" value={formatSpeed(speedDown)} sub={`↑ ${formatSpeed(speedUp)}  ↓ ${formatSpeed(speedDown)}`} tone="purple"/></div><div className="dashboard-grid"><Card className="traffic-card"><div className="card-head"><div><h2>流量趋势</h2><p>最近的流量使用记录</p></div><span className="chip">已用 {Number(traffic.metrics?.total_used_gb || 0).toFixed(2)} GB</span></div>{history.length ? <div className="chart">{history.slice(-14).map((item, index) => <div className="bar-wrap" key={`${item.date}-${index}`} title={`${item.date}: ${item.used_gb ?? 0} GB`}><i style={{ height: `${Math.max(5, Number(item.used_gb || 0) / max * 100)}%` }}/><small>{String(item.date ?? '').slice(5)}</small></div>)}</div> : <Empty icon="chart" title="暂无流量记录" text="节点开始传输数据后，这里会显示趋势。"/>}</Card><Card className="status-card"><div className="card-head"><div><h2>服务概览</h2><p>Agent 与核心运行状态</p></div><button className="text-button" onClick={() => go('/xray-servers')}>管理服务 →</button></div>{servers.length ? <div className="server-mini-list">{servers.slice(0, 5).map((server) => <div key={server.id}><span className={`status-dot ${server.ws_connected || server.status === 'online' ? 'online' : ''}`}/><div><strong>{server.name}</strong><small>{server.ip_address || server.pull_address || '未设置地址'}</small></div><span>{server.xray_running ? '运行中' : '离线'}</span></div>)}</div> : <Empty icon="server" title="还没有服务器" text="添加第一台服务器并连接 Agent。"/>}</Card></div><Card className="protocol-card"><div className="card-head"><div><h2>支持的协议</h2><p>面板和 Agent 统一维护以下五种组合</p></div></div><div className="protocol-strip">{protocols.map((item, index) => <div key={item.id}><span>{String(index + 1).padStart(2, '0')}</span><strong>{item.label}</strong></div>)}</div></Card></>
}

function Metric({ icon, label, value, sub, tone }: { icon: string; label: string; value: string; sub: string; tone: string }) {
  return <Card className="metric"><span className={`metric-icon ${tone}`}><Icon name={icon} size={21}/></span><div><p>{label}</p><strong>{value}</strong><small>{sub}</small></div></Card>
}

function ServersPage() {
  const [servers, setServers] = useState<Server[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [hideIP, setHideIP] = useState(false)
  const [notice, setNotice] = useState('')
  const load = useCallback(() => api<unknown>('/api/admin/remote-servers').then((value) => setServers(asList<Server>(value, ['servers']))).finally(() => setLoading(false)), [])
  useEffect(() => { void load() }, [load])
  return <><PageHeader title="服务管理" description="管理远程服务器与 Agent 连接" actions={<><Button variant="secondary" icon="eye" onClick={() => setHideIP(!hideIP)}>{hideIP ? '显示 IP' : '隐藏 IP'}</Button><Button icon="plus" onClick={() => setShowCreate(true)}>添加服务器</Button></>} />{notice && <Notice>{notice}</Notice>}<div className="summary-row"><span><i className="status-dot online"/>在线 {servers.filter((server) => server.ws_connected || server.status === 'online').length}</span><span><i className="status-dot"/>离线 {servers.filter((server) => !(server.ws_connected || server.status === 'online')).length}</span><span>服务器总数 {servers.length} · 无上限</span></div>{loading ? <Spinner/> : servers.length ? <div className="server-grid">{servers.map((server) => <Card key={server.id} className="server-card"><div className="server-card-top"><span className={`server-glyph ${server.ws_connected || server.status === 'online' ? 'online' : ''}`}><Icon name="server" size={22}/></span><span className={`badge ${server.ws_connected || server.status === 'online' ? 'success' : ''}`}>{server.ws_connected || server.status === 'online' ? '在线' : '离线'}</span></div><h2>{server.name}</h2><p className="mono">{hideIP ? '•••.•••.•••.•••' : server.ip_address || server.pull_address || '未设置地址'}</p><div className="server-stats"><span><small>上行</small>{formatSpeed(server.current_upload_speed || 0)}</span><span><small>下行</small>{formatSpeed(server.current_download_speed || 0)}</span><span><small>核心</small>{server.xray_running ? '运行中' : '未连接'}</span></div><div className="card-buttons"><Button variant="secondary">管理</Button><Button variant="ghost" icon="refresh" onClick={() => void load()}>刷新</Button></div></Card>)}</div> : <Card><Empty icon="server" title="还没有服务器" text="添加服务器后，复制安装命令到 VPS 执行即可接入。"/><div className="empty-action"><Button icon="plus" onClick={() => setShowCreate(true)}>添加第一台服务器</Button></div></Card>}{showCreate && <CreateServer onClose={() => setShowCreate(false)} onCreated={(message) => { setShowCreate(false); setNotice(message); void load() }} />}</>
}

function CreateServer({ onClose, onCreated }: { onClose: () => void; onCreated: (message: string) => void }) {
  const [name, setName] = useState('')
  const [ip, setIP] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { const result = await api<{ success?: boolean; message?: string; install_command?: string }>('/api/admin/remote-servers/create', { method: 'POST', body: JSON.stringify({ name, ip_address: ip, pull_address: ip, connection_mode: 'websocket', xray_mode: 'embedded' }) }); if (result.success === false) throw new Error(result.message || '创建失败'); const command = result.install_command || ''; if (command) await navigator.clipboard.writeText(command).catch(() => undefined); onCreated(command ? `服务器已创建，安装命令已复制：${command}` : '服务器已创建。') } catch (reason) { setError(reason instanceof Error ? reason.message : '创建失败') } finally { setBusy(false) } }
  return <Modal title="添加服务器" description="创建后会生成一条 Agent 安装命令" onClose={onClose}><form className="modal-form" onSubmit={submit}><label><span>服务器名称</span><input required value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 Tokyo-01"/></label><label><span>公网 IP 或域名</span><input required value={ip} onChange={(e) => setIP(e.target.value)} placeholder="203.0.113.10"/></label><div className="form-note">连接方式固定为加密 WebSocket，运行模式使用内置核心与协议侧车。</div>{error && <Notice error>{error}</Notice>}<div className="modal-actions"><Button variant="secondary" type="button" onClick={onClose}>取消</Button><Button type="submit" disabled={busy}>{busy ? '创建中…' : '创建并复制命令'}</Button></div></form></Modal>
}

function NodesPage({ go }: { go: (path: string) => void }) {
  const [nodes, setNodes] = useState<Node[]>([])
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [notice, setNotice] = useState('')
  const load = useCallback(() => api<unknown>('/api/admin/nodes').then((value) => setNodes(asList<Node>(value, ['nodes']))).finally(() => setLoading(false)), [])
  useEffect(() => { void load() }, [load])
  const filtered = nodes.filter((node) => (filter === 'all' || protocolGroup(node) === filter) && `${node.name ?? ''} ${node.tag ?? ''} ${node.address ?? node.server ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  return <><PageHeader title="节点管理" description="管理 VLESS、AnyTLS、Mieru 与 SOCKS5 节点" actions={<><Button variant="secondary">导入外部节点</Button><Button icon="plus" onClick={() => setShowCreate(true)}>添加节点</Button></>} />{notice && <Notice>{notice}</Notice>}<Card className="table-card"><div className="table-toolbar"><div className="tabs"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部 {nodes.length}</button>{['vless', 'anytls', 'mieru', 'socks'].map((item) => <button key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item === 'socks' ? 'SOCKS5' : item.toUpperCase()}</button>)}</div><label className="search"><Icon name="search"/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索节点"/></label></div>{loading ? <Spinner/> : filtered.length ? <div className="responsive-table"><table><thead><tr><th>协议</th><th>节点名称</th><th>服务器地址</th><th>端口</th><th>状态</th><th className="right">操作</th></tr></thead><tbody>{filtered.map((node, index) => <tr key={String(node.id ?? node.tag ?? index)}><td><span className="protocol-badge">{protocolName(node)}</span></td><td><strong>{node.name || node.tag || '未命名节点'}</strong></td><td className="mono">{node.address || node.server || '—'}</td><td>{node.port || '—'}</td><td><span className={`badge ${node.enabled !== false ? 'success' : ''}`}>{node.enabled !== false ? '启用' : '停用'}</span></td><td className="right"><Button variant="ghost">编辑</Button></td></tr>)}</tbody></table></div> : <Empty icon="nodes" title="暂无节点" text="请先添加服务器，再创建一种受支持的协议节点。"/>}</Card><div className="protocol-legend">{protocols.map((item) => <span key={item.id}><i/><b>{item.label}</b></span>)}</div>{showCreate && <CreateNode onClose={() => setShowCreate(false)} onNeedServer={() => { setShowCreate(false); go('/xray-servers') }} onCreated={() => { setShowCreate(false); setNotice('节点已创建并下发到 Agent。'); void load() }}/>}</>
}

function CreateNode({ onClose, onNeedServer, onCreated }: { onClose: () => void; onNeedServer: () => void; onCreated: () => void }) {
  const [servers, setServers] = useState<Server[]>([])
  const [serverID, setServerID] = useState('')
  const [profile, setProfile] = useState(protocols[0].id)
  const [port, setPort] = useState('443')
  const [destination, setDestination] = useState('www.cloudflare.com:443')
  const [path, setPath] = useState('/xhttp')
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { api<unknown>('/api/admin/remote-servers').then((value) => { const list = asList<Server>(value, ['servers']); setServers(list); if (list[0]) setServerID(String(list[0].id)) }).catch((reason) => setError(reason instanceof Error ? reason.message : '无法加载服务器')) }, [])
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const built = await api<{ inbound?: JsonObject }>('/api/admin/xray/build-inbound', { method: 'POST', body: JSON.stringify({ profile, port: Number(port), server_name: destination, dest: destination, path, email }) })
      if (!built.inbound) throw new Error('后端没有返回可下发的入站配置')
      await api(`/api/admin/remote/inbounds?server_id=${encodeURIComponent(serverID)}`, { method: 'POST', body: JSON.stringify({ action: 'add', inbound: built.inbound }) })
      onCreated()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '节点创建失败') } finally { setBusy(false) }
  }
  if (!servers.length && !error) return <Modal title="添加节点" onClose={onClose}><Spinner/></Modal>
  if (!servers.length) return <Modal title="添加节点" description="创建节点前需要至少一台服务器" onClose={onClose}><Notice error>{error || '还没有可用服务器。'}</Notice><div className="modal-actions"><Button variant="secondary" onClick={onClose}>取消</Button><Button onClick={onNeedServer}>去添加服务器</Button></div></Modal>
  const usesDestination = profile.startsWith('vless') || profile === 'anytls-shadowtls'
  return <Modal title="添加节点" description="配置会立即下发到所选 Agent" onClose={onClose}><form className="modal-form" onSubmit={submit}><label><span>目标服务器</span><select value={serverID} onChange={(event) => setServerID(event.target.value)}>{servers.map((server) => <option key={server.id} value={server.id}>{server.name} · {server.status || 'unknown'}</option>)}</select></label><label><span>协议组合</span><select value={profile} onChange={(event) => setProfile(event.target.value)}>{protocols.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label><span>公网端口</span><input required type="number" min="1" max="65535" value={port} onChange={(event) => setPort(event.target.value)}/></label>{usesDestination && <label><span>{profile === 'anytls-shadowtls' ? 'ShadowTLS 握手目标' : 'REALITY 目标'}</span><input required value={destination} onChange={(event) => setDestination(event.target.value)}/></label>}{profile === 'vless-xhttp-reality-xmux' && <label><span>XHTTP 路径</span><input required value={path} onChange={(event) => setPath(event.target.value)}/></label>}<label><span>初始账户标识</span><input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="可选"/></label>{error && <Notice error>{error}</Notice>}<div className="modal-actions"><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button type="submit" disabled={busy}>{busy ? '创建中…' : '创建并下发'}</Button></div></form></Modal>
}

function UsersPage() {
  const [users, setUsers] = useState<User[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [loading, setLoading] = useState(true)
  const load = useCallback(() => api<unknown>('/api/admin/users').then((value) => setUsers(asList<User>(value, ['users']))).finally(() => setLoading(false)), [])
  useEffect(() => { void load() }, [load])
  return <><PageHeader title="用户管理" description="管理用户账号与访问权限，不限制用户数量" actions={<Button icon="plus" onClick={() => setShowCreate(true)}>创建用户</Button>} /><Card className="table-card">{loading ? <Spinner/> : users.length ? <div className="responsive-table"><table><thead><tr><th>用户</th><th>角色</th><th>套餐</th><th>状态</th><th className="right">操作</th></tr></thead><tbody>{users.map((user, index) => <tr key={String(user.id ?? user.username ?? index)}><td><div className="user-cell"><span className="avatar small">{(user.nickname || user.username || 'U')[0].toUpperCase()}</span><div><strong>{user.nickname || user.username}</strong><small>{user.email || user.username}</small></div></div></td><td>{user.role === 'admin' ? '管理员' : '用户'}</td><td>{user.package_name || '未分配'}</td><td><span className={`badge ${user.is_active !== false ? 'success' : ''}`}>{user.is_active !== false ? '正常' : '停用'}</span></td><td className="right"><Button variant="ghost">管理</Button></td></tr>)}</tbody></table></div> : <Empty icon="users" title="暂无用户" text="创建用户后即可分配订阅与套餐。"/>}</Card>{showCreate && <CreateUser onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); void load() }}/>}</>
}

function CreateUser({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ username: '', nickname: '', email: '', password: '', remark: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { await api('/api/admin/users/create', { method: 'POST', body: JSON.stringify(form) }); onCreated() } catch (reason) { setError(reason instanceof Error ? reason.message : '创建失败') } finally { setBusy(false) } }
  const set = (key: keyof typeof form, value: string) => setForm((old) => ({ ...old, [key]: value }))
  return <Modal title="创建用户" description="可按需创建任意数量的用户" onClose={onClose}><form className="modal-form" onSubmit={submit}><div className="field-row"><label><span>用户名</span><input required value={form.username} onChange={(e) => set('username', e.target.value)}/></label><label><span>昵称</span><input value={form.nickname} onChange={(e) => set('nickname', e.target.value)}/></label></div><label><span>邮箱</span><input type="email" value={form.email} onChange={(e) => set('email', e.target.value)}/></label><label><span>初始密码</span><input required type="password" minLength={8} value={form.password} onChange={(e) => set('password', e.target.value)}/></label><label><span>备注</span><textarea value={form.remark} onChange={(e) => set('remark', e.target.value)}/></label>{error && <Notice error>{error}</Notice>}<div className="modal-actions"><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button type="submit" disabled={busy}>{busy ? '创建中…' : '创建用户'}</Button></div></form></Modal>
}

function PackagesPage() {
  const [packages, setPackages] = useState<Package[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => { api<unknown>('/api/admin/packages').then((value) => setPackages(asList<Package>(value, ['packages']))).finally(() => setLoading(false)) }, [])
  return <><PageHeader title="套餐模板管理" description="管理流量套餐模板，可在用户管理中分配套餐" actions={<Button icon="plus">创建套餐模板</Button>} />{loading ? <Spinner/> : packages.length ? <div className="package-grid">{packages.map((item, index) => <Card className="package-card" key={String(item.id ?? index)}><span className="package-art"><Icon name="package" size={25}/></span><h2>{item.name || '未命名套餐'}</h2><p>{item.description || '标准流量套餐'}</p><dl><div><dt>流量</dt><dd>{item.traffic_limit_gb ? `${item.traffic_limit_gb} GB` : '不限'}</dd></div><div><dt>有效期</dt><dd>{item.duration_days ? `${item.duration_days} 天` : '不限'}</dd></div><div><dt>限速</dt><dd>{item.speed_limit_mbps ? `${item.speed_limit_mbps} Mbps` : '不限'}</dd></div></dl><Button variant="secondary">编辑套餐</Button></Card>)}</div> : <Card><Empty icon="package" title="暂无套餐模板" text="套餐是业务配置，与面板版本或实体数量限制无关。"/></Card>}</>
}

function SubscriptionsPage() {
  const [items, setItems] = useState<Subscription[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => { api<unknown>('/api/subscriptions').then((value) => setItems(asList<Subscription>(value, ['subscriptions']))).finally(() => setLoading(false)) }, [])
  return <><PageHeader title="订阅链接" description="查看和复制可用的订阅地址" actions={<Button variant="secondary" icon="refresh">刷新订阅</Button>} /><Card className="table-card">{loading ? <Spinner/> : items.length ? <div className="subscription-list">{items.map((item, index) => <div key={String(item.id ?? index)}><span className="subscription-icon"><Icon name="link"/></span><div><strong>{item.name || item.username || '订阅链接'}</strong><small className="mono">{item.url || '安全链接已生成'}</small></div>{item.url && <Button variant="secondary" icon="copy" onClick={() => void navigator.clipboard.writeText(item.url || '')}>复制</Button>}</div>)}</div> : <Empty icon="link" title="暂无可用订阅" text="创建用户并分配节点后，订阅链接会显示在这里。"/>}</Card></>
}

function GeneratorPage() {
  const [format, setFormat] = useState('mihomo')
  return <><PageHeader title="订阅链接生成器" description="按用户、模板和输出格式生成临时订阅" /><div className="two-column"><Card><div className="card-head"><div><h2>生成配置</h2><p>选择生成方式与目标格式</p></div></div><div className="stack-form"><label><span>生成方式</span><select><option>选择节点</option><option>使用订阅文件</option></select></label><label><span>输出格式</span><select value={format} onChange={(e) => setFormat(e.target.value)}><option value="mihomo">Mihomo / Clash Meta</option><option value="singbox">sing-box</option><option value="uri">分享 URI</option></select></label><label><span>模板</span><select><option>系统默认模板</option></select></label><div className="form-note">生成结果仅会包含 VLESS + REALITY、VLESS + XHTTP、AnyTLS + ShadowTLS、Mieru 与 SOCKS5。</div><Button icon="spark">生成订阅</Button></div></Card><Card><div className="card-head"><div><h2>生成结果</h2><p>生成后可复制或下载</p></div></div><Empty icon="spark" title="等待生成" text="完成左侧配置后点击“生成订阅”。"/></Card></div></>
}

function LibraryPage({ title, description, endpoint, keys, action }: { title: string; description: string; endpoint: string; keys: string[]; action: string }) {
  const [items, setItems] = useState<JsonObject[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => { api<unknown>(endpoint).then((value) => setItems(asList<JsonObject>(value, keys))).catch(() => setItems([])).finally(() => setLoading(false)) }, [endpoint, keys.join(',')])
  return <><PageHeader title={title} description={description} actions={<Button icon="plus">{action}</Button>} /><Card className="table-card"><div className="table-toolbar"><div className="tabs"><button className="active">全部 {items.length}</button><button>启用</button><button>停用</button></div><label className="search"><Icon name="search"/><input placeholder="搜索"/></label></div>{loading ? <Spinner/> : items.length ? <div className="library-grid">{items.map((item, index) => <article key={String(item.id ?? index)}><span><Icon name="file"/></span><div><strong>{String(item.name ?? item.title ?? `项目 ${index + 1}`)}</strong><small>{String(item.type ?? item.description ?? '已保存')}</small></div><Button variant="ghost">管理</Button></article>)}</div> : <Empty icon="folder" title={`暂无${title.replace('管理', '')}`} text={`点击右上角“${action}”开始配置。`}/>}</Card></>
}

function LogsPage() {
  const [logs, setLogs] = useState('')
  const [loading, setLoading] = useState(true)
  const load = useCallback(() => api<unknown>('/api/admin/logs/system').then((value) => { const object = value as JsonObject; setLogs(typeof value === 'string' ? value : String(object.logs ?? object.content ?? object.data ?? '')) }).catch((reason) => setLogs(reason instanceof Error ? reason.message : '')).finally(() => setLoading(false)), [])
  useEffect(() => { void load() }, [load])
  return <><PageHeader title="日志管理" description="查看系统与 Agent 运行日志" actions={<Button variant="secondary" icon="refresh" onClick={() => { setLoading(true); void load() }}>刷新日志</Button>} /><Card className="log-card"><div className="tabs log-tabs"><button className="active">系统日志</button><button>Agent 日志</button><button>计划任务</button><button>安全日志</button></div>{loading ? <Spinner/> : <pre>{logs || '当前没有日志记录。'}</pre>}</Card></>
}

function SettingsPage() {
  const [tab, setTab] = useState('system')
  const tabs = [{ id: 'system', label: '系统' }, { id: 'subscription', label: '订阅' }, { id: 'security', label: '安全' }, { id: 'probe', label: '探测' }, { id: 'appearance', label: '外观' }, { id: 'announcement', label: '公告' }]
  return <><PageHeader title="系统设置" description="配置面板行为、订阅、安全与外观" /><div className="settings-layout"><aside className="settings-tabs">{tabs.map((item) => <button key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}</button>)}</aside><Card className="settings-card"><div className="card-head"><div><h2>{tabs.find((item) => item.id === tab)?.label}设置</h2><p>这些配置对所有新安装实例生效</p></div></div><div className="setting-list"><Setting title="默认启用安全连接" text="Agent 与主控之间使用加密通道"/><Setting title="自动同步配置" text="节点配置发生变化时自动下发到在线服务器"/><Setting title="精简协议模式" text="只允许当前维护的五种协议组合" checked/><Setting title="实体数量限制" text="用户、服务器和节点均不设数量上限" checked disabled/></div><div className="settings-actions"><Button>保存设置</Button></div></Card></div></>
}

function Setting({ title, text, checked = true, disabled = false }: { title: string; text: string; checked?: boolean; disabled?: boolean }) {
  return <label className="setting"><div><strong>{title}</strong><small>{text}</small></div><input type="checkbox" defaultChecked={checked} disabled={disabled}/><span className="switch"/></label>
}

function protocolGroup(node: Node) {
  const value = `${node.protocol ?? ''} ${node.name ?? ''} ${node.tag ?? ''}`.toLowerCase()
  if (value.includes('anytls') || value.includes('shadowtls')) return 'anytls'
  if (value.includes('mieru')) return 'mieru'
  if (value.includes('socks')) return 'socks'
  return 'vless'
}

function protocolName(node: Node) {
  const value = `${node.protocol ?? ''} ${node.name ?? ''} ${node.tag ?? ''}`.toLowerCase()
  if (value.includes('xhttp')) return 'VLESS · XHTTP'
  if (value.includes('anytls') || value.includes('shadowtls')) return 'AnyTLS · ShadowTLS'
  if (value.includes('mieru')) return 'Mieru'
  if (value.includes('socks')) return 'SOCKS5'
  return 'VLESS · Vision'
}

function formatSpeed(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B/s'
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB/s`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB/s`
  return `${value.toFixed(0)} B/s`
}

createRoot(document.getElementById('root')!).render(<App />)
