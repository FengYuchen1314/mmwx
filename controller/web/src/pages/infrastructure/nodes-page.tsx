import { useMemo, useState, type FormEvent } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  CopyButton,
  Group,
  Menu,
  Modal,
  MultiSelect,
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
  IconActivity,
  IconCheck,
  IconChevronDown,
  IconCopy,
  IconDeviceFloppy,
  IconDots,
  IconEdit,
  IconLink,
  IconNetwork,
  IconPlus,
  IconRefresh,
  IconRoute,
  IconSearch,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { listFrom, messageOf, request, resultRequest } from '@/adapters/mmwx/api'
import type { JsonRecord, Node, Permissions, Profile, Server } from '@/adapters/mmwx/types'
import { asText } from '@/shared/lib/format'
import { JsonPanel } from '@/shared/ui/json-panel'
import { PageHeader } from '@/shared/ui/page-header'
import { EmptyState, ErrorAlert, LoadingState } from '@/shared/ui/states'

const managedProfiles = [
  { value: 'vless-reality-vision', label: 'VLESS · REALITY · Vision' },
  { value: 'vless-xhttp-reality-xmux', label: 'VLESS · XHTTP · REALITY · XMUX' },
  { value: 'anytls-shadowtls', label: 'AnyTLS · ShadowTLS' },
  { value: 'mieru', label: 'Mieru' },
  { value: 'socks5', label: 'SOCKS5' },
]

function nodeName(node: Node): string {
  return String(node.node_name ?? node.name ?? node.tag ?? '未命名节点')
}

function nodeConfig(node: Node): JsonRecord {
  const raw = node.clash_config ?? node.parsed_config
  if (raw && typeof raw === 'object') return raw as JsonRecord
  try {
    return JSON.parse(String(raw ?? '{}')) as JsonRecord
  } catch {
    return {}
  }
}

function nodeHost(node: Node): string {
  const config = nodeConfig(node)
  return String(node.address ?? node.server ?? config.server ?? node.original_server ?? '—')
}

function nodePort(node: Node): string {
  const config = nodeConfig(node)
  return String(node.port ?? config.port ?? '—')
}

function protocolLabel(node: Node): string {
  const value = `${node.protocol ?? ''} ${nodeName(node)} ${node.inbound_tag ?? ''}`.toLowerCase()
  if (value.includes('xhttp')) return 'VLESS · XHTTP'
  if (value.includes('anytls') || value.includes('shadowtls')) return 'AnyTLS · ShadowTLS'
  if (value.includes('mieru')) return 'Mieru'
  if (value.includes('socks')) return 'SOCKS5'
  if (value.includes('vless')) return 'VLESS · Vision'
  return String(node.protocol ?? 'UNKNOWN').toUpperCase()
}

function ImportNodes({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<string | null>('paste')
  const [content, setContent] = useState('')
  const [url, setUrl] = useState('')
  const [tag, setTag] = useState('')
  const [skipCert, setSkipCert] = useState(false)
  const [proxies, setProxies] = useState<JsonRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const queryClient = useQueryClient()

  const parse = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await request<JsonRecord>(
        tab === 'url' ? '/api/admin/nodes/fetch-subscription' : '/api/admin/nodes/parse-uris',
        {
          method: 'POST',
          body: JSON.stringify(
            tab === 'url'
              ? { url, force_node_skip_cert: skipCert }
              : { content, force_node_skip_cert: skipCert },
          ),
        },
      )
      const parsed = listFrom<JsonRecord>(result.proxies)
      const supported = parsed.filter((proxy) =>
        ['vless', 'anytls', 'shadowtls', 'mieru', 'socks', 'socks5'].includes(
          String(proxy.type ?? '').toLowerCase(),
        ),
      )
      if (!supported.length) throw new Error('没有识别到当前支持的协议节点。')
      setProxies(supported)
      if (!tag && result.suggested_tag) setTag(String(result.suggested_tag))
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const nodes = proxies.map((proxy) => ({
        raw_url: '',
        node_name: String(proxy.name ?? 'Imported node'),
        protocol: String(proxy.type ?? ''),
        parsed_config: JSON.stringify(proxy),
        clash_config: JSON.stringify(proxy),
        enabled: true,
        tag,
        tags: tag ? [tag] : [],
      }))
      await request('/api/admin/nodes/batch', {
        method: 'POST',
        body: JSON.stringify({ nodes }),
      })
      await queryClient.invalidateQueries({ queryKey: ['nodes'] })
      notifications.show({ color: 'teal', message: `已导入 ${nodes.length} 个节点`, title: '导入完成' })
      onClose()
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose} opened size="lg" title="导入外部节点">
      <Stack>
        <Tabs value={tab} onChange={(value) => { setTab(value); setProxies([]); setError('') }}>
          <Tabs.List>
            <Tabs.Tab value="paste">粘贴内容</Tabs.Tab>
            <Tabs.Tab value="url">订阅 URL</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel pt="md" value="paste">
            <Textarea
              autosize
              label="Clash YAML、分享 URI、base64 或 Surge 行"
              minRows={9}
              onChange={(event) => { setContent(event.currentTarget.value); setProxies([]) }}
              placeholder="粘贴一个或多个节点"
              value={content}
            />
          </Tabs.Panel>
          <Tabs.Panel pt="md" value="url">
            <TextInput label="订阅地址" onChange={(event) => { setUrl(event.currentTarget.value); setProxies([]) }} placeholder="https://..." value={url} />
          </Tabs.Panel>
        </Tabs>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label="导入标签" onChange={(event) => setTag(event.currentTarget.value)} placeholder="可选" value={tag} />
          <Switch checked={skipCert} label="强制跳过证书校验" mt={28} onChange={(event) => setSkipCert(event.currentTarget.checked)} />
        </SimpleGrid>
        {proxies.length ? (
          <Alert color="teal">已识别 {proxies.length} 个支持的节点：{proxies.slice(0, 5).map((proxy) => String(proxy.name)).join('、')}{proxies.length > 5 ? '…' : ''}</Alert>
        ) : null}
        {error ? <ErrorAlert>{error}</ErrorAlert> : null}
        <Group justify="flex-end">
          <Button onClick={onClose} variant="default">取消</Button>
          {proxies.length ? (
            <Button leftSection={<IconUpload size={17} />} loading={busy} onClick={() => void save()}>确认导入</Button>
          ) : (
            <Button disabled={tab === 'url' ? !url.trim() : !content.trim()} loading={busy} onClick={() => void parse()}>解析</Button>
          )}
        </Group>
      </Stack>
    </Modal>
  )
}

function ManagedNodeEditor({ servers, onClose }: { servers: Server[]; onClose: () => void }) {
  const [form, setForm] = useState({
    server_id: String(servers[0]?.id ?? ''),
    profile: managedProfiles[0]?.value ?? 'vless-reality-vision',
    port: 443,
    destination: 'www.microsoft.com:443',
    path: '/xhttp',
    email: '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const queryClient = useQueryClient()
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const built = await request<JsonRecord>('/api/admin/xray/build-inbound', {
        method: 'POST',
        body: JSON.stringify({
          profile: form.profile,
          port: form.port,
          server_name: form.destination.split(':')[0],
          dest: form.destination,
          path: form.path,
          email: form.email,
        }),
      })
      if (!built.inbound) throw new Error('后端没有返回可下发的入站配置。')
      await request(`/api/admin/remote/inbounds?server_id=${encodeURIComponent(form.server_id)}`, {
        method: 'POST',
        body: JSON.stringify({ action: 'add', inbound: built.inbound }),
      })
      await queryClient.invalidateQueries({ queryKey: ['nodes'] })
      notifications.show({ color: 'teal', message: '节点已创建并下发到 Agent', title: '创建成功' })
      onClose()
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }
  if (!servers.length) {
    return (
      <Modal onClose={onClose} opened title="添加托管节点">
        <EmptyState description="请先在服务管理中连接一台 Agent。" title="没有可用服务器" />
      </Modal>
    )
  }
  return (
    <Modal onClose={onClose} opened size="lg" title="添加托管节点">
      <form onSubmit={submit}>
        <Stack>
          <Select data={servers.map((server) => ({ value: String(server.id), label: String(server.name ?? server.id) }))} label="目标服务器" onChange={(value) => setForm({ ...form, server_id: value ?? '' })} required value={form.server_id} />
          <Select data={managedProfiles} label="协议组合" onChange={(value) => setForm({ ...form, profile: value ?? managedProfiles[0]!.value })} value={form.profile} />
          <NumberInput label="公网端口" max={65535} min={1} onChange={(value) => setForm({ ...form, port: Number(value || 443) })} required value={form.port} />
          {form.profile.startsWith('vless') || form.profile === 'anytls-shadowtls' ? (
            <TextInput label="握手目标" onChange={(event) => setForm({ ...form, destination: event.currentTarget.value })} required value={form.destination} />
          ) : null}
          {form.profile === 'vless-xhttp-reality-xmux' ? (
            <TextInput label="XHTTP 路径" onChange={(event) => setForm({ ...form, path: event.currentTarget.value })} required value={form.path} />
          ) : null}
          <TextInput label="初始账户标识" onChange={(event) => setForm({ ...form, email: event.currentTarget.value })} placeholder="可选" value={form.email} />
          {error ? <ErrorAlert>{error}</ErrorAlert> : null}
          <Group justify="flex-end">
            <Button onClick={onClose} type="button" variant="default">取消</Button>
            <Button loading={busy} type="submit">创建并下发</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  )
}

function NodeEditor({ node, isAdmin, onClose }: { node: Node; isAdmin: boolean; onClose: () => void }) {
  const [name, setName] = useState(nodeName(node))
  const [tags, setTags] = useState<string[]>(Array.isArray(node.tags) ? node.tags.map(String) : node.tag ? [String(node.tag)] : [])
  const [enabled, setEnabled] = useState(node.enabled !== false)
  const [config, setConfig] = useState(typeof node.clash_config === 'string' ? node.clash_config : JSON.stringify(node.clash_config ?? {}, null, 2))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const queryClient = useQueryClient()
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      let payload: JsonRecord = { node_name: name }
      if (isAdmin) {
        const parsed = JSON.parse(config) as JsonRecord
        parsed.name = name
        payload = {
          raw_url: node.raw_url ?? '',
          node_name: name,
          protocol: node.protocol ?? parsed.type ?? '',
          parsed_config: JSON.stringify(parsed),
          clash_config: JSON.stringify(parsed),
          enabled,
          tag: tags[0] ?? '',
          tags,
          inbound_tag: node.inbound_tag ?? '',
          chain_proxy_node_id: node.chain_proxy_node_id ?? null,
          relay_group_name: node.relay_group_name ?? '',
          relay_group_node_ids: node.relay_group_node_ids ?? [],
        }
      }
      await request(`/api/admin/nodes/${encodeURIComponent(String(node.id))}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      })
      await queryClient.invalidateQueries({ queryKey: ['nodes'] })
      notifications.show({ color: 'teal', message: '节点已更新', title: '保存成功' })
      onClose()
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal onClose={onClose} opened size={isAdmin ? 'lg' : 'md'} title={`编辑 ${nodeName(node)}`}>
      <form onSubmit={submit}>
        <Stack>
          <TextInput label="节点名称" onChange={(event) => setName(event.currentTarget.value)} required value={name} />
          {isAdmin ? (
            <>
              <MultiSelect data={tags} label="标签" onChange={setTags} searchable value={tags} />
              <Switch checked={enabled} label="启用节点" onChange={(event) => setEnabled(event.currentTarget.checked)} />
              <Textarea autosize label="Clash 配置 JSON" minRows={12} onChange={(event) => setConfig(event.currentTarget.value)} value={config} />
            </>
          ) : (
            <Alert color="cyan">普通用户只能重命名自己导入的节点。</Alert>
          )}
          {error ? <ErrorAlert>{error}</ErrorAlert> : null}
          <Group justify="flex-end">
            <Button onClick={onClose} type="button" variant="default">取消</Button>
            <Button leftSection={<IconDeviceFloppy size={17} />} loading={busy} type="submit">保存</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  )
}

function RoutedOutboundEditor({ node, nodes, isAdmin, onClose }: { node: Node; nodes: Node[]; isAdmin: boolean; onClose: () => void }) {
  const endpoint = isAdmin ? '/api/admin/routed-outbound' : '/api/user/routed-outbound'
  const candidates = nodes.filter((item) => item.id !== node.id && String(item.node_type ?? '') !== 'routed')
  const [targetID, setTargetID] = useState(String(candidates[0]?.id ?? ''))
  const [label, setLabel] = useState('route')
  const [outbound, setOutbound] = useState('{\n  "protocol": "vless",\n  "settings": {}\n}')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const existing = useQuery({
    queryKey: ['routed-outbound', endpoint, node.id],
    queryFn: () => request<JsonRecord>(isAdmin ? `${endpoint}?parent_id=${node.id}` : endpoint),
  })
  const create = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await request(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          parent_node_id: node.id,
          ...(isAdmin ? {} : { target_node_id: Number(targetID) }),
          label,
          outbound: JSON.parse(outbound),
        }),
      })
      await existing.refetch()
      notifications.show({ color: 'teal', message: '路由出站已创建', title: '创建成功' })
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal onClose={onClose} opened size="lg" title={`路由出站 · ${nodeName(node)}`}>
      <Stack>
        <form onSubmit={create}>
          <Stack>
            {!isAdmin ? (
              <Select data={candidates.map((item) => ({ value: String(item.id), label: `${nodeName(item)} · ${nodeHost(item)}` }))} label="目标节点" onChange={(value) => setTargetID(value ?? '')} required value={targetID} />
            ) : null}
            <TextInput label="出站标识" onChange={(event) => setLabel(event.currentTarget.value)} required value={label} />
            <Textarea autosize label="Xray outbound JSON" minRows={8} onChange={(event) => setOutbound(event.currentTarget.value)} value={outbound} />
            {error ? <ErrorAlert>{error}</ErrorAlert> : null}
            <Button disabled={!isAdmin && !targetID} leftSection={<IconRoute size={17} />} loading={busy} type="submit">创建路由出站</Button>
          </Stack>
        </form>
        <Card bg="dark.8" withBorder>
          <JsonPanel value={existing.data} />
        </Card>
      </Stack>
    </Modal>
  )
}

function UserOutbounds({ nodes }: { nodes: Node[] }) {
  const [nodeID, setNodeID] = useState(String(nodes[0]?.id ?? ''))
  const [content, setContent] = useState('{\n  "tag": "private-egress",\n  "protocol": "socks",\n  "settings": {\n    "servers": [{ "address": "127.0.0.1", "port": 1080 }]\n  }\n}')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ['user-outbounds'], queryFn: async () => listFrom<JsonRecord>(await request('/api/user/nodes/outbounds'), ['outbounds', 'items']) })
  const create = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try {
      await request('/api/user/nodes/outbound', { method: 'POST', body: JSON.stringify({ node_id: Number(nodeID), outbound: JSON.parse(content) }) })
      await queryClient.invalidateQueries({ queryKey: ['user-outbounds'] })
      notifications.show({ color: 'teal', message: '个人出站已添加并绑定路由', title: '保存成功' })
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) }
  }
  const remove = async (item: JsonRecord) => {
    const outboundNodeID = Number(item.node_id ?? 0)
    if (!outboundNodeID) {
      setError('后端未返回这个出站对应的节点，请刷新页面后重试。')
      return
    }
    if (!window.confirm(`确定删除出站“${String(item.outbound_tag ?? '')}”吗？`)) return
    setBusy(true); setError('')
    try {
      await request('/api/user/nodes/outbound', { method: 'DELETE', body: JSON.stringify({ node_id: outboundNodeID, outbound_tag: item.outbound_tag }) })
      await queryClient.invalidateQueries({ queryKey: ['user-outbounds'] })
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) }
  }
  return (
    <Card padding="lg" shadow="lg" withBorder>
      <Group justify="space-between" mb="md"><Stack gap={0}><Title order={4}>我的专属出站</Title><Text c="dimmed" fz="sm">为套餐节点增加只对当前账号生效的出站与路由。</Text></Stack><Badge variant="light">{query.data?.length ?? 0} 个</Badge></Group>
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <form onSubmit={create}><Stack><Select data={nodes.map((node) => ({ value: String(node.id), label: nodeName(node) }))} label="作用节点" onChange={(value) => setNodeID(value ?? '')} required value={nodeID} /><Textarea autosize label="Xray 出站配置（JSON）" minRows={10} onChange={(event) => setContent(event.currentTarget.value)} value={content} />{error ? <ErrorAlert>{error}</ErrorAlert> : null}<Button disabled={!nodeID} leftSection={<IconPlus size={17} />} loading={busy} type="submit">添加个人出站</Button></Stack></form>
        <Stack>{query.isLoading ? <LoadingState /> : query.data?.length ? query.data.map((item, index) => <Card bg="dark.6" key={String(item.id ?? index)} padding="md" withBorder><Group justify="space-between"><Stack gap={1}><Text fw={700}>{String(item.outbound_tag ?? '未命名出站')}</Text><Text c="dimmed" fz="xs">{String(item.inbound_tag ?? '未关联入站')} · {String((item.outbound as JsonRecord | undefined)?.protocol ?? '')}</Text></Stack><Button color="red" disabled={busy} leftSection={<IconTrash size={16} />} onClick={() => void remove(item)} size="xs" variant="subtle">删除</Button></Group></Card>) : <EmptyState description="添加后，后端会为当前账号创建隔离的路由规则。" title="暂无个人出站" />}</Stack>
      </SimpleGrid>
    </Card>
  )
}

export function NodesPage({ profile, permissions }: { profile: Profile; permissions: Permissions }) {
  const isAdmin = Boolean(permissions.is_admin || profile.is_admin || profile.role === 'admin')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Array<string | number>>([])
  const [importing, setImporting] = useState(false)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Node | null>(null)
  const [routing, setRouting] = useState<Node | null>(null)
  const [inspect, setInspect] = useState<Node | null>(null)
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['nodes'],
    queryFn: async () => listFrom<Node>(await request('/api/admin/nodes'), ['nodes']),
  })
  const servers = useQuery({
    queryKey: ['servers', 'node-editor'],
    enabled: isAdmin,
    queryFn: async () => listFrom<Server>(await request('/api/admin/remote-servers'), ['servers']),
  })
  const nodes = query.data ?? []
  const filtered = useMemo(
    () => nodes.filter((node) => `${nodeName(node)} ${nodeHost(node)} ${protocolLabel(node)} ${(node.tags ?? []).toString()}`.toLowerCase().includes(search.toLowerCase())),
    [nodes, search],
  )

  const remove = async (ids: Array<string | number>) => {
    if (!ids.length || !window.confirm(`确定删除选中的 ${ids.length} 个节点吗？远程配置也会同步清理。`)) return
    try {
      if (ids.length === 1) {
        await request(`/api/admin/nodes/${encodeURIComponent(String(ids[0]))}`, { method: 'DELETE' })
      } else {
        await request('/api/admin/nodes/batch-delete', { method: 'POST', body: JSON.stringify({ node_ids: ids.map(Number) }) })
      }
      setSelected([])
      await queryClient.invalidateQueries({ queryKey: ['nodes'] })
      notifications.show({ color: 'teal', message: '节点已删除', title: '删除完成' })
    } catch (reason) {
      notifications.show({ color: 'red', message: messageOf(reason), title: '删除失败' })
    }
  }

  const copyUri = async (node: Node) => {
    try {
      const result = await request<JsonRecord>(`/api/admin/nodes/${node.id}/uri`)
      const uri = String(result.uri ?? '')
      await navigator.clipboard.writeText(uri)
      notifications.show({ color: 'teal', message: '分享 URI 已复制', title: nodeName(node) })
    } catch (reason) {
      notifications.show({ color: 'red', message: messageOf(reason), title: '无法生成 URI' })
    }
  }

  const ping = async (node: Node) => {
    try {
      const result = await resultRequest<JsonRecord>('/api/admin/tcping', {
        method: 'POST',
        body: JSON.stringify({ host: nodeHost(node), port: Number(nodePort(node)), protocol: node.protocol, timeout: 5000 }),
      })
      notifications.show({
        color: result.success ? 'teal' : 'red',
        message: result.success ? `延迟 ${Number(result.latency ?? result.latency_ms ?? 0).toFixed(1)} ms` : String(result.error ?? '连接失败'),
        title: nodeName(node),
      })
    } catch (reason) {
      notifications.show({ color: 'red', message: messageOf(reason), title: '测试失败' })
    }
  }

  return (
    <>
      <PageHeader
        actions={
          <Group>
            <Button leftSection={<IconUpload size={17} />} onClick={() => setImporting(true)} variant="light">导入</Button>
            {isAdmin ? <Button leftSection={<IconPlus size={17} />} onClick={() => setCreating(true)}>添加托管节点</Button> : null}
          </Group>
        }
        description={isAdmin ? '创建 Agent 入站，导入、测试和编排代理节点' : '查看套餐节点并维护自己的外部节点'}
        icon={IconNetwork}
        title={isAdmin ? '节点管理' : '我的节点'}
      />
      <Card padding="md" shadow="lg" withBorder>
        <Group justify="space-between" mb="md" wrap="wrap">
          <Group>
            <TextInput leftSection={<IconSearch size={16} />} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="搜索节点、地址或协议" value={search} w={{ base: '100%', sm: 320 }} />
            <Button leftSection={<IconRefresh size={17} />} loading={query.isFetching} onClick={() => void query.refetch()} variant="subtle">刷新</Button>
          </Group>
          {selected.length ? <Button color="red" leftSection={<IconTrash size={17} />} onClick={() => void remove(selected)} variant="light">删除 {selected.length} 项</Button> : <Badge variant="light">{filtered.length} 个节点</Badge>}
        </Group>
        {query.error ? <ErrorAlert>{messageOf(query.error)}</ErrorAlert> : null}
        {query.isLoading ? (
          <LoadingState />
        ) : filtered.length ? (
          <ScrollArea type="auto">
            <Table highlightOnHover miw={900} verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={38}><Checkbox aria-label="全选" checked={selected.length > 0 && selected.length === filtered.length} indeterminate={selected.length > 0 && selected.length < filtered.length} onChange={(event) => setSelected(event.currentTarget.checked ? filtered.map((item) => item.id ?? '') : [])} /></Table.Th>
                  <Table.Th>节点</Table.Th>
                  <Table.Th>协议</Table.Th>
                  <Table.Th>服务器</Table.Th>
                  <Table.Th>端口</Table.Th>
                  <Table.Th>状态</Table.Th>
                  <Table.Th ta="right">操作</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {filtered.map((node, index) => {
                  const id = node.id ?? index
                  const owned = String(node.username ?? node.created_by ?? '') === String(profile.username ?? '')
                  return (
                    <Table.Tr key={String(id)}>
                      <Table.Td><Checkbox aria-label={`选择 ${nodeName(node)}`} checked={selected.includes(id)} onChange={(event) => setSelected((current) => event.currentTarget.checked ? [...current, id] : current.filter((item) => item !== id))} /></Table.Td>
                      <Table.Td><Stack gap={0}><Text fw={600}>{nodeName(node)}</Text><Text c="dimmed" fz="xs">{owned ? '个人节点' : String(node.original_server ?? node.tag ?? '共享节点')}</Text></Stack></Table.Td>
                      <Table.Td><Badge variant="light">{protocolLabel(node)}</Badge></Table.Td>
                      <Table.Td><Text ff="monospace" fz="sm">{nodeHost(node)}</Text></Table.Td>
                      <Table.Td>{nodePort(node)}</Table.Td>
                      <Table.Td><Badge color={node.enabled !== false ? 'teal' : 'gray'} variant="dot">{node.enabled !== false ? '启用' : '停用'}</Badge></Table.Td>
                      <Table.Td ta="right">
                        <Menu position="bottom-end" shadow="xl">
                          <Menu.Target><Button rightSection={<IconChevronDown size={13} />} size="xs" variant="subtle">操作</Button></Menu.Target>
                          <Menu.Dropdown>
                            <Menu.Item leftSection={<IconActivity size={16} />} onClick={() => void ping(node)}>测试延迟</Menu.Item>
                            <Menu.Item leftSection={<IconLink size={16} />} onClick={() => void copyUri(node)}>复制 URI</Menu.Item>
                            {(isAdmin || permissions.routed_outbound_enabled) ? <Menu.Item leftSection={<IconRoute size={16} />} onClick={() => setRouting(node)}>路由出站</Menu.Item> : null}
                            {(isAdmin || owned) ? <Menu.Item leftSection={<IconEdit size={16} />} onClick={() => setEditing(node)}>编辑</Menu.Item> : null}
                            <Menu.Item leftSection={<IconDots size={16} />} onClick={() => setInspect(node)}>查看原始数据</Menu.Item>
                            {(isAdmin || owned) ? <><Menu.Divider /><Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={() => void remove([id])}>删除</Menu.Item></> : null}
                          </Menu.Dropdown>
                        </Menu>
                      </Table.Td>
                    </Table.Tr>
                  )
                })}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        ) : (
          <EmptyState action={<Button onClick={() => setImporting(true)}>导入节点</Button>} description="支持 Clash YAML、分享 URI、base64 和订阅 URL。" title="没有可见节点" />
        )}
      </Card>

      {!isAdmin ? <UserOutbounds nodes={nodes} /> : null}

      {importing ? <ImportNodes onClose={() => setImporting(false)} /> : null}
      {creating ? <ManagedNodeEditor onClose={() => setCreating(false)} servers={servers.data ?? []} /> : null}
      {editing ? <NodeEditor isAdmin={isAdmin} node={editing} onClose={() => setEditing(null)} /> : null}
      {routing ? <RoutedOutboundEditor isAdmin={isAdmin} node={routing} nodes={nodes} onClose={() => setRouting(null)} /> : null}
      <Modal onClose={() => setInspect(null)} opened={Boolean(inspect)} size="lg" title={inspect ? nodeName(inspect) : '节点详情'}>
        <JsonPanel value={inspect} />
      </Modal>
    </>
  )
}
