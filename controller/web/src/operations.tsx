import { FormEvent, ReactNode, useCallback, useEffect, useState } from 'react'
import { api, apiURL, asList, readToken } from './api'
import { loadRuleTemplateCatalog, RuleTemplatesPanel } from './template-v3'

type AnyRecord = Record<string, any>
type Server = AnyRecord & { id: number; name: string }
type Node = AnyRecord & { id: number }
type User = AnyRecord & { username: string }
type Package = AnyRecord & { id: number; name: string }

const profiles = [
  { id: 'vless-reality-vision', label: 'VLESS + REALITY + Vision' },
  { id: 'vless-xhttp-reality-xmux', label: 'VLESS + XHTTP + REALITY + XMUX' },
  { id: 'anytls-shadowtls', label: 'AnyTLS + ShadowTLS' },
  { id: 'mieru', label: 'Mieru' },
  { id: 'socks5', label: 'SOCKS5' },
]

const paths: Record<string, string> = {
  plus: 'M12 5v14M5 12h14', refresh: 'M20 6v5h-5M4 18v-5h5m10.5-2A8 8 0 0 0 6 7.5L4 11m16 2-2 3.5A8 8 0 0 1 4.5 14',
  search: 'm21 21-4.4-4.4m2.4-5.6a8 8 0 1 1-16 0 8 8 0 0 1 16 0', close: 'm6 6 12 12M18 6 6 18', copy: 'M8 8h12v12H8V8Zm-4 8V4h12',
  server: 'M4 5h16v6H4V5Zm0 8h16v6H4v-6Zm3-5h.01M7 16h.01', nodes: 'M5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm14 0a2 2 0 1 0 0-4 2 2 0 0 0 0 0 4ZM12 21a2 2 0 1 0 0-4 2 2 0 0 0 0 0 4ZM7 5h10M6 7l5 10m7-10-5 10',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m7-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 10v-2a4 4 0 0 0-3-3.87', package: 'M21 8 12 3 3 8l9 5 9-5Zm-18 4 9 5 9-5M3 16l9 5 9-5',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6M8 13h8m-8 4h6', terminal: 'm4 6 5 5-5 5m7 0h9', settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8.5-3.5-.1-1.3 2-1.6-2-3.4-2.5 1a9 9 0 0 0-2.2-1.3L15.3 3h-4L11 5.4a9 9 0 0 0-2.2 1.3l-2.5-1-2 3.4 2 1.6L6.2 12l.1 1.3-2 1.6 2 3.4 2.5-1a9 9 0 0 0 2.2 1.3l.3 2.4h4l.4-2.4a9 9 0 0 0 2.2-1.3l2.5 1 2-3.4-2-1.6.1-1.3Z',
  spark: 'm12 3-1.7 4.3L6 9l4.3 1.7L12 15l1.7-4.3L18 9l-4.3-1.7L12 3Z', link: 'M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1',
}

function Icon({ name, size = 17 }: { name: string; size?: number }) {
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name] ?? paths.file}/></svg>
}

function Button({ children, variant = 'primary', icon, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; icon?: string }) {
  return <button {...props} className={`btn ${variant} ${props.className ?? ''}`}>{icon && <Icon name={icon}/>} {children}</button>
}

function Header({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return <div className="page-header"><div><h1>{title}</h1><p>{description}</p></div>{actions && <div className="page-actions">{actions}</div>}</div>
}

function Card({ children, className = '' }: { children: ReactNode; className?: string }) { return <section className={`pixel-card ${className}`}>{children}</section> }
function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) { return <div className={`notice ${error ? 'error' : ''}`}>{children}</div> }
function Spinner() { return <div className="loading"><span className="operation-spinner"/>正在加载…</div> }
function Empty({ icon = 'file', title, text }: { icon?: string; title: string; text: string }) { return <div className="empty"><span className="empty-icon"><Icon name={icon} size={25}/></span><strong>{title}</strong><p>{text}</p></div> }

function Modal({ title, description, onClose, children, wide = false }: { title: string; description?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true"><div className="modal-head"><div><h2>{title}</h2>{description && <p>{description}</p>}</div><Button variant="ghost" onClick={onClose} aria-label="关闭"><Icon name="close"/></Button></div>{children}</div></div>
}

function Feedback({ message, error }: { message: string; error?: boolean }) { return message ? <Notice error={error}>{message}</Notice> : null }
const messageOf = (reason: unknown, fallback = '操作失败') => reason instanceof Error ? reason.message : fallback
const idOf = (value: AnyRecord) => Number(value.id ?? 0)
const bool = (value: unknown, fallback = false) => typeof value === 'boolean' ? value : fallback
const text = (value: unknown, fallback = '') => value === null || value === undefined ? fallback : String(value)
const number = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback
const listFrom = <T,>(value: unknown, keys: string[]) => asList<T>(value, keys)
const usernamePattern = /^[A-Za-z0-9-]{3,20}$/

function userTrafficGB(user: AnyRecord) {
  if (user.traffic_used_gb !== null && user.traffic_used_gb !== undefined) return number(user.traffic_used_gb)
  return number(user.traffic_used) / (1024 ** 3)
}

function optionalPasswordError(value: string) {
  const bytes = new TextEncoder().encode(value.trim()).byteLength
  return bytes > 0 && (bytes < 8 || bytes > 72) ? `密码必须为 8–72 字节（当前 ${bytes} 字节）` : ''
}

function outcomeMessage(base: string, result: AnyRecord) {
  const parts = [base]
  if (Object.prototype.hasOwnProperty.call(result, 'unbound_users')) parts.push(`已自动解绑 ${Math.max(0, number(result.unbound_users))} 个用户。`)
  const warnings = Array.isArray(result.warnings) ? result.warnings.map((warning) => text(warning)).filter(Boolean) : []
  if (warnings.length) parts.push(`后端警告：${warnings.join('；')}`)
  return parts.join(' ')
}

async function clipboard(value: string) {
  await navigator.clipboard.writeText(value)
}

async function streamRequest(path: string, body: unknown, onChunk: (chunk: string) => void) {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const token = readToken()
  if (token) {
    headers.set('MM-Authorization', token)
    headers.set('Authorization', `Bearer ${token}`)
  }
  const response = await fetch(apiURL(path), { method: 'POST', headers, body: JSON.stringify(body) })
  if (!response.ok) throw new Error((await response.text()) || `请求失败（${response.status}）`)
  const reader = response.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    onChunk(decoder.decode(value, { stream: true }))
  }
}

export function ServersOperationsPage() {
  const [items, setItems] = useState<Server[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Server | 'new' | null>(null)
  const [managing, setManaging] = useState<Server | null>(null)
  const [feedback, setFeedback] = useState({ message: '', error: false })
  const load = useCallback(async () => {
    setLoading(true)
    try { setItems(listFrom<Server>(await api('/api/admin/remote-servers'), ['servers'])) }
    catch (reason) { setFeedback({ message: messageOf(reason), error: true }) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  const remove = async (server: Server) => {
    if (!window.confirm(`确定永久删除服务器“${server.name}”吗？\n\n关联节点、用户凭据和流量历史会一并删除；证书记录会保留。`)) return
    try {
      await api('/api/admin/remote-servers/delete', { method: 'POST', body: JSON.stringify({ id: server.id, delete_nodes: true, uninstall_agent: false }) })
      setFeedback({ message: '服务器、关联节点、用户凭据和流量历史已删除；证书记录已保留。', error: false }); await load()
    } catch (reason) { setFeedback({ message: messageOf(reason), error: true }) }
  }
  return <><Header title="服务管理" description="管理服务器、Agent、Xray 与 Nginx 服务" actions={<><Button variant="secondary" icon="refresh" onClick={() => void load()}>刷新</Button><Button icon="plus" onClick={() => setEditing('new')}>添加服务器</Button></>}/><Feedback {...feedback}/>{loading ? <Card><Spinner/></Card> : items.length ? <div className="server-grid">{items.map((server) => <Card className="server-card" key={server.id}><div className="server-card-head"><span className={`status-dot ${server.ws_connected || server.status === 'online' ? 'online' : ''}`}/><span>{server.ws_connected || server.status === 'online' ? '在线' : '离线'}</span></div><h2>{server.name}</h2><p className="mono">{server.ip_address || server.pull_address || server.domain || '未设置地址'}</p><dl className="detail-grid compact"><div><dt>连接</dt><dd>{server.connection_mode || 'push'}</dd></div><div><dt>Xray</dt><dd>{server.xray_running ? '运行中' : '未运行'}</dd></div></dl><div className="card-actions"><Button variant="secondary" onClick={() => setManaging(server)}>管理</Button><Button variant="ghost" onClick={() => setEditing(server)}>编辑</Button><Button variant="danger" onClick={() => void remove(server)}>删除</Button></div></Card>)}</div> : <Card><Empty icon="server" title="暂无服务器" text="添加服务器后会获得 Agent 安装命令。"/></Card>}{editing && <ServerEditor server={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={(message) => { setEditing(null); setFeedback({ message, error: false }); void load() }} onFailed={load}/>} {managing && <ServerManager server={managing} onClose={() => setManaging(null)} onChanged={() => void load()}/>}</>
}

function ServerEditor({ server, onClose, onSaved, onFailed }: { server?: Server; onClose: () => void; onSaved: (message: string) => void; onFailed: () => Promise<void> }) {
  const [form, setForm] = useState({
    name: server?.name ?? '',
    ip_address: text(server?.ip_address),
    domain: text(server?.domain),
    domain_v6: text(server?.domain_v6),
    connection_mode: text(server?.connection_mode, 'websocket'),
    listen_port: number(server?.listen_port, 23889),
    pull_address: text(server?.pull_address),
    pull_address_v6: text(server?.pull_address_v6),
    pull_port: number(server?.pull_port, 0),
    traffic_limit: number(server?.traffic_limit, 0),
    traffic_reset_day: number(server?.traffic_reset_day, 0),
    xray_mode: text(server?.xray_mode, 'external'),
    traffic_stats_mode: text(server?.traffic_stats_mode, 'both'),
    traffic_source: text(server?.traffic_source, 'system'),
    ipv6_enabled: bool(server?.ipv6_enabled, true),
    lock_entry_ip: bool(server?.lock_entry_ip),
    port_range_min: number(server?.port_range_min, 0),
    port_range_max: number(server?.port_range_max, 0),
    ddns_enabled: bool(server?.ddns_enabled),
    ddns_provider_id: number(server?.ddns_provider_id, 0),
  })
  const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const set = (key: keyof typeof form, value: string | number | boolean) => setForm((old) => ({ ...old, [key]: value }))
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const path = server ? '/api/admin/remote-servers/update' : '/api/admin/remote-servers/create'
      const payload: AnyRecord = {
        ...form,
        id: server?.id,
        listen_port: Number(form.listen_port),
        pull_port: Number(form.pull_port),
        traffic_limit: Number(form.traffic_limit),
        traffic_reset_day: Number(form.traffic_reset_day),
        port_range_min: Number(form.port_range_min),
        port_range_max: Number(form.port_range_max),
        ddns_provider_id: Number(form.ddns_provider_id),
      }
      // Agent heartbeat owns ip_address. The update DTO intentionally does not
      // accept it, so do not present a successful save that silently changes nothing.
      if (server) delete payload.ip_address
      const result = await api<AnyRecord>(path, { method: 'POST', body: JSON.stringify(payload) })
      const install = text(result.install_command || result.command)
      onSaved(install ? `服务器已保存。Agent 安装命令：${install}` : '服务器已保存。')
    } catch (reason) { setError(messageOf(reason)); await onFailed() } finally { setBusy(false) }
  }
  return <Modal title={server ? '编辑服务器' : '添加服务器'} description="保存会完整回传当前配置，不会误清 DDNS 或 IPv6 设置" onClose={onClose} wide><form className="modal-form" onSubmit={submit}>
    <div className="field-row"><label><span>名称</span><input required value={form.name} onChange={(e) => set('name', e.target.value)}/></label>{server ? <label><span>Agent 上报 IP（只读）</span><input disabled value={form.ip_address}/></label> : <label><span>初始 IP 地址</span><input value={form.ip_address} onChange={(e) => set('ip_address', e.target.value)}/></label>}</div>
    <div className="field-row"><label><span>节点域名（IPv4 / 通用）</span><input value={form.domain} onChange={(e) => set('domain', e.target.value)}/></label><label><span>IPv6 专用域名</span><input value={form.domain_v6} onChange={(e) => set('domain_v6', e.target.value)}/></label></div>
    <div className="field-row"><label><span>Agent 连接 / DDNS 地址</span><input value={form.pull_address} onChange={(e) => set('pull_address', e.target.value)}/></label><label><span>DDNS IPv6 地址</span><input value={form.pull_address_v6} onChange={(e) => set('pull_address_v6', e.target.value)}/></label></div>
    <div className="field-row"><label><span>连接方式</span><select value={form.connection_mode} onChange={(e) => set('connection_mode', e.target.value)}><option value="websocket">WebSocket</option><option value="pull">Pull</option><option value="push">Push</option></select></label><label><span>Agent 端口</span><input type="number" min="0" max="65535" value={form.listen_port} onChange={(e) => set('listen_port', Number(e.target.value))}/></label><label><span>Pull 端口</span><input type="number" min="0" max="65535" value={form.pull_port} onChange={(e) => set('pull_port', Number(e.target.value))}/></label></div>
    <div className="field-row"><label><span>流量上限（字节，0 为不限）</span><input type="number" min="0" value={form.traffic_limit} onChange={(e) => set('traffic_limit', Number(e.target.value))}/></label><label><span>每月重置日（0 为关闭）</span><input type="number" min="0" max="31" value={form.traffic_reset_day} onChange={(e) => set('traffic_reset_day', Number(e.target.value))}/></label></div>
    <div className="field-row"><label><span>Xray 模式</span><select value={form.xray_mode} onChange={(e) => set('xray_mode', e.target.value)}><option value="external">外置</option><option value="embedded">内置</option></select></label><label><span>服务器流量口径</span><select value={form.traffic_stats_mode} onChange={(e) => set('traffic_stats_mode', e.target.value)}><option value="both">上行 + 下行</option><option value="upload">仅上行</option><option value="download">仅下行</option><option value="max">取较大值</option></select></label><label><span>流量数据源</span><select value={form.traffic_source} onChange={(e) => set('traffic_source', e.target.value)}><option value="xray">Xray 节点</option><option value="system">系统网卡</option></select></label></div>
    <div className="field-row"><label><span>随机端口下限（0 为关闭）</span><input type="number" min="0" max="65535" value={form.port_range_min} onChange={(e) => set('port_range_min', Number(e.target.value))}/></label><label><span>随机端口上限（0 为关闭）</span><input type="number" min="0" max="65535" value={form.port_range_max} onChange={(e) => set('port_range_max', Number(e.target.value))}/></label><label><span>DDNS 服务商 ID（0 为自动）</span><input type="number" min="0" value={form.ddns_provider_id} onChange={(e) => set('ddns_provider_id', Number(e.target.value))}/></label></div>
    <div className="inline-options"><label><input type="checkbox" checked={form.ipv6_enabled} onChange={(e) => set('ipv6_enabled', e.target.checked)}/> 启用 IPv6</label><label><input type="checkbox" checked={form.lock_entry_ip} onChange={(e) => set('lock_entry_ip', e.target.checked)}/> 锁定入口 IP</label><label><input type="checkbox" checked={form.ddns_enabled} onChange={(e) => set('ddns_enabled', e.target.checked)}/> 启用 DDNS</label></div>
    <div className="form-note">Agent 上报 IP 由心跳维护；需要指定连接地址时，请修改“Agent 连接 / DDNS 地址”。</div>
    <Feedback message={error} error/><div className="modal-actions"><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button type="submit" disabled={busy}>{busy ? '保存中…' : '保存'}</Button></div>
  </form></Modal>
}

function ServerManager({ server, onClose, onChanged }: { server: Server; onClose: () => void; onChanged: () => void }) {
  const [data, setData] = useState<AnyRecord>({}); const [log, setLog] = useState(''); const [busy, setBusy] = useState(''); const [error, setError] = useState('')
  const load = useCallback(async () => {
    setBusy('load'); setError('')
    const query = `server_id=${encodeURIComponent(server.id)}`
    const results = await Promise.allSettled([
      api(`/api/admin/remote/services/status?${query}`), api(`/api/admin/remote/system/info?${query}`), api(`/api/admin/remote/inbounds?${query}`), api(`/api/admin/remote/agent/version-info?${query}`),
    ])
    setData({ services: results[0].status === 'fulfilled' ? results[0].value : null, system: results[1].status === 'fulfilled' ? results[1].value : null, inbounds: results[2].status === 'fulfilled' ? results[2].value : null, version: results[3].status === 'fulfilled' ? results[3].value : null })
    setBusy('')
  }, [server.id])
  useEffect(() => { void load() }, [load])
  const action = async (name: string, task: () => Promise<unknown>) => { setBusy(name); setError(''); try { await task(); setLog(`${name} 已执行完成。`); await load(); onChanged() } catch (reason) { setError(messageOf(reason)) } finally { setBusy('') } }
  const upgrade = async () => {
    if (!window.confirm('确定升级此服务器的 Agent 吗？服务可能短暂重连。')) return
    setBusy('upgrade'); setError(''); setLog('开始升级…\n')
    try { await streamRequest(`/api/admin/remote/agent/upgrade-stream?server_id=${encodeURIComponent(server.id)}`, {}, (chunk) => setLog((old) => old + chunk)); onChanged() }
    catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }
  return <Modal title={`管理 ${server.name}`} description="实时服务状态与远程操作" onClose={onClose} wide><div className="action-strip"><Button variant="secondary" disabled={Boolean(busy)} onClick={() => void action('同步节点', () => api(`/api/admin/remote/sync-nodes?server_id=${encodeURIComponent(server.id)}`, { method: 'POST', body: JSON.stringify({}) }))}>同步节点</Button>{['xray', 'nginx'].map((service) => <Button key={service} variant="secondary" disabled={Boolean(busy)} onClick={() => void action(`重启 ${service}`, () => api(`/api/admin/remote/services/control?server_id=${encodeURIComponent(server.id)}`, { method: 'POST', body: JSON.stringify({ service, action: 'restart' }) }))}>重启 {service}</Button>)}<Button disabled={Boolean(busy)} onClick={() => void upgrade()}>升级 Agent</Button><Button variant="ghost" icon="refresh" onClick={() => void load()}>刷新</Button></div><Feedback message={error} error/>{busy === 'load' ? <Spinner/> : <div className="detail-panels"><section><h3>服务状态</h3><pre>{JSON.stringify(data.services ?? {}, null, 2)}</pre></section><section><h3>系统信息</h3><pre>{JSON.stringify(data.system ?? {}, null, 2)}</pre></section><section><h3>Agent 版本</h3><pre>{JSON.stringify(data.version ?? {}, null, 2)}</pre></section><section><h3>入站</h3><pre>{JSON.stringify(data.inbounds ?? {}, null, 2)}</pre></section></div>}{log && <pre className="progress-log">{log}</pre>}</Modal>
}

const nodeName = (node: Node) => text(node.node_name || node.name || node.tag, '未命名节点')
const nodeHost = (node: Node) => text(node.server || node.address || node.original_server || node.original_domain, '—')
const nodeProtocol = (node: Node) => text(node.protocol || node.type, 'unknown').toLowerCase()
const protocolLabel = (node: Node) => {
  const value = `${nodeProtocol(node)} ${nodeName(node)} ${text(node.inbound_tag)}`.toLowerCase()
  if (value.includes('xhttp')) return 'VLESS · XHTTP · REALITY'
  if (value.includes('anytls') || value.includes('shadowtls')) return 'AnyTLS · ShadowTLS'
  if (value.includes('mieru')) return 'Mieru'
  if (value.includes('socks')) return 'SOCKS5'
  return 'VLESS · REALITY · Vision'
}

export function NodesOperationsPage({ go, isAdmin = false, currentUsername = '', routedOutboundEnabled = true }: { go: (path: string) => void; isAdmin?: boolean; currentUsername?: string; routedOutboundEnabled?: boolean }) {
  const [items, setItems] = useState<Node[]>([]); const [servers, setServers] = useState<Server[]>([])
  const [query, setQuery] = useState(''); const [selected, setSelected] = useState<number[]>([]); const [modal, setModal] = useState<'create' | 'import' | 'results' | null>(null); const [editing, setEditing] = useState<Node | null>(null); const [routing, setRouting] = useState<Node | null>(null)
  const [loading, setLoading] = useState(true); const [feedback, setFeedback] = useState({ message: '', error: false }); const [result, setResult] = useState('')
  const load = useCallback(async () => {
    setLoading(true)
    const [nodesResult, serversResult] = await Promise.allSettled([api('/api/admin/nodes'), isAdmin ? api('/api/admin/remote-servers') : Promise.resolve({ servers: [] })])
    if (nodesResult.status === 'fulfilled') setItems(listFrom<Node>(nodesResult.value, ['nodes']))
    else setFeedback({ message: messageOf(nodesResult.reason), error: true })
    if (serversResult.status === 'fulfilled') setServers(listFrom<Server>(serversResult.value, ['servers']))
    setLoading(false)
  }, [isAdmin])
  useEffect(() => { void load() }, [load])
  const filtered = items.filter((node) => `${nodeName(node)} ${nodeHost(node)} ${protocolLabel(node)}`.toLowerCase().includes(query.toLowerCase()))
  const remove = async (node: Node) => {
    if (!window.confirm(`确定删除节点“${nodeName(node)}”吗？远程入站或路由也会同步清理。`)) return
    try { await api(`/api/admin/nodes/${node.id}`, { method: 'DELETE' }); setFeedback({ message: '节点已删除。', error: false }); await load() }
    catch (reason) { setFeedback({ message: messageOf(reason), error: true }) }
  }
  const removeSelected = async () => {
    if (!selected.length || !window.confirm(`确定删除选中的 ${selected.length} 个节点吗？`)) return
    try { await api('/api/admin/nodes/batch-delete', { method: 'POST', body: JSON.stringify({ node_ids: selected }) }); setSelected([]); setFeedback({ message: '所选节点已删除。', error: false }); await load() }
    catch (reason) { setFeedback({ message: messageOf(reason), error: true }) }
  }
  const uri = async (node: Node) => {
    try { const value = await api<AnyRecord>(`/api/admin/nodes/${node.id}/uri`); const link = text(value.uri); await clipboard(link); setResult(link); setFeedback({ message: '分享 URI 已复制。', error: false }) }
    catch (reason) { setFeedback({ message: messageOf(reason), error: true }) }
  }
  const ping = async (node: Node) => {
    let host = nodeHost(node); let port = number(node.port)
    try { const config = typeof node.clash_config === 'string' ? JSON.parse(node.clash_config) : node.clash_config; host = text(config?.server, host); port = number(config?.port, port) } catch { /* use list fields */ }
    try { const value = await api<AnyRecord>('/api/admin/tcping', { method: 'POST', body: JSON.stringify({ host, port, protocol: nodeProtocol(node), timeout: 5000 }) }); setFeedback({ message: value.success ? `${nodeName(node)} 延迟 ${number(value.latency).toFixed(1)} ms` : text(value.error, '连接失败'), error: !value.success }) }
    catch (reason) { setFeedback({ message: messageOf(reason), error: true }) }
  }
  const speed = async (node: Node) => {
    try { await api('/api/admin/speedtest/run', { method: 'POST', body: JSON.stringify({ node_id: node.id, threads: 1 }) }); setFeedback({ message: '测速任务已提交，可在测速结果中查看进度。', error: false }) }
    catch (reason) { setFeedback({ message: messageOf(reason), error: true }) }
  }
  if (!isAdmin) return <>
    <Header title="我的节点" description="导入、测试并维护自己的节点与路由出站" actions={<Button variant="secondary" onClick={() => setModal('import')}>导入外部节点</Button>}/>
    <Feedback {...feedback}/>
    {result && <Card className="result-card"><code>{result}</code><Button variant="ghost" onClick={() => setResult('')}>收起</Button></Card>}
    <Card className="table-card">
      <div className="table-toolbar"><span className="node-count">共 {filtered.length} 个可见节点</span><label className="search"><Icon name="search"/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索节点"/></label></div>
      {loading ? <Spinner/> : filtered.length ? <div className="responsive-table"><table><thead><tr><th>协议</th><th>节点</th><th>服务器</th><th>端口</th><th>状态</th><th className="right">操作</th></tr></thead><tbody>{filtered.map((node) => { const owned = text(node.created_by || node.username) === currentUsername; return <tr key={node.id}><td><span className="protocol-badge">{protocolLabel(node)}</span></td><td><strong>{nodeName(node)}</strong><small className="table-sub">{owned ? '个人节点' : '套餐节点'}</small></td><td className="mono">{nodeHost(node)}</td><td>{node.port || (() => { try { return JSON.parse(text(node.clash_config, '{}')).port || '—' } catch { return '—' } })()}</td><td><span className={`badge ${node.enabled !== false ? 'success' : ''}`}>{node.enabled !== false ? '启用' : '停用'}</span></td><td className="right row-actions"><Button variant="ghost" onClick={() => void ping(node)}>延迟</Button><Button variant="ghost" onClick={() => void uri(node)}>URI</Button>{routedOutboundEnabled && <Button variant="ghost" onClick={() => setRouting(node)}>路由</Button>}{owned && <><Button variant="ghost" onClick={() => setEditing(node)}>编辑</Button><Button variant="danger" onClick={() => void remove(node)}>删除</Button></>}</td></tr> })}</tbody></table></div> : <Empty icon="nodes" title="暂无节点" text="粘贴订阅、URI 或 Clash YAML 导入个人节点。"/>}
    </Card>
    {modal === 'import' && <ImportNodes onClose={() => setModal(null)} onSaved={(count) => { setModal(null); setFeedback({ message: `已导入 ${count} 个受支持节点。`, error: false }); void load() }}/>}
    {editing && <NodeEditor node={editing} isAdmin={false} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setFeedback({ message: '节点名称已更新。', error: false }); void load() }}/>}
    {routing && <RoutedOutboundEditor node={routing} availableNodes={items} isAdmin={false} onClose={() => setRouting(null)}/>}
  </>
  return <><Header title="节点管理" description="创建、导入、测试并维护受支持协议节点" actions={<><Button variant="secondary" onClick={() => setModal('import')}>导入外部节点</Button><Button variant="secondary" onClick={() => setModal('results')}>测速结果</Button><Button icon="plus" onClick={() => setModal('create')}>添加节点</Button></>}/><Feedback {...feedback}/>{result && <Card className="result-card"><code>{result}</code><Button variant="ghost" onClick={() => setResult('')}>收起</Button></Card>}<Card className="table-card"><div className="table-toolbar"><div className="action-strip"><label className="selection"><input type="checkbox" checked={selected.length > 0 && selected.length === filtered.length} onChange={(e) => setSelected(e.target.checked ? filtered.map((node) => node.id) : [])}/> 全选</label>{selected.length > 0 && <Button variant="danger" onClick={() => void removeSelected()}>删除 {selected.length} 项</Button>}</div><label className="search"><Icon name="search"/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索节点"/></label></div>{loading ? <Spinner/> : filtered.length ? <div className="responsive-table"><table><thead><tr><th/><th>协议</th><th>节点</th><th>服务器</th><th>端口</th><th>状态</th><th className="right">操作</th></tr></thead><tbody>{filtered.map((node) => <tr key={node.id}><td><input type="checkbox" checked={selected.includes(node.id)} onChange={(e) => setSelected((old) => e.target.checked ? [...old, node.id] : old.filter((id) => id !== node.id))}/></td><td><span className="protocol-badge">{protocolLabel(node)}</span></td><td><strong>{nodeName(node)}</strong></td><td className="mono">{nodeHost(node)}</td><td>{node.port || (() => { try { return JSON.parse(text(node.clash_config, '{}')).port || '—' } catch { return '—' } })()}</td><td><span className={`badge ${node.enabled !== false ? 'success' : ''}`}>{node.enabled !== false ? '启用' : '停用'}</span></td><td className="right row-actions"><Button variant="ghost" onClick={() => void ping(node)}>延迟</Button><Button variant="ghost" onClick={() => void speed(node)}>测速</Button><Button variant="ghost" onClick={() => void uri(node)}>URI</Button><Button variant="ghost" onClick={() => setRouting(node)}>路由</Button><Button variant="ghost" onClick={() => setEditing(node)}>编辑</Button><Button variant="danger" onClick={() => void remove(node)}>删除</Button></td></tr>)}</tbody></table></div> : <Empty icon="nodes" title="暂无节点" text="可以创建 Agent 入站，或粘贴订阅、URI 和 Clash YAML 导入。"/>}</Card>{modal === 'create' && <ManagedNodeEditor servers={servers} onNeedServer={() => { setModal(null); go('/xray-servers') }} onClose={() => setModal(null)} onSaved={() => { setModal(null); setFeedback({ message: '节点入站已创建并下发。', error: false }); void load() }}/>} {modal === 'import' && <ImportNodes onClose={() => setModal(null)} onSaved={(count) => { setModal(null); setFeedback({ message: `已导入 ${count} 个受支持节点。`, error: false }); void load() }}/>} {modal === 'results' && <SpeedResults onClose={() => setModal(null)}/>} {editing && <NodeEditor node={editing} isAdmin onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setFeedback({ message: '节点已更新。', error: false }); void load() }}/>} {routing && <RoutedOutboundEditor node={routing} onClose={() => setRouting(null)}/>}</>
}

function ManagedNodeEditor({ servers, onNeedServer, onClose, onSaved }: { servers: Server[]; onNeedServer: () => void; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ server_id: text(servers[0]?.id), profile: profiles[0].id, port: 443, destination: 'www.microsoft.com:443', path: '/xhttp', email: '' }); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const set = (key: keyof typeof form, value: string | number) => setForm((old) => ({ ...old, [key]: value }))
  if (!servers.length) return <Modal title="添加节点" description="创建托管节点前需要一台服务器" onClose={onClose}><Notice error>还没有服务器。</Notice><div className="modal-actions"><Button variant="secondary" onClick={onClose}>取消</Button><Button onClick={onNeedServer}>去添加服务器</Button></div></Modal>
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const built = await api<AnyRecord>('/api/admin/xray/build-inbound', { method: 'POST', body: JSON.stringify({ profile: form.profile, port: Number(form.port), server_name: form.destination.split(':')[0], dest: form.destination, path: form.path, email: form.email }) })
      if (!built.inbound) throw new Error('后端没有返回入站配置')
      await api(`/api/admin/remote/inbounds?server_id=${encodeURIComponent(form.server_id)}`, { method: 'POST', body: JSON.stringify({ action: 'add', inbound: built.inbound }) })
      onSaved()
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) }
  }
  const reality = form.profile.startsWith('vless') || form.profile === 'anytls-shadowtls'
  return <Modal title="添加托管节点" description="仅提供当前维护的五种协议组合" onClose={onClose}><form className="modal-form" onSubmit={submit}><label><span>服务器</span><select value={form.server_id} onChange={(e) => set('server_id', e.target.value)}>{servers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}</select></label><label><span>协议组合</span><select value={form.profile} onChange={(e) => set('profile', e.target.value)}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label><label><span>端口</span><input type="number" min="1" max="65535" required value={form.port} onChange={(e) => set('port', Number(e.target.value))}/></label>{reality && <label><span>握手目标</span><input required value={form.destination} onChange={(e) => set('destination', e.target.value)}/></label>}{form.profile === 'vless-xhttp-reality-xmux' && <label><span>XHTTP 路径</span><input required value={form.path} onChange={(e) => set('path', e.target.value)}/></label>}<label><span>初始账户标识</span><input value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="可选"/></label><Feedback message={error} error/><div className="modal-actions"><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button type="submit" disabled={busy}>{busy ? '下发中…' : '创建并下发'}</Button></div></form></Modal>
}

function ImportNodes({ onClose, onSaved }: { onClose: () => void; onSaved: (count: number) => void }) {
  const [content, setContent] = useState(''); const [parsed, setParsed] = useState<AnyRecord[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const parse = async () => { setBusy(true); setError(''); try { const value = await api<AnyRecord>('/api/admin/nodes/parse-uris', { method: 'POST', body: JSON.stringify({ content }) }); const supported = listFrom<AnyRecord>(value.proxies, []).filter((proxy) => ['vless', 'anytls', 'mieru', 'socks', 'socks5'].includes(text(proxy.type).toLowerCase())); setParsed(supported); if (!supported.length) throw new Error('没有识别到受支持的协议节点') } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) } }
  const save = async () => { setBusy(true); setError(''); try { const nodes = parsed.map((proxy) => ({ node_name: text(proxy.name), protocol: text(proxy.type), parsed_config: JSON.stringify(proxy), clash_config: JSON.stringify(proxy), enabled: true })); const result = await api<AnyRecord>('/api/admin/nodes/batch', { method: 'POST', body: JSON.stringify({ nodes }) }); onSaved(listFrom(result, ['nodes']).length || nodes.length) } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) } }
  return <Modal title="导入外部节点" description="支持 Clash YAML、分享 URI、base64 订阅文本和 Surge 行" onClose={onClose} wide><div className="modal-form"><label><span>节点内容</span><textarea className="code-editor" rows={10} value={content} onChange={(e) => { setContent(e.target.value); setParsed([]) }} placeholder="粘贴订阅内容或多行 URI"/></label>{parsed.length > 0 && <Notice>已识别 {parsed.length} 个受支持节点：{parsed.map((item) => text(item.name)).join('、')}</Notice>}<Feedback message={error} error/><div className="modal-actions"><Button variant="secondary" onClick={onClose}>取消</Button>{parsed.length ? <Button disabled={busy} onClick={() => void save()}>{busy ? '导入中…' : '确认导入'}</Button> : <Button disabled={busy || !content.trim()} onClick={() => void parse()}>{busy ? '解析中…' : '解析内容'}</Button>}</div></div></Modal>
}

function NodeEditor({ node, isAdmin, onClose, onSaved }: { node: Node; isAdmin: boolean; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ node_name: nodeName(node), tag: text(node.tag), enabled: bool(node.enabled, true), clash_config: text(node.clash_config), parsed_config: text(node.parsed_config), protocol: nodeProtocol(node), inbound_tag: text(node.inbound_tag) }); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { let payload: AnyRecord = { node_name: form.node_name }; if (isAdmin) { let clash = form.clash_config; if (clash) { const parsed = JSON.parse(clash); parsed.name = form.node_name; clash = JSON.stringify(parsed) } payload = { ...node, ...form, clash_config: clash } } await api(`/api/admin/nodes/${node.id}`, { method: 'PUT', body: JSON.stringify(payload) }); onSaved() } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) } }
  return <Modal title={`编辑 ${nodeName(node)}`} description={isAdmin ? '管理员可编辑节点元数据与完整 Clash 配置' : '普通用户只能修改自己节点的显示名称'} onClose={onClose} wide={isAdmin}><form className="modal-form" onSubmit={submit}><div className="field-row"><label><span>节点名称</span><input required value={form.node_name} onChange={(e) => setForm({ ...form, node_name: e.target.value })}/></label>{isAdmin && <label><span>标签</span><input value={form.tag} onChange={(e) => setForm({ ...form, tag: e.target.value })}/></label>}</div>{isAdmin && <><label className="inline-check"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })}/> 启用节点</label><label><span>Clash 配置 JSON</span><textarea className="code-editor" rows={12} value={form.clash_config} onChange={(e) => setForm({ ...form, clash_config: e.target.value })}/></label></>}<Feedback message={error} error/><div className="modal-actions"><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button type="submit" disabled={busy}>{busy ? '保存中…' : '保存节点'}</Button></div></form></Modal>
}

function SpeedResults({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<AnyRecord[]>([]); const [error, setError] = useState('')
  useEffect(() => { api<AnyRecord>('/api/admin/speedtest/results?limit=100').then((value) => setItems(listFrom(value, ['results']))).catch((reason) => setError(messageOf(reason))) }, [])
  return <Modal title="测速结果" description="任务异步执行，重新打开可查看最新状态" onClose={onClose} wide><Feedback message={error} error/>{items.length ? <div className="responsive-table"><table><thead><tr><th>节点</th><th>状态</th><th>延迟</th><th>速度</th><th>时间</th></tr></thead><tbody>{items.map((item, index) => { const downMbps = item.down_mbps ?? item.speed_mbps ?? item.download_mbps; return <tr key={text(item.id, String(index))}><td>{text(item.node_name || item.node_id)}</td><td>{text(item.status)}</td><td>{number(item.latency_ms ?? item.latency).toFixed(1)} ms</td><td>{downMbps === null || downMbps === undefined ? '—' : `${number(downMbps).toFixed(1)} Mbps`}</td><td>{text(item.created_at)}</td></tr> })}</tbody></table></div> : !error && <Spinner/>}</Modal>
}

function RoutedOutboundEditor({ node, availableNodes = [], onClose, isAdmin = true }: { node: Node; availableNodes?: Node[]; onClose: () => void; isAdmin?: boolean }) {
  const targetNodes = availableNodes.filter((candidate) => candidate.id !== node.id && text(candidate.node_type) !== 'routed' && !nodeProtocol(candidate).includes('⇋'))
  const [items, setItems] = useState<AnyRecord[]>([]); const [label, setLabel] = useState(''); const [nodeNameValue, setNodeNameValue] = useState(''); const [targetNodeID, setTargetNodeID] = useState<number>(targetNodes[0]?.id ?? 0); const [outbound, setOutbound] = useState('{\n  "protocol": "vless",\n  "settings": {\n    "vnext": [\n      { "address": "目标地址", "port": 443, "users": [] }\n    ]\n  }\n}'); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  const endpoint = isAdmin ? '/api/admin/routed-outbound' : '/api/user/routed-outbound'
  const load = useCallback(() => api<AnyRecord>(isAdmin ? `${endpoint}?parent_id=${node.id}` : endpoint).then((value) => setItems(listFrom<AnyRecord>(value, ['items']).filter((item) => isAdmin || Number(item.parent_node_id) === node.id))).catch((reason) => setError(messageOf(reason))), [endpoint, isAdmin, node.id])
  useEffect(() => { void load() }, [load])
  const create = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { await api(endpoint, { method: 'POST', body: JSON.stringify({ parent_node_id: node.id, ...(isAdmin ? {} : { target_node_id: targetNodeID }), label, node_name: nodeNameValue, outbound: JSON.parse(outbound) }) }); setLabel(''); await load() } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) } }
  const remove = async (id: number) => { if (!window.confirm('确定删除这个路由出站吗？删除会触发相关 Agent 重载。')) return; try { await api(`${endpoint}?id=${id}`, { method: 'DELETE' }); await load() } catch (reason) { setError(messageOf(reason)) } }
  return <Modal title={`路由出站 · ${nodeName(node)}`} description="为物理节点挂载虚拟出站，配置会同步到 Agent" onClose={onClose} wide><form className="modal-form" onSubmit={create}>{!isAdmin && <><label><span>目标节点</span><select required value={targetNodeID || ''} onChange={(event) => setTargetNodeID(Number(event.target.value))}><option value="">请选择目标节点</option>{targetNodes.map((target) => <option key={target.id} value={target.id}>{nodeName(target)} · {nodeHost(target)}</option>)}</select></label><Notice>出站 JSON 的服务器、端口及 SOCKS5 凭据必须与所选目标节点一致；后端会再次校验，防止流量被导向未授权地址。</Notice></>}<div className="field-row"><label><span>标识</span><input required minLength={2} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如 HK-T4"/></label><label><span>节点显示名</span><input value={nodeNameValue} onChange={(e) => setNodeNameValue(e.target.value)} placeholder="可选"/></label></div><label><span>Xray outbound JSON</span><textarea className="code-editor" rows={8} value={outbound} onChange={(e) => setOutbound(e.target.value)}/></label><Feedback message={error} error/>{!isAdmin && !targetNodes.length && <Feedback message="当前没有可作为目标的其他物理节点。" error/>}<div className="modal-actions"><Button type="submit" disabled={busy || (!isAdmin && !targetNodeID)}>{busy ? '创建中…' : '创建路由出站'}</Button></div></form><div className="library-grid route-list">{items.map((item) => <article key={text(item.id)}><span><Icon name="nodes"/></span><div><strong>{text(item.node_name || item.label)}</strong><small>{text(item.routed_outbound_tag || item.tag)}</small></div><Button variant="danger" onClick={() => void remove(Number(item.id))}>删除</Button></article>)}</div></Modal>
}

export function UsersOperationsPage() {
  const [items, setItems] = useState<User[]>([]); const [packages, setPackages] = useState<Package[]>([]); const [loading, setLoading] = useState(true); const [creating, setCreating] = useState(false); const [editing, setEditing] = useState<User | null>(null); const [feedback, setFeedback] = useState({ message: '', error: false })
  const load = useCallback(async () => {
    setLoading(true)
    const [a, b] = await Promise.allSettled([api('/api/admin/users'), api('/api/admin/packages')])
    if (a.status === 'fulfilled') setItems(listFrom<User>(a.value, ['users'])); else setFeedback({ message: messageOf(a.reason), error: true })
    if (b.status === 'fulfilled') setPackages(listFrom<Package>(b.value, ['packages']))
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])
  return <><Header title="用户管理" description="创建账号、调整状态、重置密码并分配套餐" actions={<><Button variant="secondary" icon="refresh" onClick={() => void load()}>刷新</Button><Button icon="plus" onClick={() => setCreating(true)}>创建用户</Button></>}/><Feedback {...feedback}/><Card className="table-card">{loading ? <Spinner/> : items.length ? <div className="responsive-table"><table><thead><tr><th>用户</th><th>角色</th><th>套餐</th><th>流量</th><th>状态</th><th className="right">操作</th></tr></thead><tbody>{items.map((user) => <tr key={user.username}><td><div className="user-cell"><span className="avatar small">{text(user.nickname || user.username, 'U')[0].toUpperCase()}</span><div><strong>{text(user.nickname || user.username)}</strong><small>{text(user.email || user.username)}</small></div></div></td><td>{user.role === 'admin' || user.is_admin ? '管理员' : '用户'}</td><td>{text(user.package_name, '未分配')}</td><td>{userTrafficGB(user).toFixed(2)} GB</td><td><span className={`badge ${user.is_active !== false ? 'success' : ''}`}>{user.is_active !== false ? '正常' : '停用'}</span></td><td className="right"><Button variant="ghost" onClick={() => setEditing(user)}>管理</Button></td></tr>)}</tbody></table></div> : <Empty icon="users" title="暂无用户" text="创建用户后可以分配套餐和订阅。"/>}</Card>{creating && <UserCreate onClose={() => setCreating(false)} onSaved={(password) => { setCreating(false); setFeedback({ message: password ? `用户已创建，初始密码：${password}` : '用户已创建。', error: false }); void load() }}/>} {editing && <UserManager user={editing} packages={packages} onClose={() => setEditing(null)} onChanged={(message) => { setFeedback({ message, error: false }); void load() }}/>}</>
}

function UserCreate({ onClose, onSaved }: { onClose: () => void; onSaved: (password: string) => void }) {
  const [form, setForm] = useState({ username: '', nickname: '', email: '', password: '', remark: '' }); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('')
    const username = form.username.trim(); const password = form.password.trim()
    if (!usernamePattern.test(username)) { setError('用户名必须为 3–20 位，只能包含英文字母、数字和短横线，不能包含下划线'); return }
    const passwordError = optionalPasswordError(password)
    if (passwordError) { setError(passwordError); return }
    setBusy(true)
    try { const value = await api<AnyRecord>('/api/admin/users/create', { method: 'POST', body: JSON.stringify({ ...form, username, password }) }); onSaved(text(value.password)) }
    catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) }
  }
  return <Modal title="创建用户" description="密码留空时由后端生成一次性初始密码" onClose={onClose}><form className="modal-form" onSubmit={submit}><div className="field-row"><label><span>用户名</span><input required minLength={3} maxLength={20} pattern="[A-Za-z0-9-]{3,20}" title="3–20 位英文字母、数字或短横线，不能包含下划线" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })}/></label><label><span>昵称</span><input value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })}/></label></div><label><span>邮箱</span><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}/></label><label><span>初始密码</span><input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="留空自动生成；填写时须为 8–72 字节"/></label><label><span>备注</span><textarea value={form.remark} onChange={(e) => setForm({ ...form, remark: e.target.value })}/></label><Feedback message={error} error/><div className="modal-actions"><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button type="submit" disabled={busy}>{busy ? '创建中…' : '创建用户'}</Button></div></form></Modal>
}

function UserManager({ user, packages, onClose, onChanged }: { user: User; packages: Package[]; onClose: () => void; onChanged: (message: string) => void }) {
  const [email, setEmail] = useState(text(user.email)); const [remark, setRemark] = useState(text(user.remark)); const [password, setPassword] = useState(''); const [packageID, setPackageID] = useState(text(user.package_id)); const [active, setActive] = useState(user.is_active !== false); const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [secret, setSecret] = useState('')
  const run = async (name: string, action: () => Promise<unknown>, message: string) => { setBusy(name); setError(''); try { await action(); onChanged(message) } catch (reason) { setError(messageOf(reason)) } finally { setBusy('') } }
  const saveProfile = async (event: FormEvent) => { event.preventDefault(); setBusy('profile'); setError(''); try { await Promise.all([api('/api/admin/users/update-email', { method: 'POST', body: JSON.stringify({ username: user.username, email }) }), api('/api/admin/users/remark', { method: 'POST', body: JSON.stringify({ username: user.username, remark }) })]); onChanged('用户资料已更新。') } catch (reason) { setError(messageOf(reason)) } finally { setBusy('') } }
  const reset = async () => {
    setError(''); const newPassword = password.trim(); const passwordError = optionalPasswordError(newPassword)
    if (passwordError) { setError(passwordError); return }
    setBusy('password')
    try { const value = await api<AnyRecord>('/api/admin/users/reset-password', { method: 'POST', body: JSON.stringify({ username: user.username, new_password: newPassword }) }); setSecret(text(value.password)); setPassword(''); onChanged('密码已重置。') }
    catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }
  const toggleStatus = async () => {
    const next = !active
    setBusy('status'); setError('')
    try {
      await api('/api/admin/users/status', { method: 'POST', body: JSON.stringify({ username: user.username, is_active: next }) })
      setActive(next)
      onChanged(next ? '用户已启用。' : '用户已停用。')
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }
  const remove = async () => { if (!window.confirm(`确定彻底删除用户“${user.username}”吗？`)) return; await run('delete', () => api('/api/admin/users/delete', { method: 'POST', body: JSON.stringify({ username: user.username }) }), '用户已删除。'); onClose() }
  return <Modal title={`管理用户 · ${user.username}`} onClose={onClose} wide><form className="modal-form" onSubmit={saveProfile}><div className="field-row"><label><span>邮箱</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)}/></label><label><span>备注</span><input value={remark} onChange={(e) => setRemark(e.target.value)}/></label></div><div className="modal-actions"><Button type="submit" variant="secondary" disabled={Boolean(busy)}>保存资料</Button></div></form><hr className="divider"/><div className="operation-section"><h3>账号状态与密码</h3><div className="field-row"><label><span>新密码</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="留空由后端生成；填写时须为 8–72 字节"/></label><div className="aligned-action"><Button variant="secondary" disabled={Boolean(busy)} onClick={() => void reset()}>重置密码</Button></div></div>{secret && <Notice>新密码：<code>{secret}</code> <button className="text-button" onClick={() => void clipboard(secret)}>复制</button></Notice>}<div className="action-strip"><Button variant="secondary" disabled={Boolean(busy)} onClick={() => void toggleStatus()}>{active ? '停用账号' : '启用账号'}</Button><Button variant="danger" disabled={Boolean(busy) || user.role === 'admin'} onClick={() => void remove()}>删除用户</Button></div></div><hr className="divider"/><div className="operation-section"><h3>套餐分配</h3><div className="field-row"><label><span>套餐</span><select value={packageID} onChange={(e) => setPackageID(e.target.value)}><option value="">请选择套餐</option>{packages.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><div className="aligned-action"><Button disabled={Boolean(busy) || !packageID} onClick={() => void run('assign', () => api('/api/admin/packages/assign', { method: 'POST', body: JSON.stringify({ username: user.username, package_id: Number(packageID) }) }), '套餐已分配并同步节点。')}>分配套餐</Button><Button variant="secondary" disabled={Boolean(busy)} onClick={() => void run('unassign', () => api('/api/admin/packages/unassign', { method: 'POST', body: JSON.stringify({ username: user.username }) }), '套餐已取消。')}>取消套餐</Button></div></div></div><Feedback message={error} error/><div className="modal-actions"><Button variant="secondary" onClick={onClose}>关闭</Button></div></Modal>
}

export function PackagesOperationsPage() {
  const [items, setItems] = useState<Package[]>([]); const [nodes, setNodes] = useState<Node[]>([]); const [templates, setTemplates] = useState<string[]>([]); const [editing, setEditing] = useState<Package | 'new' | null>(null); const [loading, setLoading] = useState(true); const [feedback, setFeedback] = useState({ message: '', error: false })
  const [limiterAvailable, setLimiterAvailable] = useState(false)
  const load = useCallback(async () => { setLoading(true); setFeedback({ message: '', error: false }); const [a, b, c] = await Promise.allSettled([api<AnyRecord>('/api/admin/packages'), api('/api/admin/nodes'), loadRuleTemplateCatalog()]); const errors: string[] = []; if (a.status === 'fulfilled') { setItems(listFrom<Package>(a.value, ['packages'])); setLimiterAvailable(bool((a.value.features as AnyRecord | undefined)?.limiter)) } else errors.push(messageOf(a.reason)); if (b.status === 'fulfilled') setNodes(listFrom<Node>(b.value, ['nodes'])); else errors.push(messageOf(b.reason)); if (c.status === 'fulfilled') setTemplates(c.value.templates); else errors.push(`模板目录：${messageOf(c.reason)}`); if (errors.length) setFeedback({ message: errors.join('；'), error: true }); setLoading(false) }, [])
  useEffect(() => { void load() }, [load])
  const remove = async (item: Package) => { if (!window.confirm(`确定删除套餐“${item.name}”吗？绑定此套餐的用户会自动解绑。`)) return; try { const result = await api<AnyRecord>(`/api/admin/packages/${item.id}`, { method: 'DELETE' }); setFeedback({ message: outcomeMessage('套餐已删除。', result), error: false }); await load() } catch (reason) { setFeedback({ message: messageOf(reason), error: true }) } }
  return <><Header title="套餐模板管理" description={`配置流量周期、设备数和可用节点；运行时限速${limiterAvailable ? '已授权' : '需要 limiter 许可证'}`} actions={<Button icon="plus" onClick={() => setEditing('new')}>创建套餐</Button>}/><Feedback {...feedback}/>{loading ? <Card><Spinner/></Card> : items.length ? <div className="package-grid">{items.map((item) => <Card className="package-card" key={item.id}><span className="package-art"><Icon name="package" size={25}/></span><h2>{item.name}</h2><p>{text(item.description, '标准套餐')}</p><dl><div><dt>流量</dt><dd>{number(item.traffic_limit_gb)} GB</dd></div><div><dt>周期</dt><dd>{number(item.cycle_days || item.duration_days)} 天</dd></div><div><dt>限速</dt><dd>{number(item.speed_limit_mbps) ? `${number(item.speed_limit_mbps)} Mbps` : '不限'}</dd></div></dl><div className="card-actions"><Button variant="secondary" onClick={() => setEditing(item)}>编辑套餐</Button><Button variant="danger" onClick={() => void remove(item)}>删除</Button></div></Card>)}</div> : <Card><Empty icon="package" title="暂无套餐" text="创建套餐并选择节点后即可分配给用户。"/></Card>}{editing && <PackageEditor item={editing === 'new' ? undefined : editing} nodes={nodes} templates={templates} limiterAvailable={limiterAvailable} onClose={() => setEditing(null)} onSaved={(result) => { setEditing(null); setFeedback({ message: outcomeMessage('套餐已保存。', result), error: false }); void load() }}/>}</>
}

function packageNumberMap(value: unknown) {
  const result: Record<string, number> = {}
  if (value && typeof value === 'object' && !Array.isArray(value)) for (const [key, raw] of Object.entries(value as AnyRecord)) if (Number.isFinite(Number(raw))) result[key] = Number(raw)
  return result
}

function packageTextMap(value: unknown) {
  const result: Record<string, string> = {}
  if (value && typeof value === 'object' && !Array.isArray(value)) for (const [key, raw] of Object.entries(value as AnyRecord)) result[key] = text(raw)
  return result
}

function PackageEditor({ item, nodes, templates, limiterAvailable, onClose, onSaved }: { item?: Package; nodes: Node[]; templates: string[]; limiterAvailable: boolean; onClose: () => void; onSaved: (result: AnyRecord) => void }) {
  const existingNodes = Array.isArray(item?.nodes) ? item!.nodes.map(Number) : []
  const [form, setForm] = useState({ name: item?.name ?? '', description: text(item?.description), traffic_limit_gb: number(item?.traffic_limit_gb, 100), cycle_days: number(item?.cycle_days || item?.duration_days, 30), is_reset: bool(item?.is_reset), reset_day: number(item?.reset_day, 1), speed_limit_mbps: number(item?.speed_limit_mbps), device_limit: number(item?.device_limit), traffic_mode: text(item?.traffic_mode, 'oneway'), node_name_override_enabled: bool(item?.node_name_override_enabled), template_filename: text(item?.template_filename), surge_template_filename: text(item?.surge_template_filename) })
  const [selected, setSelected] = useState<number[]>(existingNodes)
  const [multipliers, setMultipliers] = useState(() => packageNumberMap(item?.node_multipliers))
  const [nodeNames, setNodeNames] = useState(() => packageTextMap(item?.node_name_overrides))
  const [nodeSpeeds, setNodeSpeeds] = useState(() => packageNumberMap(item?.node_speed_limits))
  const [nodeDevices, setNodeDevices] = useState(() => packageNumberMap(item?.node_device_limits))
  const [autoRules, setAutoRules] = useState<AnyRecord[]>(() => Array.isArray(item?.auto_speed_rules) ? item!.auto_speed_rules.map((rule: AnyRecord) => ({ ...rule })) : [])
  const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const hasOwn = (values: Record<string, unknown>, id: number) => Object.prototype.hasOwnProperty.call(values, String(id))
  const setMapValue = (setter: React.Dispatch<React.SetStateAction<Record<string, number>>>, id: number, value: number | null) => setter((old) => { const next = { ...old }; if (value === null) delete next[String(id)]; else next[String(id)] = value; return next })
  const setNodeName = (id: number, value: string) => setNodeNames((old) => ({ ...old, [String(id)]: value }))
  const limiterBlocked = !limiterAvailable && (form.speed_limit_mbps > 0 || form.device_limit > 0 || autoRules.length > 0 || selected.some((id) => number(nodeSpeeds[String(id)]) > 0 || number(nodeDevices[String(id)]) > 0))
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('')
    if (limiterBlocked) { setError('此套餐包含限速或设备数策略；当前许可证未开放 limiter，无法安全保存而不改变原策略。'); return }
    if (form.is_reset && (form.reset_day < 1 || form.reset_day > 31)) { setError('每月重置日必须是 1–31。'); return }
    setBusy(true)
    try {
      const keepSelected = <T,>(values: Record<string, T>) => Object.fromEntries(Object.entries(values).filter(([key]) => selected.includes(Number(key))))
      const result = await api<AnyRecord>(item ? '/api/admin/packages/update' : '/api/admin/packages/create', { method: 'POST', body: JSON.stringify({ ...form, id: item?.id, nodes: selected, node_multipliers: keepSelected(multipliers), node_name_overrides: keepSelected(nodeNames), node_speed_limits: keepSelected(nodeSpeeds), node_device_limits: keepSelected(nodeDevices), auto_speed_rules: autoRules }) })
      onSaved(result)
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) }
  }
  const clashTemplates = templates.filter((filename) => !filename.toLowerCase().endsWith('.conf'))
  const surgeTemplates = templates.filter((filename) => filename.toLowerCase().endsWith('.conf'))
  const templateSelect = (kind: 'template_filename' | 'surge_template_filename', choices: string[]) => <select value={form[kind]} onChange={(event) => setForm({ ...form, [kind]: event.target.value })}><option value="">跟随系统默认</option>{form[kind] && !choices.includes(form[kind]) && <option value={form[kind]}>{form[kind]}（当前已不可见，可清除）</option>}{choices.map((filename) => <option key={filename} value={filename}>{filename}</option>)}</select>
  return <Modal title={item ? `编辑套餐 · ${item.name}` : '创建套餐'} onClose={onClose} wide><form className="modal-form" onSubmit={submit}>
    <div className="field-row"><label><span>套餐名称</span><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}/></label><label><span>流量模式</span><select value={form.traffic_mode} onChange={(e) => setForm({ ...form, traffic_mode: e.target.value })}><option value="oneway">单向流量</option><option value="twoway">双向流量</option></select></label></div>
    <label><span>说明</span><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}/></label>
    <div className="field-row"><label><span>流量（GB）</span><input type="number" min="0.01" step="0.01" required value={form.traffic_limit_gb} onChange={(e) => setForm({ ...form, traffic_limit_gb: Number(e.target.value) })}/></label><label><span>周期（天）</span><input type="number" min="1" required value={form.cycle_days} onChange={(e) => setForm({ ...form, cycle_days: Number(e.target.value) })}/></label></div>
    <div className="inline-options"><label><input type="checkbox" checked={form.is_reset} onChange={(e) => setForm({ ...form, is_reset: e.target.checked })}/> 每月自动重置流量</label>{form.is_reset && <label><span>重置日</span><input type="number" min="1" max="31" value={form.reset_day} onChange={(e) => setForm({ ...form, reset_day: Number(e.target.value) })}/></label>}</div>
    <div className="field-row"><label><span>Clash / Mihomo 模板</span>{templateSelect('template_filename', clashTemplates)}</label><label><span>Surge 模板</span>{templateSelect('surge_template_filename', surgeTemplates)}</label></div>
    <div className="field-row"><label><span>全局限速（Mbps，0 不限）</span><input type="number" min="0" disabled={!limiterAvailable} value={form.speed_limit_mbps} onChange={(e) => setForm({ ...form, speed_limit_mbps: Number(e.target.value) })}/></label><label><span>全局设备数（0 不限）</span><input type="number" min="0" disabled={!limiterAvailable} value={form.device_limit} onChange={(e) => setForm({ ...form, device_limit: Number(e.target.value) })}/></label></div>
    {!limiterAvailable && <div className="form-note">当前许可证未开放 limiter：新套餐只能保持不限速、设备数不限；已有受限策略会保留且禁止误覆盖。</div>}
    <fieldset className="checkbox-field"><legend>套餐节点</legend>{nodes.length ? <div className="checkbox-list">{nodes.map((node) => <label key={node.id}><input type="checkbox" checked={selected.includes(node.id)} onChange={(e) => setSelected((old) => e.target.checked ? [...old, node.id] : old.filter((id) => id !== node.id))}/><span>{nodeName(node)}</span></label>)}</div> : <small>暂无节点，可先保存空套餐。</small>}</fieldset>
    <div className="inline-options"><label><input type="checkbox" checked={form.node_name_override_enabled} onChange={(e) => setForm({ ...form, node_name_override_enabled: e.target.checked })}/> 在订阅中启用套餐内节点改名</label></div>
    {selected.length > 0 && <div className="detail-panels">{selected.map((id) => { const node = nodes.find((candidate) => candidate.id === id); const speedOverride = hasOwn(nodeSpeeds, id); const deviceOverride = hasOwn(nodeDevices, id); return <section key={id} className="stack-form"><div><h3>{node ? nodeName(node) : `节点 #${id}`}</h3><span className="chip">#{id}</span></div><div className="field-row"><label><span>流量倍率</span><input type="number" min="0.01" step="0.01" value={number(multipliers[String(id)], 1)} onChange={(e) => setMapValue(setMultipliers, id, Number(e.target.value))}/></label><label><span>套餐内名称</span><input disabled={!form.node_name_override_enabled} value={text(nodeNames[String(id)])} onChange={(e) => setNodeName(id, e.target.value)}/></label></div><div className="field-row"><label><span>节点限速</span><select disabled={!limiterAvailable} value={speedOverride ? 'override' : 'inherit'} onChange={(e) => setMapValue(setNodeSpeeds, id, e.target.value === 'inherit' ? null : 0)}><option value="inherit">继承全局</option><option value="override">单独覆盖</option></select>{speedOverride && <input type="number" min="0" step="0.1" disabled={!limiterAvailable} value={number(nodeSpeeds[String(id)])} onChange={(e) => setMapValue(setNodeSpeeds, id, Number(e.target.value))} placeholder="0 = 不限"/>}</label><label><span>节点设备数</span><select disabled={!limiterAvailable} value={deviceOverride ? 'override' : 'inherit'} onChange={(e) => setMapValue(setNodeDevices, id, e.target.value === 'inherit' ? null : 0)}><option value="inherit">继承全局</option><option value="override">单独覆盖</option></select>{deviceOverride && <input type="number" min="0" disabled={!limiterAvailable} value={number(nodeDevices[String(id)])} onChange={(e) => setMapValue(setNodeDevices, id, Number(e.target.value))} placeholder="0 = 不限"/>}</label></div></section> })}</div>}
    <div className="card-head"><div><h2>自动限速规则</h2><p>达到持续或突发阈值后，由 Agent 自动切换到指定速率。</p></div><Button type="button" variant="secondary" disabled={!limiterAvailable} onClick={() => setAutoRules((old) => [...old, { type: 'sustained', threshold_mbps: 100, sustained_seconds: 60, window_seconds: 300, burst_count: 3, limit_mbps: 20 }])}>添加规则</Button></div>
    {autoRules.length > 0 && <div className="detail-panels">{autoRules.map((rule, index) => { const updateRule = (key: string, value: string | number) => setAutoRules((old) => old.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: value } : item)); return <section key={index} className="stack-form"><div><h3>规则 {index + 1}</h3><Button type="button" variant="danger" disabled={!limiterAvailable} onClick={() => setAutoRules((old) => old.filter((_, itemIndex) => itemIndex !== index))}>删除</Button></div><div className="field-row"><label><span>类型</span><select disabled={!limiterAvailable} value={text(rule.type, 'sustained')} onChange={(e) => updateRule('type', e.target.value)}><option value="sustained">持续高流量</option><option value="burst">窗口内突发</option></select></label><label><span>触发阈值 Mbps</span><input type="number" min="0" step="0.1" disabled={!limiterAvailable} value={number(rule.threshold_mbps)} onChange={(e) => updateRule('threshold_mbps', Number(e.target.value))}/></label></div><div className="field-row"><label><span>持续秒数</span><input type="number" min="1" disabled={!limiterAvailable} value={number(rule.sustained_seconds, 60)} onChange={(e) => updateRule('sustained_seconds', Number(e.target.value))}/></label><label><span>限速后 Mbps</span><input type="number" min="0" step="0.1" disabled={!limiterAvailable} value={number(rule.limit_mbps)} onChange={(e) => updateRule('limit_mbps', Number(e.target.value))}/></label></div>{text(rule.type) === 'burst' && <div className="field-row"><label><span>统计窗口秒数</span><input type="number" min="1" disabled={!limiterAvailable} value={number(rule.window_seconds, 300)} onChange={(e) => updateRule('window_seconds', Number(e.target.value))}/></label><label><span>触发次数</span><input type="number" min="1" disabled={!limiterAvailable} value={number(rule.burst_count, 3)} onChange={(e) => updateRule('burst_count', Number(e.target.value))}/></label></div>}</section> })}</div>}
    <Feedback message={error} error/><div className="modal-actions"><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button type="submit" disabled={busy || limiterBlocked}>{busy ? '保存中…' : '保存套餐'}</Button></div>
  </form></Modal>
}

export function SubscriptionsOperationsPage() {
  const [items, setItems] = useState<AnyRecord[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState('')
  const load = useCallback(async () => { setLoading(true); setError(''); try { setItems(listFrom(await api('/api/subscriptions'), ['subscriptions', 'files'])) } catch (reason) { setError(messageOf(reason)) } finally { setLoading(false) } }, [])
  useEffect(() => { void load() }, [load])
  const copy = async (url: string) => { await clipboard(new URL(url, window.location.origin).toString()) }
  return <><Header title="订阅链接" description="复制、打开或下载当前账号可用的订阅" actions={<Button variant="secondary" icon="refresh" onClick={() => void load()}>刷新订阅</Button>}/><Feedback message={error} error/><Card className="table-card">{loading ? <Spinner/> : items.length ? <div className="subscription-list">{items.map((item, index) => { const url = text(item.url || item.subscribe_url || item.path); return <div key={text(item.id, String(index))}><span className="subscription-icon"><Icon name="link"/></span><div><strong>{text(item.name || item.username, '订阅链接')}</strong><small className="mono">{url || '尚未生成地址'}</small></div><div className="row-actions">{url && <><Button variant="secondary" icon="copy" onClick={() => void copy(url)}>复制</Button><Button variant="ghost" onClick={() => window.open(new URL(url, window.location.origin).toString(), '_blank', 'noopener,noreferrer')}>打开</Button><a className="btn ghost" href={url} download>下载</a></>}</div></div> })}</div> : <Empty icon="link" title="暂无可用订阅" text="请先创建用户、套餐或订阅文件。"/>}</Card></>
}

export function GeneratorOperationsPage() {
  const [nodes, setNodes] = useState<Node[]>([]); const [selected, setSelected] = useState<number[]>([]); const [expires, setExpires] = useState(600); const [maxAccess, setMaxAccess] = useState(10); const [result, setResult] = useState<AnyRecord | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  useEffect(() => { api('/api/admin/nodes').then((value) => { const list = listFrom<Node>(value, ['nodes']).filter((node) => node.clash_config); setNodes(list); setSelected(list.map((node) => node.id)) }).catch((reason) => setError(messageOf(reason))) }, [])
  const generate = async () => {
    setBusy(true); setError('')
    try {
      const proxies = nodes.filter((node) => selected.includes(node.id)).map((node) => { try { return JSON.parse(text(node.clash_config)) } catch { return null } }).filter(Boolean)
      if (!proxies.length) throw new Error('请至少选择一个带 Clash 配置的节点')
      setResult(await api<AnyRecord>('/api/admin/temp-subscription', { method: 'POST', body: JSON.stringify({ proxies, max_access: maxAccess, expire_seconds: expires }) }))
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) }
  }
  const absolute = result?.url ? new URL(text(result.url), window.location.origin).toString() : ''
  return <><Header title="订阅链接生成器" description="选择节点生成有访问次数和有效期限制的临时订阅"/><div className="two-column"><Card><div className="card-head"><div><h2>生成配置</h2><p>临时订阅不会修改用户或套餐数据</p></div></div><div className="stack-form"><div className="field-row"><label><span>有效期</span><select value={expires} onChange={(e) => setExpires(Number(e.target.value))}><option value={60}>1 分钟</option><option value={600}>10 分钟</option><option value={1800}>30 分钟</option><option value={3600}>1 小时</option></select></label><label><span>最大访问次数</span><input type="number" min="1" max="100" value={maxAccess} onChange={(e) => setMaxAccess(Number(e.target.value))}/></label></div><fieldset className="checkbox-field"><legend>选择节点</legend><div className="checkbox-list tall">{nodes.map((node) => <label key={node.id}><input type="checkbox" checked={selected.includes(node.id)} onChange={(e) => setSelected((old) => e.target.checked ? [...old, node.id] : old.filter((id) => id !== node.id))}/><span>{nodeName(node)} <small>{protocolLabel(node)}</small></span></label>)}</div></fieldset><div className="form-note">生成内容只来自当前五种受支持协议；有效期最长 1 小时，访问次数最多 100 次。</div><Feedback message={error} error/><Button icon="spark" disabled={busy || !selected.length} onClick={() => void generate()}>{busy ? '生成中…' : '生成临时订阅'}</Button></div></Card><Card><div className="card-head"><div><h2>生成结果</h2><p>复制链接或直接下载</p></div></div>{result ? <div className="generated-result"><span className="subscription-icon"><Icon name="link"/></span><code>{absolute}</code><p>到期：{text(result.expire_at)} · 可访问 {text(result.max_access)} 次</p><div className="action-strip"><Button variant="secondary" icon="copy" onClick={() => void clipboard(absolute)}>复制链接</Button><a className="btn primary" href={absolute} download>下载订阅</a></div></div> : <Empty icon="spark" title="等待生成" text="选择节点并点击生成临时订阅。"/>}</Card></div></>
}

type LibraryKind = 'templates' | 'subscribe-files' | 'custom-rules'
const libraryInfo: Record<LibraryKind, { title: string; description: string; action: string }> = {
  templates: { title: '模板管理', description: '管理订阅转换模板并进行在线转换', action: '新建模板' },
  'subscribe-files': { title: '订阅管理', description: '管理本地订阅文件、节点选择与短链接', action: '添加订阅' },
  'custom-rules': { title: '覆写管理', description: '管理 DNS、规则、规则集和 JavaScript 脚本', action: '新建覆写' },
}

export function AdvancedLibraryPage({ kind, enableScripts = true, isAdmin = false, currentUsername = '' }: { kind: LibraryKind; enableScripts?: boolean; isAdmin?: boolean; currentUsername?: string }) {
  if (kind === 'templates') return <TemplatesPage isAdmin={isAdmin} currentUsername={currentUsername}/>
  if (kind === 'subscribe-files') return <SubscribeFilesPage isAdmin={isAdmin}/>
  return <OverridesPage enableScripts={enableScripts}/>
}

function TemplatesPage({ isAdmin, currentUsername }: { isAdmin: boolean; currentUsername: string }) {
  const [section, setSection] = useState<'sources' | 'files'>('files'); const [items, setItems] = useState<AnyRecord[]>([]); const [editing, setEditing] = useState<AnyRecord | 'new' | null>(null); const [loading, setLoading] = useState(true); const [feedback, setFeedback] = useState({ message: '', error: false })
  const load = useCallback(async () => { setLoading(true); try { setItems(listFrom(await api('/api/admin/templates'), ['templates', 'items'])) } catch (reason) { setFeedback({ message: messageOf(reason), error: true }) } finally { setLoading(false) } }, [])
  useEffect(() => { void load() }, [load])
  const remove = async (item: AnyRecord) => { if (!window.confirm(`删除模板“${text(item.name)}”？`)) return; try { await api(`/api/admin/templates/${item.id}`, { method: 'DELETE' }); setFeedback({ message: '模板已删除。', error: false }); await load() } catch (reason) { setFeedback({ message: messageOf(reason), error: true }) } }
  return <><Header {...libraryInfo.templates} actions={section === 'sources' ? <Button icon="plus" onClick={() => setEditing('new')}>新建在线源</Button> : undefined}/><div className="tabs log-tabs"><button className={section === 'files' ? 'active' : ''} onClick={() => setSection('files')}>模板文件与 V3</button><button className={section === 'sources' ? 'active' : ''} onClick={() => setSection('sources')}>在线源模板</button></div>{section === 'files' ? <RuleTemplatesPanel isAdmin={isAdmin} currentUsername={currentUsername}/> : <><Feedback {...feedback}/><Card className="table-card">{loading ? <Spinner/> : items.length ? <div className="library-grid">{items.map((item) => { const canManage = isAdmin || text(item.created_by) === currentUsername; return <article key={text(item.id)}><span><Icon name="file"/></span><div><strong>{text(item.name)}</strong><small>{text(item.category, 'Clash')} · {item.use_proxy ? '通过代理获取' : '直连获取'} · {canManage ? '可管理' : '共享只读'}</small></div>{canManage && <div className="row-actions"><Button variant="ghost" onClick={() => setEditing(item)}>编辑</Button><Button variant="danger" onClick={() => void remove(item)}>删除</Button></div>}</article> })}</div> : <Empty title="暂无在线源模板" text="在线源模板用于从远程地址转换规则；本地 V3 文件请切换到另一页签。"/>}</Card>{editing && <TemplateEditor item={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setFeedback({ message: '模板已保存。', error: false }); void load() }}/>}</>}</>
}

function TemplateEditor({ item, onClose, onSaved }: { item?: AnyRecord; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: text(item?.name), category: text(item?.category, 'clash'), template_url: text(item?.template_url), rule_source: text(item?.rule_source), use_proxy: bool(item?.use_proxy), enable_include_all: bool(item?.enable_include_all) }); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [preview, setPreview] = useState('')
  const save = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { await api(item ? `/api/admin/templates/${item.id}` : '/api/admin/templates', { method: item ? 'PUT' : 'POST', body: JSON.stringify(form) }); onSaved() } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) } }
  const convert = async () => { setBusy(true); setError(''); try { const value = await api<AnyRecord>('/api/admin/templates/convert', { method: 'POST', body: JSON.stringify(form) }); setPreview(text(value.content)) } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) } }
  return <Modal title={item ? `编辑模板 · ${text(item.name)}` : '新建模板'} onClose={onClose} wide><form className="modal-form" onSubmit={save}><div className="field-row"><label><span>名称</span><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}/></label><label><span>类别</span><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}><option value="clash">Clash / Mihomo</option><option value="surge">Surge</option></select></label></div><label><span>模板 URL</span><input type="url" required value={form.template_url} onChange={(e) => setForm({ ...form, template_url: e.target.value })}/></label><label><span>规则来源</span><textarea className="code-editor" rows={6} value={form.rule_source} onChange={(e) => setForm({ ...form, rule_source: e.target.value })}/></label><div className="inline-options"><label><input type="checkbox" checked={form.use_proxy} onChange={(e) => setForm({ ...form, use_proxy: e.target.checked })}/> 通过代理获取</label><label><input type="checkbox" checked={form.enable_include_all} onChange={(e) => setForm({ ...form, enable_include_all: e.target.checked })}/> 包含全部代理</label></div>{preview && <textarea className="code-editor" rows={8} readOnly value={preview}/>}<Feedback message={error} error/><div className="modal-actions"><Button type="button" variant="ghost" disabled={busy} onClick={() => void convert()}>转换预览</Button><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button type="submit" disabled={busy}>{busy ? '处理中…' : '保存模板'}</Button></div></form></Modal>
}

function SubscribeFilesPage({ isAdmin }: { isAdmin: boolean }) {
  const [items, setItems] = useState<AnyRecord[]>([]); const [nodes, setNodes] = useState<Node[]>([]); const [templates, setTemplates] = useState<string[]>([]); const [editing, setEditing] = useState<AnyRecord | 'new' | null>(null); const [loading, setLoading] = useState(true); const [feedback, setFeedback] = useState({ message: '', error: false })
  const load = useCallback(async () => { setLoading(true); const [a, b, c] = await Promise.allSettled([api('/api/admin/subscribe-files'), api('/api/admin/nodes'), loadRuleTemplateCatalog()]); const errors: string[] = []; if (a.status === 'fulfilled') setItems(listFrom(a.value, ['files', 'subscriptions', 'items'])); else errors.push(messageOf(a.reason)); if (b.status === 'fulfilled') setNodes(listFrom(b.value, ['nodes'])); else errors.push(messageOf(b.reason)); if (c.status === 'fulfilled') setTemplates(c.value.templates); else errors.push(`模板目录：${messageOf(c.reason)}`); if (errors.length) setFeedback({ message: errors.join('；'), error: true }); setLoading(false) }, [])
  useEffect(() => { void load() }, [load])
  const remove = async (item: AnyRecord) => { if (!window.confirm(`删除订阅“${text(item.name)}”？`)) return; try { await api(`/api/admin/subscribe-files/${item.id}`, { method: 'DELETE' }); setFeedback({ message: '订阅已删除。', error: false }); await load() } catch (reason) { setFeedback({ message: messageOf(reason), error: true }) } }
  return <><Header {...libraryInfo['subscribe-files']} actions={<Button icon="plus" onClick={() => setEditing('new')}>添加订阅</Button>}/><Feedback {...feedback}/><Card className="table-card">{loading ? <Spinner/> : items.length ? <div className="library-grid">{items.map((item) => <article key={text(item.id)}><span><Icon name="link"/></span><div><strong>{text(item.name)}</strong><small>{text(item.type, 'local')} · /{text(item.custom_short_code || item.file_short_code)}{item.template_filename ? ` · ${text(item.template_filename)}` : ''}</small></div><div className="row-actions"><Button variant="ghost" onClick={() => setEditing(item)}>管理</Button><Button variant="danger" onClick={() => void remove(item)}>删除</Button></div></article>)}</div> : <Empty icon="link" title="暂无订阅" text="添加订阅文件并选择要输出的节点。"/>}</Card>{editing && <SubscribeFileEditor item={editing === 'new' ? undefined : editing} nodes={nodes} templates={templates} isAdmin={isAdmin} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setFeedback({ message: '订阅已保存。', error: false }); void load() }}/>}</>
}

const subscribeTypeLabels: Record<string, string> = { create: '本地节点生成', import: '远程 URL 导入', upload: '上传 YAML 文件', package: '套餐自动生成' }

function localSubscribeContent(nodes: Node[], selected: number[]) {
  const proxies = nodes.filter((node) => selected.includes(node.id)).map((node) => {
    const raw = node.clash_config
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as AnyRecord
    try {
      const parsed = JSON.parse(text(raw)) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as AnyRecord
    } catch { /* reported below with the node name */ }
    throw new Error(`节点“${nodeName(node)}”没有可用的 Clash 配置`)
  })
  if (!proxies.length) throw new Error('本地生成至少需要选择一个节点')
  const names = proxies.map((proxy, index) => text(proxy.name, `节点 ${index + 1}`))
  return JSON.stringify({
    'mixed-port': 7890,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'info',
    proxies,
    'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: names }],
    rules: ['MATCH,PROXY'],
  }, null, 2)
}

function SubscribeFileEditor({ item, nodes, templates, isAdmin, onClose, onSaved }: { item?: AnyRecord; nodes: Node[]; templates: string[]; isAdmin: boolean; onClose: () => void; onSaved: () => void }) {
  const itemType = text(item?.type)
  const initialType = itemType === 'create' || itemType === 'import' || itemType === 'upload' || itemType === 'package' ? itemType : itemType === 'external' ? 'import' : 'create'
  const [form, setForm] = useState({ name: text(item?.name), description: text(item?.description), type: initialType, url: text(item?.url), filename: text(item?.filename), custom_short_code: text(item?.custom_short_code), raw_output: bool(item?.raw_output), template_filename: text(item?.template_filename) })
  const [selected, setSelected] = useState<number[]>(Array.isArray(item?.selected_node_ids) ? item!.selected_node_ids.map(Number) : [])
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    let createdID = 0
    try {
      const preserved = item ? { selected_tags: item.selected_tags, selected_custom_rule_ids: item.selected_custom_rule_ids, selected_override_script_ids: item.selected_override_script_ids, stats_server_ids: item.stats_server_ids, auto_sync_custom_rules: item.auto_sync_custom_rules, sort_order: item.sort_order, traffic_limit: item.traffic_limit } : { selected_tags: [], selected_custom_rule_ids: [], selected_override_script_ids: [], stats_server_ids: '' }
      if (item) {
        const payload: AnyRecord = { ...preserved, ...form, selected_node_ids: selected }
        if (!isAdmin) delete payload.custom_short_code
        await api(`/api/admin/subscribe-files/${item.id}`, { method: 'PUT', body: JSON.stringify(payload) })
        onSaved(); return
      }

      let created: AnyRecord
      if (form.type === 'import') {
        created = await api<AnyRecord>('/api/admin/subscribe-files/import', { method: 'POST', body: JSON.stringify({ name: form.name, description: form.description, url: form.url, filename: form.filename }) })
      } else if (form.type === 'upload') {
        if (!uploadFile) throw new Error('请选择要上传的 YAML 文件')
        const body = new FormData()
        body.append('file', uploadFile)
        body.append('name', form.name)
        body.append('description', form.description)
        body.append('filename', form.filename || uploadFile.name)
        created = await api<AnyRecord>('/api/admin/subscribe-files/upload', { method: 'POST', body })
      } else {
        created = await api<AnyRecord>('/api/admin/subscribe-files/create-from-config', { method: 'POST', body: JSON.stringify({ name: form.name, description: form.description, filename: form.filename, content: localSubscribeContent(nodes, selected) }) })
      }

      const createdFile = created.file as AnyRecord | undefined
      createdID = number(createdFile?.id)
      if (!createdID) throw new Error('订阅已经生成，但后端未返回可继续配置的 ID')
      const payload: AnyRecord = {
        ...preserved,
        name: form.name,
        description: form.description,
        type: text(createdFile?.type, form.type),
        url: text(createdFile?.url, form.url),
        filename: text(createdFile?.filename, form.filename),
        template_filename: form.template_filename,
        raw_output: form.raw_output,
        selected_node_ids: selected,
      }
      if (isAdmin) payload.custom_short_code = form.custom_short_code
      await api(`/api/admin/subscribe-files/${createdID}`, { method: 'PUT', body: JSON.stringify(payload) })
      createdID = 0
      onSaved()
    } catch (reason) {
      if (createdID) await api(`/api/admin/subscribe-files/${createdID}`, { method: 'DELETE' }).catch(() => undefined)
      setError(messageOf(reason))
    } finally { setBusy(false) }
  }
  const needsNodes = !item && form.type === 'create'
  return <Modal title={item ? `管理订阅 · ${text(item.name)}` : '添加订阅'} onClose={onClose} wide><form className="modal-form" onSubmit={submit}><div className="field-row"><label><span>名称</span><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}/></label><label><span>类型</span>{item ? <input disabled value={subscribeTypeLabels[form.type] ?? form.type}/> : <select value={form.type} onChange={(e) => { setForm({ ...form, type: e.target.value }); setError('') }}><option value="create">本地节点生成</option><option value="import">远程 URL 导入</option><option value="upload">上传 YAML 文件</option></select>}</label></div><label><span>说明</span><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}/></label>{form.type === 'import' && <label><span>远程订阅 URL</span><input type="url" required value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/subscription"/></label>}{!item && form.type === 'upload' && <label><span>YAML 文件</span><input type="file" required accept=".yaml,.yml,application/yaml,text/yaml" onChange={(e) => { const file = e.target.files?.[0] ?? null; setUploadFile(file); if (file && !form.filename) setForm((old) => ({ ...old, filename: file.name })) }}/></label>}<div className="field-row"><label><span>文件名</span><input required value={form.filename} onChange={(e) => setForm({ ...form, filename: e.target.value })} placeholder="例如 main.yaml"/></label>{isAdmin ? <label><span>自定义短码</span><input value={form.custom_short_code} onChange={(e) => setForm({ ...form, custom_short_code: e.target.value })}/></label> : item ? <label><span>短码（仅管理员可改）</span><input disabled value={form.custom_short_code || text(item.file_short_code)}/></label> : null}</div><label><span>Template V3 文件</span><select value={form.template_filename} onChange={(e) => setForm({ ...form, template_filename: e.target.value })}><option value="">跟随个人、套餐或系统默认模板</option>{form.template_filename && !templates.includes(form.template_filename) && <option value={form.template_filename}>{form.template_filename}（当前已不可见，可清除）</option>}{templates.map((filename) => <option key={filename} value={filename}>{filename}</option>)}</select></label><div className="form-note">{!item && form.type === 'create' ? '本地生成会把所选节点写入一份可直接使用的 Clash / Mihomo 配置。' : !item && form.type === 'import' ? '主控会安全抓取并校验远程 YAML，再保存为本地订阅文件。' : !item && form.type === 'upload' ? '上传内容会先通过 YAML 校验，再保存到订阅目录。' : '列表只包含当前账户可见的模板；保存时后端会再次校验归属与公开范围。'}</div><fieldset className="checkbox-field"><legend>{needsNodes ? '生成配置所需节点' : '关联节点'}</legend><div className="checkbox-list tall">{nodes.map((node) => <label key={node.id}><input type="checkbox" checked={selected.includes(node.id)} onChange={(e) => setSelected((old) => e.target.checked ? [...old, node.id] : old.filter((id) => id !== node.id))}/><span>{nodeName(node)}</span></label>)}</div></fieldset><div className="inline-options"><label><input type="checkbox" checked={form.raw_output} onChange={(e) => setForm({ ...form, raw_output: e.target.checked })}/> 原始输出</label></div><Feedback message={error} error/><div className="modal-actions"><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button type="submit" disabled={busy || (needsNodes && !selected.length) || (!item && form.type === 'upload' && !uploadFile)}>{busy ? '保存中…' : '保存订阅'}</Button></div></form></Modal>
}

function OverridesPage({ enableScripts }: { enableScripts: boolean }) {
  const [tab, setTab] = useState<'rules' | 'scripts'>('rules'); const [rules, setRules] = useState<AnyRecord[]>([]); const [scripts, setScripts] = useState<AnyRecord[]>([]); const [editing, setEditing] = useState<AnyRecord | 'new' | null>(null); const [loading, setLoading] = useState(true); const [feedback, setFeedback] = useState({ message: '', error: false })
  const load = useCallback(async () => { setLoading(true); const [a, b] = await Promise.allSettled([api('/api/admin/custom-rules'), enableScripts ? api('/api/admin/override-scripts') : Promise.resolve({ scripts: [] })]); if (a.status === 'fulfilled') setRules(listFrom(a.value, ['rules', 'items'])); if (b.status === 'fulfilled') setScripts(listFrom(b.value, ['scripts', 'items'])); if (a.status === 'rejected' && b.status === 'rejected') setFeedback({ message: messageOf(a.reason), error: true }); setLoading(false) }, [enableScripts])
  useEffect(() => { void load() }, [load])
  const items = tab === 'rules' ? rules : scripts
  const remove = async (item: AnyRecord) => { if (!window.confirm(`删除“${text(item.name)}”？`)) return; const base = tab === 'rules' ? '/api/admin/custom-rules' : '/api/admin/override-scripts'; try { await api(`${base}/${item.id}`, { method: 'DELETE' }); setFeedback({ message: '覆写已删除。', error: false }); await load() } catch (reason) { setFeedback({ message: messageOf(reason), error: true }) } }
  return <><Header {...libraryInfo['custom-rules']} actions={<Button icon="plus" onClick={() => setEditing('new')}>{tab === 'rules' ? '新建规则覆写' : '新建脚本'}</Button>}/><Feedback {...feedback}/><Card className="table-card"><div className="tabs log-tabs"><button className={tab === 'rules' ? 'active' : ''} onClick={() => { setTab('rules'); setEditing(null) }}>规则覆写 {rules.length}</button>{enableScripts && <button className={tab === 'scripts' ? 'active' : ''} onClick={() => { setTab('scripts'); setEditing(null) }}>脚本覆写 {scripts.length}</button>}</div>{loading ? <Spinner/> : items.length ? <div className="library-grid">{items.map((item) => <article key={text(item.id)}><span><Icon name="settings"/></span><div><strong>{text(item.name)}</strong><small>{text(item.type || item.hook)} · {item.enabled === false ? '停用' : '启用'}</small></div><div className="row-actions"><Button variant="ghost" onClick={() => setEditing(item)}>编辑</Button><Button variant="danger" onClick={() => void remove(item)}>删除</Button></div></article>)}</div> : <Empty title="暂无覆写" text={enableScripts ? '创建规则、DNS、规则集或 JavaScript 脚本覆写。' : '创建规则、DNS 或规则集覆写。'}/>}</Card>{editing && (tab === 'rules' ? <RuleEditor item={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setFeedback({ message: '规则覆写已保存。', error: false }); void load() }}/> : enableScripts ? <ScriptEditor item={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setFeedback({ message: '脚本覆写已保存。', error: false }); void load() }}/> : null)}</>
}

function RuleEditor({ item, onClose, onSaved }: { item?: AnyRecord; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: text(item?.name), type: text(item?.type, 'rules'), mode: text(item?.mode, 'append'), content: text(item?.content), enabled: bool(item?.enabled, true) }); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { await api(item ? `/api/admin/custom-rules/${item.id}` : '/api/admin/custom-rules', { method: item ? 'PUT' : 'POST', body: JSON.stringify(form) }); onSaved() } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) } }
  return <Modal title={item ? `编辑规则 · ${text(item.name)}` : '新建规则覆写'} onClose={onClose} wide><form className="modal-form" onSubmit={submit}><div className="field-row"><label><span>名称</span><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}/></label><label><span>类型</span><select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option value="dns">DNS</option><option value="rules">规则</option><option value="rule-providers">规则集</option></select></label></div><label><span>合并模式</span><select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}><option value="append">追加</option><option value="prepend">前置</option><option value="replace">替换</option></select></label><label><span>YAML 内容</span><textarea className="code-editor" rows={14} required value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })}/></label><label className="inline-check"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })}/> 启用</label><Feedback message={error} error/><div className="modal-actions"><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button type="submit" disabled={busy}>{busy ? '保存中…' : '保存覆写'}</Button></div></form></Modal>
}

function ScriptEditor({ item, onClose, onSaved }: { item?: AnyRecord; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: text(item?.name), hook: text(item?.hook, 'post_fetch'), content: text(item?.content, 'function main(config) {\n  return config\n}'), enabled: bool(item?.enabled, true), sort_order: number(item?.sort_order) }); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { await api(item ? `/api/admin/override-scripts/${item.id}` : '/api/admin/override-scripts', { method: item ? 'PUT' : 'POST', body: JSON.stringify(form) }); onSaved() } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) } }
  return <Modal title={item ? `编辑脚本 · ${text(item.name)}` : '新建脚本覆写'} onClose={onClose} wide><form className="modal-form" onSubmit={submit}><div className="field-row"><label><span>名称</span><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}/></label><label><span>执行钩子</span><select value={form.hook} onChange={(e) => setForm({ ...form, hook: e.target.value })}><option value="post_fetch">拉取后</option><option value="pre_save_nodes">节点保存前</option></select></label></div><label><span>JavaScript</span><textarea className="code-editor" rows={16} required value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })}/></label><div className="field-row"><label><span>排序</span><input type="number" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })}/></label><label className="inline-check"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })}/> 启用脚本</label></div><Feedback message={error} error/><div className="modal-actions"><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button type="submit" disabled={busy}>{busy ? '保存中…' : '保存脚本'}</Button></div></form></Modal>
}

export function LogsOperationsPage() {
  const [tab, setTab] = useState<'system' | 'agent' | 'tasks' | 'security'>('system'); const [content, setContent] = useState(''); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [servers, setServers] = useState<Server[]>([]); const [serverID, setServerID] = useState(''); const [service, setService] = useState('agent')
  useEffect(() => { api('/api/admin/remote-servers').then((value) => { const list = listFrom<Server>(value, ['servers']); setServers(list); if (list[0]) setServerID(text(list[0].id)) }).catch(() => undefined) }, [])
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      let value: any
      if (tab === 'system') value = await api('/api/admin/logs/system?lines=1000')
      else if (tab === 'agent') { if (!serverID) throw new Error('请先选择服务器'); value = await api(`/api/admin/logs/agent?server_id=${encodeURIComponent(serverID)}&service=${service}&lines=1000`) }
      else if (tab === 'tasks') value = await api('/api/admin/tasks/runs?limit=100&offset=0')
      else value = await api('/api/admin/security/events?limit=200')
      if (tab === 'system' && Array.isArray(value.rows)) setContent(value.rows.map((row: AnyRecord) => `${text(row.time)} [${text(row.level)}] ${text(row.msg || row.raw)} ${row.fields ? JSON.stringify(row.fields) : ''}`).join('\n'))
      else if (tab === 'agent') setContent(text(value.logs || value.content || value.data, JSON.stringify(value, null, 2)))
      else setContent(JSON.stringify(value.runs || value.events || value, null, 2))
    } catch (reason) { setError(messageOf(reason)); setContent('') } finally { setLoading(false) }
  }, [tab, serverID, service])
  useEffect(() => { void load() }, [load])
  return <><Header title="日志管理" description="查看系统、Agent、计划任务和安全事件" actions={<Button variant="secondary" icon="refresh" onClick={() => void load()}>刷新日志</Button>}/><Feedback message={error} error/><Card className="log-card"><div className="log-toolbar"><div className="tabs log-tabs">{(['system', 'agent', 'tasks', 'security'] as const).map((id) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{({ system: '系统日志', agent: 'Agent 日志', tasks: '计划任务', security: '安全日志' })[id]}</button>)}</div>{tab === 'agent' && <div className="agent-log-selectors"><select value={serverID} onChange={(e) => setServerID(e.target.value)}>{servers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}</select><select value={service} onChange={(e) => setService(e.target.value)}><option value="agent">Agent</option><option value="xray">Xray</option><option value="nginx">Nginx</option></select></div>}</div>{loading ? <Spinner/> : <pre>{content || '当前没有日志记录。'}</pre>}</Card></>
}

type SettingsTab = 'system' | 'subscription' | 'security' | 'appearance'

export function SettingsOperationsPage() {
  const [tab, setTab] = useState<SettingsTab>('system'); const [data, setData] = useState<AnyRecord>({}); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [feedback, setFeedback] = useState({ message: '', error: false })
  const [loaded, setLoaded] = useState(false)
  const tabs: { id: SettingsTab; label: string }[] = [{ id: 'system', label: '系统与 Agent' }, { id: 'subscription', label: '订阅' }, { id: 'security', label: '安全' }, { id: 'appearance', label: '外观' }]
  const load = useCallback(async () => {
    setLoading(true); setLoaded(false); setData({}); setFeedback({ message: '', error: false })
    try {
      if (tab === 'system') {
        const [master, intervals, agent, scripts, silent, encryption] = await Promise.all([api<AnyRecord>('/api/admin/system-settings/master-url'), api<AnyRecord>('/api/admin/system-settings/intervals'), api<AnyRecord>('/api/admin/system-settings/agent-log'), api<AnyRecord>('/api/admin/system-settings/override-scripts'), api<AnyRecord>('/api/admin/system-settings/silent-mode'), api<AnyRecord>('/api/admin/system-settings/require-encryption')])
        setData({ ...master, ...intervals, ...agent, ...scripts, ...silent, ...encryption })
      } else if (tab === 'subscription') setData(await api('/api/admin/system-settings/subscription-output-format'))
      else if (tab === 'security') setData(await api('/api/admin/security-settings'))
      else setData(await api('/api/admin/system-settings/default-theme'))
      setLoaded(true)
    } catch (reason) { setFeedback({ message: messageOf(reason), error: true }) } finally { setLoading(false) }
  }, [tab])
  useEffect(() => { void load() }, [load])
  const set = (key: string, value: unknown) => setData((old) => ({ ...old, [key]: value }))
  const save = async () => {
    if (!loaded) { setFeedback({ message: '设置尚未完整载入，已阻止保存。请刷新后重试。', error: true }); return }
    setBusy(true); setFeedback({ message: '', error: false })
    try {
      if (tab === 'system') {
        // Several of these handlers update the same SystemConfig row from a
        // read-modify-write snapshot. Submit them in order so a slower request
        // cannot overwrite a setting saved by another request.
        await api('/api/admin/system-settings/master-url', { method: 'PUT', body: JSON.stringify({ master_url: text(data.master_url), subscription_url: text(data.subscription_url), local_only: bool(data.local_only) }) })
        await api('/api/admin/system-settings/intervals', { method: 'PUT', body: JSON.stringify({ speed_collect_interval: number(data.speed_collect_interval, 3), traffic_collect_interval: number(data.traffic_collect_interval, 60), traffic_check_interval: number(data.traffic_check_interval, 120), heartbeat_interval: number(data.heartbeat_interval, 30), report_interval: number(data.report_interval, 5) }) })
        await api('/api/admin/system-settings/agent-log', { method: 'PUT', body: JSON.stringify({ agent_log_enabled: bool(data.agent_log_enabled) }) })
        await api('/api/admin/system-settings/override-scripts', { method: 'PUT', body: JSON.stringify({ enable_override_scripts: bool(data.enable_override_scripts) }) })
        await api('/api/admin/system-settings/silent-mode', { method: 'PUT', body: JSON.stringify({ silent_mode: bool(data.silent_mode), silent_mode_timeout: number(data.silent_mode_timeout, 15) }) })
        await api('/api/admin/system-settings/require-encryption', { method: 'PUT', body: JSON.stringify({ require_encryption: bool(data.require_encryption) }) })
      }
      else if (tab === 'subscription') await api('/api/admin/system-settings/subscription-output-format', { method: 'PUT', body: JSON.stringify({ subscription_output_format: text(data.subscription_output_format, 'yaml') }) })
      else if (tab === 'security') await api('/api/admin/security-settings', { method: 'PUT', body: JSON.stringify(data) })
      else await api('/api/admin/system-settings/default-theme', { method: 'PUT', body: JSON.stringify({ default_theme: text(data.default_theme, 'pixel') }) })
      setFeedback({ message: '设置已保存并立即生效。', error: false }); await load()
    } catch (reason) { setFeedback({ message: messageOf(reason), error: true }) } finally { setBusy(false) }
  }
  return <><Header title="系统设置" description="保存面板、Agent、订阅、安全和外观配置"/><div className="settings-layout"><aside className="settings-tabs">{tabs.map((item) => <button key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}</button>)}</aside><Card className="settings-card"><div className="card-head"><div><h2>{tabs.find((item) => item.id === tab)?.label}</h2><p>此页直接读取并写入后端系统设置</p></div></div><Feedback {...feedback}/>{loading ? <Spinner/> : <>{tab === 'system' && <SystemFields data={data} set={set}/>} {tab === 'subscription' && <div className="stack-form"><label><span>订阅序列化格式</span><select value={text(data.subscription_output_format, 'yaml')} onChange={(e) => set('subscription_output_format', e.target.value)}><option value="yaml">YAML</option><option value="json">JSON</option></select></label><div className="form-note">协议白名单由后端固定为五种组合，不提供可绕过的旧协议开关。</div></div>} {tab === 'security' && <SecurityFields data={data} set={set}/>} {tab === 'appearance' && <div className="stack-form"><label><span>新用户默认主题</span><select value={text(data.default_theme, 'pixel')} onChange={(e) => set('default_theme', e.target.value)}><option value="pixel">像素</option><option value="flat">扁平</option><option value="anime">动漫</option></select></label></div>}<div className="settings-actions"><Button disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存设置'}</Button></div></>}</Card></div></>
}

function Toggle({ title, textValue, checked, onChange }: { title: string; textValue: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="setting"><div><strong>{title}</strong><small>{textValue}</small></div><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}/><span className="switch"/></label>
}

function SystemFields({ data, set }: { data: AnyRecord; set: (key: string, value: unknown) => void }) {
  return <div className="stack-form"><div className="field-row"><label><span>主控公网地址</span><input value={text(data.master_url)} onChange={(e) => set('master_url', e.target.value)} placeholder="https://panel.example.com"/></label><label><span>订阅公网地址</span><input value={text(data.subscription_url)} onChange={(e) => set('subscription_url', e.target.value)} placeholder="留空使用主控地址"/></label></div><div className="settings-number-grid">{[
    ['speed_collect_interval', '速度采集（秒）', 3], ['traffic_collect_interval', '流量采集（秒）', 60], ['traffic_check_interval', '流量检查（秒）', 120], ['heartbeat_interval', '心跳（秒）', 30], ['report_interval', '面板刷新（秒）', 5], ['silent_mode_timeout', '静默超时（分钟）', 15],
  ].map(([key, label, fallback]) => <label key={String(key)}><span>{String(label)}</span><input type="number" min="1" value={number(data[String(key)], Number(fallback))} onChange={(e) => set(String(key), Number(e.target.value))}/></label>)}</div><div className="setting-list"><Toggle title="仅本机访问" textValue="限制主控管理入口仅本机可见" checked={bool(data.local_only)} onChange={(value) => set('local_only', value)}/><Toggle title="Agent 日志" textValue="允许在线查看 Agent、Xray 和 Nginx 日志" checked={bool(data.agent_log_enabled)} onChange={(value) => set('agent_log_enabled', value)}/><Toggle title="覆写脚本" textValue="在订阅流水线中执行已启用的脚本" checked={bool(data.enable_override_scripts)} onChange={(value) => set('enable_override_scripts', value)}/><Toggle title="静默模式" textValue="未解锁请求会伪装成 404" checked={bool(data.silent_mode)} onChange={(value) => set('silent_mode', value)}/><Toggle title="强制 Agent 加密通信" textValue="要求 Agent 与主控使用安全通道；不强制浏览器加密" checked={bool(data.require_encryption)} onChange={(value) => set('require_encryption', value)}/></div></div>
}

function SecurityFields({ data, set }: { data: AnyRecord; set: (key: string, value: unknown) => void }) {
  const numeric = [
    ['login_rate_max_attempts', '登录最大尝试', 5], ['login_rate_window_minutes', '登录统计窗口（分钟）', 60], ['login_rate_lock_minutes', '登录锁定（分钟）', 60], ['brute_force_max_failures', '暴力破解阈值', 5], ['brute_force_window_minutes', '暴力破解窗口（分钟）', 1440], ['brute_force_block_minutes', '封禁时间（分钟）', 1440], ['sub_rate_limit', '订阅访问次数', 60], ['sub_rate_window_minutes', '订阅限流窗口（分钟）', 1],
  ]
  return <div className="stack-form"><div className="settings-number-grid">{numeric.map(([key, label, fallback]) => <label key={String(key)}><span>{String(label)}</span><input type="number" min="1" value={number(data[String(key)], Number(fallback))} onChange={(e) => set(String(key), Number(e.target.value))}/></label>)}</div><div className="setting-list"><Toggle title="暴力破解防护" textValue="达到阈值时自动封禁来源 IP" checked={bool(data.brute_force_enabled, true)} onChange={(value) => set('brute_force_enabled', value)}/><Toggle title="订阅限流" textValue="限制单个来源频繁拉取订阅" checked={bool(data.sub_rate_enabled, true)} onChange={(value) => set('sub_rate_enabled', value)}/><Toggle title="拦截未知订阅客户端" textValue="仅允许可识别的代理客户端 UA" checked={bool(data.block_unknown_subscription_ua)} onChange={(value) => set('block_unknown_subscription_ua', value)}/><Toggle title="跳过本地 IP" textValue="避免反代配置不完整时误封全部用户" checked={bool(data.skip_local_ip, true)} onChange={(value) => set('skip_local_ip', value)}/></div><div className="field-row"><label><span>Turnstile Site Key（可选）</span><input value={text(data.turnstile_site_key)} onChange={(e) => set('turnstile_site_key', e.target.value)}/></label><label><span>Turnstile Secret Key（可选）</span><input type="password" value={text(data.turnstile_secret_key)} onChange={(e) => set('turnstile_secret_key', e.target.value)}/></label></div></div>
}
