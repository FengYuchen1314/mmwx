import { useEffect, useState } from 'react'
import {
  Badge,
  Button,
  Card,
  Grid,
  Group,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core'
import {
  IconActivity,
  IconChartHistogram,
  IconNetwork,
  IconRefresh,
  IconServer,
  IconUsers,
} from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'

import { apiUrl, listFrom, readSession, request } from '@/adapters/mmwx/api'
import type { Node, Permissions, Profile, Server, TrafficSummary, User } from '@/adapters/mmwx/types'
import { formatSpeed } from '@/shared/lib/format'
import { PageHeader } from '@/shared/ui/page-header'
import { EmptyState, LoadingState } from '@/shared/ui/states'

interface DashboardData {
  traffic: TrafficSummary
  servers: Server[]
  nodes: Node[]
  users: User[]
}

const protocols = [
  'VLESS · REALITY · Vision',
  'VLESS · XHTTP · REALITY · XMUX',
  'AnyTLS · ShadowTLS',
  'Mieru',
  'SOCKS5',
]

async function loadDashboard(isAdmin: boolean): Promise<DashboardData> {
  const calls: Array<Promise<unknown>> = [
    request<TrafficSummary>('/api/traffic/summary'),
    isAdmin ? request('/api/admin/remote-servers') : Promise.resolve([]),
    request(isAdmin ? '/api/admin/nodes' : '/api/user/nodes'),
    isAdmin ? request('/api/admin/users') : Promise.resolve([]),
  ]
  const [traffic, servers, nodes, users] = await Promise.allSettled(calls)
  return {
    traffic: traffic?.status === 'fulfilled' ? (traffic.value as TrafficSummary) : {},
    servers: servers?.status === 'fulfilled' ? listFrom<Server>(servers.value, ['servers']) : [],
    nodes: nodes?.status === 'fulfilled' ? listFrom<Node>(nodes.value, ['nodes']) : [],
    users: users?.status === 'fulfilled' ? listFrom<User>(users.value, ['users']) : [],
  }
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  color,
}: {
  icon: typeof IconServer
  label: string
  value: string
  detail: string
  color: string
}) {
  return (
    <Card className="control-surface" padding="lg" shadow="lg" withBorder>
      <Group align="flex-start" wrap="nowrap">
        <ThemeIcon color={color} size={44} variant="light">
          <Icon size={22} stroke={1.7} />
        </ThemeIcon>
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Text c="dimmed" fz="xs" fw={700} tt="uppercase">
            {label}
          </Text>
          <Title order={2}>{value}</Title>
          <Text c="dimmed" fz="xs" truncate>
            {detail}
          </Text>
        </Stack>
      </Group>
    </Card>
  )
}

export function DashboardPage({ profile, permissions }: { profile: Profile; permissions: Permissions }) {
  const isAdmin = Boolean(permissions.is_admin || profile.is_admin || profile.role === 'admin')
  const [live, setLive] = useState(false)
  const interval = useQuery({
    queryKey: ['dashboard', 'interval'],
    queryFn: () => request<{ refetch_interval_ms?: number }>('/api/system-config/refetch-interval'),
    staleTime: 300_000,
  })
  const query = useQuery({
    queryKey: ['dashboard', isAdmin],
    queryFn: () => loadDashboard(isAdmin),
    refetchInterval: Math.max(1_000, Math.min(60_000, Number(interval.data?.refetch_interval_ms ?? 5_000))),
  })
  useEffect(() => {
    const token = readSession()
    if (!token) return
    let socket: WebSocket | undefined
    let lastRefresh = 0
    try {
      const url = new URL(apiUrl('/api/ws/dashboard'), window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('token', token)
      socket = new WebSocket(url)
      socket.onopen = () => setLive(true)
      socket.onclose = () => setLive(false)
      socket.onerror = () => setLive(false)
      socket.onmessage = () => {
        const now = Date.now()
        if (now - lastRefresh >= 1_000) { lastRefresh = now; void query.refetch() }
      }
    } catch { setLive(false) }
    return () => { socket?.close(); setLive(false) }
  }, [isAdmin])
  const data = query.data ?? { traffic: {}, servers: [], nodes: [], users: [] }
  const metrics = data.traffic.metrics ?? {}
  const history = data.traffic.history ?? []
  const online = data.servers.filter((server) => server.ws_connected || server.status === 'online').length
  const downloadSpeed = data.servers.reduce(
    (sum, server) => sum + Number(server.current_download_speed || 0),
    0,
  )
  const uploadSpeed = data.servers.reduce(
    (sum, server) => sum + Number(server.current_upload_speed || 0),
    0,
  )
  const max = Math.max(1, ...history.map((item) => Number(item.used_gb || 0)))

  return (
    <>
      <PageHeader
        actions={
          <><Badge color={live ? 'teal' : 'gray'} variant="dot">{live ? '实时连接' : '定时刷新'}</Badge><Button leftSection={<IconRefresh size={17} />} loading={query.isFetching} onClick={() => void query.refetch()} variant="light">刷新</Button></>
        }
        description={isAdmin ? '控制平面的关键运行状态与最近流量趋势' : '你的流量、节点与订阅入口'}
        icon={IconChartHistogram}
        title={isAdmin ? '运行总览' : '我的总览'}
      />

      <SimpleGrid cols={{ base: 1, xs: 2, xl: 4 }} mb="md">
        {isAdmin ? (
          <>
            <MetricCard
              color="cyan"
              detail={`${online} 台在线`}
              icon={IconServer}
              label="服务器"
              value={query.isLoading ? '—' : String(data.servers.length)}
            />
            <MetricCard
              color="blue"
              detail="套餐节点与受管入站"
              icon={IconNetwork}
              label="代理节点"
              value={query.isLoading ? '—' : String(data.nodes.length)}
            />
            <MetricCard
              color="teal"
              detail="管理员与普通成员"
              icon={IconUsers}
              label="用户"
              value={query.isLoading ? '—' : String(data.users.length)}
            />
            <MetricCard
              color="violet"
              detail={`↑ ${formatSpeed(uploadSpeed)}`}
              icon={IconActivity}
              label="实时下行"
              value={query.isLoading ? '—' : formatSpeed(downloadSpeed)}
            />
          </>
        ) : (
          <>
            <MetricCard
              color="cyan"
              detail="服务端统一结算"
              icon={IconChartHistogram}
              label="已用流量"
              value={query.isLoading ? '—' : `${Number(metrics.total_used_gb || 0).toFixed(2)} GB`}
            />
            <MetricCard
              color="teal"
              detail="当前统计周期"
              icon={IconActivity}
              label="剩余流量"
              value={query.isLoading ? '—' : `${Number(metrics.total_remaining_gb || 0).toFixed(2)} GB`}
            />
            <MetricCard
              color="violet"
              detail="流量额度占比"
              icon={IconChartHistogram}
              label="使用率"
              value={query.isLoading ? '—' : `${Number(metrics.usage_percentage || 0).toFixed(1)}%`}
            />
            <MetricCard
              color="blue"
              detail="套餐节点与个人节点"
              icon={IconNetwork}
              label="可用节点"
              value={query.isLoading ? '—' : String(data.nodes.length)}
            />
          </>
        )}
      </SimpleGrid>

      <Grid mb="md">
        <Grid.Col span={{ base: 12, lg: 8 }}>
          <Card h="100%" padding="lg" shadow="lg" withBorder>
            <Group justify="space-between" mb="md">
              <Stack gap={0}>
                <Title order={4}>流量趋势</Title>
                <Text c="dimmed" fz="sm">最近 14 个服务端统计点</Text>
              </Stack>
              <Badge variant="light">
                已用 {Number(metrics.total_used_gb || 0).toFixed(2)} GB
              </Badge>
            </Group>
            {query.isLoading ? (
              <LoadingState />
            ) : history.length ? (
              <div
                aria-label={`最近流量统计：${history.slice(-14).map((item) => `${item.date}，${Number(item.used_gb ?? 0).toFixed(2)} GB`).join('；')}`}
                className="control-chart"
                role="img"
              >
                {history.slice(-14).map((item, index) => (
                  <div aria-hidden="true" className="control-chart-column" key={`${item.date}-${index}`}>
                    <div
                      className="control-chart-bar"
                      style={{ height: `${Math.max(3, (Number(item.used_gb || 0) / max) * 100)}%` }}
                    />
                    <Text c="dimmed" fz={10}>{String(item.date ?? '').slice(5)}</Text>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState description="节点产生流量后会显示趋势。" title="暂无统计记录" />
            )}
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 4 }}>
          <Card h="100%" padding="lg" shadow="lg" withBorder>
            <Group justify="space-between" mb="md">
              <Stack gap={0}>
                <Title order={4}>{isAdmin ? '服务状态' : '常用入口'}</Title>
                <Text c="dimmed" fz="sm">
                  {isAdmin ? 'Agent 与核心连接' : '由管理员开放的功能'}
                </Text>
              </Stack>
              {isAdmin ? <Button component={Link} size="xs" to="/xray-servers" variant="subtle">管理</Button> : null}
            </Group>
            {isAdmin ? (
              data.servers.length ? (
                <Stack gap="sm">
                  {data.servers.slice(0, 6).map((server, index) => {
                    const connected = Boolean(server.ws_connected || server.status === 'online')
                    return (
                      <Group justify="space-between" key={String(server.id ?? index)} wrap="nowrap">
                        <Stack gap={0} style={{ minWidth: 0 }}>
                          <Text fw={600} truncate>{server.name || '未命名服务器'}</Text>
                          <Text c="dimmed" fz="xs" truncate>{server.ip_address || server.pull_address || '未设置地址'}</Text>
                        </Stack>
                        <Badge color={connected ? 'teal' : 'gray'} variant="light">
                          {connected ? '在线' : '离线'}
                        </Badge>
                      </Group>
                    )
                  })}
                </Stack>
              ) : (
                <EmptyState
                  action={<Button component={Link} size="xs" to="/xray-servers">添加服务器</Button>}
                  description="连接第一台 Agent 后会显示状态。"
                  title="尚无服务器"
                />
              )
            ) : (
              <Stack>
                {(permissions.pages ?? []).slice(0, 6).map((page) => {
                  const labels: Record<string, [string, string]> = {
                    subscription: ['订阅中心', '/subscription'],
                    generator: ['订阅生成', '/generator'],
                    nodes: ['我的节点', '/nodes'],
                    templates: ['模板管理', '/templates'],
                    'subscribe-files': ['订阅文件', '/subscribe-files'],
                    'custom-rules': ['覆写管理', '/custom-rules'],
                  }
                  const item = labels[page]
                  return item ? (
                    <Button component={Link} justify="space-between" key={page} to={item[1]} variant="light">
                      {item[0]}
                    </Button>
                  ) : null
                })}
              </Stack>
            )}
          </Card>
        </Grid.Col>
      </Grid>

      <Card padding="lg" shadow="lg" withBorder>
        <Stack gap="md">
          <Group justify="space-between">
            <Stack gap={0}>
              <Title order={4}>支持的连接配置</Title>
              <Text c="dimmed" fz="sm">面板与 Agent 共同维护的协议组合</Text>
            </Stack>
          </Group>
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }}>
            {protocols.map((protocol, index) => (
              <Card bg="dark.6" key={protocol} padding="sm" withBorder>
                <Group wrap="nowrap">
                  <ThemeIcon color="cyan" size="sm" variant="light">{index + 1}</ThemeIcon>
                  <Text fz="xs" fw={600}>{protocol}</Text>
                </Group>
              </Card>
            ))}
          </SimpleGrid>
          {!isAdmin ? <Progress value={Number(metrics.usage_percentage || 0)} /> : null}
        </Stack>
      </Card>
    </>
  )
}
