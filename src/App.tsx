import { useMemo, useState } from 'react'
import { Activity, Clock, Cpu, Database, HardDrive, MemoryStick, Wifi } from 'lucide-react'
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { ProbeBucket, ProbePingSeries, ProbeServer } from './types'
import { useProbe } from './use-probe'

const colors = ['#8b5cf6', '#0ea5e9', '#22c55e', '#f59e0b', '#ef4444', '#ec4899']

function bytes(value = 0): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = Math.max(0, value)
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i < 2 ? 0 : 1)} ${units[i]}`
}

function speed(value = 0): string { return `${bytes(value)}/s` }
function pct(used = 0, total = 0): number { return total > 0 ? Math.min(100, used * 100 / total) : 0 }

function Meter({ icon, label, value, percent }: { icon: React.ReactNode; label: string; value: string; percent: number }) {
  return <div className="metric">
    <div className="metric-head"><span>{icon}{label}</span><strong>{value}</strong></div>
    <div className="meter"><i style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></div>
  </div>
}

function averagePing(series: ProbePingSeries[]): ProbePingSeries {
  const count = series[0]?.buckets.length || 0
  const buckets: ProbeBucket[] = Array.from({ length: count }, (_, index) => {
    const values = series.map(item => item.buckets[index]).filter(Boolean)
    const ms = values.filter(v => v.ms >= 0).map(v => v.ms)
    const loss = values.filter(v => v.loss >= 0).map(v => v.loss)
    return {
      ms: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : -1,
      loss: loss.length ? loss.reduce((a, b) => a + b, 0) / loss.length : -1,
    }
  })
  const current = series.filter(item => item.current_ms >= 0).map(item => item.current_ms)
  return {
    key: '__avg__', label: '平均',
    current_ms: current.length ? current.reduce((a, b) => a + b, 0) / current.length : -1,
    loss_pct: series.length ? series.reduce((sum, item) => sum + item.loss_pct, 0) / series.length : 0,
    buckets,
  }
}

function TrendDialog({ serverIndex, initial, mode, close }: {
  serverIndex: number; initial: ProbePingSeries[]; mode: 'latency' | 'loss'; close: () => void
}) {
  const [range, setRange] = useState('1h')
  const [series, setSeries] = useState<ProbePingSeries[]>(initial)
  const [loading, setLoading] = useState(false)

  const load = async (next: string) => {
    setRange(next); setLoading(true)
    try {
      const response = await fetch(`/api/series?server=${serverIndex}&range=${next}&all=1`, { cache: 'no-store' })
      const payload = await response.json() as { success: boolean; series?: ProbePingSeries; all_series?: ProbePingSeries[] }
      if (payload.success) setSeries([...(payload.series ? [{ ...payload.series, key: '__avg__', label: '平均' }] : []), ...(payload.all_series || [])])
    } finally { setLoading(false) }
  }
  const rows = useMemo(() => Array.from({ length: series[0]?.buckets.length || 0 }, (_, index) => {
    const row: Record<string, string | number | null> = { time: `${index + 1}` }
    for (const item of series) {
      const bucket = item.buckets[index]
      const value = mode === 'loss' ? bucket?.loss : bucket?.ms
      row[item.key || item.label] = value !== undefined && value >= 0 ? value : null
    }
    return row
  }), [series, mode])

  return <div className="modal-backdrop" onMouseDown={close}>
    <section className="modal" onMouseDown={event => event.stopPropagation()}>
      <header><h2>{mode === 'loss' ? '丢包率趋势' : '延迟趋势'}</h2><button onClick={close}>×</button></header>
      <div className="ranges">{['1h', '6h', '24h'].map(item => <button className={range === item ? 'active' : ''} onClick={() => void load(item)} key={item}>{item}</button>)}</div>
      <div className="chart">{loading ? <div className="loading">加载中…</div> : <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <XAxis dataKey="time" hide /><YAxis width={50} unit={mode === 'loss' ? '%' : 'ms'} domain={mode === 'loss' ? [0, 100] : undefined} />
          <Tooltip formatter={(value) => `${Number(value).toFixed(mode === 'loss' ? 1 : 0)}${mode === 'loss' ? '%' : 'ms'}`} />
          {series.map((item, index) => <Line key={item.key || item.label} dataKey={item.key || item.label} name={item.label} stroke={colors[index % colors.length]} dot={false} connectNulls={false} isAnimationActive={false} />)}
        </LineChart>
      </ResponsiveContainer>}</div>
    </section>
  </div>
}

function PingPanel({ ping, serverIndex }: { ping: ProbePingSeries[]; serverIndex: number }) {
  const [mode, setMode] = useState<'latency' | 'loss' | null>(null)
  const average = averagePing(ping)
  const lines = [{ ...average, key: '__avg__' }, ...ping]
  const blocks = (kind: 'latency' | 'loss') => average.buckets.map((bucket, index) => {
    const value = kind === 'loss' ? bucket.loss : bucket.ms
    const level = value < 0 ? 'none' : kind === 'loss' ? (value >= 20 ? 'bad' : value > 0 ? 'warn' : 'good') : (value >= 200 ? 'warn' : 'good')
    return <i key={index} className={level} />
  })
  return <>
    <div className="ping-grid">
      <button onClick={() => setMode('latency')}><span><Clock size={14} />延迟 <strong>{average.current_ms < 0 ? '超时' : `${average.current_ms.toFixed(0)} ms`}</strong></span><em>{blocks('latency')}</em></button>
      <button onClick={() => setMode('loss')}><span><Wifi size={14} />丢包率 <strong>{average.loss_pct.toFixed(1)}%</strong></span><em>{blocks('loss')}</em></button>
    </div>
    {mode && <TrendDialog serverIndex={serverIndex} initial={lines} mode={mode} close={() => setMode(null)} />}
  </>
}

function ServerCard({ server, index }: { server: ProbeServer; index: number }) {
  return <article className="server-card">
    <div className="server-title"><span className={server.online ? 'status online' : 'status'} /><h2>{server.name || `服务器 ${index + 1}`}</h2><span>{server.online ? '在线' : '离线'}</span></div>
    <div className="metrics">
      {server.cpu_pct !== undefined && <Meter icon={<Cpu size={14} />} label="CPU" value={`${server.cpu_pct.toFixed(1)}%`} percent={server.cpu_pct} />}
      {server.mem_total !== undefined && <Meter icon={<MemoryStick size={14} />} label="内存" value={`${bytes(server.mem_used)} / ${bytes(server.mem_total)}`} percent={pct(server.mem_used, server.mem_total)} />}
      {server.disk_total !== undefined && <Meter icon={<HardDrive size={14} />} label="硬盘" value={`${bytes(server.disk_used)} / ${bytes(server.disk_total)}`} percent={pct(server.disk_used, server.disk_total)} />}
      {server.traffic_used !== undefined && <Meter icon={<Database size={14} />} label="流量" value={server.traffic_limit ? `${bytes(server.traffic_used)} / ${bytes(server.traffic_limit)}` : bytes(server.traffic_used)} percent={pct(server.traffic_used, server.traffic_limit)} />}
    </div>
    {(server.upload_speed !== undefined || server.download_speed !== undefined) && <div className="speed"><span>↑ {speed(server.upload_speed)}</span><span>↓ {speed(server.download_speed)}</span></div>}
    {!!server.ping?.length && <PingPanel ping={server.ping} serverIndex={index} />}
  </article>
}

export function App() {
  const { data, error } = useProbe()
  const [view, setView] = useState<'card' | 'list'>(() => (localStorage.getItem('probe-view') as 'card' | 'list') || 'card')
  const setMode = (next: 'card' | 'list') => { setView(next); localStorage.setItem('probe-view', next) }
  if (!data && !error) return <main className="center"><Activity className="pulse" />正在连接主控…</main>
  if (error && !data) return <main className="center error">主控暂时不可用<br /><small>{error}</small></main>
  if (!data?.enabled) return <main className="center">探针尚未启用</main>
  const title = data.title?.trim() || '服务器状态'
  const servers = data.servers || []
  return <div className="app-shell">
    <header className="topbar"><div>{data.logo && <img src={data.logo} alt="" />}<h1>{title}</h1></div><nav><button className={view === 'card' ? 'active' : ''} onClick={() => setMode('card')}>卡片</button><button className={view === 'list' ? 'active' : ''} onClick={() => setMode('list')}>列表</button></nav></header>
    <main className={`servers ${view}`}>{servers.length ? servers.map((server, index) => <ServerCard key={`${server.name}-${index}`} server={server} index={index} />) : <div className="empty">暂无服务器数据</div>}</main>
    <footer>Powered by MMWX Probe</footer>
  </div>
}
