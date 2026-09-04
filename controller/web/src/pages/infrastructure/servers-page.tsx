import { useEffect, useState, type FormEvent } from 'react'
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Card,
  CopyButton,
  Grid,
  Group,
  Modal,
  NumberInput,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core'
import {
  IconCheck,
  IconCopy,
  IconDeviceFloppy,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconServer,
  IconSettings,
  IconTrash,
} from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { listFrom, messageOf, request, streamRequest } from '@/adapters/mmwx/api'
import type { JsonRecord, Server } from '@/adapters/mmwx/types'
import { JsonPanel } from '@/shared/ui/json-panel'
import { PageHeader } from '@/shared/ui/page-header'
import { EmptyState, ErrorAlert, LoadingState } from '@/shared/ui/states'

interface ServerFormValue {
  name: string
  ip_address: string
  domain: string
  domain_v6: string
  connection_mode: string
  listen_port: number
  pull_address: string
  pull_address_v6: string
  pull_port: number
  pull_token: string
  traffic_limit: number
  traffic_reset_day: number
  xray_mode: string
  traffic_stats_mode: string
  traffic_source: string
  ipv6_enabled: boolean
  lock_entry_ip: boolean
  port_range_min: number
  port_range_max: number
  ddns_enabled: boolean
  ddns_provider_id: number
}

const emptyForm: ServerFormValue = {
  name: '',
  ip_address: '',
  domain: '',
  domain_v6: '',
  connection_mode: 'websocket',
  listen_port: 23889,
  pull_address: '',
  pull_address_v6: '',
  pull_port: 0,
  pull_token: '',
  traffic_limit: 0,
  traffic_reset_day: 0,
  xray_mode: 'external',
  traffic_stats_mode: 'both',
  traffic_source: 'system',
  ipv6_enabled: true,
  lock_entry_ip: false,
  port_range_min: 0,
  port_range_max: 0,
  ddns_enabled: false,
  ddns_provider_id: 0,
}

function fromServer(server?: Server): ServerFormValue {
  if (!server) return { ...emptyForm }
  const value = server as JsonRecord
  return {
    name: String(value.name ?? ''),
    ip_address: String(value.ip_address ?? ''),
    domain: String(value.domain ?? ''),
    domain_v6: String(value.domain_v6 ?? ''),
    connection_mode: String(value.connection_mode ?? 'websocket'),
    listen_port: Number(value.listen_port ?? 23889),
    pull_address: String(value.pull_address ?? ''),
    pull_address_v6: String(value.pull_address_v6 ?? ''),
    pull_port: Number(value.pull_port ?? 0),
    pull_token: String(value.pull_token ?? ''),
    traffic_limit: Number(value.traffic_limit ?? 0),
    traffic_reset_day: Number(value.traffic_reset_day ?? 0),
    xray_mode: String(value.xray_mode ?? 'external'),
    traffic_stats_mode: String(value.traffic_stats_mode ?? 'both'),
    traffic_source: String(value.traffic_source ?? 'system'),
    ipv6_enabled: value.ipv6_enabled !== false,
    lock_entry_ip: Boolean(value.lock_entry_ip),
    port_range_min: Number(value.port_range_min ?? 0),
    port_range_max: Number(value.port_range_max ?? 0),
    ddns_enabled: Boolean(value.ddns_enabled),
    ddns_provider_id: Number(value.ddns_provider_id ?? 0),
  }
}

function ServerEditor({ server, onClose }: { server?: Server; onClose: () => void }) {
  const [form, setForm] = useState<ServerFormValue>(() => fromServer(server))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [installCommand, setInstallCommand] = useState('')
  const queryClient = useQueryClient()
  const set = <K extends keyof ServerFormValue>(key: K, value: ServerFormValue[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const payload: JsonRecord = { ...form }
      if (server?.id !== undefined) {
        payload.id = server.id
        delete payload.ip_address
      }
      const result = await request<JsonRecord>(
        server ? '/api/admin/remote-servers/update' : '/api/admin/remote-servers/create',
        { method: 'POST', body: JSON.stringify(payload) },
      )
      setInstallCommand(String(result.install_command ?? result.command ?? ''))
      await queryClient.invalidateQueries({ queryKey: ['servers'] })
      notifications.show({ color: 'teal', message: '服务器配置已保存', title: '保存成功' })
      if (server || !(result.install_command || result.command)) onClose()
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose} opened size="xl" title={server ? '编辑服务器' : '添加服务器'}>
      {installCommand ? (
        <Stack>
          <Alert color="teal" title="服务器已创建">
            下面的安装命令只需在目标服务器执行一次。
          </Alert>
          <Card bg="dark.8" padding="md" withBorder>
            <Text ff="monospace" fz="sm" style={{ overflowWrap: 'anywhere' }}>{installCommand}</Text>
          </Card>
          <CopyButton value={installCommand}>
            {({ copied, copy }) => (
              <Button leftSection={copied ? <IconCheck size={17} /> : <IconCopy size={17} />} onClick={copy}>
                {copied ? '已复制' : '复制安装命令'}
              </Button>
            )}
          </CopyButton>
          <Button onClick={onClose} variant="light">完成</Button>
        </Stack>
      ) : (
        <form onSubmit={submit}>
          <Stack>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput required label="服务器名称" value={form.name} onChange={(event) => set('name', event.currentTarget.value)} />
              <TextInput disabled={Boolean(server)} label={server ? 'Agent 上报 IP（只读）' : '初始 IP'} value={form.ip_address} onChange={(event) => set('ip_address', event.currentTarget.value)} />
              <TextInput label="节点域名" placeholder="node.example.com" value={form.domain} onChange={(event) => set('domain', event.currentTarget.value)} />
              <TextInput label="IPv6 专用域名" value={form.domain_v6} onChange={(event) => set('domain_v6', event.currentTarget.value)} />
              <TextInput label="Agent / DDNS 地址" value={form.pull_address} onChange={(event) => set('pull_address', event.currentTarget.value)} />
              <TextInput label="IPv6 DDNS 地址" value={form.pull_address_v6} onChange={(event) => set('pull_address_v6', event.currentTarget.value)} />
              <Select
                data={[{ value: 'websocket', label: 'WebSocket（推荐）' }, { value: 'pull', label: 'Pull' }, { value: 'push', label: 'Push' }]}
                label="连接方式"
                value={form.connection_mode}
                onChange={(value) => set('connection_mode', value ?? 'websocket')}
              />
              <NumberInput label="Agent 端口" min={0} max={65535} value={form.listen_port} onChange={(value) => set('listen_port', Number(value || 0))} />
            </SimpleGrid>
            <Accordion variant="separated">
              <Accordion.Item value="network">
                <Accordion.Control>网络、流量与运行参数</Accordion.Control>
                <Accordion.Panel>
                  <Stack>
                    <SimpleGrid cols={{ base: 1, sm: 3 }}>
                      <NumberInput label="Pull 端口" min={0} max={65535} value={form.pull_port} onChange={(value) => set('pull_port', Number(value || 0))} />
                      <NumberInput label="流量上限（字节）" min={0} value={form.traffic_limit} onChange={(value) => set('traffic_limit', Number(value || 0))} />
                      <NumberInput label="每月重置日" min={0} max={31} value={form.traffic_reset_day} onChange={(value) => set('traffic_reset_day', Number(value || 0))} />
                      <NumberInput label="随机端口下限" min={0} max={65535} value={form.port_range_min} onChange={(value) => set('port_range_min', Number(value || 0))} />
                      <NumberInput label="随机端口上限" min={0} max={65535} value={form.port_range_max} onChange={(value) => set('port_range_max', Number(value || 0))} />
                      <NumberInput label="DNS 服务商 ID" min={0} value={form.ddns_provider_id} onChange={(value) => set('ddns_provider_id', Number(value || 0))} />
                    </SimpleGrid>
                    <SimpleGrid cols={{ base: 1, sm: 3 }}>
                      <Select data={[{ value: 'external', label: '外置 Xray' }, { value: 'embedded', label: '内置 Xray' }]} label="Xray 模式" value={form.xray_mode} onChange={(value) => set('xray_mode', value ?? 'external')} />
                      <Select data={[{ value: 'both', label: '上行 + 下行' }, { value: 'upload', label: '仅上行' }, { value: 'download', label: '仅下行' }, { value: 'max', label: '取较大值' }]} label="统计口径" value={form.traffic_stats_mode} onChange={(value) => set('traffic_stats_mode', value ?? 'both')} />
                      <Select data={[{ value: 'system', label: '系统网卡' }, { value: 'xray', label: 'Xray 节点' }]} label="数据来源" value={form.traffic_source} onChange={(value) => set('traffic_source', value ?? 'system')} />
                    </SimpleGrid>
                    <PasswordInput label="Pull Token（留空自动生成）" value={form.pull_token} onChange={(event) => set('pull_token', event.currentTarget.value)} />
                    <Group>
                      <Switch checked={form.ipv6_enabled} label="启用 IPv6" onChange={(event) => set('ipv6_enabled', event.currentTarget.checked)} />
                      <Switch checked={form.lock_entry_ip} label="锁定入口 IP" onChange={(event) => set('lock_entry_ip', event.currentTarget.checked)} />
                      <Switch checked={form.ddns_enabled} label="启用 DDNS" onChange={(event) => set('ddns_enabled', event.currentTarget.checked)} />
                    </Group>
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            </Accordion>
            {error ? <ErrorAlert>{error}</ErrorAlert> : null}
            <Group justify="flex-end">
              <Button onClick={onClose} type="button" variant="default">取消</Button>
              <Button leftSection={<IconDeviceFloppy size={17} />} loading={busy} type="submit">保存</Button>
            </Group>
          </Stack>
        </form>
      )}
    </Modal>
  )
}

function ServerManager({ server, onClose }: { server: Server; onClose: () => void }) {
  const id = String(server.id ?? '')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<unknown>()
  const query = useQuery({
    queryKey: ['server-runtime', id],
    queryFn: async () => {
      const suffix = `server_id=${encodeURIComponent(id)}`
      const [services, system, inbounds, version] = await Promise.allSettled([
        request(`/api/admin/remote/services/status?${suffix}`),
        request(`/api/admin/remote/system/info?${suffix}`),
        request(`/api/admin/remote/inbounds?${suffix}`),
        request(`/api/admin/remote/agent/version-info?${suffix}`),
      ])
      return {
        services: services.status === 'fulfilled' ? services.value : null,
        system: system.status === 'fulfilled' ? system.value : null,
        inbounds: inbounds.status === 'fulfilled' ? inbounds.value : null,
        version: version.status === 'fulfilled' ? version.value : null,
      }
    },
  })

  const act = async (name: string, path: string, body: unknown = {}, dangerous = false) => {
    if (dangerous && !window.confirm(`${name} 会改变远程服务器状态，确定继续吗？`)) return
    setBusy(name)
    setError('')
    try {
      if (path.includes('-stream')) {
        const events: unknown[] = []
        setResult(events)
        await streamRequest(path, { method: 'POST', body: JSON.stringify(body) }, (value) => {
          events.push(value)
          setResult([...events])
        })
      } else {
        setResult(await request(path, { method: 'POST', body: JSON.stringify(body) }))
      }
      notifications.show({ color: 'teal', message: `${name} 指令已送达`, title: '操作完成' })
      await query.refetch()
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy('')
    }
  }

  const inspect = async (name: string, path: string) => {
    setBusy(name); setError('')
    try { setResult(await request(path)) } catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }

  return (
    <Modal onClose={onClose} opened size="xl" title={`管理 ${server.name || '服务器'}`}>
      <Stack>
        <Group>
          <Button loading={busy === '同步节点'} onClick={() => void act('同步节点', `/api/admin/remote/sync-nodes?server_id=${encodeURIComponent(id)}`)} variant="light">同步节点</Button>
          {['xray', 'nginx'].map((service) => (
            <Button
              key={service}
              loading={busy === `重启 ${service}`}
              onClick={() => void act(`重启 ${service}`, `/api/admin/remote/services/control?server_id=${encodeURIComponent(id)}`, { service, action: 'restart' })}
              variant="light"
            >
              重启 {service}
            </Button>
          ))}
          <Button leftSection={<IconRefresh size={17} />} loading={query.isFetching} onClick={() => void query.refetch()} variant="subtle">刷新</Button>
        </Group>
        <Accordion variant="separated">
          <Accordion.Item value="core">
            <Accordion.Control>核心与 Agent 生命周期</Accordion.Control>
            <Accordion.Panel><Group>
              <Button loading={busy === '安装 Xray'} onClick={() => void act('安装 Xray', `/api/admin/remote/xray/install-stream?server_id=${encodeURIComponent(id)}`, {}, true)} variant="light">安装 Xray</Button>
              <Button color="red" loading={busy === '移除 Xray'} onClick={() => void act('移除 Xray', `/api/admin/remote/xray/remove-stream?server_id=${encodeURIComponent(id)}`, {}, true)} variant="light">移除 Xray</Button>
              <Button loading={busy === '安装 Nginx'} onClick={() => void act('安装 Nginx', `/api/admin/remote/nginx/install-stream?server_id=${encodeURIComponent(id)}`, {}, true)} variant="light">安装 Nginx</Button>
              <Button color="red" loading={busy === '移除 Nginx'} onClick={() => void act('移除 Nginx', `/api/admin/remote/nginx/remove-stream?server_id=${encodeURIComponent(id)}`, {}, true)} variant="light">移除 Nginx</Button>
              <Button loading={busy === '升级 Agent'} onClick={() => void act('升级 Agent', `/api/admin/remote/agent/upgrade-stream?server_id=${encodeURIComponent(id)}`, {}, true)} variant="light">升级 Agent</Button>
            </Group></Accordion.Panel>
          </Accordion.Item>
          <Accordion.Item value="network">
            <Accordion.Control>网络、HTTPS 与 WARP</Accordion.Control>
            <Accordion.Panel><Group>
              <Button loading={busy === '配置 SSL'} onClick={() => void act('配置 SSL', `/api/admin/remote/setup-ssl?server_id=${encodeURIComponent(id)}`, {}, true)} variant="light">配置远程 SSL</Button>
              <Button loading={busy === '安装 WARP'} onClick={() => void act('安装 WARP', `/api/admin/remote/warp/install?server_id=${encodeURIComponent(id)}`, {}, true)} variant="light">安装 WARP</Button>
              <Button color="red" loading={busy === '移除 WARP'} onClick={() => void act('移除 WARP', `/api/admin/remote/warp/remove?server_id=${encodeURIComponent(id)}`, {}, true)} variant="light">移除 WARP</Button>
              <Button loading={busy === '测试 DDNS'} onClick={() => void act('测试 DDNS', `/api/admin/servers/${encodeURIComponent(id)}/ddns-test`)} variant="light">测试 DDNS</Button>
              <Button loading={busy === '扫描配置'} onClick={() => void act('扫描配置', `/api/admin/remote/scan?server_id=${encodeURIComponent(id)}`)} variant="light">扫描运行配置</Button>
            </Group></Accordion.Panel>
          </Accordion.Item>
          <Accordion.Item value="tokens">
            <Accordion.Control>连接令牌与恢复</Accordion.Control>
            <Accordion.Panel><Group>
              <Button loading={busy === '查看连接令牌'} onClick={() => void inspect('查看连接令牌', `/api/admin/remote-servers/reveal-token?server_id=${encodeURIComponent(id)}`)} variant="light">查看连接令牌</Button>
              <Button color="orange" loading={busy === '轮换服务端令牌'} onClick={() => void act('轮换服务端令牌', `/api/admin/remote-servers/reset-server-token?server_id=${encodeURIComponent(id)}`, {}, true)} variant="light">轮换服务端 Token</Button>
              <Button color="orange" loading={busy === '轮换 Agent 令牌'} onClick={() => void act('轮换 Agent 令牌', `/api/admin/remote-servers/reset-agent-token?server_id=${encodeURIComponent(id)}`, {}, true)} variant="light">轮换 Agent Token</Button>
              <Button loading={busy === '配置恢复状态'} onClick={() => void inspect('配置恢复状态', `/api/admin/xray-snapshots/recovery-status?server_id=${encodeURIComponent(id)}`)} variant="light">配置恢复状态</Button>
            </Group></Accordion.Panel>
          </Accordion.Item>
        </Accordion>
        {error ? <ErrorAlert>{error}</ErrorAlert> : null}
        {result !== undefined ? <Card bg="dark.8" withBorder><Group justify="space-between" mb="xs"><Text fw={700}>最近操作结果</Text><Button onClick={() => setResult(undefined)} size="xs" variant="subtle">关闭</Button></Group><JsonPanel value={result} /></Card> : null}
        {query.isLoading ? <LoadingState /> : <JsonPanel value={query.data} />}
      </Stack>
    </Modal>
  )
}

export function ServersPage() {
  const [editor, setEditor] = useState<Server | 'new' | null>(null)
  const [manager, setManager] = useState<Server | null>(null)
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['servers'],
    queryFn: async () => listFrom<Server>(await request('/api/admin/remote-servers'), ['servers']),
  })

  const remove = async (server: Server) => {
    if (!window.confirm(`确定删除服务器“${server.name || server.id}”及其关联节点吗？`)) return
    try {
      await request('/api/admin/remote-servers/delete', {
        method: 'POST',
        body: JSON.stringify({ id: server.id, delete_nodes: true, uninstall_agent: false }),
      })
      await queryClient.invalidateQueries({ queryKey: ['servers'] })
      notifications.show({ color: 'teal', message: '服务器与关联节点已删除', title: '删除成功' })
    } catch (reason) {
      notifications.show({ color: 'red', message: messageOf(reason), title: '删除失败' })
    }
  }

  return (
    <>
      <PageHeader
        actions={
          <Group>
            <Button leftSection={<IconRefresh size={17} />} loading={query.isFetching} onClick={() => void query.refetch()} variant="light">刷新</Button>
            <Button leftSection={<IconPlus size={17} />} onClick={() => setEditor('new')}>添加服务器</Button>
          </Group>
        }
        description="连接 Agent，管理 Xray、Nginx、网络与流量策略"
        icon={IconServer}
        title="服务管理"
      />
      {query.error ? <ErrorAlert>{messageOf(query.error)}</ErrorAlert> : null}
      {query.isLoading ? (
        <Card withBorder><LoadingState /></Card>
      ) : query.data?.length ? (
        <Grid>
          {query.data.map((server, index) => {
            const connected = Boolean(server.ws_connected || server.status === 'online')
            return (
              <Grid.Col key={String(server.id ?? index)} span={{ base: 12, md: 6, xl: 4 }}>
                <Card className="control-surface" h="100%" padding="lg" shadow="lg" withBorder>
                  <Stack h="100%">
                    <Group justify="space-between">
                      <Badge color={connected ? 'teal' : 'gray'} variant="light">{connected ? '在线' : '离线'}</Badge>
                      <Badge color={server.xray_running ? 'cyan' : 'gray'} variant="dot">Xray {server.xray_running ? '运行中' : '未运行'}</Badge>
                    </Group>
                    <Stack gap={2}>
                      <Title order={3}>{server.name || '未命名服务器'}</Title>
                      <Text c="dimmed" ff="monospace" fz="sm">{server.ip_address || server.pull_address || String(server.domain ?? '未设置地址')}</Text>
                    </Stack>
                    <SimpleGrid cols={{ base: 1, sm: 2 }} mt="auto">
                      <Card bg="dark.6" padding="sm" withBorder><Text c="dimmed" fz="xs">连接方式</Text><Text fw={600}>{String(server.connection_mode ?? 'websocket')}</Text></Card>
                      <Card bg="dark.6" padding="sm" withBorder><Text c="dimmed" fz="xs">入站数量</Text><Text fw={600}>{Array.isArray(server.inbounds) ? server.inbounds.length : 0}</Text></Card>
                    </SimpleGrid>
                    <Group gap="xs">
                      <Button leftSection={<IconPlayerPlay size={16} />} onClick={() => setManager(server)} size="xs" variant="light">管理</Button>
                      <Button leftSection={<IconSettings size={16} />} onClick={() => setEditor(server)} size="xs" variant="subtle">编辑</Button>
                      <Button color="red" leftSection={<IconTrash size={16} />} onClick={() => void remove(server)} size="xs" variant="subtle">删除</Button>
                    </Group>
                  </Stack>
                </Card>
              </Grid.Col>
            )
          })}
        </Grid>
      ) : (
        <Card withBorder><EmptyState action={<Button onClick={() => setEditor('new')}>添加服务器</Button>} description="添加后会生成 Agent 安装命令。" title="还没有服务器" /></Card>
      )}
      {editor ? <ServerEditor onClose={() => setEditor(null)} server={editor === 'new' ? undefined : editor} /> : null}
      {manager ? <ServerManager onClose={() => setManager(null)} server={manager} /> : null}
    </>
  )
}
