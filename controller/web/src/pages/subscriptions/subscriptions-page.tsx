import { useState, type FormEvent } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  CopyButton,
  Group,
  Modal,
  NumberInput,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core'
import {
  IconCheck,
  IconCopy,
  IconExternalLink,
  IconFileDescription,
  IconLink,
  IconPlus,
  IconRefresh,
  IconRepeat,
  IconTrash,
} from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { apiUrl, listFrom, messageOf, request } from '@/adapters/mmwx/api'
import type { JsonRecord, Permissions, Profile } from '@/adapters/mmwx/types'
import { dateText, formatBytes } from '@/shared/lib/format'
import { JsonPanel } from '@/shared/ui/json-panel'
import { PageHeader } from '@/shared/ui/page-header'
import { EmptyState, ErrorAlert, LoadingState } from '@/shared/ui/states'

type ExternalSource = JsonRecord & { id?: number | string; name?: string; url?: string }
type ProviderConfig = JsonRecord & { id?: number | string; name?: string; external_subscription_id?: number | string; process_mode?: string }
type SyncSelection = { sessionId: string; candidates: JsonRecord[]; summary: JsonRecord }

function absoluteUrl(value: unknown): string {
  const text = String(value ?? '')
  if (!text) return ''
  return new URL(apiUrl(text), window.location.origin).toString()
}

function MySubscriptions() {
  const query = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => request<JsonRecord>('/api/subscriptions'),
  })
  const items = listFrom<JsonRecord>(query.data, ['subscriptions', 'files'])
  const userCode = String(query.data?.user_short_code ?? '')
  const itemUrl = (item: JsonRecord) => {
    const explicit = item.url ?? item.subscribe_url ?? item.path
    if (explicit) return absoluteUrl(explicit)
    const fileCode = String(item.file_short_code ?? item.custom_short_code ?? '')
    return fileCode ? absoluteUrl(`/x/${fileCode}${userCode}`) : ''
  }
  return (
    <Card padding="lg" shadow="lg" withBorder>
      <Group justify="space-between" mb="md"><Stack gap={0}><Title order={4}>我的订阅</Title><Text c="dimmed" fz="sm">当前账号可访问的套餐与订阅文件</Text></Stack><Button leftSection={<IconRefresh size={17} />} loading={query.isFetching} onClick={() => void query.refetch()} variant="subtle">刷新</Button></Group>
      {query.error ? <ErrorAlert>{messageOf(query.error)}</ErrorAlert> : null}
      {query.isLoading ? <LoadingState /> : items.length ? (
        <Stack>
          {items.map((item, index) => {
            const url = itemUrl(item)
            return (
              <Card bg="dark.6" key={String(item.id ?? index)} padding="md" withBorder>
                <Group justify="space-between" align="flex-start" wrap="wrap">
                  <Stack gap={3} style={{ minWidth: 0, flex: 1 }}>
                    <Group><Text fw={700}>{String(item.name ?? '未命名订阅')}</Text>{item.type ? <Badge variant="light">{String(item.type)}</Badge> : null}</Group>
                    <Text c="dimmed" fz="sm">{String(item.description ?? item.filename ?? '当前账号订阅')}</Text>
                    {url ? <Text ff="monospace" fz="xs" style={{ overflowWrap: 'anywhere' }}>{url}</Text> : <Text c="dimmed" fz="xs">尚未生成可访问地址</Text>}
                    <Group gap="lg"><Text c="dimmed" fz="xs">到期：{dateText(item.expire_at)}</Text><Text c="dimmed" fz="xs">更新：{dateText(item.updated_at)}</Text></Group>
                  </Stack>
                  {url ? <Group><CopyButton value={url}>{({ copied, copy }) => <Button leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />} onClick={copy} size="xs" variant="light">{copied ? '已复制' : '复制'}</Button>}</CopyButton><Button component="a" href={url} leftSection={<IconExternalLink size={16} />} rel="noreferrer" size="xs" target="_blank" variant="subtle">打开</Button></Group> : null}
                </Group>
              </Card>
            )
          })}
        </Stack>
      ) : <EmptyState description="分配套餐或订阅文件后会显示在这里。" title="暂无可用订阅" />}
    </Card>
  )
}

function ExternalEditor({ item, onClose }: { item?: ExternalSource; onClose: () => void }) {
  const [form, setForm] = useState({ name: String(item?.name ?? ''), url: String(item?.url ?? ''), user_agent: String(item?.user_agent ?? ''), traffic_mode: String(item?.traffic_mode ?? 'download') })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const queryClient = useQueryClient()
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const path = item ? `/api/user/external-subscriptions?id=${encodeURIComponent(String(item.id))}` : '/api/user/external-subscriptions'
      await request(path, { method: item ? 'PUT' : 'POST', body: JSON.stringify(form) })
      await queryClient.invalidateQueries({ queryKey: ['external-subscriptions'] })
      notifications.show({ color: 'teal', message: '外部订阅已保存', title: form.name })
      onClose()
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) }
  }
  return (
    <Modal onClose={onClose} opened title={item ? '编辑外部订阅' : '添加外部订阅'}>
      <form onSubmit={submit}><Stack>
        <TextInput label="名称" onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} required value={form.name} />
        <TextInput label="订阅 URL" onChange={(event) => setForm({ ...form, url: event.currentTarget.value })} required type="url" value={form.url} />
        <TextInput label="User-Agent" onChange={(event) => setForm({ ...form, user_agent: event.currentTarget.value })} placeholder="留空使用后端默认值" value={form.user_agent} />
        <Select data={[{ value: 'download', label: '仅下载' }, { value: 'upload', label: '仅上传' }, { value: 'both', label: '上传 + 下载' }]} label="流量统计" onChange={(value) => setForm({ ...form, traffic_mode: value ?? 'download' })} value={form.traffic_mode} />
        {error ? <ErrorAlert>{error}</ErrorAlert> : null}
        <Group justify="flex-end"><Button onClick={onClose} type="button" variant="default">取消</Button><Button loading={busy} type="submit">保存</Button></Group>
      </Stack></form>
    </Modal>
  )
}

function ExternalSubscriptions() {
  const [editing, setEditing] = useState<ExternalSource | 'new' | null>(null)
  const [inspect, setInspect] = useState<JsonRecord | null>(null)
  const [selection, setSelection] = useState<SyncSelection | null>(null)
  const [selectedCandidates, setSelectedCandidates] = useState<string[]>([])
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState('')
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['external-subscriptions'],
    queryFn: async () => listFrom<ExternalSource>(await request('/api/user/external-subscriptions'), ['subscriptions', 'items']),
  })
  const sync = async (item?: ExternalSource) => {
    try {
      const path = item ? `/api/user/sync-external-subscription?id=${encodeURIComponent(String(item.id))}` : '/api/user/sync-external-subscriptions'
      const result = await request<JsonRecord>(path, { method: 'POST', body: '{}' })
      await query.refetch()
      const candidates = Array.isArray(result.new_nodes) ? result.new_nodes.filter((entry): entry is JsonRecord => Boolean(entry && typeof entry === 'object')) : []
      const sessionId = String(result.session_id ?? '')
      if (sessionId && candidates.length) {
        setSelectedCandidates(candidates.map((candidate) => String(candidate.id)))
        setConfirmError('')
        setSelection({ sessionId, candidates, summary: result })
      } else {
        setInspect(result)
      }
      notifications.show({ color: 'teal', message: candidates.length ? `发现 ${candidates.length} 个新增节点，请确认保存` : '同步完成，没有待确认的新节点', title: item?.name ?? '全部外部订阅' })
    } catch (reason) { notifications.show({ color: 'red', message: messageOf(reason), title: '同步失败' }) }
  }
  const confirmSelection = async (candidateIds: string[]) => {
    if (!selection) return
    setConfirming(true); setConfirmError('')
    try {
      const result = await request<JsonRecord>('/api/user/sync-external-subscriptions/confirm', { method: 'POST', body: JSON.stringify({ session_id: selection.sessionId, candidate_ids: candidateIds }) })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['external-subscriptions'] }),
        queryClient.invalidateQueries({ queryKey: ['nodes'] }),
      ])
      setSelection(null)
      setInspect(result)
      notifications.show({ color: 'teal', message: String(result.message ?? `已保存 ${candidateIds.length} 个节点`), title: '候选节点处理完成' })
    } catch (reason) { setConfirmError(messageOf(reason)) } finally { setConfirming(false) }
  }
  const remove = async (item: ExternalSource) => {
    if (!window.confirm(`确定删除外部订阅“${item.name}”吗？`)) return
    try {
      await request(`/api/user/external-subscriptions?id=${encodeURIComponent(String(item.id))}`, { method: 'DELETE' })
      await queryClient.invalidateQueries({ queryKey: ['external-subscriptions'] })
    } catch (reason) { notifications.show({ color: 'red', message: messageOf(reason), title: '删除失败' }) }
  }
  const showNodes = async (item: ExternalSource) => {
    try { setInspect(await request<JsonRecord>(`/api/user/external-subscriptions/nodes?id=${encodeURIComponent(String(item.id))}`)) }
    catch (reason) { notifications.show({ color: 'red', message: messageOf(reason), title: '读取失败' }) }
  }
  return (
    <Card padding="lg" shadow="lg" withBorder>
      <Group justify="space-between" mb="md"><Stack gap={0}><Title order={4}>外部订阅</Title><Text c="dimmed" fz="sm">拉取远程节点源并同步候选节点</Text></Stack><Group><Button leftSection={<IconRepeat size={17} />} onClick={() => void sync()} variant="light">同步全部</Button><Button leftSection={<IconPlus size={17} />} onClick={() => setEditing('new')}>添加</Button></Group></Group>
      {query.error ? <ErrorAlert>{messageOf(query.error)}</ErrorAlert> : null}
      {query.isLoading ? <LoadingState /> : query.data?.length ? (
        <ScrollArea><Table highlightOnHover miw={850} verticalSpacing="sm"><Table.Thead><Table.Tr><Table.Th>订阅</Table.Th><Table.Th>节点</Table.Th><Table.Th>流量</Table.Th><Table.Th>同步时间</Table.Th><Table.Th ta="right">操作</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
          {query.data.map((item, index) => <Table.Tr key={String(item.id ?? index)}><Table.Td><Stack gap={0}><Text fw={600}>{item.name}</Text><Text c="dimmed" ff="monospace" fz="xs" maw={320} truncate>{String(item.url ?? '')}</Text></Stack></Table.Td><Table.Td>{String(item.node_count ?? 0)}</Table.Td><Table.Td>{formatBytes(Number(item.upload ?? 0) + Number(item.download ?? 0))}</Table.Td><Table.Td>{dateText(item.last_sync_at)}</Table.Td><Table.Td><Group justify="flex-end" gap="xs"><Button onClick={() => void showNodes(item)} size="xs" variant="subtle">节点</Button><Button onClick={() => void sync(item)} size="xs" variant="light">同步</Button><Button onClick={() => setEditing(item)} size="xs" variant="subtle">编辑</Button><Button color="red" onClick={() => void remove(item)} size="xs" variant="subtle">删除</Button></Group></Table.Td></Table.Tr>)}
        </Table.Tbody></Table></ScrollArea>
      ) : <EmptyState action={<Button onClick={() => setEditing('new')}>添加外部订阅</Button>} description="支持 HTTP 和 HTTPS 订阅地址。" title="暂无外部订阅" />}
      {editing ? <ExternalEditor item={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} /> : null}
      <Modal closeOnClickOutside={false} onClose={() => setSelection(null)} opened={Boolean(selection)} size="lg" title="确认新增节点">
        <Stack>
          <Alert color="cyan" title={`同步发现 ${selection?.candidates.length ?? 0} 个新节点`}>候选结果只保留 10 分钟。取消勾选不想导入的节点，再确认保存。</Alert>
          <Group justify="space-between"><Checkbox checked={Boolean(selection?.candidates.length) && selectedCandidates.length === selection?.candidates.length} indeterminate={selectedCandidates.length > 0 && selectedCandidates.length < (selection?.candidates.length ?? 0)} label="全选" onChange={(event) => setSelectedCandidates(event.currentTarget.checked ? (selection?.candidates ?? []).map((candidate) => String(candidate.id)) : [])} /><Badge variant="light">已选 {selectedCandidates.length} 个</Badge></Group>
          <ScrollArea.Autosize mah={360}><Stack gap="xs">{selection?.candidates.map((candidate) => {
            const id = String(candidate.id)
            return <Card bg="dark.6" key={id} padding="sm" withBorder><Checkbox checked={selectedCandidates.includes(id)} label={<Stack gap={0}><Text fw={600}>{String(candidate.name ?? '未命名节点')}</Text><Text c="dimmed" fz="xs">{String(candidate.subscription_name ?? '外部订阅')} · {String(candidate.protocol ?? '未知协议')} · {String(candidate.server ?? '—')}:{String(candidate.port ?? '—')}</Text></Stack>} onChange={(event) => setSelectedCandidates((current) => event.currentTarget.checked ? [...current, id] : current.filter((value) => value !== id))} /></Card>
          })}</Stack></ScrollArea.Autosize>
          {confirmError ? <ErrorAlert>{confirmError}</ErrorAlert> : null}
          <Group justify="space-between"><Button color="gray" disabled={confirming} onClick={() => { if (window.confirm('确定放弃本次发现的全部候选节点吗？')) void confirmSelection([]) }} variant="subtle">放弃全部</Button><Group><Button disabled={confirming} onClick={() => setInspect(selection?.summary ?? null)} variant="default">查看原始结果</Button><Button disabled={!selectedCandidates.length} loading={confirming} onClick={() => void confirmSelection(selectedCandidates)}>保存 {selectedCandidates.length} 个节点</Button></Group></Group>
        </Stack>
      </Modal>
      <Modal onClose={() => setInspect(null)} opened={Boolean(inspect)} size="lg" title="同步 / 节点结果"><JsonPanel value={inspect} /></Modal>
    </Card>
  )
}

function ProviderEditor({ item, sources, onClose }: { item?: ProviderConfig; sources: ExternalSource[]; onClose: () => void }) {
  const [form, setForm] = useState({
    external_subscription_id: Number(item?.external_subscription_id ?? sources[0]?.id ?? 0),
    name: String(item?.name ?? ''),
    type: String(item?.type ?? 'http'),
    interval: Number(item?.interval ?? 3600),
    proxy: String(item?.proxy ?? 'DIRECT'),
    size_limit: Number(item?.size_limit ?? 0),
    process_mode: String(item?.process_mode ?? 'client'),
    filter: String(item?.filter ?? ''),
    exclude_filter: String(item?.exclude_filter ?? ''),
    exclude_type: String(item?.exclude_type ?? ''),
    geo_ip_filter: String(item?.geo_ip_filter ?? ''),
    health_check_enabled: item?.health_check_enabled !== false,
    health_check_url: String(item?.health_check_url ?? 'https://www.gstatic.com/generate_204'),
    health_check_interval: Number(item?.health_check_interval ?? 300),
    health_check_timeout: Number(item?.health_check_timeout ?? 5000),
    health_check_lazy: item?.health_check_lazy !== false,
    health_check_expected_status: Number(item?.health_check_expected_status ?? 204),
    override: String(item?.override ?? ''),
    header: String(item?.header ?? ''),
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const queryClient = useQueryClient()
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try {
      for (const raw of [form.override, form.header]) if (raw.trim()) JSON.parse(raw)
      await request(item ? `/api/user/proxy-provider-configs?id=${item.id}` : '/api/user/proxy-provider-configs', { method: item ? 'PUT' : 'POST', body: JSON.stringify(form) })
      await queryClient.invalidateQueries({ queryKey: ['provider-configs'] })
      onClose()
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) }
  }
  return (
    <Modal onClose={onClose} opened size="lg" title={item ? '编辑 Proxy Provider' : '添加 Proxy Provider'}>
      <form onSubmit={submit}><Stack>
        <SimpleGrid cols={{ base: 1, sm: 2 }}><TextInput label="名称" onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} required value={form.name} /><Select data={sources.map((source) => ({ value: String(source.id), label: String(source.name ?? source.id) }))} disabled={Boolean(item)} label="外部订阅" onChange={(value) => setForm({ ...form, external_subscription_id: Number(value) })} value={String(form.external_subscription_id)} /></SimpleGrid>
        <SimpleGrid cols={{ base: 1, sm: 4 }}><Select data={[{ value: 'client', label: '客户端处理' }, { value: 'mmw', label: '服务端处理' }]} label="处理模式" onChange={(value) => setForm({ ...form, process_mode: value ?? 'client' })} value={form.process_mode} /><NumberInput label="刷新间隔（秒）" min={0} onChange={(value) => setForm({ ...form, interval: Number(value || 0) })} value={form.interval} /><TextInput label="请求代理" onChange={(event) => setForm({ ...form, proxy: event.currentTarget.value })} value={form.proxy} /><NumberInput label="大小限制（字节）" min={0} onChange={(value) => setForm({ ...form, size_limit: Number(value || 0) })} value={form.size_limit} /></SimpleGrid>
        <SimpleGrid cols={{ base: 1, sm: 4 }}><TextInput label="包含过滤" onChange={(event) => setForm({ ...form, filter: event.currentTarget.value })} value={form.filter} /><TextInput label="排除过滤" onChange={(event) => setForm({ ...form, exclude_filter: event.currentTarget.value })} value={form.exclude_filter} /><TextInput label="排除协议" onChange={(event) => setForm({ ...form, exclude_type: event.currentTarget.value })} placeholder="ss, socks5" value={form.exclude_type} /><TextInput label="GeoIP 过滤" onChange={(event) => setForm({ ...form, geo_ip_filter: event.currentTarget.value })} value={form.geo_ip_filter} /></SimpleGrid>
        <Group><Switch checked={form.health_check_enabled} label="启用健康检查" onChange={(event) => setForm({ ...form, health_check_enabled: event.currentTarget.checked })} /><Switch checked={form.health_check_lazy} label="延迟到首次使用时检查" onChange={(event) => setForm({ ...form, health_check_lazy: event.currentTarget.checked })} /></Group>
        <SimpleGrid cols={{ base: 1, sm: 4 }}><TextInput label="健康检查 URL" onChange={(event) => setForm({ ...form, health_check_url: event.currentTarget.value })} value={form.health_check_url} /><NumberInput label="检查间隔（秒）" min={0} onChange={(value) => setForm({ ...form, health_check_interval: Number(value || 0) })} value={form.health_check_interval} /><NumberInput label="超时（毫秒）" min={0} onChange={(value) => setForm({ ...form, health_check_timeout: Number(value || 0) })} value={form.health_check_timeout} /><NumberInput label="预期状态码" max={599} min={100} onChange={(value) => setForm({ ...form, health_check_expected_status: Number(value || 0) })} value={form.health_check_expected_status} /></SimpleGrid>
        <SimpleGrid cols={{ base: 1, sm: 2 }}><Textarea label="Header JSON" minRows={4} onChange={(event) => setForm({ ...form, header: event.currentTarget.value })} value={form.header} /><Textarea label="Override JSON" minRows={4} onChange={(event) => setForm({ ...form, override: event.currentTarget.value })} value={form.override} /></SimpleGrid>
        {error ? <ErrorAlert>{error}</ErrorAlert> : null}<Group justify="flex-end"><Button onClick={onClose} type="button" variant="default">取消</Button><Button loading={busy} type="submit">保存</Button></Group>
      </Stack></form>
    </Modal>
  )
}

function ProviderConfigs() {
  const [editing, setEditing] = useState<ProviderConfig | 'new' | null>(null)
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ['provider-configs'], queryFn: async () => listFrom<ProviderConfig>(await request('/api/user/proxy-provider-configs'), ['configs', 'items']) })
  const sources = useQuery({ queryKey: ['external-subscriptions'], queryFn: async () => listFrom<ExternalSource>(await request('/api/user/external-subscriptions'), ['subscriptions', 'items']) })
  const remove = async (item: ProviderConfig) => {
    if (!window.confirm(`确定删除 Provider“${item.name}”吗？`)) return
    try { await request(`/api/user/proxy-provider-configs?id=${item.id}`, { method: 'DELETE' }); await queryClient.invalidateQueries({ queryKey: ['provider-configs'] }) }
    catch (reason) { notifications.show({ color: 'red', message: messageOf(reason), title: '删除失败' }) }
  }
  return (
    <Card padding="lg" shadow="lg" withBorder>
      <Group justify="space-between" mb="md"><Stack gap={0}><Title order={4}>Proxy Provider</Title><Text c="dimmed" fz="sm">为 Clash / Mihomo 输出可复用的数据源</Text></Stack><Button disabled={!sources.data?.length} leftSection={<IconPlus size={17} />} onClick={() => setEditing('new')}>添加</Button></Group>
      {query.isLoading ? <LoadingState /> : query.data?.length ? <SimpleGrid cols={{ base: 1, lg: 2 }}>{query.data.map((item, index) => <Card bg="dark.6" key={String(item.id ?? index)} withBorder><Stack><Group justify="space-between"><Text fw={700}>{item.name}</Text><Badge variant="light">{item.process_mode === 'mmw' ? '服务端' : '客户端'}</Badge></Group><Text c="dimmed" fz="sm">外部订阅 #{String(item.external_subscription_id)}</Text><Group><Button onClick={() => setEditing(item)} size="xs" variant="light">编辑</Button><Button color="red" onClick={() => void remove(item)} size="xs" variant="subtle">删除</Button></Group></Stack></Card>)}</SimpleGrid> : <EmptyState description="先添加一个外部订阅，再创建 Provider 配置。" title="暂无 Provider 配置" />}
      {editing ? <ProviderEditor item={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} sources={sources.data ?? []} /> : null}
    </Card>
  )
}

function RenewalRequests() {
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const query = useQuery({ queryKey: ['renewal-requests'], queryFn: async () => listFrom<JsonRecord>(await request('/api/user/renewal-request'), ['requests']) })
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try { await request('/api/user/renewal-request', { method: 'POST', body: JSON.stringify({ passphrase: passphrase.trim() }) }); setPassphrase(''); await query.refetch(); notifications.show({ color: 'teal', message: '续费申请已进入 Telegram 审核流程', title: '提交成功' }) }
    catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) }
  }
  return (
    <SimpleGrid cols={{ base: 1, lg: 2 }}>
      <Card padding="lg" shadow="lg" withBorder><form onSubmit={submit}><Stack><Title order={4}>提交续费申请</Title><Text c="dimmed" fz="sm">账号需要已有套餐并绑定 Telegram。</Text><TextInput label="续费口令" maxLength={256} onChange={(event) => setPassphrase(event.currentTarget.value)} required value={passphrase} />{error ? <ErrorAlert>{error}</ErrorAlert> : null}<Button loading={busy} type="submit">提交申请</Button></Stack></form></Card>
      <Card padding="lg" shadow="lg" withBorder><Stack><Title order={4}>申请历史</Title>{query.isLoading ? <LoadingState /> : query.data?.length ? query.data.map((item, index) => <Card bg="dark.6" key={String(item.id ?? index)} withBorder><Group justify="space-between"><Stack gap={0}><Text fw={600}>{String(item.package_name ?? `套餐 #${item.package_id}`)}</Text><Text c="dimmed" fz="xs">{dateText(item.created_at)} · {String(item.renew_days ?? 0)} 天</Text></Stack><Badge color={item.status === 'approved' ? 'teal' : item.status === 'failed' || item.status === 'rejected' ? 'red' : 'orange'}>{String(item.status ?? 'pending')}</Badge></Group></Card>) : <EmptyState description="提交后的审核结果会显示在这里。" title="暂无申请" />}</Stack></Card>
    </SimpleGrid>
  )
}

export function SubscriptionsPage({ profile: _profile, permissions: _permissions }: { profile: Profile; permissions: Permissions }) {
  return (
    <>
      <PageHeader description="订阅入口、外部数据源、Proxy Provider 与续费申请" icon={IconLink} title="订阅中心" />
      <Tabs defaultValue="subscriptions" keepMounted={false}>
        <Tabs.List mb="md"><Tabs.Tab leftSection={<IconLink size={16} />} value="subscriptions">我的订阅</Tabs.Tab><Tabs.Tab leftSection={<IconRepeat size={16} />} value="external">外部订阅</Tabs.Tab><Tabs.Tab leftSection={<IconFileDescription size={16} />} value="providers">Proxy Provider</Tabs.Tab><Tabs.Tab value="renewal">续费申请</Tabs.Tab></Tabs.List>
        <Tabs.Panel value="subscriptions"><MySubscriptions /></Tabs.Panel>
        <Tabs.Panel value="external"><ExternalSubscriptions /></Tabs.Panel>
        <Tabs.Panel value="providers"><ProviderConfigs /></Tabs.Panel>
        <Tabs.Panel value="renewal"><RenewalRequests /></Tabs.Panel>
      </Tabs>
    </>
  )
}
