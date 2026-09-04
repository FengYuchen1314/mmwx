import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  FileInput,
  Group,
  Modal,
  MultiSelect,
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
  IconBook,
  IconCloudUpload,
  IconEdit,
  IconFileCode,
  IconFolder,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { listFrom, messageOf, request } from '@/adapters/mmwx/api'
import type { JsonRecord, Node, Permissions, Profile } from '@/adapters/mmwx/types'
import { JsonPanel } from '@/shared/ui/json-panel'
import { PageHeader } from '@/shared/ui/page-header'
import { EmptyState, ErrorAlert, LoadingState } from '@/shared/ui/states'

type TemplateSource = JsonRecord & { id?: number | string; name?: string }

function RuleTemplateEditor({ filename, onClose }: { filename: string; onClose: () => void }) {
  const [content, setContent] = useState('')
  const [newName, setNewName] = useState(filename)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const queryClient = useQueryClient()
  useEffect(() => {
    void request<JsonRecord>(`/api/admin/rule-templates/${encodeURIComponent(filename)}`)
      .then((value) => setContent(String(value.content ?? '')))
      .catch((reason) => setError(messageOf(reason)))
  }, [filename])
  const save = async () => {
    setBusy(true); setError('')
    try {
      await request(`/api/admin/rule-templates/${encodeURIComponent(filename)}`, { method: 'PUT', body: JSON.stringify({ content }) })
      if (newName.trim() && newName.trim() !== filename) {
        await request('/api/admin/rule-templates/rename', { method: 'POST', body: JSON.stringify({ old_name: filename, new_name: newName.trim() }) })
      }
      await queryClient.invalidateQueries({ queryKey: ['rule-templates'] })
      notifications.show({ color: 'teal', message: '模板文件已保存', title: newName })
      onClose()
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) }
  }
  return (
    <Modal onClose={onClose} opened size="xl" title={`编辑模板 · ${filename}`}>
      <Stack><TextInput label="文件名" onChange={(event) => setNewName(event.currentTarget.value)} value={newName} /><Textarea autosize label="模板内容" minRows={20} onChange={(event) => setContent(event.currentTarget.value)} value={content} />{error ? <ErrorAlert>{error}</ErrorAlert> : null}<Group justify="flex-end"><Button onClick={onClose} variant="default">取消</Button><Button loading={busy} onClick={() => void save()}>保存</Button></Group></Stack>
    </Modal>
  )
}

function RuleTemplateFiles({ isAdmin }: { isAdmin: boolean }) {
  const [file, setFile] = useState<File | null>(null)
  const [editing, setEditing] = useState('')
  const [busy, setBusy] = useState(false)
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ['rule-templates'], queryFn: () => request<JsonRecord>('/api/admin/rule-templates') })
  const templates = listFrom<string>(query.data?.templates)
  const owners = (query.data?.owners ?? {}) as Record<string, string>
  const currentUsername = String(query.data?.username ?? '')
  const upload = async () => {
    if (!file) return
    setBusy(true)
    try {
      const body = new FormData(); body.append('template', file)
      await request('/api/admin/rule-templates/upload', { method: 'POST', body })
      setFile(null)
      await queryClient.invalidateQueries({ queryKey: ['rule-templates'] })
      notifications.show({ color: 'teal', message: '模板文件已上传', title: file.name })
    } catch (reason) { notifications.show({ color: 'red', message: messageOf(reason), title: '上传失败' }) }
    finally { setBusy(false) }
  }
  const remove = async (filename: string) => {
    if (!window.confirm(`确定删除模板“${filename}”吗？`)) return
    try { await request(`/api/admin/rule-templates/${encodeURIComponent(filename)}`, { method: 'DELETE' }); await queryClient.invalidateQueries({ queryKey: ['rule-templates'] }) }
    catch (reason) { notifications.show({ color: 'red', message: messageOf(reason), title: '删除失败' }) }
  }
  return (
    <Stack>
      <Card padding="lg" withBorder><Group align="end"><FileInput accept=".yaml,.yml,.conf" clearable label="上传模板文件" onChange={setFile} placeholder="选择 .yaml、.yml 或 .conf" value={file} style={{ flex: 1 }} /><Button disabled={!file} leftSection={<IconCloudUpload size={17} />} loading={busy} onClick={() => void upload()}>上传</Button></Group></Card>
      <Card padding="lg" shadow="lg" withBorder>
        <Group justify="space-between" mb="md"><Stack gap={0}><Title order={4}>模板文件</Title><Text c="dimmed" fz="sm">Clash / Mihomo V3 与 Surge 文件</Text></Stack><Button leftSection={<IconRefresh size={17} />} loading={query.isFetching} onClick={() => void query.refetch()} variant="subtle">刷新</Button></Group>
        {query.isLoading ? <LoadingState /> : templates.length ? <SimpleGrid cols={{ base: 1, md: 2 }}>{templates.map((filename) => { const owner = owners[filename] ?? ''; const canManage = isAdmin || owner === currentUsername; return <Card bg="dark.6" key={filename} withBorder><Group justify="space-between" align="flex-start"><Stack gap={2}><Text fw={700}>{filename}</Text><Text c="dimmed" fz="xs">{filename.endsWith('.conf') ? 'Surge' : 'Clash / Mihomo'} · {owner ? owner === currentUsername ? '我的模板' : owner === '__shared__' ? '公开共享' : `所有者 ${owner}` : '内置模板'}</Text></Stack>{canManage ? <Group gap="xs"><Button leftSection={<IconEdit size={15} />} onClick={() => setEditing(filename)} size="xs" variant="subtle">编辑</Button><Button color="red" leftSection={<IconTrash size={15} />} onClick={() => void remove(filename)} size="xs" variant="subtle">删除</Button></Group> : <Badge variant="light">只读</Badge>}</Group></Card> })}</SimpleGrid> : <EmptyState description="上传模板后可绑定到套餐与订阅文件。" title="暂无模板文件" />}
      </Card>
      {editing ? <RuleTemplateEditor filename={editing} onClose={() => setEditing('')} /> : null}
    </Stack>
  )
}

function OnlineTemplateEditor({ item, onClose }: { item?: TemplateSource; onClose: () => void }) {
  const [form, setForm] = useState({ name: String(item?.name ?? ''), category: String(item?.category ?? 'clash'), template_url: String(item?.template_url ?? ''), rule_source: String(item?.rule_source ?? ''), use_proxy: Boolean(item?.use_proxy), enable_include_all: Boolean(item?.enable_include_all) })
  const [preview, setPreview] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const queryClient = useQueryClient()
  const act = async (previewOnly: boolean) => {
    setBusy(true); setError('')
    try {
      if (previewOnly) {
        const result = await request<JsonRecord>('/api/admin/templates/convert', { method: 'POST', body: JSON.stringify(form) })
        setPreview(String(result.content ?? ''))
      } else {
        await request(item ? `/api/admin/templates/${item.id}` : '/api/admin/templates', { method: item ? 'PUT' : 'POST', body: JSON.stringify(form) })
        await queryClient.invalidateQueries({ queryKey: ['online-templates'] })
        onClose()
      }
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) }
  }
  return (
    <Modal onClose={onClose} opened size="lg" title={item ? '编辑在线源模板' : '新建在线源模板'}>
      <Stack><SimpleGrid cols={2}><TextInput label="名称" onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} required value={form.name} /><Select data={[{ value: 'clash', label: 'Clash / Mihomo' }, { value: 'surge', label: 'Surge' }]} label="类别" onChange={(value) => setForm({ ...form, category: value ?? 'clash' })} value={form.category} /></SimpleGrid><TextInput label="模板 URL" onChange={(event) => setForm({ ...form, template_url: event.currentTarget.value })} type="url" value={form.template_url} /><Textarea autosize label="规则来源" minRows={6} onChange={(event) => setForm({ ...form, rule_source: event.currentTarget.value })} required value={form.rule_source} /><Group><Switch checked={form.use_proxy} label="通过代理获取" onChange={(event) => setForm({ ...form, use_proxy: event.currentTarget.checked })} /><Switch checked={form.enable_include_all} label="包含全部代理" onChange={(event) => setForm({ ...form, enable_include_all: event.currentTarget.checked })} /></Group>{preview ? <Textarea autosize label="转换预览" minRows={10} readOnly value={preview} /> : null}{error ? <ErrorAlert>{error}</ErrorAlert> : null}<Group justify="flex-end"><Button loading={busy} onClick={() => void act(true)} variant="light">转换预览</Button><Button onClick={onClose} variant="default">取消</Button><Button loading={busy} onClick={() => void act(false)}>保存</Button></Group></Stack>
    </Modal>
  )
}

function OnlineTemplates() {
  const [editing, setEditing] = useState<TemplateSource | 'new' | null>(null)
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ['online-templates'], queryFn: async () => listFrom<TemplateSource>(await request('/api/admin/templates'), ['templates', 'items']) })
  const remove = async (item: TemplateSource) => { if (!window.confirm(`确定删除“${item.name}”吗？`)) return; try { await request(`/api/admin/templates/${item.id}`, { method: 'DELETE' }); await queryClient.invalidateQueries({ queryKey: ['online-templates'] }) } catch (reason) { notifications.show({ color: 'red', message: messageOf(reason), title: '删除失败' }) } }
  return (
    <Card padding="lg" shadow="lg" withBorder><Group justify="space-between" mb="md"><Stack gap={0}><Title order={4}>在线源模板</Title><Text c="dimmed" fz="sm">从远程模板与 ACL 规则源生成配置</Text></Stack><Button leftSection={<IconPlus size={17} />} onClick={() => setEditing('new')}>新建</Button></Group>{query.isLoading ? <LoadingState /> : query.data?.length ? <SimpleGrid cols={{ base: 1, md: 2 }}>{query.data.map((item, index) => <Card bg="dark.6" key={String(item.id ?? index)} withBorder><Group justify="space-between"><Stack gap={2}><Text fw={700}>{item.name}</Text><Text c="dimmed" fz="xs">{String(item.category ?? 'clash')} · {item.use_proxy ? '代理获取' : '直连获取'}</Text></Stack><Group gap="xs"><Button onClick={() => setEditing(item)} size="xs" variant="light">编辑</Button><Button color="red" onClick={() => void remove(item)} size="xs" variant="subtle">删除</Button></Group></Group></Card>)}</SimpleGrid> : <EmptyState description="新建一个模板 URL 与规则源组合。" title="暂无在线源模板" />}{editing ? <OnlineTemplateEditor item={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} /> : null}</Card>
  )
}

export function TemplatesPage({ profile, permissions }: { profile: Profile; permissions: Permissions }) {
  const isAdmin = Boolean(permissions.is_admin || profile.is_admin || profile.role === 'admin')
  const metadata = useQuery({ queryKey: ['template-v3'], queryFn: () => request<JsonRecord>('/api/admin/template-v3') })
  return (
    <><PageHeader description="模板文件、在线规则源与 Template V3 元数据" icon={IconBook} title="模板管理" /><Tabs defaultValue="files" keepMounted={false}><Tabs.List mb="md"><Tabs.Tab value="files">模板文件</Tabs.Tab><Tabs.Tab value="online">在线源</Tabs.Tab><Tabs.Tab value="v3">V3 工作台</Tabs.Tab></Tabs.List><Tabs.Panel value="files"><RuleTemplateFiles isAdmin={isAdmin} /></Tabs.Panel><Tabs.Panel value="online"><OnlineTemplates /></Tabs.Panel><Tabs.Panel value="v3"><Card padding="lg" shadow="lg" withBorder>{metadata.isLoading ? <LoadingState /> : <JsonPanel value={metadata.data} />}</Card></Tabs.Panel></Tabs></>
  )
}

type SubscribeFile = JsonRecord & { id?: number | string; name?: string; type?: string; filename?: string }

function SubscriptionFileEditor({ item, nodes, onClose }: { item?: SubscribeFile; nodes: Node[]; onClose: () => void }) {
  const [mode, setMode] = useState(String(item?.type ?? 'create'))
  const [name, setName] = useState(String(item?.name ?? ''))
  const [description, setDescription] = useState(String(item?.description ?? ''))
  const [filename, setFilename] = useState(String(item?.filename ?? 'subscription.yaml'))
  const [url, setUrl] = useState(String(item?.url ?? ''))
  const [shortCode, setShortCode] = useState(String(item?.custom_short_code ?? ''))
  const [template, setTemplate] = useState(String(item?.template_filename ?? ''))
  const [selected, setSelected] = useState<string[]>((Array.isArray(item?.selected_node_ids) ? item.selected_node_ids : []).map(String))
  const [upload, setUpload] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const queryClient = useQueryClient()
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try {
      if (item) {
        await request(`/api/admin/subscribe-files/${item.id}`, { method: 'PUT', body: JSON.stringify({ ...item, name, description, filename, url, custom_short_code: shortCode, template_filename: template, selected_node_ids: selected.map(Number) }) })
      } else if (mode === 'import') {
        await request('/api/admin/subscribe-files/import', { method: 'POST', body: JSON.stringify({ name, description, filename, url }) })
      } else if (mode === 'upload') {
        if (!upload) throw new Error('请选择 YAML 文件。')
        const body = new FormData(); body.append('file', upload); body.append('name', name); body.append('description', description); body.append('filename', filename || upload.name)
        await request('/api/admin/subscribe-files/upload', { method: 'POST', body })
      } else {
        const proxies = nodes.filter((node) => selected.includes(String(node.id))).map((node) => typeof node.clash_config === 'string' ? JSON.parse(node.clash_config) : node.clash_config).filter(Boolean)
        if (!proxies.length) throw new Error('至少选择一个带 Clash 配置的节点。')
        const names = proxies.map((proxy: JsonRecord) => String(proxy.name ?? 'node'))
        const content = JSON.stringify({ 'mixed-port': 7890, mode: 'rule', proxies, 'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: names }], rules: ['MATCH,PROXY'] }, null, 2)
        await request('/api/admin/subscribe-files/create-from-config', { method: 'POST', body: JSON.stringify({ name, description, filename, content }) })
      }
      await queryClient.invalidateQueries({ queryKey: ['subscribe-files'] })
      notifications.show({ color: 'teal', message: '订阅文件已保存', title: name })
      onClose()
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) }
  }
  return (
    <Modal onClose={onClose} opened size="lg" title={item ? '编辑订阅文件' : '添加订阅文件'}>
      <form onSubmit={save}><Stack><SimpleGrid cols={2}><TextInput label="名称" onChange={(event) => setName(event.currentTarget.value)} required value={name} /><Select data={[{ value: 'create', label: '本地节点生成' }, { value: 'import', label: '远程 URL 导入' }, { value: 'upload', label: '上传 YAML' }]} disabled={Boolean(item)} label="类型" onChange={(value) => setMode(value ?? 'create')} value={mode} /></SimpleGrid><TextInput label="说明" onChange={(event) => setDescription(event.currentTarget.value)} value={description} /><SimpleGrid cols={2}><TextInput label="文件名" onChange={(event) => setFilename(event.currentTarget.value)} required value={filename} /><TextInput label="自定义短码" onChange={(event) => setShortCode(event.currentTarget.value)} value={shortCode} /></SimpleGrid>{!item && mode === 'import' ? <TextInput label="远程 URL" onChange={(event) => setUrl(event.currentTarget.value)} required type="url" value={url} /> : null}{!item && mode === 'upload' ? <FileInput accept=".yaml,.yml" label="YAML 文件" onChange={setUpload} required value={upload} /> : null}{(item || mode === 'create') ? <MultiSelect data={nodes.map((node) => ({ value: String(node.id), label: String(node.node_name ?? node.name ?? node.id) }))} label="关联节点" onChange={setSelected} searchable value={selected} /> : null}<TextInput label="Template V3 文件" onChange={(event) => setTemplate(event.currentTarget.value)} placeholder="留空按默认值" value={template} />{error ? <ErrorAlert>{error}</ErrorAlert> : null}<Group justify="flex-end"><Button onClick={onClose} type="button" variant="default">取消</Button><Button loading={busy} type="submit">保存</Button></Group></Stack></form>
    </Modal>
  )
}

export function SubscribeFilesPage() {
  const [editing, setEditing] = useState<SubscribeFile | 'new' | null>(null)
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ['subscribe-files'], queryFn: async () => listFrom<SubscribeFile>(await request('/api/admin/subscribe-files'), ['files', 'subscriptions', 'items']) })
  const nodes = useQuery({ queryKey: ['nodes', 'subscribe-files'], queryFn: async () => listFrom<Node>(await request('/api/admin/nodes'), ['nodes']) })
  const remove = async (item: SubscribeFile) => { if (!window.confirm(`确定删除订阅“${item.name}”吗？`)) return; try { await request(`/api/admin/subscribe-files/${item.id}`, { method: 'DELETE' }); await queryClient.invalidateQueries({ queryKey: ['subscribe-files'] }) } catch (reason) { notifications.show({ color: 'red', message: messageOf(reason), title: '删除失败' }) } }
  return (
    <><PageHeader actions={<Button leftSection={<IconPlus size={17} />} onClick={() => setEditing('new')}>添加订阅</Button>} description="创建、导入或上传订阅文件，并关联节点与模板" icon={IconFolder} title="订阅文件" /><Card padding="lg" shadow="lg" withBorder>{query.isLoading ? <LoadingState /> : query.data?.length ? <ScrollArea><Table highlightOnHover miw={760} verticalSpacing="sm"><Table.Thead><Table.Tr><Table.Th>名称</Table.Th><Table.Th>类型</Table.Th><Table.Th>文件名</Table.Th><Table.Th>短码</Table.Th><Table.Th>模板</Table.Th><Table.Th ta="right">操作</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{query.data.map((item, index) => <Table.Tr key={String(item.id ?? index)}><Table.Td><Text fw={600}>{item.name}</Text></Table.Td><Table.Td><Badge variant="light">{item.type || 'local'}</Badge></Table.Td><Table.Td>{item.filename}</Table.Td><Table.Td>{String(item.custom_short_code ?? item.file_short_code ?? '—')}</Table.Td><Table.Td>{String(item.template_filename ?? '默认')}</Table.Td><Table.Td><Group justify="flex-end"><Button onClick={() => setEditing(item)} size="xs" variant="light">编辑</Button><Button color="red" onClick={() => void remove(item)} size="xs" variant="subtle">删除</Button></Group></Table.Td></Table.Tr>)}</Table.Tbody></Table></ScrollArea> : <EmptyState action={<Button onClick={() => setEditing('new')}>添加订阅</Button>} description="支持本地节点生成、远程导入和文件上传。" title="暂无订阅文件" />}</Card>{editing ? <SubscriptionFileEditor item={editing === 'new' ? undefined : editing} nodes={nodes.data ?? []} onClose={() => setEditing(null)} /> : null}</>
  )
}

type OverrideRecord = JsonRecord & { id?: number | string; name?: string; enabled?: boolean }

interface OverrideForm {
  name: string
  type: string
  mode: string
  hook: string
  content: string
  enabled: boolean
  sort_order: number
}

function OverrideEditor({ kind, item, onClose }: { kind: 'rules' | 'scripts'; item?: OverrideRecord; onClose: () => void }) {
  const [form, setForm] = useState<OverrideForm>({
    name: String(item?.name ?? ''),
    type: String(item?.type ?? 'rules'),
    mode: String(item?.mode ?? 'append'),
    hook: String(item?.hook ?? 'post_fetch'),
    content: String(item?.content ?? (kind === 'scripts' ? 'function main(config) {\n  return config\n}' : '')),
    enabled: item?.enabled !== false,
    sort_order: Number(item?.sort_order ?? 0),
  })
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const queryClient = useQueryClient()
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); const base = kind === 'rules' ? '/api/admin/custom-rules' : '/api/admin/override-scripts'; try { await request(item ? `${base}/${item.id}` : base, { method: item ? 'PUT' : 'POST', body: JSON.stringify(form) }); await queryClient.invalidateQueries({ queryKey: ['overrides'] }); onClose() } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) } }
  return <Modal onClose={onClose} opened size="lg" title={`${item ? '编辑' : '新建'}${kind === 'rules' ? '规则覆写' : '脚本覆写'}`}><form onSubmit={submit}><Stack><TextInput label="名称" onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} required value={String(form.name)} />{kind === 'rules' ? <SimpleGrid cols={2}><Select data={[{ value: 'dns', label: 'DNS' }, { value: 'rules', label: '规则' }, { value: 'rule-providers', label: '规则集' }]} label="类型" onChange={(value) => setForm({ ...form, type: value ?? 'rules' })} value={String('type' in form ? form.type : 'rules')} /><Select data={[{ value: 'append', label: '追加' }, { value: 'prepend', label: '前置' }, { value: 'replace', label: '替换' }]} label="合并模式" onChange={(value) => setForm({ ...form, mode: value ?? 'append' })} value={String('mode' in form ? form.mode : 'append')} /></SimpleGrid> : <Select data={[{ value: 'post_fetch', label: '拉取后' }, { value: 'pre_save_nodes', label: '节点保存前' }]} label="执行钩子" onChange={(value) => setForm({ ...form, hook: value ?? 'post_fetch' })} value={String('hook' in form ? form.hook : 'post_fetch')} />}<Textarea autosize label={kind === 'rules' ? 'YAML 内容' : 'JavaScript'} minRows={16} onChange={(event) => setForm({ ...form, content: event.currentTarget.value })} required value={String(form.content)} /><Switch checked={Boolean(form.enabled)} label="启用" onChange={(event) => setForm({ ...form, enabled: event.currentTarget.checked })} />{error ? <ErrorAlert>{error}</ErrorAlert> : null}<Group justify="flex-end"><Button onClick={onClose} type="button" variant="default">取消</Button><Button loading={busy} type="submit">保存</Button></Group></Stack></form></Modal>
}

export function CustomRulesPage({ permissions }: { permissions: Permissions }) {
  const [tab, setTab] = useState<string | null>('rules'); const [editing, setEditing] = useState<OverrideRecord | 'new' | null>(null); const queryClient = useQueryClient()
  const scriptsEnabled = Boolean(permissions.is_admin || permissions.enable_override_scripts)
  const query = useQuery({ queryKey: ['overrides'], queryFn: async () => { const [rules, scripts] = await Promise.allSettled([request('/api/admin/custom-rules'), scriptsEnabled ? request('/api/admin/override-scripts') : Promise.resolve([])]); return { rules: rules.status === 'fulfilled' ? listFrom<OverrideRecord>(rules.value, ['rules', 'items']) : [], scripts: scripts.status === 'fulfilled' ? listFrom<OverrideRecord>(scripts.value, ['scripts', 'items']) : [] } } })
  const items = tab === 'scripts' ? query.data?.scripts ?? [] : query.data?.rules ?? []
  const remove = async (item: OverrideRecord) => { const base = tab === 'scripts' ? '/api/admin/override-scripts' : '/api/admin/custom-rules'; if (!window.confirm(`确定删除“${item.name}”吗？`)) return; try { await request(`${base}/${item.id}`, { method: 'DELETE' }); await queryClient.invalidateQueries({ queryKey: ['overrides'] }) } catch (reason) { notifications.show({ color: 'red', message: messageOf(reason), title: '删除失败' }) } }
  return <><PageHeader actions={<Button leftSection={<IconPlus size={17} />} onClick={() => setEditing('new')}>新建{tab === 'scripts' ? '脚本' : '规则'}</Button>} description="维护 DNS、规则、规则集与订阅处理脚本" icon={IconFileCode} title="覆写管理" /><Tabs value={tab} onChange={(value) => { setTab(value); setEditing(null) }}><Tabs.List mb="md"><Tabs.Tab value="rules">规则覆写</Tabs.Tab>{scriptsEnabled ? <Tabs.Tab value="scripts">脚本覆写</Tabs.Tab> : null}</Tabs.List><Card padding="lg" shadow="lg" withBorder>{query.isLoading ? <LoadingState /> : items.length ? <SimpleGrid cols={{ base: 1, md: 2 }}>{items.map((item, index) => <Card bg="dark.6" key={String(item.id ?? index)} withBorder><Group justify="space-between"><Stack gap={2}><Text fw={700}>{item.name}</Text><Text c="dimmed" fz="xs">{String(item.type ?? item.hook ?? 'override')} · {item.enabled !== false ? '启用' : '停用'}</Text></Stack><Group gap="xs"><Button onClick={() => setEditing(item)} size="xs" variant="light">编辑</Button><Button color="red" onClick={() => void remove(item)} size="xs" variant="subtle">删除</Button></Group></Group></Card>)}</SimpleGrid> : <EmptyState description="新增一个覆写后，可绑定到订阅文件。" title="暂无覆写" />}</Card></Tabs>{editing ? <OverrideEditor item={editing === 'new' ? undefined : editing} kind={tab === 'scripts' ? 'scripts' : 'rules'} onClose={() => setEditing(null)} /> : null}</>
}
