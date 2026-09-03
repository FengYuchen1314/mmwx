import { FormEvent, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'

type Profile = { id: string; label: string; protocol: string }
type Server = { id: number; name: string; status?: string; ip_address?: string; pull_address?: string }
type Inbound = { tag?: string; protocol?: string; port?: number; streamSettings?: Record<string, unknown> }
type Credentials = Record<string, string>
type ServerCreateResult = { success?: boolean; message?: string; install_command?: string }

const fallbackProfiles: Profile[] = [
  { id: 'vless-reality-vision', label: 'VLESS + REALITY + Vision', protocol: 'vless' },
  { id: 'vless-xhttp-reality-xmux', label: 'VLESS + XHTTP + REALITY + XMUX', protocol: 'vless' },
  { id: 'anytls-shadowtls', label: 'AnyTLS + ShadowTLS', protocol: 'anytls' },
  { id: 'mieru', label: 'Mieru', protocol: 'mieru' },
  { id: 'socks5', label: 'SOCKS5', protocol: 'socks' },
]

function parseJSON<T>(response: Response): Promise<T> {
  return response.text().then((text) => {
    try { return JSON.parse(text) as T } catch { throw new Error(text || `HTTP ${response.status}`) }
  })
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem('mmwx_token') ?? '')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [newServerName, setNewServerName] = useState('')
  const [newServerIP, setNewServerIP] = useState('')
  const [profiles, setProfiles] = useState<Profile[]>(fallbackProfiles)
  const [servers, setServers] = useState<Server[]>([])
  const [serverId, setServerId] = useState<number | null>(null)
  const [inbounds, setInbounds] = useState<Inbound[]>([])
  const [profileId, setProfileId] = useState(fallbackProfiles[0].id)
  const [port, setPort] = useState('443')
  const [target, setTarget] = useState('www.cloudflare.com:443')
  const [path, setPath] = useState('/xhttp')
  const [email, setEmail] = useState('')
  const [notice, setNotice] = useState('')
  const [credentials, setCredentials] = useState<Credentials | null>(null)
  const [installCommand, setInstallCommand] = useState('')
  const loggedIn = token !== ''

  const selectedProfile = useMemo(
    () => profiles.find((item) => item.id === profileId) ?? fallbackProfiles[0],
    [profileId, profiles],
  )

  const request = async <T,>(url: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    if (init.body) headers.set('Content-Type', 'application/json')
    const response = await fetch(url, { ...init, headers })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(body || `请求失败（${response.status}）`)
    }
    return parseJSON<T>(response)
  }

  const loadServers = async () => {
    const result = await request<{ servers?: Server[]; message?: string }>('/api/admin/remote-servers')
    const next = result.servers ?? []
    setServers(next)
    setServerId((current) => current && next.some((item) => item.id === current) ? current : next[0]?.id ?? null)
  }

  const loadProfiles = async () => {
    try {
      const result = await request<{ profiles?: Profile[] }>('/api/admin/protocol-profiles')
      if (result.profiles?.length) setProfiles(result.profiles)
    } catch { setProfiles(fallbackProfiles) }
  }

  const loadInbounds = async (id: number) => {
    const result = await request<{ inbounds?: Inbound[] }>(`/api/admin/remote/inbounds?server_id=${id}`)
    setInbounds(result.inbounds ?? [])
  }

  useEffect(() => {
    if (!loggedIn) return
    void Promise.all([loadProfiles(), loadServers()]).catch((error: Error) => setNotice(error.message))
  }, [token])

  useEffect(() => {
    if (serverId) void loadInbounds(serverId).catch((error: Error) => setNotice(error.message))
    else setInbounds([])
  }, [serverId])

  const login = async (event: FormEvent) => {
    event.preventDefault()
    setNotice('')
    try {
      const response = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, remember_me: true }),
      })
      const result = await parseJSON<{ token?: string; error?: string }>(response)
      if (!response.ok || !result.token) throw new Error(result.error ?? '登录失败')
      localStorage.setItem('mmwx_token', result.token)
      setToken(result.token)
    } catch (error) { setNotice(error instanceof Error ? error.message : '登录失败') }
  }

  const createInbound = async (event: FormEvent) => {
    event.preventDefault()
    if (!serverId) { setNotice('请先添加并选择一台服务器。'); return }
    setNotice('')
    setCredentials(null)
    try {
      const built = await request<{ inbound: Record<string, unknown>; credentials: Credentials }>('/api/admin/xray/build-inbound', {
        method: 'POST',
        body: JSON.stringify({ profile: selectedProfile.id, port: Number(port), server_name: target, dest: target, path, email }),
      })
      await request(`/api/admin/remote/inbounds?server_id=${serverId}`, {
        method: 'POST', body: JSON.stringify({ action: 'add', inbound: built.inbound }),
      })
      setCredentials(built.credentials)
      setNotice('入站已创建并下发到 Agent。')
      await loadInbounds(serverId)
    } catch (error) { setNotice(error instanceof Error ? error.message : '创建失败') }
  }

  const createServer = async (event: FormEvent) => {
    event.preventDefault()
    setNotice('')
    setInstallCommand('')
    try {
      const result = await request<ServerCreateResult>('/api/admin/remote-servers/create', {
        method: 'POST',
        // The paired Xray fork is required for AnyTLS and Mieru. WebSocket mode
        // lets a new Agent connect outward without opening a management port.
        body: JSON.stringify({
          name: newServerName,
          ip_address: newServerIP,
          pull_address: newServerIP,
          connection_mode: 'websocket',
          xray_mode: 'embedded',
        }),
      })
      if (result.success === false) throw new Error(result.message ?? '服务器创建失败')
      setInstallCommand(result.install_command ?? '')
      setNewServerName('')
      setNewServerIP('')
      setNotice('服务器已创建。请在目标服务器执行下方安装命令，连接后即可下发入站。')
      await loadServers()
    } catch (error) { setNotice(error instanceof Error ? error.message : '服务器创建失败') }
  }

  const removeInbound = async (tag?: string) => {
    if (!serverId || !tag || !confirm(`删除入站 ${tag}？`)) return
    try {
      await request(`/api/admin/remote/inbounds?server_id=${serverId}`, { method: 'POST', body: JSON.stringify({ action: 'remove', tag }) })
      setNotice('入站已删除。')
      await loadInbounds(serverId)
    } catch (error) { setNotice(error instanceof Error ? error.message : '删除失败') }
  }

  if (!loggedIn) return <main className="login-shell"><form className="login-card" onSubmit={login}>
    <p className="eyebrow">MMWX CONTROL</p><h1>登录管理台</h1><p>精简协议与无配额版本。</p>
    <label>用户名<input autoFocus value={username} onChange={(event) => setUsername(event.target.value)} /></label>
    <label>密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
    <button type="submit">登录</button>{notice && <p className="notice error">{notice}</p>}
  </form></main>

  return <main className="app-shell">
    <header><div><p className="eyebrow">MMWX CONTROL</p><h1>入站管理</h1></div><button className="quiet" onClick={() => { localStorage.removeItem('mmwx_token'); setToken('') }}>退出</button></header>
    <section className="toolbar"><label>服务器<select value={serverId ?? ''} onChange={(event) => setServerId(Number(event.target.value) || null)}>
      {servers.length === 0 && <option value="">尚无服务器</option>}{servers.map((server) => <option key={server.id} value={server.id}>{server.name} · {server.status ?? 'unknown'}</option>)}
    </select></label><button className="quiet" onClick={() => void loadServers()}>刷新服务器</button></section>
    <form className="panel server-setup" onSubmit={createServer}>
      <div className="panel-title"><div><p className="eyebrow">SERVER SETUP</p><h2>添加服务器</h2></div></div>
      <div className="form-row"><label>名称<input required value={newServerName} onChange={(event) => setNewServerName(event.target.value)} placeholder="Tokyo-01" /></label><label>公网 IP 或域名<input required value={newServerIP} onChange={(event) => setNewServerIP(event.target.value)} placeholder="203.0.113.10" /></label></div>
      <p className="hint">默认创建 WebSocket + embedded Agent；这是 AnyTLS、Mieru 与 ShadowTLS 侧车所需的运行方式。</p>
      <button type="submit">生成安装命令</button>
      {installCommand && <pre className="install-command">{installCommand}</pre>}
      {installCommand && <button type="button" className="quiet" onClick={() => void navigator.clipboard.writeText(installCommand)}>复制安装命令</button>}
    </form>
    <section className="content-grid"><form className="panel" onSubmit={createInbound}>
      <div className="panel-title"><div><p className="eyebrow">NEW INBOUND</p><h2>仅五种受支持组合</h2></div></div>
      <div className="profiles">{profiles.map((profile) => <button type="button" key={profile.id} className={profile.id === profileId ? 'profile active' : 'profile'} onClick={() => setProfileId(profile.id)}>{profile.label}</button>)}</div>
      <label>公网端口<input inputMode="numeric" min="1" max="65535" value={port} onChange={(event) => setPort(event.target.value)} /></label>
      {(profileId.startsWith('vless') || profileId === 'anytls-shadowtls') && <label>{profileId === 'anytls-shadowtls' ? 'ShadowTLS handshake 目标' : 'REALITY 目标'}<input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="www.cloudflare.com:443" /></label>}
      {profileId === 'vless-xhttp-reality-xmux' && <label>XHTTP 路径<input value={path} onChange={(event) => setPath(event.target.value)} /></label>}
      <label>初始账户标识（可选）<input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="admin" /></label>
      {profileId === 'anytls-shadowtls' && <p className="hint">Agent 会把 AnyTLS 放在回环端口，ShadowTLS 侧车接管这里填写的公网端口。</p>}
      <button type="submit" disabled={!serverId}>创建并下发</button>
    </form>
    <section className="panel"><div className="panel-title"><div><p className="eyebrow">ACTIVE</p><h2>当前入站</h2></div><button className="quiet" onClick={() => serverId && void loadInbounds(serverId)}>刷新</button></div>
      <div className="inbounds">{inbounds.length === 0 ? <p className="empty">此服务器尚未配置入站。</p> : inbounds.map((inbound) => <article key={inbound.tag} className="inbound"><div><strong>{inbound.tag}</strong><span>{inbound.protocol} · :{inbound.port}</span></div><button className="danger" onClick={() => void removeInbound(inbound.tag)}>删除</button></article>)}</div>
    </section>
    {credentials && <section className="panel credentials"><p className="eyebrow">GENERATED CREDENTIALS</p><h2>请立即保存凭据</h2><pre>{JSON.stringify(credentials, null, 2)}</pre><button className="quiet" onClick={() => void navigator.clipboard.writeText(JSON.stringify(credentials, null, 2))}>复制 JSON</button></section>}
    {notice && <p className="notice">{notice}</p>}
  </section>
</main>
}

createRoot(document.getElementById('root')!).render(<App />)
