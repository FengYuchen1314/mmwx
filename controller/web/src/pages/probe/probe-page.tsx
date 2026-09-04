import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Group,
  Modal,
  Progress,
  RingProgress,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core'
import {
  IconActivityHeartbeat,
  IconCloudComputing,
  IconCpu,
  IconDatabase,
  IconHistory,
  IconRefresh,
  IconServer,
  IconWorld,
} from '@tabler/icons-react'

import { apiUrl, listFrom, messageOf, publicRequest } from '@/adapters/mmwx/api'
import type { JsonRecord, ProbePayload, ProbeServer } from '@/adapters/mmwx/types'
import { formatBytes, formatSpeed } from '@/shared/lib/format'
import { correspondingSourceUrl } from '@/shared/lib/source'
import { ErrorAlert, LoadingState } from '@/shared/ui/states'

type Bucket = { ms?: number; loss?: number }
type PingSeries = JsonRecord & { key?: string; label?: string; isp?: string; current_ms?: number; loss_pct?: number; buckets?: Bucket[] }
type Point = { t?: number; value?: number }

function percent(value: unknown, total: unknown): number {
  const next = Number(value); const maximum = Number(total)
  return maximum > 0 && Number.isFinite(next) ? Math.max(0, Math.min(100, next / maximum * 100)) : 0
}

function region(server: ProbeServer): string {
  return [server.region_country, server.region_name, server.region_city].filter(Boolean).join(' · ') || String(server.region ?? '未标注地区')
}

function PingBuckets({ values }: { values: Bucket[] }) {
  const summary = values.map((item, index) => {
    const latency = Number(item.ms ?? -1); const loss = Number(item.loss ?? -1)
    return latency < 0 || loss < 0 ? `采样 ${index + 1} 无数据` : `采样 ${index + 1} 延迟 ${latency} 毫秒，丢包 ${loss.toFixed(1)}%`
  }).join('；')
  return <Group aria-label={`近一小时延迟：${summary}`} gap={3} role="img" wrap="nowrap">{values.map((item, index) => {
    const latency = Number(item.ms ?? -1); const loss = Number(item.loss ?? -1)
    const color = latency < 0 || loss < 0 ? 'gray' : latency >= 300 || loss >= 50 ? 'red' : latency >= 160 || loss >= 10 ? 'yellow' : 'teal'
    return <Box aria-hidden="true" bg={`${color}.6`} h={22} key={index} style={{ borderRadius: 3, flex: 1 }} />
  })}</Group>
}

function MiniLine({ points, color = '#22d3ee' }: { points: Point[]; color?: string }) {
  const values = points.filter((point) => Number.isFinite(Number(point.value)))
  if (values.length < 2) return <Text c="dimmed" fz="sm">这一时段没有足够的采样。</Text>
  const numbers = values.map((point) => Number(point.value)); const min = Math.min(...numbers); const max = Math.max(...numbers); const span = Math.max(1, max - min)
  const data = values.map((point, index) => `${(index / Math.max(1, values.length - 1)) * 100},${44 - ((Number(point.value) - min) / span) * 38}`).join(' ')
  return <svg aria-label={`历史曲线，共 ${numbers.length} 个采样，最低 ${min.toFixed(2)}，最高 ${max.toFixed(2)}，最新 ${numbers.at(-1)?.toFixed(2)}`} className="control-chart" preserveAspectRatio="none" role="img" viewBox="0 0 100 48"><path d="M0 8H100M0 26H100M0 44H100" stroke="var(--mantine-color-dark-4)" strokeWidth=".35" /><polyline fill="none" points={data} stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" /></svg>
}

function HistoryModal({ index, server, onClose }: { index: number; server: ProbeServer; onClose: () => void }) {
  const [range, setRange] = useState('6h')
  const [data, setData] = useState<JsonRecord>()
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true; setData(undefined); setError('')
    publicRequest<JsonRecord>(`/api/public/probe-series?server=${index}&range=${range}&metric=system`).then((value) => { if (active) setData(value) }).catch((reason) => { if (active) setError(messageOf(reason)) })
    return () => { active = false }
  }, [index, range])
  const series = (data?.series && typeof data.series === 'object' ? data.series : {}) as JsonRecord
  const metrics = [
    ['CPU 使用率', listFrom<Point>(series.cpu_pct), '#22d3ee'],
    ['内存使用', listFrom<Point>(series.mem_used), '#a78bfa'],
    ['实时上行', listFrom<Point>(series.upload_speed), '#34d399'],
    ['实时下行', listFrom<Point>(series.download_speed), '#60a5fa'],
  ] as const
  return <Modal onClose={onClose} opened size="xl" title={`${String(server.name ?? `服务器 ${index + 1}`)} · 历史指标`}><Stack><Group>{['1h', '6h', '24h'].map((value) => <Button key={value} onClick={() => setRange(value)} size="xs" variant={range === value ? 'filled' : 'light'}>{value}</Button>)}</Group>{error ? <ErrorAlert>{error}</ErrorAlert> : null}{!data && !error ? <LoadingState label="正在读取历史采样" /> : <SimpleGrid cols={{ base: 1, sm: 2 }}>{metrics.map(([label, points, color]) => <Card bg="dark.6" key={label} padding="md" withBorder><Text fw={700} mb="sm">{label}</Text><MiniLine color={color} points={points} /></Card>)}</SimpleGrid>}</Stack></Modal>
}

function ServerCard({ index, server, onHistory }: { index: number; server: ProbeServer; onHistory: () => void }) {
  const online = Boolean(server.online ?? server.status === 'connected')
  const cpu = Number(server.cpu_pct ?? 0)
  const memory = percent(server.mem_used, server.mem_total)
  const disk = percent(server.disk_used, server.disk_total)
  const traffic = percent(server.traffic_used, server.traffic_limit)
  const pings = listFrom<PingSeries>(server.ping)
  return (
    <Card className="control-surface" padding="lg" shadow="lg" withBorder>
      <Stack>
        <Group justify="space-between" align="flex-start"><Group wrap="nowrap"><ThemeIcon color={online ? 'teal' : 'gray'} size="xl" variant="light"><IconServer size={22} /></ThemeIcon><Stack gap={1}><Group><Title order={4}>{String(server.name ?? `服务器 ${String(index + 1).padStart(2, '0')}`)}</Title><Badge color={online ? 'teal' : 'gray'} variant="light">{online ? '在线' : '离线'}</Badge></Group><Text c="dimmed" fz="sm">{region(server)}</Text></Stack></Group><Button leftSection={<IconHistory size={16} />} onClick={onHistory} size="xs" variant="subtle">历史</Button></Group>
        {server.provider_name || server.expires_at ? <Group gap="lg"><Text c="dimmed" fz="xs">{String(server.provider_name ?? '未标注服务商')}</Text><Text c="dimmed" fz="xs">到期 {String(server.expires_at ?? '—')}</Text></Group> : null}
        <SimpleGrid cols={{ base: 1, xs: 3 }}>
          <Stack align="center" gap={4}><RingProgress label={<Center><Text fw={700} fz="xs">CPU</Text></Center>} sections={[{ value: Math.max(0, Math.min(100, cpu)), color: 'cyan' }]} size={86} thickness={7} /><Text c="dimmed" fz="xs">{Number.isFinite(cpu) ? `${cpu.toFixed(1)}%` : '—'}</Text></Stack>
          <Stack align="center" gap={4}><RingProgress label={<Center><Text fw={700} fz="xs">内存</Text></Center>} sections={[{ value: memory, color: 'violet' }]} size={86} thickness={7} /><Text c="dimmed" fz="xs">{formatBytes(server.mem_used)} / {formatBytes(server.mem_total)}</Text></Stack>
          <Stack align="center" gap={4}><RingProgress label={<Center><Text fw={700} fz="xs">硬盘</Text></Center>} sections={[{ value: disk, color: 'blue' }]} size={86} thickness={7} /><Text c="dimmed" fz="xs">{formatBytes(server.disk_used)} / {formatBytes(server.disk_total)}</Text></Stack>
        </SimpleGrid>
        <SimpleGrid cols={{ base: 1, xs: 2 }}>
          <Card bg="dark.6" padding="sm" withBorder><Text c="dimmed" fz="xs">实时上行</Text><Text fw={700}>↑ {formatSpeed(server.upload_speed)}</Text></Card>
          <Card bg="dark.6" padding="sm" withBorder><Text c="dimmed" fz="xs">实时下行</Text><Text fw={700}>↓ {formatSpeed(server.download_speed)}</Text></Card>
        </SimpleGrid>
        {server.traffic_used !== undefined ? <Stack gap={4}><Group justify="space-between"><Text c="dimmed" fz="xs">周期流量</Text><Text fz="xs">{formatBytes(server.traffic_used)} / {formatBytes(server.traffic_limit)}</Text></Group><Progress color={traffic > 90 ? 'red' : traffic > 75 ? 'yellow' : 'cyan'} value={traffic} /></Stack> : null}
        {pings.length ? <Stack gap="sm"><Text c="dimmed" fz="xs" fw={700} tt="uppercase">网络延迟 · 近一小时</Text>{pings.map((ping, pingIndex) => <Stack gap={4} key={String(ping.key ?? pingIndex)}><Group justify="space-between"><Text fz="sm">{String(ping.label ?? '探测目标')}</Text><Text c={Number(ping.current_ms ?? -1) < 0 ? 'red' : undefined} fw={700} fz="sm">{Number(ping.current_ms ?? -1) < 0 ? '超时' : `${Number(ping.current_ms).toFixed(0)} ms`}</Text></Group><PingBuckets values={ping.buckets ?? []} /></Stack>)}</Stack> : null}
      </Stack>
    </Card>
  )
}

export function ProbePage({ initialPayload }: { initialPayload?: ProbePayload | null }) {
  const [payload, setPayload] = useState<ProbePayload | null>(initialPayload ?? null)
  const [loading, setLoading] = useState(!initialPayload)
  const [error, setError] = useState('')
  const [history, setHistory] = useState<number | null>(null)
  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true); setError('')
    try { setPayload(await publicRequest<ProbePayload>('/api/public/probe-servers')) }
    catch (reason) { setError(messageOf(reason, '无法读取公开状态')) }
    finally { if (!quiet) setLoading(false) }
  }, [])
  useEffect(() => { if (!initialPayload) void refresh() }, [initialPayload, refresh])
  useEffect(() => {
    if (!payload?.enabled) return
    const timer = window.setInterval(() => void refresh(true), 5000)
    return () => window.clearInterval(timer)
  }, [payload?.enabled, refresh])
  useEffect(() => {
    if (!payload?.enabled) return
    let socket: WebSocket | undefined
    try {
      const url = new URL(apiUrl('/api/public/probe-ws'), window.location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(url); socket.onmessage = (event) => { try { setPayload(JSON.parse(String(event.data)) as ProbePayload) } catch { /* malformed public frame */ } }
    } catch { /* polling remains active */ }
    return () => socket?.close()
  }, [payload?.enabled])
  const servers = payload?.servers ?? []
  const online = servers.filter((server) => Boolean(server.online)).length
  const pings = servers.flatMap((server) => listFrom<PingSeries>(server.ping)).map((item) => Number(item.current_ms ?? -1)).filter((value) => value >= 0)
  const average = useMemo(() => pings.length ? pings.reduce((sum, value) => sum + value, 0) / pings.length : 0, [pings])

  if (loading) return <Center mih="100vh"><LoadingState label="正在读取服务状态" /></Center>
  if (error && !payload) return <Center mih="100vh"><Stack maw={520} w="100%"><ErrorAlert>{error}</ErrorAlert><Button onClick={() => void refresh()}>重新加载</Button></Stack></Center>
  if (!payload?.enabled) return <Center mih="100vh"><Card maw={520} padding="xl" ta="center" withBorder><ThemeIcon color="gray" mb="md" size={64} variant="light"><IconCloudComputing size={32} /></ThemeIcon><Title order={2}>状态页面暂未开放</Title><Text c="dimmed" mt="sm">管理员尚未启用公开探针，或当前访问策略不允许展示。</Text><Button component="a" href="/admin-login" mt="xl" variant="light">管理员登录</Button></Card></Center>

  return (
    <Box className="probe-console" mih="100vh" p={{ base: 'sm', sm: 'xl' }}>
      <Stack maw={1500} mx="auto">
        <Card padding="lg" shadow="xl" withBorder><Group justify="space-between"><Group wrap="nowrap"><ThemeIcon size="xl" variant="light"><IconWorld size={24} /></ThemeIcon><Stack gap={0}><Title order={2}>{String(payload.title ?? '服务状态')}</Title><Text c="dimmed" fz="sm">公开只读状态 · 每 5 秒自动更新</Text></Stack></Group><Button leftSection={<IconRefresh size={17} />} onClick={() => void refresh()} variant="subtle">刷新</Button></Group></Card>
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <Card padding="lg" withBorder><Group><ThemeIcon color="teal" variant="light"><IconActivityHeartbeat size={19} /></ThemeIcon><Stack gap={0}><Text c="dimmed" fz="xs">在线服务</Text><Title order={3}>{online} / {servers.length}</Title></Stack></Group></Card>
          <Card padding="lg" withBorder><Group><ThemeIcon color="cyan" variant="light"><IconCpu size={19} /></ThemeIcon><Stack gap={0}><Text c="dimmed" fz="xs">平均延迟</Text><Title order={3}>{pings.length ? `${average.toFixed(0)} ms` : '—'}</Title></Stack></Group></Card>
          <Card padding="lg" withBorder><Group><ThemeIcon color="violet" variant="light"><IconDatabase size={19} /></ThemeIcon><Stack gap={0}><Text c="dimmed" fz="xs">公开指标</Text><Title order={3}>实时</Title></Stack></Group></Card>
        </SimpleGrid>
        {servers.length ? <SimpleGrid cols={{ base: 1, lg: 2 }}>{servers.map((server, index) => <ServerCard index={index} key={`${String(server.name ?? '')}-${index}`} onHistory={() => setHistory(index)} server={server} />)}</SimpleGrid> : <Alert title="暂无服务器">管理员尚未选择要公开展示的服务器。</Alert>}
        <Group gap="xs" justify="center" py="md"><Text c="dimmed" fz="xs">MMWX Service Observatory · 仅展示管理员明确公开的指标 ·</Text><Text component="a" fz="xs" href={correspondingSourceUrl} rel="noreferrer" target="_blank" td="underline">源码与许可证</Text></Group>
      </Stack>
      {history !== null && servers[history] ? <HistoryModal index={history} onClose={() => setHistory(null)} server={servers[history]} /> : null}
    </Box>
  )
}
