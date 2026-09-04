import { useCallback, useEffect, useState } from 'react'
import { apiURL, publicApi } from './api'

export type ProbeBucket = { ms: number; loss: number }
export type ProbePingSeries = {
  key?: string
  label: string
  isp?: string
  current_ms: number
  loss_pct: number
  buckets: ProbeBucket[]
}
export type ProbeDailyTraffic = { date: string; uplink: number; downlink: number; total: number }
export type ProbeReturnRoute = { carrier: string; region?: string; route_type: string; tested_at?: string }
export type ProbeServer = {
  name?: string
  region?: string
  region_country?: string
  region_name?: string
  region_city?: string
  provider_name?: string
  provider_url?: string
  telecom_paid_peer?: boolean
  upload_speed?: number
  download_speed?: number
  traffic_used?: number
  traffic_limit?: number
  cumulative_up?: number
  cumulative_down?: number
  online: boolean
  cpu_pct?: number
  loadavg?: string
  mem_used?: number
  mem_total?: number
  disk_used?: number
  disk_total?: number
  uptime?: number
  cpu_model?: string
  cpu_cores?: number
  cpu_threads?: number
  os?: string
  kernel?: string
  arch?: string
  ping?: ProbePingSeries[]
  expires_at?: string
  renewal_price?: number
  renewal_cycle?: string
  renewal_currency?: string
  renewal_price_cny?: number
  return_routes?: ProbeReturnRoute[]
  daily_traffic?: ProbeDailyTraffic[]
}
export type ProbePayload = {
  enabled: boolean
  title?: string
  logo?: string
  appearance?: { theme?: 'flat' | 'anime' | 'pixel'; color_mode?: string; revision?: string }
  block_login?: boolean
  show_name?: boolean
  show_globe?: boolean
  license_badge?: { name?: string; display_name?: string }
  servers?: ProbeServer[]
}

type MetricPoint = { t: number; value: number }
type ProbeSystemSeries = {
  cpu_pct?: MetricPoint[]
  mem_used?: MetricPoint[]
  mem_total?: MetricPoint[]
  upload_speed?: MetricPoint[]
  download_speed?: MetricPoint[]
  cumulative_up?: MetricPoint[]
  cumulative_down?: MetricPoint[]
}
type SystemSeriesResponse = { success: boolean; series?: ProbeSystemSeries; bucket_sec?: number; generated_at?: number }
type PingSeriesResponse = { success: boolean; series?: ProbePingSeries; all_series?: ProbePingSeries[]; bucket_sec?: number; generated_at?: number }

const formatNumber = (value: number, digits = 0) => Number.isFinite(value) ? value.toFixed(digits) : '—'

function formatBytes(value?: number) {
  if (!Number.isFinite(value) || Number(value) < 0) return '—'
  let next = Number(value)
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let index = 0
  while (next >= 1024 && index < units.length - 1) { next /= 1024; index += 1 }
  return `${next.toFixed(index > 2 ? 2 : index > 0 ? 1 : 0)} ${units[index]}`
}

function formatSpeed(value?: number) {
  const text = formatBytes(value)
  return text === '—' ? text : `${text}/s`
}

function formatDuration(value?: number) {
  if (!Number.isFinite(value) || Number(value) <= 0) return '—'
  const seconds = Math.floor(Number(value))
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor(seconds % 86400 / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  if (days) return `${days} 天 ${hours} 小时`
  if (hours) return `${hours} 小时 ${minutes} 分`
  return `${minutes} 分钟`
}

function ratio(used?: number, total?: number) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || Number(total) <= 0) return null
  return Math.max(0, Math.min(100, Number(used) / Number(total) * 100))
}

function regionText(server: ProbeServer) {
  return [server.region_country, server.region_name, server.region_city].filter(Boolean).join(' · ') || server.region || '未标注区域'
}

function ispText(value?: string) {
  return ({ telecom: '电信', unicom: '联通', mobile: '移动', intl: '国际' } as Record<string, string>)[value ?? ''] ?? value ?? ''
}

function routeText(value: string) {
  return ({ telecom: '电信', unicom: '联通', mobile: '移动' } as Record<string, string>)[value] ?? value
}

function cycleText(value?: string) {
  return ({ monthly: '/ 月', month: '/ 月', yearly: '/ 年', year: '/ 年', quarterly: '/ 季', one_time: '一次性' } as Record<string, string>)[value ?? ''] ?? (value ? `/ ${value}` : '')
}

function MetricBar({ label, value, detail }: { label: string; value: number | null; detail: string }) {
  return <div className="probe-metric-bar"><div><span>{label}</span><strong>{value === null ? '—' : `${formatNumber(value, 1)}%`}</strong></div><i><b style={{ width: `${value ?? 0}%` }}/></i><small>{detail}</small></div>
}

function PingBuckets({ buckets }: { buckets: ProbeBucket[] }) {
  return <div className="probe-ping-buckets" aria-label="最近一小时延迟">
    {buckets.map((bucket, index) => {
      const missing = bucket.ms < 0 || bucket.loss < 0
      const level = missing ? 'missing' : bucket.loss >= 50 || bucket.ms >= 300 ? 'bad' : bucket.loss >= 10 || bucket.ms >= 160 ? 'warn' : 'good'
      const title = missing ? '无数据' : `${bucket.ms} ms · 丢包 ${formatNumber(bucket.loss, 1)}%`
      return <i key={index} className={level} title={title}/>
    })}
  </div>
}

function DailyTraffic({ values }: { values: ProbeDailyTraffic[] }) {
  const rows = values.slice(-30)
  const max = Math.max(1, ...rows.map((item) => Number(item.total) || 0))
  return <div className="probe-daily"><div className="probe-subhead"><span>近 30 日流量</span><small>{formatBytes(rows.reduce((sum, item) => sum + (Number(item.total) || 0), 0))}</small></div><div>{rows.map((item) => <i key={item.date} title={`${item.date} · ${formatBytes(item.total)}`} style={{ height: `${Math.max(2, Number(item.total) / max * 100)}%` }}/>)}</div></div>
}

function ProbeServerCard({ server, index, showGlobe, onHistory }: { server: ProbeServer; index: number; showGlobe: boolean; onHistory: () => void }) {
  const memory = ratio(server.mem_used, server.mem_total)
  const disk = ratio(server.disk_used, server.disk_total)
  const traffic = ratio(server.traffic_used, server.traffic_limit)
  const displayName = server.name || `服务器 ${String(index + 1).padStart(2, '0')}`
  const pings = server.ping ?? []
  const hasSystem = server.cpu_pct !== undefined || server.mem_total !== undefined || server.disk_total !== undefined
  const renewal = server.renewal_price_cny !== undefined
    ? `¥${formatNumber(server.renewal_price_cny, 2)} ${cycleText(server.renewal_cycle)}`
    : server.renewal_price !== undefined ? `${server.renewal_currency || ''} ${formatNumber(server.renewal_price, 2)} ${cycleText(server.renewal_cycle)}` : ''
  return <article className={`probe-server ${server.online ? 'online' : 'offline'}`}>
    <div className="probe-server-head"><div className="probe-server-title">{showGlobe && <span className="probe-globe" aria-hidden="true">◎</span>}<div><div><i className="probe-status-dot"/><h2>{displayName}</h2></div><p>{regionText(server)}</p></div></div><span className="probe-state">{server.online ? '在线' : '离线'}</span></div>
    {(server.provider_name || server.expires_at || renewal) && <div className="probe-contract"><span>{server.provider_url ? <a href={server.provider_url} target="_blank" rel="noreferrer">{server.provider_name || '服务商'}</a> : server.provider_name}</span>{server.expires_at && <span>到期 {server.expires_at}</span>}{renewal && <span>{renewal}</span>}</div>}
    {hasSystem && <div className="probe-resource-grid">
      <MetricBar label="CPU" value={server.cpu_pct === undefined ? null : Math.max(0, Math.min(100, server.cpu_pct))} detail={server.loadavg ? `负载 ${server.loadavg}` : server.cpu_model || '实时使用率'}/>
      <MetricBar label="内存" value={memory} detail={server.mem_total === undefined ? '暂无数据' : `${formatBytes(server.mem_used)} / ${formatBytes(server.mem_total)}`}/>
      <MetricBar label="硬盘" value={disk} detail={server.disk_total === undefined ? '暂无数据' : `${formatBytes(server.disk_used)} / ${formatBytes(server.disk_total)}`}/>
    </div>}
    {(server.upload_speed !== undefined || server.download_speed !== undefined || server.traffic_limit !== undefined) && <div className="probe-live-grid">
      {server.upload_speed !== undefined && <div><small>实时上行</small><strong>↑ {formatSpeed(server.upload_speed)}</strong></div>}
      {server.download_speed !== undefined && <div><small>实时下行</small><strong>↓ {formatSpeed(server.download_speed)}</strong></div>}
      {server.traffic_used !== undefined && <div><small>周期流量</small><strong>{formatBytes(server.traffic_used)}{server.traffic_limit ? ` / ${formatBytes(server.traffic_limit)}` : ''}</strong>{traffic !== null && <i><b style={{ width: `${traffic}%` }}/></i>}</div>}
      {(server.cumulative_up !== undefined || server.cumulative_down !== undefined) && <div><small>累计上下行</small><strong>↑ {formatBytes(server.cumulative_up)} · ↓ {formatBytes(server.cumulative_down)}</strong></div>}
    </div>}
    {(server.os || server.cpu_model || server.uptime) && <div className="probe-machine"><span>{[server.os, server.arch, server.kernel].filter(Boolean).join(' · ')}</span><span>{server.cpu_model}{server.cpu_cores ? ` · ${server.cpu_cores} 核${server.cpu_threads ? ` / ${server.cpu_threads} 线程` : ''}` : ''}</span>{server.uptime !== undefined && <span>运行 {formatDuration(server.uptime)}</span>}</div>}
    {pings.length > 0 && <div className="probe-pings"><div className="probe-subhead"><span>网络延迟</span><small>近 1 小时</small></div>{pings.map((ping) => <div className="probe-ping-row" key={ping.key || `${ping.label}-${ping.isp}`}><div><strong>{ping.label}</strong><small>{ispText(ping.isp)}</small></div><PingBuckets buckets={ping.buckets ?? []}/><div><strong className={ping.current_ms < 0 ? 'probe-failed' : ''}>{ping.current_ms < 0 ? '超时' : `${ping.current_ms} ms`}</strong><small>丢包 {formatNumber(ping.loss_pct, 1)}%</small></div></div>)}</div>}
    {(server.return_routes?.length ?? 0) > 0 && <div className="probe-routes"><div className="probe-subhead"><span>回程线路</span></div><div>{server.return_routes?.map((route, routeIndex) => <span key={`${route.carrier}-${route.region}-${routeIndex}`}><b>{routeText(route.carrier)}</b>{route.region ? `${route.region} · ` : ''}{route.route_type}</span>)}</div></div>}
    {(server.daily_traffic?.length ?? 0) > 0 && <DailyTraffic values={server.daily_traffic ?? []}/>}
    <div className="probe-server-actions"><button type="button" onClick={onHistory}>查看历史曲线</button></div>
  </article>
}

type ChartLine = { name: string; points: MetricPoint[]; color: string }

function MetricChart({ lines, formatValue }: { lines: ChartLine[]; formatValue: (value: number) => string }) {
  const validLines = lines.map((line) => ({ ...line, points: line.points.filter((point) => Number.isFinite(point.t) && Number.isFinite(point.value)) })).filter((line) => line.points.length)
  const values = validLines.flatMap((line) => line.points.map((point) => point.value))
  const timestamps = validLines.flatMap((line) => line.points.map((point) => point.t))
  if (!values.length || !timestamps.length) return <div className="probe-chart-empty">这一时段没有可用采样</div>
  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)
  const minTime = Math.min(...timestamps)
  const maxTime = Math.max(...timestamps)
  const spanValue = Math.max(1, maxValue - minValue)
  const spanTime = Math.max(1, maxTime - minTime)
  const pointsText = (points: MetricPoint[]) => points.map((point) => `${18 + (point.t - minTime) / spanTime * 564},${108 - (point.value - minValue) / spanValue * 88}`).join(' ')
  return <div className="probe-line-chart"><div className="probe-chart-scale"><span>{formatValue(maxValue)}</span><span>{formatValue(minValue)}</span></div><svg viewBox="0 0 600 126" preserveAspectRatio="none" role="img" aria-label={validLines.map((line) => line.name).join('、')}><path d="M18 20H582M18 64H582M18 108H582" className="grid"/>{validLines.map((line) => <polyline key={line.name} points={pointsText(line.points)} style={{ stroke: line.color }}/>)}</svg><div className="probe-chart-legend">{validLines.map((line) => <span key={line.name}><i style={{ background: line.color }}/>{line.name}</span>)}</div></div>
}

function pingPoints(series: ProbePingSeries) {
  return (series.buckets ?? []).map((bucket, index) => ({ t: index, value: bucket.ms })).filter((point) => point.value >= 0)
}

function ProbeHistory({ server, index, onClose }: { server: ProbeServer; index: number; onClose: () => void }) {
  const [range, setRange] = useState<'1h' | '6h' | '24h'>('6h')
  const [system, setSystem] = useState<ProbeSystemSeries | null>(null)
  const [ping, setPing] = useState<ProbePingSeries[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    const base = `server=${index}&range=${range}`
    Promise.allSettled([
      publicApi<SystemSeriesResponse>(`/api/public/probe-series?${base}&metric=system`),
      publicApi<PingSeriesResponse>(`/api/public/probe-series?${base}&metric=ping&target=__all__&all=1`),
    ]).then(([systemResult, pingResult]) => {
      if (!active) return
      if (systemResult.status === 'fulfilled') setSystem(systemResult.value.series ?? null); else setSystem(null)
      if (pingResult.status === 'fulfilled') setPing(pingResult.value.all_series ?? (pingResult.value.series ? [pingResult.value.series] : [])); else setPing([])
      if (systemResult.status === 'rejected' && pingResult.status === 'rejected') setError(systemResult.reason instanceof Error ? systemResult.reason.message : '历史数据暂时不可用')
      setLoading(false)
    })
    return () => { active = false }
  }, [index, range])
  const memoryLines = [{ name: '已用', points: system?.mem_used ?? [], color: '#d97757' }, { name: '总量', points: system?.mem_total ?? [], color: '#8a6eb4' }]
  const speedLines = [{ name: '上行', points: system?.upload_speed ?? [], color: '#4a956b' }, { name: '下行', points: system?.download_speed ?? [], color: '#5284bb' }]
  const pingColors = ['#d97757', '#5284bb', '#4a956b', '#8a6eb4', '#c95353', '#9b7b48', '#4a8d8b', '#b26f9b']
  // The system-series endpoint contains the store's complete snapshot. Only
  // render a metric when the public list payload exposed that metric too, so a
  // disabled display/collection switch cannot be bypassed through this view.
  const showCPU = server.cpu_pct !== undefined
  const showMemory = server.mem_used !== undefined || server.mem_total !== undefined
  const showSpeed = server.upload_speed !== undefined || server.download_speed !== undefined
  const showPing = (server.ping?.length ?? 0) > 0
  return <section className="probe-history">
    <div className="probe-history-head"><div><small>历史曲线</small><h2>{server.name || `服务器 ${String(index + 1).padStart(2, '0')}`}</h2><p>{regionText(server)}</p></div><div className="probe-history-controls"><div>{(['1h', '6h', '24h'] as const).map((value) => <button key={value} className={range === value ? 'active' : ''} onClick={() => setRange(value)}>{value === '1h' ? '1 小时' : value === '6h' ? '6 小时' : '24 小时'}</button>)}</div><button className="close" type="button" onClick={onClose} aria-label="关闭历史曲线">×</button></div></div>
    {loading ? <div className="probe-history-loading"><i/>正在读取历史序列…</div> : error && !showCPU && !showMemory && !showSpeed && !showPing ? <div className="probe-history-error">{error}</div> : showCPU || showMemory || showSpeed || showPing ? <div className="probe-history-grid">
      {showCPU && <article><h3>CPU 使用率</h3><MetricChart lines={[{ name: 'CPU', points: system?.cpu_pct ?? [], color: '#d97757' }]} formatValue={(value) => `${formatNumber(value, 1)}%`}/></article>}
      {showMemory && <article><h3>内存</h3><MetricChart lines={memoryLines} formatValue={formatBytes}/></article>}
      {showSpeed && <article><h3>实时网速</h3><MetricChart lines={speedLines} formatValue={formatSpeed}/></article>}
      {showPing && <article className="wide"><h3>网络延迟</h3><MetricChart lines={ping.map((series, lineIndex) => ({ name: `${series.label}${series.isp ? ` · ${ispText(series.isp)}` : ''}`, points: pingPoints(series), color: pingColors[lineIndex % pingColors.length] }))} formatValue={(value) => `${formatNumber(value)} ms`}/></article>}
    </div> : <div className="probe-history-loading">管理员未公开这台服务器的历史指标。</div>}
  </section>
}

function ProbeUnavailable({ error }: { error?: string }) {
  return <main className="probe-unavailable"><div><span>◎</span><h1>状态页面暂未开放</h1><p>{error || '管理员尚未启用公开探针，或当前访问通道不在公开策略内。'}</p><a href="/login">返回登录</a></div></main>
}

export function PublicProbePage({ initialPayload }: { initialPayload?: ProbePayload | null }) {
  const [payload, setPayload] = useState<ProbePayload | null>(initialPayload ?? null)
  const [loading, setLoading] = useState(!initialPayload)
  const [error, setError] = useState('')
  const [transport, setTransport] = useState<'connecting' | 'live' | 'polling'>('connecting')
  const [updatedAt, setUpdatedAt] = useState<Date | null>(initialPayload ? new Date() : null)
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const next = await publicApi<ProbePayload>('/api/public/probe-servers')
      setPayload(next); setUpdatedAt(new Date()); setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法读取公开探针')
    } finally { if (!quiet) setLoading(false) }
  }, [])
  useEffect(() => { if (!initialPayload) void refresh() }, [initialPayload, refresh])
  useEffect(() => {
    const oldTheme = document.documentElement.dataset.theme
    const oldProbeTheme = document.documentElement.dataset.probeTheme
    document.documentElement.dataset.theme = payload?.appearance?.color_mode === 'dark' ? 'dark' : 'light'
    document.documentElement.dataset.probeTheme = payload?.appearance?.theme ?? 'pixel'
    return () => {
      if (oldTheme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = oldTheme
      if (oldProbeTheme === undefined) delete document.documentElement.dataset.probeTheme; else document.documentElement.dataset.probeTheme = oldProbeTheme
    }
  }, [payload?.appearance?.color_mode, payload?.appearance?.theme])
  useEffect(() => {
    const previous = document.title
    if (payload?.title) document.title = payload.title
    return () => { document.title = previous }
  }, [payload?.title])
  useEffect(() => {
    if (!payload?.enabled) return
    let disposed = false
    let socket: WebSocket | null = null
    let retryTimer = 0
    const connect = () => {
      if (disposed) return
      setTransport('connecting')
      const url = new URL(apiURL('/api/public/probe-ws'), window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      try { socket = new WebSocket(url) } catch { setTransport('polling'); return }
      socket.onopen = () => { if (!disposed) setTransport('live') }
      socket.onmessage = (event) => {
        if (disposed) return
        try {
          const next = JSON.parse(String(event.data)) as ProbePayload
          if (typeof next.enabled === 'boolean') { setPayload(next); setUpdatedAt(new Date()); setError('') }
        } catch { /* ignore malformed public frames */ }
      }
      socket.onerror = () => socket?.close()
      socket.onclose = () => {
        if (disposed) return
        setTransport('polling')
        retryTimer = window.setTimeout(connect, 30000)
      }
    }
    connect()
    return () => { disposed = true; window.clearTimeout(retryTimer); socket?.close() }
  }, [payload?.enabled])
  useEffect(() => {
    if (!payload?.enabled || transport !== 'polling') return
    const timer = window.setInterval(() => void refresh(true), 5000)
    return () => window.clearInterval(timer)
  }, [payload?.enabled, refresh, transport])

  const servers = payload?.servers ?? []
  const online = servers.filter((server) => server.online).length
  const latencyValues = servers.flatMap((server) => server.ping ?? []).map((series) => series.current_ms).filter((value) => value >= 0)
  const averageLatency = latencyValues.length ? latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length : null
  const theme = payload?.appearance?.theme ?? 'pixel'
  const logoSource = payload?.logo ? (/^data:image\//i.test(payload.logo) ? payload.logo : apiURL(payload.logo)) : ''
  const historyServer = historyIndex === null ? null : servers[historyIndex]
  const statusText = transport === 'live' ? '实时推送' : transport === 'polling' ? '自动轮询' : '正在连接'
  if (loading && !payload) return <main className="probe-loading"><i/><span>正在连接状态服务…</span></main>
  if (!payload?.enabled) return <ProbeUnavailable error={error}/>
  return <div className="probe-app" data-probe-theme={theme}>
    <header className="probe-header"><div className="probe-brand">{logoSource && <img src={logoSource} alt="" onError={(event) => { event.currentTarget.hidden = true }}/>}<div><h1>{payload.title || '服务器状态'}</h1><p>服务运行状态与网络质量</p></div></div><div className="probe-header-actions"><span className={`probe-transport ${transport}`}><i/>{statusText}</span><button type="button" onClick={() => void refresh()} disabled={loading}>{loading ? '刷新中…' : '立即刷新'}</button>{!payload.block_login && <a href="/login">控制台登录</a>}</div></header>
    <main className="probe-content">
      <section className="probe-overview"><div><small>在线服务器</small><strong>{online}<em> / {servers.length}</em></strong></div><div><small>平均延迟</small><strong>{averageLatency === null ? '—' : formatNumber(averageLatency)}<em>{averageLatency === null ? '' : ' ms'}</em></strong></div><div><small>最近更新</small><strong className="time">{updatedAt?.toLocaleTimeString('zh-CN', { hour12: false }) || '—'}</strong></div>{payload.license_badge && <div><small>服务版本</small><strong className="license">{payload.license_badge.display_name || payload.license_badge.name}</strong></div>}</section>
      {servers.length ? <section className="probe-server-grid">{servers.map((server, index) => <ProbeServerCard key={`${server.name ?? 'server'}-${index}`} server={server} index={index} showGlobe={Boolean(payload.show_globe)} onHistory={() => { setHistoryIndex(index); window.setTimeout(() => document.querySelector('.probe-history')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0) }}/>)}</section> : <section className="probe-empty"><span>◇</span><h2>暂无公开服务器</h2><p>状态页已经启用，但管理员尚未选择要展示的服务器。</p></section>}
      {historyServer && <ProbeHistory server={historyServer} index={historyIndex ?? 0} onClose={() => setHistoryIndex(null)}/>}
    </main>
    <footer className="probe-footer"><span className="probe-status-dot"/>状态数据自动更新 · 历史序列按需加载</footer>
  </div>
}
