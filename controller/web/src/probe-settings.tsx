import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './api'

type AnyRecord = Record<string, any>

type ProbePingTarget = {
  key: string
  label: string
  isp: string
  host: string
  port: number
  type?: 'tcp' | 'icmp' | ''
}

type ProbeDisguiseConfig = {
  enabled: boolean
  internal_enabled: boolean
  external_enabled: boolean
  title: string
  logo: string
  block_login: boolean
  server_ids: number[]
  show_name: boolean
  external_access_only: boolean
  external_token_configured: boolean
  metric_cpu: boolean
  metric_mem: boolean
  metric_disk: boolean
  metric_ping: boolean
  metric_traffic: boolean
  metric_speed: boolean
  show_expiry: boolean
  show_price: boolean
  show_globe: boolean
  show_return_route: boolean
  show_external_license: boolean
  ping_targets: ProbePingTarget[]
  ping_targets_override: Record<string, ProbePingTarget[]>
  ping_interval_ms: number
}

type TargetCandidate = { target: ProbePingTarget; group: string }

const defaultConfig: ProbeDisguiseConfig = {
  enabled: false,
  internal_enabled: false,
  external_enabled: false,
  title: '服务器状态',
  logo: '',
  block_login: false,
  server_ids: [],
  show_name: false,
  external_access_only: false,
  external_token_configured: false,
  metric_cpu: false,
  metric_mem: false,
  metric_disk: false,
  metric_ping: false,
  metric_traffic: true,
  metric_speed: true,
  show_expiry: false,
  show_price: false,
  show_globe: false,
  show_return_route: false,
  show_external_license: false,
  ping_targets: [],
  ping_targets_override: {},
  ping_interval_ms: 60000,
}

const errorText = (reason: unknown) => reason instanceof Error ? reason.message : '操作失败'
const ispName = (value: string) => ({ telecom: '电信', unicom: '联通', mobile: '移动', intl: '国际' } as Record<string, string>)[value] ?? value

function normalizeTarget(value: AnyRecord): ProbePingTarget | null {
  const key = String(value.key ?? '').trim()
  const host = String(value.host ?? '').trim()
  if (!key || !host) return null
  const type = value.type === 'icmp' ? 'icmp' : value.type === 'tcp' ? 'tcp' : ''
  return { key, label: String(value.label ?? key).trim() || key, isp: String(value.isp ?? '').trim(), host, port: Number(value.port) || (type === 'icmp' ? 0 : 80), type }
}

function normalizeConfig(value: AnyRecord): ProbeDisguiseConfig {
  const targets = Array.isArray(value.ping_targets) ? value.ping_targets.map((item) => normalizeTarget(item)).filter(Boolean) as ProbePingTarget[] : []
  const overrides: Record<string, ProbePingTarget[]> = {}
  if (value.ping_targets_override && typeof value.ping_targets_override === 'object') {
    for (const [serverID, rows] of Object.entries(value.ping_targets_override as Record<string, unknown>)) {
      overrides[serverID] = Array.isArray(rows) ? rows.map((item) => normalizeTarget(item as AnyRecord)).filter(Boolean) as ProbePingTarget[] : []
    }
  }
  return {
    ...defaultConfig,
    ...value,
    enabled: Boolean(value.enabled),
    internal_enabled: Boolean(value.internal_enabled),
    external_enabled: Boolean(value.external_enabled),
    title: String(value.title ?? ''),
    logo: String(value.logo ?? ''),
    block_login: Boolean(value.block_login),
    server_ids: Array.isArray(value.server_ids) ? value.server_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0) : [],
    show_name: Boolean(value.show_name),
    external_access_only: Boolean(value.external_access_only),
    external_token_configured: Boolean(value.external_token_configured),
    metric_cpu: Boolean(value.metric_cpu),
    metric_mem: Boolean(value.metric_mem),
    metric_disk: Boolean(value.metric_disk),
    metric_ping: Boolean(value.metric_ping),
    metric_traffic: value.metric_traffic !== false,
    metric_speed: value.metric_speed !== false,
    show_expiry: Boolean(value.show_expiry),
    show_price: Boolean(value.show_price),
    show_globe: Boolean(value.show_globe),
    show_return_route: Boolean(value.show_return_route),
    show_external_license: Boolean(value.show_external_license),
    ping_targets: targets,
    ping_targets_override: overrides,
    ping_interval_ms: Math.max(2000, Math.min(300000, Number(value.ping_interval_ms) || 60000)),
  }
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="setting compact-setting"><div><strong>{label}</strong>{hint && <small>{hint}</small>}</div><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)}/><span className="switch"/></label>
}

function buildCandidates(regions: AnyRecord, existing: ProbePingTarget[]): TargetCandidate[] {
  const values = new Map<string, TargetCandidate>()
  const add = (target: ProbePingTarget, group: string) => { if (target.key && target.host && !values.has(target.key)) values.set(target.key, { target, group }) }
  const provinces = Array.isArray(regions.provinces) ? regions.provinces as AnyRecord[] : []
  for (const province of provinces) {
    for (const row of Array.isArray(province.targets) ? province.targets as AnyRecord[] : []) {
      const target = normalizeTarget({ ...row, label: `${String(province.province ?? '')}${ispName(String(row.isp ?? ''))}` })
      if (target) add(target, '省级三网')
    }
  }
  const cities = Array.isArray(regions.cities) ? regions.cities as AnyRecord[] : []
  for (const row of cities) { const target = normalizeTarget(row); if (target) add(target, '城市节点') }
  const international = Array.isArray(regions.international) ? regions.international as AnyRecord[] : []
  for (const row of international) { const target = normalizeTarget({ ...row, isp: 'intl' }); if (target) add(target, String(row.group ?? '国际目标')) }
  for (const target of existing) add(target, target.key.startsWith('custom-') ? '自定义' : '已保存')
  return Array.from(values.values()).sort((a, b) => `${a.group}-${a.target.label}`.localeCompare(`${b.group}-${b.target.label}`, 'zh-CN'))
}

function TargetChooser({ candidates, selected, onChange }: { candidates: TargetCandidate[]; selected: ProbePingTarget[]; onChange: (targets: ProbePingTarget[]) => void }) {
  const [query, setQuery] = useState('')
  const selectedKeys = useMemo(() => new Set(selected.map((item) => item.key)), [selected])
  const rows = candidates.filter((candidate) => `${candidate.group} ${candidate.target.label} ${candidate.target.host} ${candidate.target.isp}`.toLowerCase().includes(query.trim().toLowerCase()))
  const toggle = (candidate: TargetCandidate) => {
    if (selectedKeys.has(candidate.target.key)) onChange(selected.filter((item) => item.key !== candidate.target.key))
    else if (selected.length < 30) onChange([...selected, candidate.target])
  }
  return <><div className="probe-target-toolbar"><label><span>筛选目标</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="省份、城市、运营商或主机名"/></label><small>已选 {selected.length} / 30</small></div><div className="probe-target-list">{rows.length ? rows.map((candidate) => { const checked = selectedKeys.has(candidate.target.key); return <label key={candidate.target.key}><input type="checkbox" checked={checked} disabled={!checked && selected.length >= 30} onChange={() => toggle(candidate)}/><div><strong>{candidate.target.label}</strong><small>{candidate.group} · {ispName(candidate.target.isp)} · {candidate.target.type || 'tcp'}</small></div></label> }) : <div className="probe-target-empty">没有匹配的探测目标</div>}</div></>
}

export function ProbeSettingsPanel({ servers, regions, regionSource }: { servers: AnyRecord[]; regions: AnyRecord; regionSource: string }) {
  const [config, setConfig] = useState<ProbeDisguiseConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState({ message: '', error: false })
  const [externalToken, setExternalToken] = useState('')
  const [overrideServer, setOverrideServer] = useState(0)
  const [custom, setCustom] = useState({ label: '', host: '', port: 443, type: 'tcp' as 'tcp' | 'icmp' })
  const load = useCallback(async () => {
    setLoading(true); setConfig(null)
    try { setConfig(normalizeConfig(await api<AnyRecord>('/api/admin/system-settings/probe-disguise'))); setFeedback({ message: '', error: false }) }
    catch (reason) { setFeedback({ message: errorText(reason), error: true }) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => { if (config && overrideServer && !config.server_ids.includes(overrideServer)) setOverrideServer(0) }, [config, overrideServer])
  const allExisting = config ? [...config.ping_targets, ...Object.values(config.ping_targets_override).flat()] : []
  const candidates = useMemo(() => buildCandidates(regions, allExisting), [regions, allExisting])
  const set = <K extends keyof ProbeDisguiseConfig>(key: K, value: ProbeDisguiseConfig[K]) => setConfig((current) => current ? { ...current, [key]: value } : current)
  const toggleServer = (id: number) => setConfig((current) => {
    if (!current) return current
    const selected = current.server_ids.includes(id)
    const serverIDs = selected ? current.server_ids.filter((value) => value !== id) : [...current.server_ids, id]
    const overrides = { ...current.ping_targets_override }
    if (selected) delete overrides[String(id)]
    return { ...current, server_ids: serverIDs, ping_targets_override: overrides }
  })
  const addCustomTarget = () => {
    if (!config) return
    const label = custom.label.trim(); const host = custom.host.trim()
    if (!label || !host) { setFeedback({ message: '自定义目标需要填写名称和主机。', error: true }); return }
    const key = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    set('ping_targets', [...config.ping_targets, { key, label, host, isp: 'custom', port: custom.type === 'icmp' ? 0 : Math.max(1, Math.min(65535, custom.port || 443)), type: custom.type }])
    setCustom({ label: '', host: '', port: 443, type: 'tcp' })
    setFeedback({ message: '自定义目标已加入全局清单；保存后由后端执行公网地址校验。', error: false })
  }
  const hasOverride = config && overrideServer > 0 && Object.prototype.hasOwnProperty.call(config.ping_targets_override, String(overrideServer))
  const overrideTargets = config && overrideServer > 0 ? config.ping_targets_override[String(overrideServer)] ?? [] : []
  const overrideMode = !hasOverride ? 'global' : overrideTargets.length ? 'custom' : 'disabled'
  const setOverrideMode = (mode: string) => {
    if (!config || !overrideServer) return
    const overrides = { ...config.ping_targets_override }
    if (mode === 'global') delete overrides[String(overrideServer)]
    else if (mode === 'disabled') overrides[String(overrideServer)] = []
    else overrides[String(overrideServer)] = config.ping_targets.length ? [...config.ping_targets] : candidates[0] ? [candidates[0].target] : []
    set('ping_targets_override', overrides)
  }
  const setOverrideTargets = (targets: ProbePingTarget[]) => {
    if (!config || !overrideServer) return
    set('ping_targets_override', { ...config.ping_targets_override, [String(overrideServer)]: targets })
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!config) return
    const token = externalToken.trim()
    if (config.block_login && !config.internal_enabled) { setFeedback({ message: '以探针页替代登录入口时必须同时启用内置状态页，否则访客无法读取跳转策略。', error: true }); return }
    if (token && token.length < 32) { setFeedback({ message: '独立探针密钥至少需要 32 个字符。', error: true }); return }
    if (config.external_enabled && config.external_access_only && !config.external_token_configured && !token) { setFeedback({ message: '启用独立探针源站保护前，请先设置至少 32 个字符的专用密钥。', error: true }); return }
    setSaving(true); setFeedback({ message: '', error: false })
    try {
      const body: AnyRecord = {
        enabled: config.internal_enabled || config.external_enabled,
        internal_enabled: config.internal_enabled,
        external_enabled: config.external_enabled,
        title: config.title.trim(),
        logo: config.logo.trim(),
        block_login: config.block_login,
        server_ids: config.server_ids,
        show_name: config.show_name,
        external_access_only: config.external_access_only,
        metric_cpu: config.metric_cpu,
        metric_mem: config.metric_mem,
        metric_disk: config.metric_disk,
        metric_ping: config.metric_ping,
        metric_traffic: config.metric_traffic,
        metric_speed: config.metric_speed,
        show_expiry: config.show_expiry,
        show_price: config.show_price,
        show_globe: config.show_globe,
        show_return_route: config.show_return_route,
        show_external_license: config.show_external_license,
        ping_targets: config.ping_targets,
        ping_targets_override: config.ping_targets_override,
        ping_interval_ms: config.ping_interval_ms,
      }
      if (token) body.external_access_token = token
      const response = await api<AnyRecord>('/api/admin/system-settings/probe-disguise', { method: 'PUT', body: JSON.stringify(body) })
      setConfig({ ...config, enabled: body.enabled, external_token_configured: config.external_token_configured || Boolean(token) })
      setExternalToken('')
      setFeedback({ message: String(response.message ?? '公开探针设置已保存。'), error: false })
    } catch (reason) { setFeedback({ message: errorText(reason), error: true }) }
    finally { setSaving(false) }
  }
  if (loading && !config) return <div className="loading"><span className="operation-spinner"/>正在读取探针设置…</div>
  if (!config) return <div className="probe-admin-form"><div className="notice error">{feedback.message || '探针设置不可用'}</div><div><button className="btn secondary" type="button" onClick={() => void load()}>重新加载</button></div></div>
  const provinceCount = Array.isArray(regions.provinces) ? regions.provinces.length : 0
  const cityCount = Array.isArray(regions.cities) ? regions.cities.length : 0
  const intlCount = Array.isArray(regions.international) ? regions.international.length : 0
  return <form className="probe-admin-form" onSubmit={save}>
    {feedback.message && <div className={`notice ${feedback.error ? 'error' : ''}`}>{feedback.message}</div>}
    <div className="probe-admin-summary"><div><small>内置状态页</small><strong>{config.internal_enabled ? '已开启' : '已关闭'}</strong></div><div><small>独立探针通道</small><strong>{config.external_enabled ? '已开启' : '已关闭'}</strong></div><div><small>公开服务器</small><strong>{config.server_ids.length} / {servers.length}</strong></div><div><small>目标数据源</small><strong>{regionSource || 'unknown'}</strong></div></div>

    <section className="probe-admin-section"><div className="probe-admin-section-head"><div><h2>访问通道与页面身份</h2><p>内置状态页使用同源公开接口；独立探针由外部 Worker 携带专用密钥访问源站。</p></div></div><div className="probe-admin-toggles"><Toggle label="启用内置状态页" hint="访客可在 /probe 查看" checked={config.internal_enabled} onChange={(value) => set('internal_enabled', value)}/><Toggle label="启用独立探针通道" hint="供单独部署的探针前端使用" checked={config.external_enabled} onChange={(value) => set('external_enabled', value)}/></div><div className="field-grid"><label><span>页面标题</span><input value={config.title} onChange={(event) => set('title', event.target.value)} placeholder="服务器状态"/></label><label><span>Logo 地址</span><input value={config.logo} onChange={(event) => set('logo', event.target.value)} placeholder="https://…、/public/… 或 data:image/…"/></label></div><div className="probe-admin-toggles"><Toggle label="显示服务器名称" hint="关闭时公开页使用匿名序号" checked={config.show_name} onChange={(value) => set('show_name', value)}/><Toggle label="以探针页替代普通登录入口" hint="/login 返回探针；/admin-login 保留管理员入口" checked={config.block_login} onChange={(value) => set('block_login', value)}/></div>{config.block_login && <div className="probe-admin-warning">开启后请保存管理员入口：<strong>/admin-login</strong>。该入口只改变前端路由，不会关闭登录 API。{!config.internal_enabled && <><br/><strong>保存前还需启用内置状态页。</strong></>}</div>}</section>

    <section className="probe-admin-section"><div className="probe-admin-section-head"><div><h2>公开服务器</h2><p>公开接口只返回后端白名单字段，不会暴露服务器 ID、IP、Token 或入站配置。</p></div><small>{config.server_ids.length} 台已选</small></div><fieldset className="checkbox-field"><legend>选择要展示的服务器</legend><div className="checkbox-list tall">{servers.length ? servers.map((server) => { const id = Number(server.id); return <label key={id}><input type="checkbox" checked={config.server_ids.includes(id)} onChange={() => toggleServer(id)}/><span>{String(server.name || `服务器 #${id}`)}</span><small>{String(server.region_city || server.region_name || server.region || server.status || '')}</small></label> }) : <div className="probe-target-empty">暂无可选择的远程服务器</div>}</div></fieldset></section>

    <section className="probe-admin-section"><div className="probe-admin-section-head"><div><h2>实时指标与扩展信息</h2><p>关闭的指标不会进入公开响应；CPU、内存、硬盘和延迟还会同步调整 Agent 采集。</p></div></div><div className="probe-admin-toggles"><Toggle label="CPU 与负载" checked={config.metric_cpu} onChange={(value) => set('metric_cpu', value)}/><Toggle label="内存" checked={config.metric_mem} onChange={(value) => set('metric_mem', value)}/><Toggle label="硬盘" checked={config.metric_disk} onChange={(value) => set('metric_disk', value)}/><Toggle label="网络延迟" checked={config.metric_ping} onChange={(value) => set('metric_ping', value)}/><Toggle label="周期与累计流量" checked={config.metric_traffic} onChange={(value) => set('metric_traffic', value)}/><Toggle label="实时网速" checked={config.metric_speed} onChange={(value) => set('metric_speed', value)}/><Toggle label="到期日与服务商" checked={config.show_expiry} onChange={(value) => set('show_expiry', value)}/><Toggle label="续费价格" checked={config.show_price} onChange={(value) => set('show_price', value)}/><Toggle label="区域图标" checked={config.show_globe} onChange={(value) => set('show_globe', value)}/><Toggle label="回程线路" checked={config.show_return_route} onChange={(value) => set('show_return_route', value)}/><Toggle label="外部授权版本标识" checked={config.show_external_license} onChange={(value) => set('show_external_license', value)}/></div></section>

    <section className="probe-admin-section"><div className="probe-admin-section-head"><div><h2>延迟探测目标</h2><p>候选包含 {provinceCount} 个省级分组、{cityCount} 个城市节点和 {intlCount} 个国际目标；每台服务器最多 30 个。</p></div><label className="small-control"><span>探测间隔</span><select value={config.ping_interval_ms} onChange={(event) => set('ping_interval_ms', Number(event.target.value))}><option value={5000}>5 秒</option><option value={15000}>15 秒</option><option value={30000}>30 秒</option><option value={60000}>60 秒（推荐）</option><option value={120000}>2 分钟</option><option value={300000}>5 分钟</option></select></label></div><TargetChooser candidates={candidates} selected={config.ping_targets} onChange={(targets) => set('ping_targets', targets)}/><div className="probe-custom-target"><label><span>自定义名称</span><input value={custom.label} onChange={(event) => setCustom((current) => ({ ...current, label: event.target.value }))} placeholder="业务入口"/></label><label><span>公网主机或 IP</span><input value={custom.host} onChange={(event) => setCustom((current) => ({ ...current, host: event.target.value.trim() }))} placeholder="status.example.com"/></label><label><span>端口</span><input type="number" min="1" max="65535" disabled={custom.type === 'icmp'} value={custom.port} onChange={(event) => setCustom((current) => ({ ...current, port: Number(event.target.value) }))}/></label><label><span>方式</span><select value={custom.type} onChange={(event) => setCustom((current) => ({ ...current, type: event.target.value as 'tcp' | 'icmp' }))}><option value="tcp">TCP</option><option value="icmp">ICMP</option></select></label><button className="btn secondary" type="button" onClick={addCustomTarget}>加入清单</button></div>
      {config.server_ids.length > 0 && <div className="probe-override-editor"><div><label><span>单台服务器覆盖</span><select value={overrideServer} onChange={(event) => setOverrideServer(Number(event.target.value))}><option value="0">选择服务器</option>{servers.filter((server) => config.server_ids.includes(Number(server.id))).map((server) => <option key={server.id} value={server.id}>{server.name || `#${server.id}`}</option>)}</select></label><label><span>目标策略</span><select disabled={!overrideServer} value={overrideMode} onChange={(event) => setOverrideMode(event.target.value)}><option value="global">跟随全局</option><option value="disabled">该服务器不探测</option><option value="custom">独立选择目标</option></select></label></div>{overrideServer > 0 && overrideMode === 'custom' && <TargetChooser candidates={candidates} selected={overrideTargets} onChange={setOverrideTargets}/>}<div className="form-note">“跟随全局”不会写覆盖键；“不探测”会保存空数组。两种状态在后端具有不同语义。</div></div>}
    </section>

    <section className="probe-admin-section"><div className="probe-admin-section-head"><div><h2>独立探针源站保护</h2><p>开启保护后，独立 Worker 必须使用 X-MMwx-Probe-Token 请求头；明文密钥只在本次保存时发送。</p></div><span className={`badge ${config.external_token_configured ? 'success' : ''}`}>{config.external_token_configured ? '已配置密钥' : '尚未配置'}</span></div><div className="probe-admin-toggles"><Toggle label="只允许受保护的外部访问" hint="同源内置探针仍由上方内置开关控制" checked={config.external_access_only} onChange={(value) => set('external_access_only', value)}/></div><label><span>{config.external_token_configured ? '轮换专用密钥（留空不变）' : '设置专用密钥'}</span><input type="password" autoComplete="new-password" minLength={32} value={externalToken} onChange={(event) => setExternalToken(event.target.value)} placeholder="至少 32 个字符，仅复制到独立 Worker"/></label>{config.external_enabled && !config.external_access_only && <div className="probe-admin-warning">独立通道已启用但源站保护未开启，接口会保持兼容的公开访问模式。</div>}</section>

    <div className="probe-admin-actions"><span className="form-note">保存后会立即向在线 Agent 下发新的采集开关与探测目标。</span><div><a className="btn secondary" href="/probe" target="_blank" rel="noreferrer">预览公开页</a><button className="btn primary" type="submit" disabled={saving}>{saving ? '保存中…' : '保存探针设置'}</button></div></div>
  </form>
}
