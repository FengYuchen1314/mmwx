import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { api, asList } from './api'
import './user-services.css'

type TabID = 'subscriptions' | 'external' | 'providers' | 'renewal'
type FeedbackState = { message: string; error: boolean }

type SubscriptionItem = {
  id: number
  name: string
  description?: string
  type?: string
  url?: string
  subscribe_url?: string
  path?: string
  filename?: string
  file_short_code?: string
  custom_short_code?: string
  expire_at?: string | null
  updated_at?: string
  latest_version?: number
}

type ExternalSubscription = {
  id: number
  username?: string
  name: string
  url: string
  user_agent: string
  traffic_mode: 'download' | 'upload' | 'both' | string
  node_count: number
  last_sync_at?: string | null
  upload?: number
  download?: number
  total?: number
  expire?: string | null
  created_at?: string
  updated_at?: string
}

type FilterDraft = {
  filter: string
  exclude_filter: string
  geo_ip_filter: string
}

type SyncCandidate = {
  id: string
  subscription_name?: string
  name: string
  protocol?: string
  server?: string
  port?: string | number
}

type SyncResponse = {
  message?: string
  updated_count?: number
  node_count?: number
  session_id?: string
  new_nodes?: SyncCandidate[]
}

type ProviderConfig = {
  id: number
  username?: string
  external_subscription_id: number
  name: string
  type: string
  interval: number
  proxy: string
  size_limit: number
  header: string
  health_check_enabled: boolean
  health_check_url: string
  health_check_interval: number
  health_check_timeout: number
  health_check_lazy: boolean
  health_check_expected_status: number
  filter: string
  exclude_filter: string
  exclude_type: string
  geo_ip_filter: string
  override: string
  process_mode: string
  created_at?: string
  updated_at?: string
}

type RenewalRequest = {
  id: number
  username?: string
  package_id: number
  package_name: string
  previous_end_date?: string | null
  renew_days: number
  source: string
  status: string
  reviewed_at?: string | null
  new_end_date?: string | null
  error_message?: string
  created_at: string
  updated_at?: string
}

const EMPTY_FEEDBACK: FeedbackState = { message: '', error: false }
const EMPTY_FILTER: FilterDraft = { filter: '', exclude_filter: '', geo_ip_filter: '' }

const TABS: Array<{ id: TabID; label: string; description: string }> = [
  { id: 'subscriptions', label: '我的订阅', description: '已分配给当前账号的订阅入口' },
  { id: 'external', label: '外部订阅', description: '导入、同步并筛选外部节点源' },
  { id: 'providers', label: 'Proxy Provider', description: '维护 Clash proxy-provider 配置' },
  { id: 'renewal', label: '续费申请', description: '提交口令并查看审核历史' },
]

function messageOf(reason: unknown, fallback = '操作失败') {
  return reason instanceof Error ? reason.message : fallback
}

function formatDate(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function formatBytes(value?: number) {
  const bytes = Number(value ?? 0)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 2 : 0)} ${units[index]}`
}

function absoluteURL(value: string) {
  return new URL(value, window.location.origin).toString()
}

function providerYAML(item: ProviderConfig, source: ExternalSubscription, userToken: string) {
  const serverProcessed = item.process_mode === 'mmw'
  const url = serverProcessed
    ? absoluteURL(`/api/proxy-provider/${item.id}?token=${encodeURIComponent(userToken)}`)
    : source.url
  const lines = [
    'proxy-providers:',
    `  ${JSON.stringify(item.name)}:`,
    `    type: ${JSON.stringify(item.type || 'http')}`,
    `    path: ${JSON.stringify(`./proxy_providers/${item.name}.yaml`)}`,
    `    url: ${JSON.stringify(url)}`,
    `    interval: ${Math.max(0, Number(item.interval) || 0)}`,
  ]
  if (item.proxy && item.proxy !== 'DIRECT') lines.push(`    proxy: ${JSON.stringify(item.proxy)}`)
  if (item.size_limit > 0) lines.push(`    size-limit: ${item.size_limit}`)
  if (item.header.trim()) lines.push(`    header: ${JSON.stringify(JSON.parse(item.header))}`)
  if (item.health_check_enabled) {
    lines.push('    health-check:')
    lines.push('      enable: true')
    lines.push(`      url: ${JSON.stringify(item.health_check_url)}`)
    lines.push(`      interval: ${Math.max(0, Number(item.health_check_interval) || 0)}`)
    lines.push(`      timeout: ${Math.max(0, Number(item.health_check_timeout) || 0)}`)
    lines.push(`      lazy: ${item.health_check_lazy ? 'true' : 'false'}`)
    lines.push(`      expected-status: ${Math.max(100, Number(item.health_check_expected_status) || 204)}`)
  }
  // Client mode lets Mihomo apply these fields. In MMW mode the authenticated
  // endpoint has already applied the same rules to the returned proxies list.
  if (!serverProcessed) {
    if (item.filter) lines.push(`    filter: ${JSON.stringify(item.filter)}`)
    if (item.exclude_filter) lines.push(`    exclude-filter: ${JSON.stringify(item.exclude_filter)}`)
    if (item.exclude_type) lines.push(`    exclude-type: ${JSON.stringify(item.exclude_type)}`)
    if (item.override.trim()) lines.push(`    override: ${JSON.stringify(JSON.parse(item.override))}`)
  }
  return `${lines.join('\n')}\n`
}

async function copyText(value: string) {
  await navigator.clipboard.writeText(value)
}

function Button({ children, variant = 'primary', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button type="button" {...props} className={`btn ${variant} ${props.className ?? ''}`.trim()}>{children}</button>
}

function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`pixel-card ${className}`.trim()}>{children}</section>
}

function Feedback({ value }: { value: FeedbackState }) {
  if (!value.message) return null
  return <div className={`notice ${value.error ? 'error' : ''}`} role={value.error ? 'alert' : 'status'}>{value.message}</div>
}

function Loading({ text = '正在加载…' }: { text?: string }) {
  return <div className="loading"><span className="uss-spinner" aria-hidden="true"/>{text}</div>
}

function Empty({ title, description }: { title: string; description: string }) {
  return <div className="empty"><span className="empty-icon" aria-hidden="true">◇</span><strong>{title}</strong><p>{description}</p></div>
}

function Modal({ title, description, onClose, children, wide = false }: { title: string; description?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-head"><div><h2>{title}</h2>{description && <p>{description}</p>}</div><Button variant="ghost" onClick={onClose} aria-label="关闭">×</Button></div>
      {children}
    </div>
  </div>
}

export function UserServicesPage({ isAdmin = false, currentUsername = '' }: { isAdmin?: boolean; currentUsername?: string }) {
  const [tab, setTab] = useState<TabID>('subscriptions')
  const active = TABS.find((item) => item.id === tab) ?? TABS[0]

  return <div className="uss-page">
    <div className="page-header">
      <div><h1>订阅与数据源</h1><p>集中管理订阅入口、外部节点源、Provider 配置和续费申请</p></div>
    </div>
    <div className="uss-tabs" role="tablist" aria-label="订阅与数据源功能">
      {TABS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}><strong>{item.label}</strong><small>{item.description}</small></button>)}
    </div>
    <div role="tabpanel" aria-label={active.label}>
      {tab === 'subscriptions' && <MySubscriptionsTab/>}
      {tab === 'external' && <ExternalSubscriptionsTab isAdmin={isAdmin} currentUsername={currentUsername}/>}
      {tab === 'providers' && <ProviderConfigsTab currentUsername={currentUsername}/>}
      {tab === 'renewal' && <RenewalTab/>}
    </div>
  </div>
}

function MySubscriptionsTab() {
  const [items, setItems] = useState<SubscriptionItem[]>([])
  const [userShortCode, setUserShortCode] = useState('')
  const [loading, setLoading] = useState(true)
  const [feedback, setFeedback] = useState<FeedbackState>(EMPTY_FEEDBACK)

  const load = useCallback(async () => {
    setLoading(true)
    setFeedback(EMPTY_FEEDBACK)
    try {
      const result = await api<unknown>('/api/subscriptions')
      setItems(asList<SubscriptionItem>(result, ['subscriptions']))
      if (result && typeof result === 'object') setUserShortCode(String((result as Record<string, unknown>).user_short_code ?? ''))
    } catch (reason) {
      setFeedback({ message: messageOf(reason, '订阅列表加载失败'), error: true })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const itemURL = (item: SubscriptionItem) => {
    const explicit = item.url || item.subscribe_url || item.path
    if (explicit) return absoluteURL(explicit)
    const fileCode = item.file_short_code || item.custom_short_code || ''
    if (!fileCode) return ''
    return absoluteURL(`/x/${fileCode}${userShortCode}`)
  }

  const copy = async (url: string) => {
    try {
      await copyText(url)
      setFeedback({ message: '订阅地址已复制。', error: false })
    } catch (reason) {
      setFeedback({ message: messageOf(reason, '浏览器未允许写入剪贴板'), error: true })
    }
  }

  return <>
    <div className="uss-section-head"><div><h2>我的订阅</h2><p>普通用户仅看到已分配或自己创建的订阅；管理员按后端规则会看到全部订阅。</p></div><Button variant="secondary" onClick={() => void load()}>刷新</Button></div>
    <Feedback value={feedback}/>
    <Card className="uss-card">
      {loading ? <Loading/> : items.length ? <div className="uss-subscription-list">{items.map((item, index) => {
        const url = itemURL(item)
        return <article key={item.id || index}>
          <span className="uss-source-glyph" aria-hidden="true">↗</span>
          <div className="uss-grow"><div className="uss-title-line"><strong>{item.name || '未命名订阅'}</strong>{item.type && <span className="badge">{item.type}</span>}</div><p>{item.description || item.filename || '当前账号可访问的订阅'}</p>{url ? <code>{url}</code> : <small>后端未返回 URL 或短码，暂时无法构造访问地址。</small>}<div className="uss-meta"><span>到期：{formatDate(item.expire_at)}</span><span>更新：{formatDate(item.updated_at)}</span>{item.latest_version ? <span>版本：{item.latest_version}</span> : null}</div></div>
          <div className="uss-actions">{url ? <><Button variant="secondary" onClick={() => void copy(url)}>复制</Button><Button variant="ghost" onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}>打开</Button></> : <Button variant="ghost" disabled>暂无地址</Button>}</div>
        </article>
      })}</div> : <Empty title="暂无可用订阅" description="分配套餐或订阅文件后，可用入口会显示在这里。"/>}
    </Card>
  </>
}

function ExternalSubscriptionsTab({ isAdmin, currentUsername }: { isAdmin: boolean; currentUsername: string }) {
  const [items, setItems] = useState<ExternalSubscription[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<ExternalSubscription | 'new' | null>(null)
  const [nodes, setNodes] = useState<{ subscription: ExternalSubscription; items: Array<Record<string, unknown>> } | null>(null)
  const [candidateSession, setCandidateSession] = useState<{ sessionID: string; items: SyncCandidate[]; selected: string[] } | null>(null)
  const [busy, setBusy] = useState('')
  const [feedback, setFeedback] = useState<FeedbackState>(EMPTY_FEEDBACK)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api<unknown>('/api/user/external-subscriptions')
      setItems(asList<ExternalSubscription>(result, ['subscriptions', 'items']))
    } catch (reason) {
      setFeedback({ message: messageOf(reason, '外部订阅加载失败'), error: true })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const acceptSync = (result: SyncResponse) => {
    const candidates = Array.isArray(result.new_nodes) ? result.new_nodes.filter((item) => item && typeof item.id === 'string') : []
    if (result.session_id && candidates.length) {
      setCandidateSession({ sessionID: result.session_id, items: candidates, selected: candidates.map((item) => item.id) })
      setFeedback({ message: `同步完成，发现 ${candidates.length} 个新增节点，请确认要保存的候选项。`, error: false })
    } else {
      const count = Number(result.updated_count ?? result.node_count ?? 0)
      setFeedback({ message: result.message ? `${result.message}${count ? `，已更新 ${count} 个节点。` : '。'}` : `同步完成，已更新 ${count} 个节点。`, error: false })
    }
  }

  const sync = async (item?: ExternalSubscription) => {
    const key = item ? `sync-${item.id}` : 'sync-all'
    setBusy(key)
    setFeedback(EMPTY_FEEDBACK)
    try {
      const path = item ? `/api/user/sync-external-subscription?id=${encodeURIComponent(item.id)}` : '/api/user/sync-external-subscriptions'
      acceptSync(await api<SyncResponse>(path, { method: 'POST', body: JSON.stringify({}) }))
      await load()
    } catch (reason) {
      setFeedback({ message: messageOf(reason, '同步失败'), error: true })
    } finally {
      setBusy('')
    }
  }

  const remove = async (item: ExternalSubscription) => {
    if (!window.confirm(`确定删除外部订阅“${item.name}”吗？关联的 Proxy Provider 配置也可能被级联删除。`)) return
    setBusy(`delete-${item.id}`)
    try {
      await api(`/api/user/external-subscriptions?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' })
      setFeedback({ message: '外部订阅已删除。', error: false })
      await load()
    } catch (reason) {
      setFeedback({ message: messageOf(reason, '删除失败'), error: true })
    } finally {
      setBusy('')
    }
  }

  const showNodes = async (item: ExternalSubscription) => {
    setBusy(`nodes-${item.id}`)
    try {
      const result = await api<unknown>(`/api/user/external-subscriptions/nodes?id=${encodeURIComponent(item.id)}`)
      setNodes({ subscription: item, items: asList<Record<string, unknown>>(result, ['nodes', 'node_names']) })
    } catch (reason) {
      setFeedback({ message: messageOf(reason, '节点列表获取失败'), error: true })
    } finally {
      setBusy('')
    }
  }

  const confirmCandidates = async (selected: string[]) => {
    if (!candidateSession) return
    setBusy('confirm-candidates')
    try {
      const result = await api<{ message?: string; created_count?: number }>('/api/user/sync-external-subscriptions/confirm', { method: 'POST', body: JSON.stringify({ session_id: candidateSession.sessionID, candidate_ids: selected }) })
      setCandidateSession(null)
      setFeedback({ message: result.message || `已保存 ${Number(result.created_count ?? 0)} 个新增节点。`, error: false })
      await load()
    } catch (reason) {
      setFeedback({ message: messageOf(reason, '新增节点确认失败'), error: true })
    } finally {
      setBusy('')
    }
  }

  return <>
    <div className="uss-section-head"><div><h2>外部订阅</h2><p>拉取远程订阅、查看节点并按需确认新增节点。{isAdmin ? '批量同步仅处理当前管理员名下记录；其他所有者请逐项同步。' : ''}</p></div><div className="uss-actions"><Button variant="secondary" disabled={Boolean(busy)} title={isAdmin ? `仅同步 ${currentUsername || '当前管理员'} 名下订阅` : undefined} onClick={() => void sync()}>{busy === 'sync-all' ? '同步中…' : isAdmin ? '同步当前账号' : '同步全部'}</Button><Button onClick={() => setEditing('new')}>添加外部订阅</Button></div></div>
    <Feedback value={feedback}/>
    <Card className="uss-card">
      {loading ? <Loading/> : items.length ? <div className="responsive-table"><table><thead><tr><th>订阅</th><th>节点 / 流量</th><th>最近同步</th><th>到期</th><th className="right">操作</th></tr></thead><tbody>{items.map((item) => {
        const used = Number(item.upload ?? 0) + Number(item.download ?? 0)
        return <tr key={item.id}><td><div className="uss-table-title"><strong>{item.name}</strong>{item.username && <small>所有者：{item.username}</small>}<code title={item.url}>{item.url}</code><small>UA：{item.user_agent || '后端默认'} · 流量模式：{item.traffic_mode || 'download'}</small></div></td><td><strong>{item.node_count ?? 0} 个</strong><small className="uss-block">{formatBytes(used)} / {item.total ? formatBytes(item.total) : '未知总量'}</small></td><td>{formatDate(item.last_sync_at)}</td><td>{formatDate(item.expire)}</td><td className="right"><div className="uss-row-actions"><Button variant="ghost" disabled={Boolean(busy)} onClick={() => void showNodes(item)}>{busy === `nodes-${item.id}` ? '获取中…' : '节点'}</Button><Button variant="secondary" disabled={Boolean(busy)} onClick={() => void sync(item)}>{busy === `sync-${item.id}` ? '同步中…' : '同步'}</Button><Button variant="ghost" onClick={() => setEditing(item)}>编辑 / 预检</Button><Button variant="danger" disabled={Boolean(busy)} onClick={() => void remove(item)}>{busy === `delete-${item.id}` ? '删除中…' : '删除'}</Button></div></td></tr>
      })}</tbody></table></div> : <Empty title="暂无外部订阅" description="添加一个 HTTP 或 HTTPS 订阅地址后即可开始同步。"/>}
    </Card>
    {editing && <ExternalSubscriptionEditor item={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={(message) => { setEditing(null); setFeedback({ message, error: false }); void load() }}/>}
    {nodes && <NodeListModal value={nodes} onClose={() => setNodes(null)}/>}
    {candidateSession && <CandidateModal value={candidateSession} busy={busy === 'confirm-candidates'} onChange={(selected) => setCandidateSession({ ...candidateSession, selected })} onConfirm={() => void confirmCandidates(candidateSession.selected)} onDiscard={() => void confirmCandidates([])}/>}
  </>
}

function ExternalSubscriptionEditor({ item, onClose, onSaved }: { item?: ExternalSubscription; onClose: () => void; onSaved: (message: string) => void }) {
  const [form, setForm] = useState({ name: item?.name ?? '', url: item?.url ?? '', user_agent: item?.user_agent ?? '', traffic_mode: item?.traffic_mode || 'download' })
  const [filters, setFilters] = useState<FilterDraft>(EMPTY_FILTER)
  const [filterResult, setFilterResult] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy('save')
    setError('')
    try {
      const path = item ? `/api/user/external-subscriptions?id=${encodeURIComponent(item.id)}` : '/api/user/external-subscriptions'
      await api(path, { method: item ? 'PUT' : 'POST', body: JSON.stringify(form) })
      onSaved(item ? '外部订阅已更新。筛选预检字段不会随订阅保存。' : '外部订阅已创建。现在可以编辑它并检查筛选条件。')
    } catch (reason) {
      setError(messageOf(reason, '保存失败'))
    } finally {
      setBusy('')
    }
  }

  const checkFilters = async () => {
    if (!item) return
    setBusy('filter')
    setError('')
    setFilterResult('')
    try {
      const result = await api<{ has_matches?: boolean; match_count?: number }>('/api/user/external-subscriptions/check-filter', { method: 'POST', body: JSON.stringify({ subscription_id: item.id, ...filters }) })
      setFilterResult(result.has_matches ? `匹配 ${Number(result.match_count ?? 0)} 个节点。` : '当前条件没有匹配节点。')
    } catch (reason) {
      setError(messageOf(reason, '筛选检查失败'))
    } finally {
      setBusy('')
    }
  }

  return <Modal title={item ? `编辑外部订阅 · ${item.name}` : '添加外部订阅'} description="URL 仅允许后端接受的 HTTP / HTTPS 地址" onClose={onClose} wide>
    <form className="modal-form" onSubmit={submit}>
      <div className="field-row"><label><span>名称</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })}/></label><label><span>流量统计方式</span><select value={form.traffic_mode} onChange={(event) => setForm({ ...form, traffic_mode: event.target.value })}><option value="download">仅下载</option><option value="upload">仅上传</option><option value="both">上传 + 下载</option></select></label></div>
      <label><span>订阅 URL</span><input required type="url" value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="https://example.com/subscription"/></label>
      <label><span>User-Agent</span><input value={form.user_agent} onChange={(event) => setForm({ ...form, user_agent: event.target.value })} placeholder="留空时由后端使用默认值"/></label>
      <fieldset className="uss-fieldset"><legend>筛选预检</legend><div className="form-note">后端不会把下面三个字段保存到外部订阅；它们只会提交给 <code>check-filter</code> 检查当前节点的匹配数量。持久化筛选请在 Proxy Provider 配置中设置。</div><div className="field-row"><label><span>包含过滤（filter）</span><input value={filters.filter} onChange={(event) => setFilters({ ...filters, filter: event.target.value })} placeholder="正则表达式或留空"/></label><label><span>排除过滤（exclude_filter）</span><input value={filters.exclude_filter} onChange={(event) => setFilters({ ...filters, exclude_filter: event.target.value })} placeholder="正则表达式或留空"/></label></div><label><span>GeoIP 过滤（geo_ip_filter）</span><input value={filters.geo_ip_filter} onChange={(event) => setFilters({ ...filters, geo_ip_filter: event.target.value })} placeholder="例如 CN,US；具体语法由后端解析"/></label>{item ? <div className="uss-inline-result"><Button variant="secondary" disabled={Boolean(busy)} onClick={() => void checkFilters()}>{busy === 'filter' ? '检查中…' : '检查匹配'}</Button>{filterResult && <span>{filterResult}</span>}</div> : <small className="uss-field-help">请先保存订阅；检查接口需要已有的订阅 ID。</small>}</fieldset>
      {error && <div className="notice error">{error}</div>}
      <div className="modal-actions"><Button variant="secondary" onClick={onClose}>取消</Button><button className="btn primary" type="submit" disabled={Boolean(busy)}>{busy === 'save' ? '保存中…' : '保存订阅'}</button></div>
    </form>
  </Modal>
}

function NodeListModal({ value, onClose }: { value: { subscription: ExternalSubscription; items: Array<Record<string, unknown>> }; onClose: () => void }) {
  return <Modal title={`订阅节点 · ${value.subscription.name}`} description={`后端实时读取该订阅，共 ${value.items.length} 项`} onClose={onClose} wide>
    {value.items.length ? <div className="uss-node-grid">{value.items.map((node, index) => {
      const plainName = typeof node === 'string' ? node : String(node.name ?? node.node_name ?? `节点 ${index + 1}`)
      const detail = typeof node === 'string' ? '' : [node.type ?? node.protocol, node.server, node.port].filter((part) => part !== undefined && part !== '').map(String).join(' · ')
      return <article key={`${plainName}-${index}`}><span>{index + 1}</span><div><strong>{plainName}</strong>{detail && <small>{detail}</small>}</div></article>
    })}</div> : <Empty title="没有读取到节点" description="远程订阅可能为空，或其内容格式不受后端解析器支持。"/>}
    <div className="modal-actions"><Button variant="secondary" onClick={onClose}>关闭</Button></div>
  </Modal>
}

function CandidateModal({ value, busy, onChange, onConfirm, onDiscard }: { value: { sessionID: string; items: SyncCandidate[]; selected: string[] }; busy: boolean; onChange: (selected: string[]) => void; onConfirm: () => void; onDiscard: () => void }) {
  const allSelected = value.items.length > 0 && value.selected.length === value.items.length
  const toggleAll = () => onChange(allSelected ? [] : value.items.map((item) => item.id))
  return <Modal title="确认新增节点" description="同步已更新已有节点；以下候选项只有确认后才会保存。选择会话约 10 分钟后过期。" onClose={onDiscard} wide>
    <div className="uss-candidate-toolbar"><label><input type="checkbox" checked={allSelected} onChange={toggleAll}/> 全选（{value.selected.length}/{value.items.length}）</label></div>
    <div className="uss-candidate-list">{value.items.map((item) => <label key={item.id}><input type="checkbox" checked={value.selected.includes(item.id)} onChange={(event) => onChange(event.target.checked ? [...value.selected, item.id] : value.selected.filter((id) => id !== item.id))}/><span><strong>{item.name}</strong><small>{[item.subscription_name, item.protocol, item.server, item.port].filter((part) => part !== undefined && part !== '').join(' · ')}</small></span></label>)}</div>
    <div className="modal-actions"><Button variant="secondary" disabled={busy} onClick={onDiscard}>不保存候选项</Button><Button disabled={busy} onClick={onConfirm}>{busy ? '保存中…' : `保存选中的 ${value.selected.length} 项`}</Button></div>
  </Modal>
}

function ProviderConfigsTab({ currentUsername }: { currentUsername: string }) {
  const [items, setItems] = useState<ProviderConfig[]>([])
  const [subscriptions, setSubscriptions] = useState<ExternalSubscription[]>([])
  const [userToken, setUserToken] = useState('')
  const [providerEnabled, setProviderEnabled] = useState(false)
  const [editing, setEditing] = useState<ProviderConfig | 'new' | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [feedback, setFeedback] = useState<FeedbackState>(EMPTY_FEEDBACK)

  const load = useCallback(async () => {
    setLoading(true)
    setProviderEnabled(false)
    const [configs, sources, token, preferences] = await Promise.allSettled([api<unknown>('/api/user/proxy-provider-configs'), api<unknown>('/api/user/external-subscriptions'), api<Record<string, unknown>>('/api/user/token'), api<Record<string, unknown>>('/api/user/config')])
    if (configs.status === 'fulfilled') setItems(asList<ProviderConfig>(configs.value, ['configs', 'items']))
    else setFeedback({ message: messageOf(configs.reason, 'Provider 配置加载失败'), error: true })
    if (sources.status === 'fulfilled') setSubscriptions(asList<ExternalSubscription>(sources.value, ['subscriptions', 'items']).filter((source) => !source.username || source.username === currentUsername))
    if (token.status === 'fulfilled') setUserToken(String(token.value.token ?? ''))
    if (preferences.status === 'fulfilled') setProviderEnabled(preferences.value.enable_proxy_provider === true)
    else setFeedback({ message: messageOf(preferences.reason, 'Provider 功能开关读取失败'), error: true })
    setLoading(false)
  }, [currentUsername])

  useEffect(() => { void load() }, [load])

  const remove = async (item: ProviderConfig) => {
    if (!window.confirm(`确定删除 Proxy Provider 配置“${item.name}”吗？`)) return
    setBusy(`delete-${item.id}`)
    try {
      await api(`/api/user/proxy-provider-configs?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' })
      setFeedback({ message: 'Proxy Provider 配置已删除。', error: false })
      await load()
    } catch (reason) {
      setFeedback({ message: messageOf(reason, '删除失败'), error: true })
    } finally {
      setBusy('')
    }
  }

  const sourceName = (id: number) => subscriptions.find((item) => item.id === id)?.name || `外部订阅 #${id}`
  const copyYAML = async (item: ProviderConfig) => {
    if (!providerEnabled) {
      setFeedback({ message: '请先在“账号与安全 → 订阅偏好”中启用 Proxy Provider。', error: true })
      return
    }
    const source = subscriptions.find((candidate) => candidate.id === item.external_subscription_id)
    if (!source || (item.process_mode === 'mmw' && !userToken)) {
      setFeedback({ message: 'Provider 数据源或订阅令牌尚未加载，请刷新后重试。', error: true })
      return
    }
    try {
      await copyText(providerYAML(item, source, userToken))
      setFeedback({ message: '可直接粘贴到 Clash/Mihomo 配置的 Provider YAML 已复制。', error: false })
    } catch (reason) {
      setFeedback({ message: messageOf(reason, '复制 Provider YAML 失败'), error: true })
    }
  }
  const preview = (item: ProviderConfig) => {
    if (!providerEnabled) {
      setFeedback({ message: '请先在“账号与安全 → 订阅偏好”中启用 Proxy Provider。', error: true })
      return
    }
    if (!userToken) {
      setFeedback({ message: '订阅令牌尚未加载，请刷新后重试。', error: true })
      return
    }
    window.open(absoluteURL(`/api/proxy-provider/${item.id}?token=${encodeURIComponent(userToken)}`), '_blank', 'noopener,noreferrer')
  }

  return <>
    <div className="uss-section-head"><div><h2>Proxy Provider 配置</h2><p>这些记录供订阅生成流程使用，并按当前用户名隔离。</p></div><Button disabled={!subscriptions.length || !providerEnabled} onClick={() => setEditing('new')}>添加配置</Button></div>
    <div className="notice">客户端处理会让 Clash/Mihomo 直接拉取外部源；服务端处理会通过带订阅专用令牌的面板地址完成筛选与 Override。复制 YAML 时会自动选择正确地址。</div>
    {!providerEnabled && !loading && <div className="notice error">Proxy Provider 当前被账号级开关关闭。请先到“账号与安全 → 订阅偏好”启用，已有服务端地址也会保持不可访问。</div>}
    {!subscriptions.length && !loading && <div className="notice error">创建 Provider 配置前，请先添加至少一个外部订阅作为数据源。</div>}
    <Feedback value={feedback}/>
    <Card className="uss-card">
      {loading ? <Loading/> : items.length ? <div className="uss-provider-grid">{items.map((item) => <article key={item.id}><div className="uss-provider-head"><div><strong>{item.name}</strong><span className="badge">{item.process_mode === 'mmw' ? '服务端处理' : '客户端处理'}</span></div><small>{sourceName(item.external_subscription_id)}</small></div><dl><div><dt>类型</dt><dd>{item.type || 'http'}</dd></div><div><dt>刷新</dt><dd>{item.interval || 0} 秒</dd></div><div><dt>代理</dt><dd>{item.proxy || 'DIRECT'}</dd></div><div><dt>健康检查</dt><dd>{item.health_check_enabled ? `${item.health_check_interval}s` : '关闭'}</dd></div></dl><div className="uss-filter-summary"><span>包含：{item.filter || '不限'}</span><span>排除：{item.exclude_filter || '无'}</span><span>GeoIP：{item.geo_ip_filter || '不限'}</span></div><div className="uss-actions"><Button variant="ghost" onClick={() => void copyYAML(item)}>复制 YAML</Button>{item.process_mode === 'mmw' && <Button variant="ghost" onClick={() => preview(item)}>预览</Button>}<Button variant="secondary" onClick={() => setEditing(item)}>编辑</Button><Button variant="danger" disabled={Boolean(busy)} onClick={() => void remove(item)}>{busy === `delete-${item.id}` ? '删除中…' : '删除'}</Button></div></article>)}</div> : <Empty title="暂无 Provider 配置" description="选择一个外部订阅，并配置刷新与过滤规则。"/>}
    </Card>
    {editing && <ProviderEditor item={editing === 'new' ? undefined : editing} subscriptions={subscriptions} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setFeedback({ message: 'Proxy Provider 配置已保存。', error: false }); void load() }}/>}
  </>
}

function ProviderEditor({ item, subscriptions, onClose, onSaved }: { item?: ProviderConfig; subscriptions: ExternalSubscription[]; onClose: () => void; onSaved: () => void }) {
  const firstSourceID = subscriptions[0]?.id ?? 0
  const [form, setForm] = useState<ProviderConfig>({
    id: item?.id ?? 0,
    external_subscription_id: item?.external_subscription_id ?? firstSourceID,
    name: item?.name ?? '',
    type: item?.type || 'http',
    interval: item?.interval ?? 3600,
    proxy: item?.proxy || 'DIRECT',
    size_limit: item?.size_limit ?? 0,
    header: item?.header ?? '',
    health_check_enabled: item?.health_check_enabled ?? true,
    health_check_url: item?.health_check_url || 'https://www.gstatic.com/generate_204',
    health_check_interval: item?.health_check_interval ?? 300,
    health_check_timeout: item?.health_check_timeout ?? 5000,
    health_check_lazy: item?.health_check_lazy ?? true,
    health_check_expected_status: item?.health_check_expected_status ?? 204,
    filter: item?.filter ?? '',
    exclude_filter: item?.exclude_filter ?? '',
    exclude_type: item?.exclude_type ?? '',
    geo_ip_filter: item?.geo_ip_filter ?? '',
    override: item?.override ?? '',
    process_mode: item?.process_mode || 'client',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = <K extends keyof ProviderConfig>(key: K, value: ProviderConfig[K]) => setForm((old) => ({ ...old, [key]: value }))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (!form.external_subscription_id) throw new Error('请选择外部订阅数据源')
      if (!['client', 'mmw'].includes(form.process_mode)) throw new Error('处理模式无效')
      if (form.filter) new RegExp(form.filter)
      if (form.exclude_filter) new RegExp(form.exclude_filter)
      for (const [label, raw] of [['Header', form.header], ['Override', form.override]] as const) {
        if (!raw.trim()) continue
        const parsed = JSON.parse(raw)
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(`${label} 必须是 JSON 对象`)
      }
      const path = item ? `/api/user/proxy-provider-configs?id=${encodeURIComponent(item.id)}` : '/api/user/proxy-provider-configs'
      await api(path, { method: item ? 'PUT' : 'POST', body: JSON.stringify(form) })
      onSaved()
    } catch (reason) {
      setError(messageOf(reason, '保存失败'))
    } finally {
      setBusy(false)
    }
  }

  return <Modal title={item ? `编辑 Provider · ${item.name}` : '添加 Proxy Provider'} description={item ? '后端不允许在更新时更换关联的外部订阅。' : '创建后记录仅属于当前账号。'} onClose={onClose} wide>
    <form className="modal-form" onSubmit={submit}>
      <div className="field-row"><label><span>名称</span><input required value={form.name} onChange={(event) => set('name', event.target.value)}/></label><label><span>外部订阅</span><select disabled={Boolean(item)} value={form.external_subscription_id} onChange={(event) => set('external_subscription_id', Number(event.target.value))}>{subscriptions.map((source) => <option key={source.id} value={source.id}>{source.name}{source.username ? ` · ${source.username}` : ''}</option>)}</select></label></div>
      <div className="uss-three-fields"><label><span>类型</span><select value={form.type} onChange={(event) => set('type', event.target.value)}><option value="http">http</option></select></label><label><span>处理模式</span><select value={form.process_mode} onChange={(event) => set('process_mode', event.target.value)}><option value="client">客户端直连外部源</option><option value="mmw">服务端筛选后输出</option></select></label><label><span>刷新间隔（秒）</span><input type="number" min="0" value={form.interval} onChange={(event) => set('interval', Number(event.target.value))}/></label></div>
      <div className="uss-three-fields"><label><span>请求代理</span><input value={form.proxy} onChange={(event) => set('proxy', event.target.value)} placeholder="DIRECT"/></label><label><span>大小限制</span><input type="number" min="0" value={form.size_limit} onChange={(event) => set('size_limit', Number(event.target.value))}/></label><label><span>排除类型</span><input value={form.exclude_type} onChange={(event) => set('exclude_type', event.target.value)}/></label></div>
      <div className="field-row"><label><span>包含过滤</span><input value={form.filter} onChange={(event) => set('filter', event.target.value)}/></label><label><span>排除过滤</span><input value={form.exclude_filter} onChange={(event) => set('exclude_filter', event.target.value)}/></label></div>
      <label><span>GeoIP 过滤</span><input value={form.geo_ip_filter} onChange={(event) => set('geo_ip_filter', event.target.value)}/></label>
      <fieldset className="uss-fieldset"><legend>健康检查</legend><div className="uss-check-row"><label><input type="checkbox" checked={form.health_check_enabled} onChange={(event) => set('health_check_enabled', event.target.checked)}/> 启用健康检查</label><label><input type="checkbox" checked={form.health_check_lazy} onChange={(event) => set('health_check_lazy', event.target.checked)}/> Lazy 模式</label></div><label><span>检查 URL</span><input type="url" value={form.health_check_url} onChange={(event) => set('health_check_url', event.target.value)}/></label><div className="uss-three-fields"><label><span>间隔（秒）</span><input type="number" min="0" value={form.health_check_interval} onChange={(event) => set('health_check_interval', Number(event.target.value))}/></label><label><span>超时（毫秒）</span><input type="number" min="0" value={form.health_check_timeout} onChange={(event) => set('health_check_timeout', Number(event.target.value))}/></label><label><span>预期状态码</span><input type="number" min="100" max="599" value={form.health_check_expected_status} onChange={(event) => set('health_check_expected_status', Number(event.target.value))}/></label></div></fieldset>
      <div className="field-row"><label><span>Header（JSON 对象）</span><textarea rows={4} value={form.header} onChange={(event) => set('header', event.target.value)} placeholder={'{"User-Agent":["Clash/v1.18.0"]}'}/></label><label><span>Override（JSON 对象）</span><textarea rows={4} value={form.override} onChange={(event) => set('override', event.target.value)} placeholder={'{"udp":true}'}/></label></div>
      {error && <div className="notice error">{error}</div>}
      <div className="modal-actions"><Button variant="secondary" onClick={onClose}>取消</Button><button className="btn primary" type="submit" disabled={busy}>{busy ? '保存中…' : '保存配置'}</button></div>
    </form>
  </Modal>
}

function RenewalTab() {
  const [requests, setRequests] = useState<RenewalRequest[]>([])
  const [passphrase, setPassphrase] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<FeedbackState>(EMPTY_FEEDBACK)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api<unknown>('/api/user/renewal-request')
      setRequests(asList<RenewalRequest>(result, ['requests']))
    } catch (reason) {
      setFeedback({ message: messageOf(reason, '续费历史加载失败'), error: true })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = passphrase.trim()
    if (!value || Array.from(value).length > 256 || /[\r\n]/.test(value)) {
      setFeedback({ message: '口令须为 1–256 个字符，且不能包含换行。', error: true })
      return
    }
    setBusy(true)
    setFeedback(EMPTY_FEEDBACK)
    try {
      await api('/api/user/renewal-request', { method: 'POST', body: JSON.stringify({ passphrase: value }) })
      setPassphrase('')
      setFeedback({ message: '续费申请已提交，并已发送给 Telegram 审核流程。', error: false })
    } catch (reason) {
      setFeedback({ message: messageOf(reason, '续费申请提交失败'), error: true })
    } finally {
      setBusy(false)
      await load()
    }
  }

  const latest = requests[0]
  return <>
    <div className="uss-section-head"><div><h2>续费申请</h2><p>申请会使用最近一次套餐，并通过已绑定的 Telegram 账号进入审核。</p></div><Button variant="secondary" onClick={() => void load()}>刷新历史</Button></div>
    <Feedback value={feedback}/>
    <div className="uss-renewal-layout">
      <Card className="uss-card uss-renewal-form"><div className="uss-card-head"><div><h3>提交新申请</h3><p>后端要求账号已有可续费套餐，并且已绑定 Telegram。</p></div>{latest && <StatusBadge status={latest.status}/>}</div><form className="stack-form" onSubmit={submit}><label><span>续费口令</span><input required maxLength={256} autoComplete="off" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} placeholder="输入管理员约定的续费口令"/><small className="uss-field-help">1–256 个字符，不能包含换行。口令不会出现在本页历史记录中。</small></label><button className="btn primary" type="submit" disabled={busy}>{busy ? '提交中…' : '提交续费申请'}</button></form>{latest && <div className="uss-latest"><strong>最近一次申请</strong><dl><div><dt>套餐</dt><dd>{latest.package_name || `#${latest.package_id}`}</dd></div><div><dt>续期</dt><dd>{latest.renew_days} 天</dd></div><div><dt>提交</dt><dd>{formatDate(latest.created_at)}</dd></div><div><dt>新到期日</dt><dd>{formatDate(latest.new_end_date)}</dd></div></dl>{latest.error_message && <div className="notice error">{latest.error_message}</div>}</div>}</Card>
      <Card className="uss-card uss-history"><div className="uss-card-head"><div><h3>申请历史</h3><p>最多显示后端返回的最近 20 条记录。</p></div></div>{loading ? <Loading/> : requests.length ? <div className="uss-history-list">{requests.map((request) => <article key={request.id}><div><strong>{request.package_name || `套餐 #${request.package_id}`}</strong><small>{formatDate(request.created_at)} · 续期 {request.renew_days} 天</small></div><StatusBadge status={request.status}/>{request.new_end_date && <p>新到期日：{formatDate(request.new_end_date)}</p>}{request.error_message && <p className="uss-error-text">{request.error_message}</p>}</article>)}</div> : <Empty title="暂无续费申请" description="提交后的状态和失败原因会显示在这里。"/>}</Card>
    </div>
  </>
}

function StatusBadge({ status }: { status: string }) {
  const labels: Record<string, string> = { pending: '待审核', processing: '处理中', approved: '已通过', rejected: '已拒绝', failed: '失败' }
  return <span className={`uss-status ${status}`}>{labels[status] || status || '未知'}</span>
}
