import { useState, type FormEvent } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Grid,
  Group,
  Modal,
  MultiSelect,
  NumberInput,
  PasswordInput,
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
  IconCalendarPlus,
  IconDeviceFloppy,
  IconEdit,
  IconKey,
  IconPackage,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconUserCog,
  IconUsers,
} from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { listFrom, messageOf, request } from '@/adapters/mmwx/api'
import type { JsonRecord, Node, User } from '@/adapters/mmwx/types'
import { dateText, formatBytes, localDateInputValue } from '@/shared/lib/format'
import { JsonPanel } from '@/shared/ui/json-panel'
import { PageHeader } from '@/shared/ui/page-header'
import { EmptyState, ErrorAlert, LoadingState } from '@/shared/ui/states'

type PackageRecord = JsonRecord & {
  id?: number | string
  name?: string
  description?: string
  traffic_limit_gb?: number
  traffic_limit_bytes?: number
  cycle_days?: number
  speed_limit_mbps?: number
  device_limit?: number
  is_reset?: boolean
  reset_day?: number
  nodes?: Array<number | string>
}

function UserCreate({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({ username: '', nickname: '', email: '', password: '', remark: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [createdPassword, setCreatedPassword] = useState('')
  const queryClient = useQueryClient()
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const result = await request<JsonRecord>('/api/admin/users/create', {
        method: 'POST',
        body: JSON.stringify(form),
      })
      await queryClient.invalidateQueries({ queryKey: ['users'] })
      const password = String(result.password ?? form.password)
      if (password) setCreatedPassword(password)
      else onClose()
      notifications.show({ color: 'teal', message: '用户已创建', title: form.username })
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal onClose={onClose} opened title="创建用户">
      {createdPassword ? (
        <Stack>
          <Alert color="teal" title="用户已创建">请把初始密码安全地交给用户；关闭后不会再次显示。</Alert>
          <Text ff="monospace" fz="lg" fw={700} ta="center">{createdPassword}</Text>
          <Button onClick={() => void navigator.clipboard.writeText(createdPassword)}>复制密码</Button>
          <Button onClick={onClose} variant="light">完成</Button>
        </Stack>
      ) : (
        <form onSubmit={submit}>
          <Stack>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput label="用户名" onChange={(event) => setForm({ ...form, username: event.currentTarget.value })} required value={form.username} />
              <TextInput label="昵称" onChange={(event) => setForm({ ...form, nickname: event.currentTarget.value })} value={form.nickname} />
            </SimpleGrid>
            <TextInput label="邮箱" onChange={(event) => setForm({ ...form, email: event.currentTarget.value })} type="email" value={form.email} />
            <PasswordInput description="留空时由服务端生成随机密码" label="初始密码" onChange={(event) => setForm({ ...form, password: event.currentTarget.value })} value={form.password} />
            <Textarea label="备注" onChange={(event) => setForm({ ...form, remark: event.currentTarget.value })} value={form.remark} />
            {error ? <ErrorAlert>{error}</ErrorAlert> : null}
            <Group justify="flex-end">
              <Button onClick={onClose} type="button" variant="default">取消</Button>
              <Button loading={busy} type="submit">创建用户</Button>
            </Group>
          </Stack>
        </form>
      )}
    </Modal>
  )
}

function UserManager({ user, packages, onClose }: { user: User; packages: PackageRecord[]; onClose: () => void }) {
  const username = String(user.username ?? '')
  const [email, setEmail] = useState(String(user.email ?? ''))
  const [remark, setRemark] = useState(String(user.remark ?? ''))
  const [shortCode, setShortCode] = useState(String(user.custom_user_short_code ?? ''))
  const [newPassword, setNewPassword] = useState('')
  const [packageID, setPackageID] = useState(String(user.package_id ?? ''))
  const [startDate, setStartDate] = useState(() => localDateInputValue())
  const [expireDate, setExpireDate] = useState('')
  const [extendDays, setExtendDays] = useState(30)
  const [speedLimit, setSpeedLimit] = useState<string | number>(user.speed_limit_override === null || user.speed_limit_override === undefined ? '' : Number(user.speed_limit_override))
  const [deviceLimit, setDeviceLimit] = useState<string | number>(user.device_limit_override === null || user.device_limit_override === undefined ? '' : Number(user.device_limit_override))
  const [trafficLimit, setTrafficLimit] = useState<string | number>(user.traffic_limit_override_gb === null || user.traffic_limit_override_gb === undefined ? '' : Number(user.traffic_limit_override_gb))
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const queryClient = useQueryClient()

  const run = async (name: string, path: string, method: string, body: unknown) => {
    setBusy(name)
    setError('')
    setResult('')
    try {
      const response = await request<JsonRecord>(path, { method, body: JSON.stringify(body) })
      await queryClient.invalidateQueries({ queryKey: ['users'] })
      notifications.show({ color: 'teal', message: `${name}已完成`, title: username })
      if (response.password) setResult(`新密码：${String(response.password)}`)
      return true
    } catch (reason) {
      setError(messageOf(reason))
      return false
    } finally {
      setBusy('')
    }
  }

  const saveProfile = async () => {
    const calls = [
      run('更新邮箱', '/api/admin/users/update-email', 'POST', { username, email }),
      run('更新备注', '/api/admin/users/remark', 'POST', { username, remark }),
      run('更新短码', '/api/admin/users/short-code', 'POST', { username, short_code: shortCode }),
    ]
    await Promise.all(calls)
  }

  const resetPassword = async () => {
    await run('重置密码', '/api/admin/users/reset-password', 'POST', {
      username,
      new_password: newPassword,
    })
    setNewPassword('')
  }

  const saveLimits = async () => {
    const toNullable = (value: string | number) => (value === '' ? null : Number(value))
    const first = await run('更新速度与设备限制', '/api/admin/users/limits', 'PUT', {
      username,
      speed_limit_override: toNullable(speedLimit),
      device_limit_override: toNullable(deviceLimit),
    })
    if (first) {
      await run('更新流量限制', '/api/admin/users/traffic-limit', 'PUT', {
        username,
        traffic_limit_override_gb: toNullable(trafficLimit),
      })
    }
  }

  return (
    <Modal onClose={onClose} opened size="xl" title={`管理用户 · ${username}`}>
      <Tabs defaultValue="profile">
        <Tabs.List grow>
          <Tabs.Tab value="profile">资料与安全</Tabs.Tab>
          <Tabs.Tab value="package">套餐</Tabs.Tab>
          <Tabs.Tab value="limits">限制</Tabs.Tab>
          <Tabs.Tab value="raw">原始数据</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel pt="md" value="profile">
          <Stack>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput label="邮箱" onChange={(event) => setEmail(event.currentTarget.value)} type="email" value={email} />
              <TextInput description="2–16 位字母、数字、下划线或横杠；留空恢复自动短码" label="自定义短码" onChange={(event) => setShortCode(event.currentTarget.value)} value={shortCode} />
            </SimpleGrid>
            <Textarea label="备注" onChange={(event) => setRemark(event.currentTarget.value)} value={remark} />
            <Button leftSection={<IconDeviceFloppy size={17} />} loading={busy.includes('更新')} onClick={() => void saveProfile()}>保存资料</Button>
            <Card bg="dark.8" withBorder>
              <Stack>
                <Text fw={600}>重置密码</Text>
                <PasswordInput description="留空时自动生成随机密码" onChange={(event) => setNewPassword(event.currentTarget.value)} value={newPassword} />
                <Button leftSection={<IconKey size={17} />} loading={busy === '重置密码'} onClick={() => void resetPassword()} variant="light">重置密码</Button>
                {result ? <Alert color="teal">{result}</Alert> : null}
              </Stack>
            </Card>
            {user.role !== 'admin' ? (
              <Button
                color={user.is_active !== false ? 'red' : 'teal'}
                loading={busy === '切换状态'}
                onClick={() => void run('切换状态', '/api/admin/users/status', 'POST', { username, is_active: user.is_active === false })}
                variant="light"
              >
                {user.is_active !== false ? '停用账号并下线' : '重新启用账号'}
              </Button>
            ) : null}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel pt="md" value="package">
          <Stack>
            <Select clearable data={packages.map((item) => ({ value: String(item.id), label: String(item.name ?? item.id) }))} label="套餐" onChange={(value) => setPackageID(value ?? '')} value={packageID} />
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput label="开始日期" onChange={(event) => setStartDate(event.currentTarget.value)} type="date" value={startDate} />
              <TextInput description="留空按套餐周期计算" label="到期日期" onChange={(event) => setExpireDate(event.currentTarget.value)} type="date" value={expireDate} />
            </SimpleGrid>
            <Group>
              <Button disabled={!packageID} loading={busy === '分配套餐'} onClick={() => void run('分配套餐', '/api/admin/packages/assign', 'POST', { username, package_id: Number(packageID), start_date: startDate, expire_date: expireDate })}>分配 / 更换套餐</Button>
              <Button color="red" loading={busy === '解绑套餐'} onClick={() => void run('解绑套餐', '/api/admin/packages/unassign', 'POST', { username })} variant="light">解绑套餐</Button>
            </Group>
            <Card bg="dark.8" withBorder>
              <Group align="end">
                <NumberInput label="延长天数" max={3650} min={1} onChange={(value) => setExtendDays(Number(value || 30))} value={extendDays} />
                <Button leftSection={<IconCalendarPlus size={17} />} loading={busy === '延长有效期'} onClick={() => void run('延长有效期', '/api/admin/users/extend', 'POST', { username, days: extendDays })} variant="light">续期</Button>
              </Group>
            </Card>
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel pt="md" value="limits">
          <Stack>
            <Alert color="cyan">空白表示继承套餐；0 表示明确不限；正数表示用户级覆盖。</Alert>
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <NumberInput allowDecimal label="速度上限（Mbps）" min={0} onChange={setSpeedLimit} value={speedLimit} />
              <NumberInput label="设备数量" min={0} onChange={setDeviceLimit} value={deviceLimit} />
              <NumberInput allowDecimal label="流量上限（GB）" min={0} onChange={setTrafficLimit} value={trafficLimit} />
            </SimpleGrid>
            <Button leftSection={<IconDeviceFloppy size={17} />} loading={busy.includes('限制')} onClick={() => void saveLimits()}>保存限制</Button>
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel pt="md" value="raw"><JsonPanel value={user} /></Tabs.Panel>
      </Tabs>
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}
    </Modal>
  )
}

export function UsersPage() {
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [managing, setManaging] = useState<User | null>(null)
  const queryClient = useQueryClient()
  const users = useQuery({
    queryKey: ['users'],
    queryFn: async () => listFrom<User>(await request('/api/admin/users'), ['users']),
  })
  const packages = useQuery({
    queryKey: ['packages'],
    queryFn: async () => listFrom<PackageRecord>(await request('/api/admin/packages'), ['packages']),
  })
  const filtered = (users.data ?? []).filter((user) =>
    `${user.username ?? ''} ${user.nickname ?? ''} ${user.email ?? ''} ${user.remark ?? ''}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  )

  const remove = async (user: User) => {
    if (!window.confirm(`确定永久删除用户“${user.username}”吗？该用户的入站凭据和套餐绑定会一并清理。`)) return
    try {
      await request('/api/admin/users/delete', { method: 'POST', body: JSON.stringify({ username: user.username }) })
      await queryClient.invalidateQueries({ queryKey: ['users'] })
      notifications.show({ color: 'teal', message: '用户已删除', title: String(user.username) })
    } catch (reason) {
      notifications.show({ color: 'red', message: messageOf(reason), title: '删除失败' })
    }
  }

  return (
    <>
      <PageHeader
        actions={<Button leftSection={<IconPlus size={17} />} onClick={() => setCreating(true)}>创建用户</Button>}
        description="管理账号、套餐、订阅权限、速度、设备与流量覆盖"
        icon={IconUsers}
        title="用户管理"
      />
      <Card padding="md" shadow="lg" withBorder>
        <Group justify="space-between" mb="md">
          <TextInput leftSection={<IconSearch size={16} />} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="搜索用户名、昵称或邮箱" value={search} w={{ base: '100%', sm: 330 }} />
          <Button leftSection={<IconRefresh size={17} />} loading={users.isFetching} onClick={() => void users.refetch()} variant="subtle">刷新</Button>
        </Group>
        {users.error ? <ErrorAlert>{messageOf(users.error)}</ErrorAlert> : null}
        {users.isLoading ? (
          <LoadingState />
        ) : filtered.length ? (
          <ScrollArea>
            <Table highlightOnHover miw={850} verticalSpacing="sm">
              <Table.Thead><Table.Tr><Table.Th>用户</Table.Th><Table.Th>角色</Table.Th><Table.Th>套餐</Table.Th><Table.Th>流量</Table.Th><Table.Th>到期</Table.Th><Table.Th>状态</Table.Th><Table.Th ta="right">操作</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {filtered.map((user, index) => (
                  <Table.Tr key={String(user.username ?? index)}>
                    <Table.Td><Stack gap={0}><Text fw={600}>{user.nickname || user.username}</Text><Text c="dimmed" fz="xs">{user.email || user.username}</Text></Stack></Table.Td>
                    <Table.Td><Badge color={user.role === 'admin' ? 'cyan' : 'gray'} variant="light">{user.role === 'admin' ? '管理员' : '用户'}</Badge></Table.Td>
                    <Table.Td>{String(user.package_name ?? '未分配')}</Table.Td>
                    <Table.Td>{formatBytes(user.traffic_used)}</Table.Td>
                    <Table.Td>{dateText(user.package_end_date)}</Table.Td>
                    <Table.Td><Badge color={user.is_active !== false ? (user.is_over_limit ? 'orange' : 'teal') : 'red'} variant="dot">{user.is_active === false ? '停用' : user.is_over_limit ? '超额' : '正常'}</Badge></Table.Td>
                    <Table.Td ta="right"><Group gap="xs" justify="flex-end" wrap="nowrap"><Button leftSection={<IconUserCog size={16} />} onClick={() => setManaging(user)} size="xs" variant="light">管理</Button>{user.role !== 'admin' ? <Button color="red" leftSection={<IconTrash size={16} />} onClick={() => void remove(user)} size="xs" variant="subtle">删除</Button> : null}</Group></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        ) : (
          <EmptyState action={<Button onClick={() => setCreating(true)}>创建用户</Button>} description="创建后即可分配套餐和订阅。" title="暂无用户" />
        )}
      </Card>
      {creating ? <UserCreate onClose={() => setCreating(false)} /> : null}
      {managing ? <UserManager onClose={() => setManaging(null)} packages={packages.data ?? []} user={managing} /> : null}
    </>
  )
}

function PackageEditor({ item, nodes, onClose }: { item?: PackageRecord; nodes: Node[]; onClose: () => void }) {
  const [form, setForm] = useState({
    name: String(item?.name ?? ''),
    description: String(item?.description ?? ''),
    traffic_limit_gb: Number(item?.traffic_limit_gb ?? (item?.traffic_limit_bytes ? Number(item.traffic_limit_bytes) / 1024 ** 3 : 100)),
    cycle_days: Number(item?.cycle_days ?? 30),
    is_reset: Boolean(item?.is_reset),
    reset_day: Number(item?.reset_day ?? 1),
    nodes: (item?.nodes ?? []).map(String),
    speed_limit_mbps: Number(item?.speed_limit_mbps ?? 0),
    device_limit: Number(item?.device_limit ?? 0),
    traffic_mode: String(item?.traffic_mode ?? 'oneway'),
    template_filename: String(item?.template_filename ?? ''),
    surge_template_filename: String(item?.surge_template_filename ?? ''),
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const queryClient = useQueryClient()
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await request(item ? '/api/admin/packages/update' : '/api/admin/packages/create', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          id: item?.id,
          nodes: form.nodes.map(Number),
          node_multipliers: item?.node_multipliers ?? {},
          node_name_overrides: item?.node_name_overrides ?? {},
          node_name_override_enabled: Boolean(item?.node_name_override_enabled),
          node_speed_limits: item?.node_speed_limits ?? {},
          node_device_limits: item?.node_device_limits ?? {},
          auto_speed_rules: item?.auto_speed_rules ?? [],
        }),
      })
      await queryClient.invalidateQueries({ queryKey: ['packages'] })
      notifications.show({ color: 'teal', message: '套餐已保存', title: form.name })
      onClose()
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal onClose={onClose} opened size="lg" title={item ? '编辑套餐' : '创建套餐'}>
      <form onSubmit={submit}>
        <Stack>
          <TextInput label="套餐名称" onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} required value={form.name} />
          <Textarea label="说明" onChange={(event) => setForm({ ...form, description: event.currentTarget.value })} value={form.description} />
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <NumberInput allowDecimal label="流量（GB）" min={0.01} onChange={(value) => setForm({ ...form, traffic_limit_gb: Number(value || 0) })} required value={form.traffic_limit_gb} />
            <NumberInput label="周期（天）" min={1} onChange={(value) => setForm({ ...form, cycle_days: Number(value || 1) })} required value={form.cycle_days} />
            <Select data={[{ value: 'oneway', label: '单向计费' }, { value: 'twoway', label: '双向计费' }]} label="流量口径" onChange={(value) => setForm({ ...form, traffic_mode: value ?? 'oneway' })} value={form.traffic_mode} />
            <NumberInput allowDecimal label="限速（Mbps，0 不限）" min={0} onChange={(value) => setForm({ ...form, speed_limit_mbps: Number(value || 0) })} value={form.speed_limit_mbps} />
            <NumberInput label="设备数（0 不限）" min={0} onChange={(value) => setForm({ ...form, device_limit: Number(value || 0) })} value={form.device_limit} />
            <NumberInput disabled={!form.is_reset} label="每月重置日" max={31} min={1} onChange={(value) => setForm({ ...form, reset_day: Number(value || 1) })} value={form.reset_day} />
          </SimpleGrid>
          <Switch checked={form.is_reset} label="启用每月流量重置" onChange={(event) => setForm({ ...form, is_reset: event.currentTarget.checked })} />
          <MultiSelect data={nodes.map((node) => ({ value: String(node.id), label: `${String(node.node_name ?? node.name ?? node.id)} · ${String(node.protocol ?? '')}` }))} label="包含节点" onChange={(value) => setForm({ ...form, nodes: value })} searchable value={form.nodes} />
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput label="Clash 模板文件" onChange={(event) => setForm({ ...form, template_filename: event.currentTarget.value })} placeholder="留空使用默认" value={form.template_filename} />
            <TextInput label="Surge 模板文件" onChange={(event) => setForm({ ...form, surge_template_filename: event.currentTarget.value })} placeholder="留空使用默认" value={form.surge_template_filename} />
          </SimpleGrid>
          {error ? <ErrorAlert>{error}</ErrorAlert> : null}
          <Group justify="flex-end"><Button onClick={onClose} type="button" variant="default">取消</Button><Button leftSection={<IconDeviceFloppy size={17} />} loading={busy} type="submit">保存套餐</Button></Group>
        </Stack>
      </form>
    </Modal>
  )
}

export function PackagesPage() {
  const [editing, setEditing] = useState<PackageRecord | 'new' | null>(null)
  const queryClient = useQueryClient()
  const packages = useQuery({
    queryKey: ['packages'],
    queryFn: async () => listFrom<PackageRecord>(await request('/api/admin/packages'), ['packages']),
  })
  const nodes = useQuery({
    queryKey: ['nodes', 'package-editor'],
    queryFn: async () => listFrom<Node>(await request('/api/admin/nodes'), ['nodes']),
  })
  const remove = async (item: PackageRecord) => {
    if (!window.confirm(`确定删除套餐“${item.name}”吗？已绑定用户会被解绑。`)) return
    try {
      await request(`/api/admin/packages/${item.id}`, { method: 'DELETE' })
      await queryClient.invalidateQueries({ queryKey: ['packages'] })
      notifications.show({ color: 'teal', message: '套餐已删除', title: String(item.name) })
    } catch (reason) {
      notifications.show({ color: 'red', message: messageOf(reason), title: '删除失败' })
    }
  }
  return (
    <>
      <PageHeader actions={<Button leftSection={<IconPlus size={17} />} onClick={() => setEditing('new')}>创建套餐</Button>} description="配置节点集合、流量周期、倍率、速度与设备策略" icon={IconPackage} title="套餐管理" />
      {packages.error ? <ErrorAlert>{messageOf(packages.error)}</ErrorAlert> : null}
      {packages.isLoading ? (
        <Card withBorder><LoadingState /></Card>
      ) : packages.data?.length ? (
        <Grid>
          {packages.data.map((item, index) => (
            <Grid.Col key={String(item.id ?? index)} span={{ base: 12, sm: 6, xl: 4 }}>
              <Card className="control-surface" h="100%" padding="lg" shadow="lg" withBorder>
                <Stack h="100%">
                  <Group justify="space-between"><Badge variant="light">{item.cycle_days ?? 0} 天</Badge>{item.is_reset ? <Badge color="teal" variant="dot">每月 {item.reset_day} 日重置</Badge> : null}</Group>
                  <Stack gap={2}><Title order={3}>{item.name || '未命名套餐'}</Title><Text c="dimmed" fz="sm">{item.description || '标准订阅套餐'}</Text></Stack>
                  <SimpleGrid cols={3} mt="auto">
                    <Stack gap={0}><Text c="dimmed" fz="xs">流量</Text><Text fw={700}>{Number(item.traffic_limit_gb ?? 0).toFixed(0)} GB</Text></Stack>
                    <Stack gap={0}><Text c="dimmed" fz="xs">速度</Text><Text fw={700}>{item.speed_limit_mbps ? `${item.speed_limit_mbps} M` : '不限'}</Text></Stack>
                    <Stack gap={0}><Text c="dimmed" fz="xs">设备</Text><Text fw={700}>{item.device_limit || '不限'}</Text></Stack>
                  </SimpleGrid>
                  <Group><Button leftSection={<IconEdit size={16} />} onClick={() => setEditing(item)} size="xs" variant="light">编辑</Button><Button color="red" leftSection={<IconTrash size={16} />} onClick={() => void remove(item)} size="xs" variant="subtle">删除</Button></Group>
                </Stack>
              </Card>
            </Grid.Col>
          ))}
        </Grid>
      ) : (
        <Card withBorder><EmptyState action={<Button onClick={() => setEditing('new')}>创建套餐</Button>} description="套餐会把节点、流量与限制策略统一分配给用户。" title="暂无套餐" /></Card>
      )}
      {editing ? <PackageEditor item={editing === 'new' ? undefined : editing} nodes={nodes.data ?? []} onClose={() => setEditing(null)} /> : null}
    </>
  )
}
