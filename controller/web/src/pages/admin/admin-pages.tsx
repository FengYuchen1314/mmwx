import { useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  FileInput,
  Group,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconActivity,
  IconBell,
  IconCertificate,
  IconCloudDownload,
  IconDatabase,
  IconGauge,
  IconInfoCircle,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconShieldLock,
  IconTerminal2,
  IconTool,
} from '@tabler/icons-react'

import { download, messageOf, request } from '@/adapters/mmwx/api'
import { localDateInputValue } from '@/shared/lib/format'
import { correspondingSourceUrl, remnawaveSourceUrl } from '@/shared/lib/source'
import {
  DataBrowser,
  JsonSettings,
  RequestRunner,
  type EndpointDefinition,
} from '@/shared/ui/api-workspace'
import { JsonPanel } from '@/shared/ui/json-panel'
import { PageHeader } from '@/shared/ui/page-header'

const trafficViews = [
  { id: 'servers', title: '服务器实时流量', path: '/api/admin/traffic/servers', description: '各远程服务器当前流量、速率与状态。' },
  { id: 'users', title: '用户实时流量', path: '/api/admin/traffic/users', description: '用户级流量、限额和当前速率。' },
  { id: 'snapshots', title: '服务器快照', path: '/api/admin/traffic/snapshots', description: '服务器流量采样历史。' },
  { id: 'nodes', title: '节点快照', path: '/api/admin/traffic/node-snapshots', description: '今日节点流量基线快照。', dated: true },
  { id: 'user-snapshots', title: '用户快照', path: '/api/admin/traffic/user-snapshots', description: '今日用户流量基线快照。', dated: true },
  { id: 'system', title: '系统流量快照', path: '/api/admin/traffic/server-system-snapshots', description: '今日服务器系统网卡基线。', dated: true },
  { id: 'server-period', title: '服务器周期汇总', path: '/api/admin/traffic/server-period-totals', description: '从今日零点起的服务器汇总。', dated: true },
  { id: 'user-period', title: '用户周期汇总', path: '/api/admin/traffic/user-period-totals', description: '从今日零点起的用户汇总。', dated: true },
  { id: 'node-totals', title: '节点汇总', path: '/api/admin/traffic/node-totals', description: '从今日零点起的节点累计流量与连接。', dated: true },
  { id: 'connections', title: '用户连接', path: '/api/admin/traffic/user-connections', description: '活跃连接和设备观测。' },
] as const

export function TrafficPage() {
  const [active, setActive] = useState<string>(trafficViews[0].id)
  const view = trafficViews.find((item) => item.id === active) ?? trafficViews[0]
  const path = 'dated' in view && view.dated ? `${view.path}?date=${localDateInputValue()}` : view.path
  return (
    <Stack>
      <PageHeader description="从主控账本查看服务器、节点与用户的实时和周期数据。" icon={IconActivity} title="流量中心" />
      <Tabs onChange={(value) => value && setActive(value)} value={active} variant="pills">
        <Tabs.List mb="md">
          {trafficViews.map((item) => <Tabs.Tab key={item.id} value={item.id}>{item.title}</Tabs.Tab>)}
        </Tabs.List>
        <DataBrowser description={view.description} path={path} title={view.title} />
      </Tabs>
    </Stack>
  )
}

const certificateActions: EndpointDefinition[] = [
  { group: '证书', title: '创建 ACME 证书', description: '使用已保存的 DNS 凭据申请证书。', method: 'POST', path: '/api/admin/certificates/create', body: { domain: 'example.com', email: 'admin@example.com', provider: 'letsencrypt', challenge_mode: 'dns', dns_provider_id: 1, auto_renew: true, auto_deploy: false, deploy_target: 'none', remote_server_id: 0 } },
  { group: '证书', title: '生成自签证书', description: '为指定受管服务器生成并下发自签证书。', method: 'POST', path: '/api/admin/certificates/self-signed', body: { server_id: 1, domain: 'example.com' }, dangerous: true },
  { group: '证书', title: '续期证书', description: '立即执行一次证书续期。', method: 'POST', path: '/api/admin/certificates/renew', body: { id: 1 }, dangerous: true },
  { group: '证书', title: '部署证书', description: '保存部署路径，并把有效证书部署到主控和远程服务器。', method: 'POST', path: '/api/admin/certificates/deploy', body: { id: 1, deploy_target: 'nginx', deploy_cert_path: '/usr/local/nginx/cert/example.com.pem', deploy_key_path: '/usr/local/nginx/cert/example.com.key' }, dangerous: true },
  { group: 'HTTPS', title: '主控证书状态', description: '检查当前主控 HTTPS 证书与部署状态。', method: 'GET', path: '/api/admin/master-cert-status' },
  { group: 'HTTPS', title: '启用主控 HTTPS', description: '校验证书覆盖域名后切换主控监听。', method: 'POST', path: '/api/admin/enable-https', body: { certificate_id: 1, domain: 'panel.example.com' }, dangerous: true },
  { group: 'DNS', title: '添加 DNS 提供商', description: '保存 DNS API 凭据供 ACME DNS-01 使用。', method: 'POST', path: '/api/admin/dns-providers/create', body: { name: 'Cloudflare', provider_type: 'cloudflare', credentials: '{"CF_DNS_API_TOKEN":""}' } },
]

function CertificateUploader() {
  const [domain, setDomain] = useState('')
  const [certificate, setCertificate] = useState<File | null>(null)
  const [privateKey, setPrivateKey] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const upload = async () => {
    if (!domain.trim() || !certificate || !privateKey) return
    setBusy(true); setError('')
    try {
      await request('/api/admin/certificates/upload', { method: 'POST', body: JSON.stringify({ domain: domain.trim(), cert_pem: await certificate.text(), key_pem: await privateKey.text() }) })
      setCertificate(null); setPrivateKey(null)
      notifications.show({ color: 'teal', message: '证书材料已校验并保存', title: domain })
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) }
  }
  return <Card padding="lg" shadow="lg" withBorder><Stack><Title order={4}>上传已有证书</Title><Text c="dimmed" fz="sm">上传 PEM 证书链和私钥；浏览器只会把内容发送给当前主控。</Text><TextInput label="证书域名" onChange={(event) => setDomain(event.currentTarget.value)} placeholder="example.com" value={domain} /><SimpleGrid cols={{ base: 1, sm: 2 }}><FileInput accept=".pem,.crt,.cer" clearable label="证书链" onChange={setCertificate} value={certificate} /><FileInput accept=".pem,.key" clearable label="私钥" onChange={setPrivateKey} value={privateKey} /></SimpleGrid>{error ? <Alert color="red">{error}</Alert> : null}<Button disabled={!domain.trim() || !certificate || !privateKey} loading={busy} onClick={() => void upload()}>校验并上传</Button></Stack></Card>
}

function CertificateDownload() {
  const [id, setID] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async () => {
    const certificateID = Number(id)
    if (!Number.isInteger(certificateID) || certificateID <= 0) return
    setBusy(true); setError('')
    try { await download(`/api/admin/certificates/download?id=${certificateID}`) }
    catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) }
  }
  return <Card padding="lg" shadow="lg" withBorder><Stack><Title order={4}>下载证书材料</Title><Text c="dimmed" fz="sm">输入证书 ID，下载包含 fullchain.pem 和 privkey.pem 的 ZIP。</Text><Group align="end"><TextInput label="证书 ID" min={1} onChange={(event) => setID(event.currentTarget.value)} placeholder="1" type="number" value={id} style={{ flex: 1 }} /><Button disabled={!Number(id)} leftSection={<IconCloudDownload size={17} />} loading={busy} onClick={() => void run()}>下载 ZIP</Button></Group>{error ? <Alert color="red">{error}</Alert> : null}</Stack></Card>
}

export function CertificatesPage() {
  return (
    <Stack>
      <PageHeader description="统一管理 ACME、自签证书、自动续期、部署目标与 DNS 凭据。" icon={IconCertificate} title="证书与 DNS" />
      <SimpleGrid cols={{ base: 1, xl: 2 }}>
        <DataBrowser description="包括有效期、续期和部署状态。" path="/api/admin/certificates" title="证书清单" />
        <DataBrowser description="敏感字段由后端隐藏。" path="/api/admin/dns-providers" title="DNS 提供商" />
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, xl: 2 }}><CertificateUploader /><CertificateDownload /></SimpleGrid>
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        {certificateActions.map((item) => <RequestRunner definition={item} key={item.path + item.title} />)}
      </SimpleGrid>
    </Stack>
  )
}

const monitorActions: EndpointDefinition[] = [
  { group: '测速端', title: '测速端清单', description: '在线状态、版本与最后心跳。', method: 'GET', path: '/api/admin/speedtest/testers' },
  { group: '测速端', title: '测速结果', description: '最近的节点测速结果。', method: 'GET', path: '/api/admin/speedtest/results?limit=100' },
  { group: '测速端', title: 'Mihomo 状态', description: '检查本地主控测速核心。', method: 'GET', path: '/api/admin/speedtest/mihomo-status' },
  { group: '测速端', title: '检查更新', description: '比较所有测速端与最新版本。', method: 'GET', path: '/api/admin/speedtest/testers/update-info' },
  { group: '测速端', title: '更新全部测速端', description: '更新所有在线且平台受支持的测速端。', method: 'POST', path: '/api/admin/speedtest/testers/update-all', body: {}, dangerous: true },
  { group: '探针', title: 'CDN 地区', description: '查看探针地区与 CDN 映射。', method: 'GET', path: '/api/admin/probe/regions' },
]

export function MonitoringPage() {
  return (
    <Stack>
      <PageHeader description="管理测速执行端、结果和公开探针的访问与展示策略。" icon={IconGauge} title="测速与探针" />
      <JsonSettings description="设置公开入口、登录阻断、显示标题和伪装目标。" getPath="/api/admin/system-settings/probe-disguise" title="公开探针策略" />
      <SimpleGrid cols={{ base: 1, lg: 2 }}>{monitorActions.map((item) => <RequestRunner definition={item} key={item.title} />)}</SimpleGrid>
    </Stack>
  )
}

const notificationActions: EndpointDefinition[] = [
  { group: '通知', title: '发送测试通知', description: '按当前渠道设置发送测试消息。', method: 'POST', path: '/api/admin/notify-config/test', body: { channel: 'telegram' } },
  { group: '通知', title: '预览通知', description: '渲染通知模板但不发送。', method: 'POST', path: '/api/admin/notify-config/preview', body: { event: 'traffic_warning' } },
  { group: '公告', title: '公告列表', description: '查看草稿、计划中和已发布公告。', method: 'GET', path: '/api/admin/announcements' },
  { group: '公告', title: '创建公告', description: '创建站内公告。', method: 'POST', path: '/api/admin/announcements', body: { title: '维护通知', body: '', type: 'info', enabled: true } },
  { group: 'Telegram', title: '机器人状态', description: '查看 Telegram Bot 配置及运行状态。', method: 'GET', path: '/api/admin/system-settings/tgbot' },
  { group: 'Telegram', title: '绑定邀请码', description: '查看当前 Telegram 绑定邀请码。', method: 'GET', path: '/api/admin/tgbot/invites' },
]

export function NotificationsPage() {
  return (
    <Stack>
      <PageHeader description="设置事件通知渠道、站内公告和 Telegram 机器人。" icon={IconBell} title="通知与公告" />
      <SimpleGrid cols={{ base: 1, xl: 2 }}>
        <JsonSettings description="流量、到期、离线和系统事件的推送渠道。" getPath="/api/admin/notify-config" title="通知策略" />
        <JsonSettings description="Bot Token、管理员会话与交互行为。" getPath="/api/admin/system-settings/tgbot" title="Telegram Bot" />
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, lg: 2 }}>{notificationActions.map((item) => <RequestRunner definition={item} key={item.title} />)}</SimpleGrid>
    </Stack>
  )
}

const logViews = [
  ['系统日志', '/api/admin/logs/system?lines=1000', '主控最近 1000 行日志。'],
  ['Agent 日志', '/api/admin/logs/agent?server_id=1&service=agent&lines=1000', '修改 server_id 查看指定服务器。'],
  ['任务运行', '/api/admin/tasks/runs?limit=100&offset=0', '后台任务运行记录。'],
  ['安全事件', '/api/admin/security/events?limit=200', '登录、探测和封禁审计事件。'],
] as const

function DebugLogTools() {
  const [value, setValue] = useState<unknown>()
  const [downloadPath, setDownloadPath] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const run = async (name: string, path: string, method: 'GET' | 'POST') => {
    setBusy(name); setError('')
    try {
      const result = await request<Record<string, unknown>>(path, { method, body: method === 'POST' ? '{}' : undefined })
      setValue(result)
      setDownloadPath(String(result.download_url ?? ''))
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }
  const save = async () => {
    if (!downloadPath) return
    setBusy('download'); setError('')
    try { await download(downloadPath); setDownloadPath('') }
    catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }
  return <Card padding="lg" shadow="lg" withBorder><Stack><Group justify="space-between"><Stack gap={0}><Title order={4}>个人调试日志</Title><Text c="dimmed" fz="sm">临时开启详细日志，最多持续 5 分钟；关闭后可下载一次。</Text></Stack><Badge color="orange" variant="light">含敏感诊断信息</Badge></Group><Group><Button loading={busy === 'status'} onClick={() => void run('status', '/api/user/debug/status', 'GET')} variant="subtle">查看状态</Button><Button loading={busy === 'enable'} onClick={() => void run('enable', '/api/user/debug/enable', 'POST')} variant="light">开启</Button><Button loading={busy === 'tail'} onClick={() => void run('tail', '/api/user/debug/tail?lines=200', 'GET')} variant="light">读取最近日志</Button><Button color="orange" loading={busy === 'disable'} onClick={() => void run('disable', '/api/user/debug/disable', 'POST')} variant="light">关闭并生成文件</Button>{downloadPath ? <Button leftSection={<IconCloudDownload size={17} />} loading={busy === 'download'} onClick={() => void save()}>下载日志</Button> : null}</Group>{error ? <Alert color="red">{error}</Alert> : null}{value !== undefined ? <JsonPanel value={value} /> : null}</Stack></Card>
}

export function LogsPage() {
  const [active, setActive] = useState<string>(logViews[0][1])
  const view = logViews.find((item) => item[1] === active) ?? logViews[0]
  return (
    <Stack>
      <PageHeader description="集中查看主控、Agent、后台任务和安全审计记录。" icon={IconTerminal2} title="日志与安全" />
      <Tabs onChange={(value) => value && setActive(value)} value={active} variant="pills">
        <Tabs.List mb="md">{logViews.map(([title, path]) => <Tabs.Tab key={path} value={path}>{title}</Tabs.Tab>)}</Tabs.List>
        <DataBrowser description={view[2]} path={view[1]} title={view[0]} />
      </Tabs>
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <DataBrowser description="当前被限制的访问来源。" path="/api/admin/security/bans?limit=200" title="IP 封禁" />
        <DataBrowser description="可手动执行的后台任务类型。" path="/api/admin/tasks/types" title="任务类型" />
      </SimpleGrid>
      <DebugLogTools />
    </Stack>
  )
}

const systemSections = [
  ['品牌信息', '站点名称和品牌文本；新前端不会读取旧壁纸与旧主题字段。', '/api/admin/system-settings/branding', '/api/admin/system-settings/branding', 'POST', 'branding'],
  ['主控与订阅地址', 'Agent 回连和订阅生成使用的外部地址。', '/api/admin/system-settings/master-url', '/api/admin/system-settings/master-url', 'PUT', ''],
  ['采集间隔', '心跳、速度、流量和状态上报间隔。', '/api/admin/system-settings/intervals', '/api/admin/system-settings/intervals', 'PUT', ''],
  ['仪表盘刷新', '控制浏览器实时数据刷新频率。', '/api/system-config/refetch-interval', '/api/admin/system-settings/dashboard-refresh', 'PUT', ''],
  ['短链接', '订阅短链与自定义短码策略。', '/api/admin/system-settings/short-link', '/api/admin/system-settings/short-link', 'PUT', ''],
  ['节点倍率前缀', '节点名称中倍率信息的输出格式。', '/api/admin/system-settings/node-name-multiplier-prefix', '/api/admin/system-settings/node-name-multiplier-prefix', 'PUT', ''],
  ['普通用户权限', '普通用户可见页面、能力与配额。', '/api/admin/system-settings/user-permissions', '/api/admin/system-settings/user-permissions', 'PUT', ''],
  ['默认模板', '新用户与订阅文件的默认模板。', '/api/admin/system-settings/default-template', '/api/admin/system-settings/default-template', 'PUT', ''],
] as const

export function SystemSettingsPage() {
  const [section, setSection] = useState<string>(systemSections[0][2])
  const item = systemSections.find((entry) => entry[2] === section) ?? systemSections[0]
  return (
    <Stack>
      <PageHeader description="按后端原生配置边界保存，避免多个设置互相覆盖。" icon={IconSettings} title="系统设置" />
      <Select data={systemSections.map(([label, , value]) => ({ label, value }))} label="配置分区" onChange={(value) => value && setSection(value)} value={section} />
      <JsonSettings description={item[1]} getPath={item[2]} key={item[2]} method={item[4]} readKey={item[5] || undefined} savePath={item[3]} title={item[0]} />
      {section === '/api/admin/system-settings/branding' ? <BrandingLogoUploader /> : null}
    </Stack>
  )
}

function BrandingLogoUploader() {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const upload = async () => {
    if (!file) return
    setBusy(true); setError('')
    try {
      const body = new FormData(); body.append('logo', file)
      await request('/api/admin/system-settings/branding/logo', { method: 'POST', body })
      setFile(null); notifications.show({ color: 'teal', message: '新 Logo 已上传', title: '品牌信息' })
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) }
  }
  return <Card padding="lg" shadow="lg" withBorder><Stack><Title order={4}>品牌 Logo</Title><Text c="dimmed" fz="sm">支持 PNG、JPG、WebP、GIF、SVG 和 ICO，最大 2 MB。新界面不会读取旧登录壁纸或旧主题。</Text><FileInput accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon" clearable label="选择 Logo" onChange={setFile} value={file} />{error ? <Alert color="red">{error}</Alert> : null}<Button disabled={!file} loading={busy} onClick={() => void upload()}>上传 Logo</Button></Stack></Card>
}

const advancedSections = [
  ['安全与 Turnstile', '登录、订阅频率限制和验证码。', '/api/admin/security-settings'],
  ['Agent 日志', '是否采集远程 Agent 日志。', '/api/admin/system-settings/agent-log'],
  ['覆写脚本', '控制用户是否可执行订阅覆写脚本。', '/api/admin/system-settings/override-scripts'],
  ['订阅输出格式', '订阅格式、兼容模式和输出选项。', '/api/admin/system-settings/subscription-output-format'],
  ['静默模式', '异常时的静默和超时策略。', '/api/admin/system-settings/silent-mode'],
  ['传输加密要求', 'Agent HTTP 与 WebSocket 的加密策略。', '/api/admin/system-settings/require-encryption'],
  ['妙妙屋功能', '模块功能开关。', '/api/admin/system-settings/miaomiaowu-features'],
  ['外部 HTTPS', '反向代理托管的 HTTPS 状态。', '/api/admin/system-settings/external-https'],
] as const

export function AdvancedSettingsPage() {
  return (
    <Stack>
      <PageHeader description="安全、Agent 行为和订阅生成的低层控制项。" icon={IconShieldLock} title="高级设置" />
      <Alert color="orange" icon={<IconInfoCircle size={18} />} title="谨慎保存">这些设置会影响 Agent 通信或所有订阅输出。保存前请确认字段含义，复杂改动建议先备份。</Alert>
      <SimpleGrid cols={{ base: 1, xl: 2 }}>
        {advancedSections.map(([title, description, path]) => <JsonSettings description={description} getPath={path} key={path} title={title} />)}
      </SimpleGrid>
    </Stack>
  )
}

const dataActions: EndpointDefinition[] = [
  { group: '版本', title: '检查更新', description: '查询控制器最新可用版本。', method: 'GET', path: '/api/admin/update/check' },
  { group: '版本', title: '应用更新', description: '下载并切换控制器版本，服务可能重启。', method: 'POST', path: '/api/admin/update/apply', body: {}, dangerous: true },
  { group: '版本', title: '流式应用更新', description: '填写检查更新返回的目标版本，实时显示下载与切换进度。', method: 'GET', path: '/api/admin/update/apply-sse?channel=stable&target=v0.1.16', dangerous: true, stream: true },
  { group: '数据库', title: '数据库状态', description: '查看当前数据库驱动、连接和迁移状态。', method: 'GET', path: '/api/admin/database/status' },
  { group: '数据库', title: '测试连接', description: '测试目标数据库配置。', method: 'POST', path: '/api/admin/database/test', body: { driver: 'sqlite', path: 'data/mmwx.db' } },
  { group: '迁移', title: '导入妙妙屋备份', description: '把上传或拉取接口返回的临时路径填入后执行迁移。', method: 'POST', path: '/api/admin/migrate/import-mmw', body: { db_path: '/tmp/mmwx-migrate/example/mmw.db', subscribes_dir: '/tmp/mmwx-migrate/example/subscribes' }, dangerous: true },
]

function BackupRestore() {
  const [file, setFile] = useState<File | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const restore = async () => {
    if (!file || !window.confirm('恢复会覆盖当前数据；如果备份包含数据库，主控还会自动重启。确定继续吗？')) return
    setBusy(true); setError('')
    try {
      const body = new FormData(); body.append('backup', file); if (passphrase) body.append('passphrase', passphrase)
      await request('/api/admin/backup/restore', { method: 'POST', body })
      notifications.show({ color: 'teal', message: '备份已恢复，主控可能正在重启', title: '恢复完成' })
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) }
  }
  return <Card padding="lg" shadow="lg" withBorder><Stack><Title order={4}>恢复完整备份</Title><Text c="dimmed" fz="sm">选择由 MMWX 导出的 ZIP；旧版加密备份还需要原密码。</Text><FileInput accept=".zip,.bak,.mmwx" clearable label="备份文件" onChange={setFile} value={file} /><PasswordInput label="旧版备份密码（可选）" onChange={(event) => setPassphrase(event.currentTarget.value)} value={passphrase} />{error ? <Alert color="red">{error}</Alert> : null}<Button color="orange" disabled={!file} loading={busy} onClick={() => void restore()} variant="light">验证并恢复</Button></Stack></Card>
}

function LegacyMigrationUpload() {
  const [file, setFile] = useState<File | null>(null)
  const [stage, setStage] = useState<Record<string, unknown> | null>(null)
  const [result, setResult] = useState<Record<string, unknown> | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const upload = async () => {
    if (!file) return
    setBusy('upload'); setError(''); setResult(null)
    try {
      const body = new FormData(); body.append('backup', file)
      setStage(await request<Record<string, unknown>>('/api/admin/migrate/upload-mmw-backup', { method: 'POST', body }))
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }
  const importBackup = async () => {
    const dbPath = String(stage?.db_path ?? '')
    if (!dbPath || !window.confirm('导入会把旧妙妙屋数据合并到当前实例，确定继续吗？')) return
    setBusy('import'); setError('')
    try {
      setResult(await request<Record<string, unknown>>('/api/admin/migrate/import-mmw', { method: 'POST', body: JSON.stringify({ db_path: dbPath, subscribes_dir: String(stage?.subscribes_dir ?? '') }) }))
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }
  return <Card padding="lg" shadow="lg" withBorder><Stack><Title order={4}>导入旧妙妙屋备份</Title><Text c="dimmed" fz="sm">上传旧面板导出的 ZIP。后端先隔离解压并验证，再由你确认合并数据和订阅文件。</Text><Group align="end"><FileInput accept=".zip,application/zip" clearable label="旧版 ZIP 备份" onChange={(value) => { setFile(value); setStage(null); setResult(null) }} value={file} style={{ flex: 1 }} /><Button disabled={!file} loading={busy === 'upload'} onClick={() => void upload()} variant="light">上传并验证</Button></Group>{stage ? <Card bg="dark.6" padding="sm" withBorder><Stack gap={3}><Text fw={600}>验证通过</Text><Text c="dimmed" fz="xs">数据库：{String(stage.db_path ?? '—')}</Text><Text c="dimmed" fz="xs">订阅文件：{String(stage.subscribe_count ?? 0)} 个 · 备份大小：{String(stage.size_bytes ?? 0)} 字节</Text><Button color="orange" loading={busy === 'import'} onClick={() => void importBackup()} variant="light">确认导入</Button></Stack></Card> : null}{result ? <Alert color="teal" title="导入完成">{String(result.message ?? '旧版数据已合并')}</Alert> : null}{error ? <Alert color="red">{error}</Alert> : null}</Stack></Card>
}

export function DataPage() {
  return (
    <Stack>
      <PageHeader
        actions={<Button leftSection={<IconCloudDownload size={17} />} onClick={() => void download('/api/admin/backup/download')}>下载备份</Button>}
        description="备份、恢复、数据库迁移、控制器版本与开放源码信息。"
        icon={IconDatabase}
        title="数据与版本"
      />
      <Card padding="lg" shadow="lg" withBorder>
        <Group align="flex-start" wrap="nowrap">
          <ThemeIcon size="xl" variant="light"><IconInfoCircle size={22} /></ThemeIcon>
          <Stack gap={4}>
            <Group><Title order={4}>开放源码与上游</Title><Badge color="cyan" variant="light">AGPL-3.0-only</Badge></Group>
            <Text c="dimmed" fz="sm">本前端基于 Remnawave Frontend 的设计系统进行二次开发，业务模型和 API 适配由 MMWX 重写。</Text>
            <Group gap="lg">
              <Text component="a" href={correspondingSourceUrl} rel="noreferrer" target="_blank" td="underline">本项目源码</Text>
              <Text component="a" href={remnawaveSourceUrl} rel="noreferrer" target="_blank" td="underline">上游基线 c2c9ba3</Text>
            </Group>
          </Stack>
        </Group>
      </Card>
      <SimpleGrid cols={{ base: 1, xl: 2 }}><BackupRestore /><LegacyMigrationUpload /></SimpleGrid>
      <SimpleGrid cols={{ base: 1, lg: 2 }}>{dataActions.map((item) => <RequestRunner definition={item} key={item.title} />)}</SimpleGrid>
    </Stack>
  )
}

const endpoints: EndpointDefinition[] = [
  { group: '远程服务', title: '服务状态', description: '目标 Agent 上所有受管服务。', method: 'GET', path: '/api/admin/remote/services/status?server_id=1' },
  { group: '远程服务', title: '系统信息', description: 'CPU、内存、磁盘与网络。', method: 'GET', path: '/api/admin/remote/system/info?server_id=1' },
  { group: '远程服务', title: '重启 Xray', description: '远程重启 Xray 服务。', method: 'POST', path: '/api/admin/remote/services/control?server_id=1', body: { service: 'xray', action: 'restart' }, dangerous: true },
  { group: '远程服务', title: '升级 Agent', description: '流式升级指定远程 Agent，并显示服务端进度。', method: 'POST', path: '/api/admin/remote/agent/upgrade-stream?server_id=1', body: {}, dangerous: true, stream: true },
  { group: '远程服务', title: '安装 Xray', description: '在指定 Agent 流式安装或升级 Xray。', method: 'POST', path: '/api/admin/remote/xray/install-stream?server_id=1', body: {}, dangerous: true, stream: true },
  { group: '远程服务', title: '移除 Xray', description: '从指定 Agent 移除 Xray，并显示服务端进度。', method: 'POST', path: '/api/admin/remote/xray/remove-stream?server_id=1', body: {}, dangerous: true, stream: true },
  { group: '远程服务', title: '移除 Nginx', description: '从指定 Agent 移除 Nginx，并显示服务端进度。', method: 'POST', path: '/api/admin/remote/nginx/remove-stream?server_id=1', body: {}, dangerous: true, stream: true },
  { group: 'Xray', title: '读取配置', description: '读取目标 Agent 完整 Xray 配置。', method: 'GET', path: '/api/admin/remote/xray/config?server_id=1' },
  { group: 'Xray', title: '测试配置', description: '在 Agent 上校验但不应用。', method: 'POST', path: '/api/admin/remote/xray/test-config?server_id=1', body: { config: '{}' } },
  { group: 'Xray', title: '系统配置', description: '读取日志、API 和 policy 公共片段。', method: 'GET', path: '/api/admin/remote/xray/system-config?server_id=1' },
  { group: 'Xray', title: '生成 X25519', description: '生成 Reality 密钥对。', method: 'POST', path: '/api/admin/xray/generate-x25519', body: {} },
  { group: 'Xray', title: '生成加密密钥', description: '生成 VLESS Encryption 配置。', method: 'POST', path: '/api/admin/xray/generate-keys', body: { type: 'mlkem768x25519plus', encryptionType: 'x25519' } },
  { group: 'Nginx', title: '配置文件', description: '读取远程 Nginx 配置文件。', method: 'GET', path: '/api/admin/remote/nginx/config/files?server_id=1' },
  { group: 'Nginx', title: '网站清单', description: '读取受管网站。', method: 'GET', path: '/api/admin/remote/nginx/websites?server_id=1' },
  { group: 'Nginx', title: '安装 Nginx', description: '在目标服务器安装受管 Nginx。', method: 'POST', path: '/api/admin/remote/nginx/install?server_id=1', body: {}, dangerous: true },
  { group: 'WARP', title: 'WARP 状态', description: '检查目标服务器 WARP。', method: 'GET', path: '/api/admin/remote/warp/status?server_id=1' },
  { group: 'WARP', title: '安装 WARP', description: '在目标服务器部署 WARP。', method: 'POST', path: '/api/admin/remote/warp/install?server_id=1', body: {}, dangerous: true },
  { group: '网络', title: '网卡清单', description: '读取服务器网卡。', method: 'GET', path: '/api/admin/server-nics?server_id=1' },
  { group: '网络', title: '批量 TCP Ping', description: '检测多目标连通性；每个目标可单独设置协议与超时。', method: 'POST', path: '/api/admin/tcping/batch', body: [{ host: 'example.com', port: 443, timeout: 5000, protocol: 'vless' }] },
  { group: '网络', title: '远端 TCP Ping', description: '让指定 Agent 主动探测一组任意目标。', method: 'POST', path: '/api/admin/remote/tcping', body: { server_id: 1, targets: ['1.2.3.4:443'], timeout_ms: 3000 } },
  { group: '网络', title: 'DNS 解析诊断', description: '通过主控解析域名，也可输入 host:port。', method: 'GET', path: '/api/dns/resolve?hostname=example.com' },
  { group: '路由', title: '远程出站', description: '读取目标 Agent 当前出站。', method: 'GET', path: '/api/admin/remote/outbounds?server_id=1' },
  { group: '路由', title: '远程路由', description: '读取目标 Agent 当前路由。', method: 'GET', path: '/api/admin/remote/routing?server_id=1' },
  { group: '路由', title: '隧道清单', description: '读取入口和路由隧道。', method: 'GET', path: '/api/admin/tunnels' },
  { group: 'Reality', title: '域名池', description: '读取可用 Reality 目标。', method: 'GET', path: '/api/admin/remote/reality-domains?server_id=1' },
  { group: 'Reality', title: '添加自定义域名', description: '为指定服务器加入 Reality 域名池。', method: 'POST', path: '/api/admin/remote/reality-domains/custom', body: { server_id: 1, domain: 'www.example.com:443' } },
  { group: '快照', title: '快照历史', description: '读取 Agent Xray 配置快照。', method: 'GET', path: '/api/admin/xray-snapshots/list?server_id=1' },
  { group: '快照', title: '恢复状态', description: '检查主控与 Agent 配置漂移。', method: 'GET', path: '/api/admin/xray-snapshots/recovery-status?server_id=1' },
  { group: '共享', title: '服务器共享', description: '读取服务器分享关系。', method: 'GET', path: '/api/admin/server-share/list?server_id=1' },
  { group: 'DDNS', title: 'DDNS 状态', description: '读取服务器解析状态。', method: 'GET', path: '/api/admin/servers/1/ddns-status' },
  { group: 'DDNS', title: '执行 DDNS 测试', description: '立即执行一次解析更新。', method: 'POST', path: '/api/admin/servers/1/ddns-test', body: {} },
  { group: '用户', title: '子账号', description: '读取指定主账号的子账号。', method: 'GET', path: '/api/admin/users/subaccounts?username=demo' },
  { group: '用户', title: '用户限制', description: '保存速度和设备限制覆盖。', method: 'PUT', path: '/api/admin/users/limits', body: { username: 'demo', speed_limit_override: null, device_limit_override: null }, dangerous: true },
  { group: '用户', title: '节点限制', description: '保存节点级速度和设备覆盖。', method: 'PUT', path: '/api/admin/users/node-limits', body: { username: 'demo', node_speed_overrides: {}, node_device_overrides: {} }, dangerous: true },
  { group: '用户', title: '重建 Xray 凭据', description: '撤销当前管理员节点凭据并重建。', method: 'POST', path: '/api/admin/users/reset-xray-credentials', body: {}, dangerous: true },
  { group: '订阅', title: '路由规则预设', description: '读取订阅路由规则预设。', method: 'GET', path: '/api/admin/routing-rule-presets' },
  { group: '订阅', title: '代理组', description: '读取规范化代理组。', method: 'GET', path: '/api/proxy-groups' },
  { group: '订阅', title: '同步代理组', description: '从配置的数据源刷新代理组。', method: 'POST', path: '/api/admin/proxy-groups/sync', body: {} },
  { group: '系统', title: '全局 API Token', description: '读取全局 API Token 掩码和状态。', method: 'GET', path: '/api/admin/system-settings/api-token' },
  { group: '系统', title: '重建全局 API Token', description: '让现有全局 Token 立即失效。', method: 'POST', path: '/api/admin/system-settings/api-token/regenerate', body: {}, dangerous: true },
  { group: '系统', title: '轮换主登录凭据', description: '修改管理员用户名或密码；成功后会撤销全部现有登录会话。', method: 'PUT', path: '/api/admin/credentials', body: { username: '', password: '' }, dangerous: true },
  { group: '任务', title: '执行后台任务', description: '由后端验证任务名和服务器范围。', method: 'POST', path: '/api/admin/tasks/run', body: { task: 'return_route_test', server_ids: [1] }, dangerous: true },
  { group: '迁移', title: '主控迁移', description: '探测并迁移 Agent 到新主控；更换域名时必须明确确认。', method: 'POST', path: '/api/admin/system-settings/master-migration', body: { action: 'preview', new_master_url: 'https://new.example.com', change_domain: true }, dangerous: true },
  { group: '迁移', title: '接管外部 Xray', description: '合并指定服务器现有配置。', method: 'POST', path: '/api/admin/migrate/takeover-external-xray', body: { server_ids: [1] }, dangerous: true },
  { group: '服务器', title: '查看连接令牌', description: '只在连接修复时查看目标服务器令牌。', method: 'GET', path: '/api/admin/remote-servers/reveal-token?server_id=1', dangerous: true },
  { group: '服务器', title: '添加共享服务器', description: '使用另一个主控生成的共享凭据。', method: 'POST', path: '/api/admin/remote-servers/add-shared', body: { owner_url: 'https://owner.example.com', share_token: '', name: '', prefix: '' } },
  { group: '服务器', title: '同步节点地址', description: '把服务器最新地址同步到关联节点。', method: 'POST', path: '/api/admin/remote-servers/sync-node-address', body: { id: 1 }, dangerous: true },
  { group: '服务器', title: '流量统计选择', description: '指定参与全局统计的服务器。', method: 'POST', path: '/api/admin/remote-servers/traffic-stats-selection', body: { server_ids: [1] } },
  { group: '服务器', title: '重排服务器', description: '保存服务器显示顺序。', method: 'POST', path: '/api/admin/remote-servers/reorder', body: { ids: [1] } },
  { group: '服务器', title: '原子轮换双 Token', description: '同时轮换服务器与 Agent Token，供紧急密钥处置。', method: 'POST', path: '/api/admin/remote-servers/reset-all-tokens?server_id=1', body: {}, dangerous: true },
  { group: '远程服务', title: 'Agent 版本信息', description: '读取当前和可用 Agent 版本。', method: 'GET', path: '/api/admin/remote/agent/version-info?server_id=1' },
  { group: '远程服务', title: '卸载 Agent', description: '从目标服务器移除 Agent，并显示服务端进度。', method: 'POST', path: '/api/admin/remote/agent/uninstall-stream?server_id=1', body: {}, dangerous: true, stream: true },
  { group: '远程服务', title: '服务器间可达性', description: '从一台 Agent 检查到另一台 Agent 的管理通道。', method: 'POST', path: '/api/admin/remote/reachable', body: { from_server_id: 1, to_server_id: 2, timeout_ms: 3000 } },
  { group: '远程服务', title: '用户实时速度', description: '读取目标服务器各用户速率。', method: 'GET', path: '/api/admin/remote/user-speeds?server_id=1' },
  { group: 'Xray', title: '保存完整配置', description: '覆盖目标 Agent 的 Xray 配置，建议先测试。', method: 'POST', path: '/api/admin/remote/xray/config?server_id=1', body: { config: '{}' }, dangerous: true },
  { group: 'Xray', title: '配置文件清单', description: '读取拆分的 Xray 配置文件。', method: 'GET', path: '/api/admin/remote/xray/config/files?server_id=1' },
  { group: 'Xray', title: '协议档案', description: '读取受支持的入站组合。', method: 'GET', path: '/api/admin/protocol-profiles' },
  { group: 'Xray', title: '构建入站', description: '根据协议档案生成入站 JSON。', method: 'POST', path: '/api/admin/xray/build-inbound', body: { profile: 'vless-reality-vision', port: 443, server_name: 'www.microsoft.com', dest: 'www.microsoft.com:443' } },
  { group: 'Nginx', title: '读取主配置', description: '读取目标服务器 Nginx 主配置。', method: 'GET', path: '/api/admin/remote/nginx/config?server_id=1' },
  { group: 'Nginx', title: '保存主配置', description: '覆盖目标服务器 Nginx 主配置。', method: 'POST', path: '/api/admin/remote/nginx/config?server_id=1', body: { config: '' }, dangerous: true },
  { group: 'Nginx', title: 'Server 块清单', description: '解析目标服务器的 Nginx server 块。', method: 'GET', path: '/api/admin/remote/nginx/servers-list?server_id=1' },
  { group: 'Nginx', title: '校验网站配置', description: '写入前校验域名和站点参数。', method: 'POST', path: '/api/admin/remote/website/validate', body: { server_id: 1, domain: 'app.example.com', site_type: 'proxy', site_value: 'http://127.0.0.1:3000' } },
  { group: 'Nginx', title: '添加网站', description: '创建受管反向代理或静态站点。', method: 'POST', path: '/api/admin/remote/website/add', body: { server_id: 1, domain: 'app.example.com', site_type: 'proxy', site_value: 'http://127.0.0.1:3000', entry_mode: 'auto' }, dangerous: true },
  { group: 'WARP', title: '设置 WARP License', description: '更新目标服务器 WARP+ License。', method: 'POST', path: '/api/admin/remote/warp/license?server_id=1', body: { license: '' }, dangerous: true },
  { group: 'WARP', title: '移除 WARP', description: '从目标服务器移除 WARP。', method: 'POST', path: '/api/admin/remote/warp/remove?server_id=1', body: {}, dangerous: true },
  { group: '路由', title: '入站管理', description: '读取或修改目标服务器入站。', method: 'GET', path: '/api/admin/remote/inbounds?server_id=1' },
  { group: '路由', title: '创建隧道链', description: '按服务器顺序建立多跳链路。', method: 'POST', path: '/api/admin/tunnel-chains', body: { label: 'chain-1', server_ids: [1, 2], entry_port: 0, target_address: '203.0.113.20', target_port: 443 }, dangerous: true },
  { group: '路由', title: '管理员路由出站', description: '读取某个父节点可用的跨节点出站。', method: 'GET', path: '/api/admin/routed-outbound?parent_id=1' },
  { group: 'Reality', title: '删除自定义域名', description: '从全局自定义域名池删除。', method: 'POST', path: '/api/admin/remote/reality-domains/custom/delete', body: { domain: 'www.example.com:443' }, dangerous: true },
  { group: 'Reality', title: '屏蔽域名清单', description: '读取全局 Reality 屏蔽域名。', method: 'GET', path: '/api/admin/remote/reality-domains/blocked' },
  { group: 'Reality', title: '恢复屏蔽域名', description: '把域名恢复到可用池。', method: 'POST', path: '/api/admin/remote/reality-domains/blocked/restore', body: { domain: 'www.example.com:443' } },
  { group: 'Reality', title: '分享状态', description: '读取全局 Reality 域名分享状态。', method: 'GET', path: '/api/admin/remote/reality-domains/share' },
  { group: 'Reality', title: '切换分享', description: '启用或关闭全局域名分享，并选择要分享的域名。', method: 'POST', path: '/api/admin/remote/reality-domains/share/toggle', body: { enabled: true, domains: ['www.example.com:443'] }, dangerous: true },
  { group: 'Reality', title: '同步分享域名', description: '立即同步全局共享域名池。', method: 'POST', path: '/api/admin/remote/reality-domains/share/sync', body: {} },
  { group: 'Reality', title: '撤回分享域名', description: '从共享池撤回指定域名。', method: 'POST', path: '/api/admin/remote/reality-domains/share/withdraw', body: { domain: 'www.example.com:443' }, dangerous: true },
  { group: '远程部署', title: '配置远程 SSL', description: '使用已保存域名与证书配置 SSL。', method: 'POST', path: '/api/admin/remote/setup-ssl?server_id=1', body: {}, dangerous: true },
  { group: '远程部署', title: '部署回落自站', description: '部署 steal-self 回落站点配置。', method: 'POST', path: '/api/admin/remote/deploy-steal-self?server_id=1', body: {}, dangerous: true },
  { group: '远程部署', title: '同步入站到节点', description: '根据 Agent 当前入站重建面板节点。', method: 'POST', path: '/api/admin/remote/sync-nodes?server_id=1', body: {}, dangerous: true },
  { group: '远程部署', title: '切换回落模式', description: '在 tunnel、fallback 和 default 间切换。', method: 'POST', path: '/api/admin/remote/switch-steal-mode?server_id=1', body: { steal_mode: 'tunnel' }, dangerous: true },
  { group: '快照', title: '标记预期恢复', description: '让下一次 Agent 连接进入恢复流程。', method: 'POST', path: '/api/admin/xray-snapshots/expect-recovery?server_id=1', body: {}, dangerous: true },
  { group: '快照', title: '应用主控配置', description: '用主控 current 覆盖 Agent 配置。', method: 'POST', path: '/api/admin/xray-snapshots/recovery-apply?server_id=1', body: {}, dangerous: true },
  { group: '快照', title: '接受 Agent 配置', description: '把 Agent pending 配置提升为 current。', method: 'POST', path: '/api/admin/xray-snapshots/recovery-accept?server_id=1', body: {}, dangerous: true },
  { group: '快照', title: '恢复指定快照', description: '按快照 ID 恢复其所属 Agent。', method: 'POST', path: '/api/admin/xray-snapshots/restore?snapshot_id=1', body: {}, dangerous: true },
  { group: '共享', title: '创建服务器分享', description: '生成一次性共享凭据。', method: 'POST', path: '/api/admin/server-share/create', body: { server_id: 1, label: 'share', allow_manage_xray: false } },
  { group: '共享', title: '撤销服务器分享', description: '让现有共享凭据失效，并可同时删除共享入站。', method: 'POST', path: '/api/admin/server-share/revoke', body: { id: 1, delete_inbounds: true }, dangerous: true },
  { group: '节点批量', title: '节点标签', description: '读取全部节点标签。', method: 'GET', path: '/api/admin/nodes/tags' },
  { group: '节点批量', title: '节点 URI 总览', description: '读取可导出的节点 URI。', method: 'GET', path: '/api/admin/node-uris' },
  { group: '节点批量', title: '批量重命名', description: '为每个选中节点指定新名称。', method: 'POST', path: '/api/admin/nodes/batch-rename', body: { updates: [{ node_id: 1, new_name: 'new-node-name' }] }, dangerous: true },
  { group: '节点批量', title: '关闭跳过证书校验', description: '把选中节点中已开启的 skip-cert-verify 统一关闭。', method: 'POST', path: '/api/admin/nodes/batch-disable-skip-cert', body: { node_ids: [1] }, dangerous: true },
  { group: '节点批量', title: '批量 Snell 选项', description: '为 Snell 节点设置 TFO 和 UDP Relay；至少填写一项。', method: 'POST', path: '/api/admin/nodes/batch-snell-options', body: { node_ids: [1], tfo: true, udp_relay: true }, dangerous: true },
  { group: '节点详情', title: '节点关联入站', description: '读取节点关联的远程入站。', method: 'GET', path: '/api/admin/nodes/1/related-inbounds' },
  { group: '节点详情', title: '修改节点服务器地址', description: '替换节点连接地址，同时保留可恢复的原始地址。', method: 'PUT', path: '/api/admin/nodes/1/server', body: { server: 'edge.example.com' }, dangerous: true },
  { group: '节点详情', title: '恢复原始服务器地址', description: '把节点地址恢复为上次替换前保存的原始地址。', method: 'PUT', path: '/api/admin/nodes/1/restore-server', body: {}, dangerous: true },
  { group: '节点详情', title: '覆盖节点配置', description: '保存完整 Clash 节点 JSON，必须包含 name、type、server 和 port。', method: 'PUT', path: '/api/admin/nodes/1/config', body: { clash_config: '{"name":"node","type":"vless","server":"edge.example.com","port":443}' }, dangerous: true },
  { group: '节点详情', title: '设置节点中转', description: '保存中转地址和端口；端口为 0 时沿用节点当前端口。', method: 'PUT', path: '/api/admin/nodes/1/relay', body: { relay_server: 'relay.example.com', relay_port: 443 }, dangerous: true },
  { group: '节点详情', title: '复制节点并设置中转', description: '复制当前节点，并给副本设置中转目标。', method: 'POST', path: '/api/admin/nodes/1/relay-copy', body: { relay_server: 'relay.example.com', relay_port: 443, name_suffix: 'tunnel' }, dangerous: true },
  { group: '用户', title: '用户订阅分配', description: '读取指定用户的订阅文件分配。', method: 'GET', path: '/api/admin/users/demo/subscriptions' },
  { group: '用户', title: '保存订阅分配', description: '覆盖指定用户可用的订阅文件。', method: 'PUT', path: '/api/admin/users/demo/subscriptions', body: { subscription_ids: [] }, dangerous: true },
  { group: '用户', title: '用户流量覆盖', description: '设置用户流量上限覆盖。', method: 'PUT', path: '/api/admin/users/traffic-limit', body: { username: 'demo', traffic_limit_override_gb: null }, dangerous: true },
  { group: '用户', title: '延长有效期', description: '延长用户套餐或账号到期时间。', method: 'POST', path: '/api/admin/users/extend', body: { username: 'demo', days: 30 }, dangerous: true },
  { group: '流量下钻', title: '用户节点流量', description: '读取某用户各节点流量。', method: 'GET', path: '/api/admin/traffic/user-nodes?username=demo' },
  { group: '流量下钻', title: '节点用户流量', description: '读取某节点各用户流量。', method: 'GET', path: '/api/admin/traffic/node-users?node_id=1' },
  { group: '流量下钻', title: '账本周期', description: '按范围和视图读取流量账本周期。', method: 'GET', path: '/api/admin/traffic/period?range=today&view=servers' },
  { group: '订阅文件', title: '重排订阅文件', description: '保存订阅文件显示顺序。', method: 'PUT', path: '/api/admin/subscribe-files/reorder', body: { ids: [1] } },
  { group: '订阅文件', title: '订阅流量', description: '读取全部可见订阅文件的流量统计。', method: 'GET', path: '/api/admin/subscribe-files/traffic' },
  { group: '订阅文件', title: '分配用户', description: '读取指定订阅文件的用户。', method: 'GET', path: '/api/admin/subscribe-files/1/users' },
  { group: '订阅文件', title: '文件内容', description: '按实际文件名读取订阅内容。', method: 'GET', path: '/api/admin/subscribe-files/config.yaml/content' },
  { group: '订阅文件', title: '保存原始 YAML', description: '校验并保存订阅 YAML，同时记录历史版本。', method: 'PUT', path: '/api/admin/subscribe-files/config.yaml/content', body: { content: 'proxies: []\nproxy-groups: []\nrules: []\n' }, dangerous: true },
  { group: '订阅文件', title: '规则历史', description: '读取指定规则文件的保存历史。', method: 'GET', path: '/api/admin/rules/config.yaml/history' },
  { group: 'Template V3', title: '处理模板', description: '按已保存模板名和节点数据渲染 Template V3。', method: 'POST', path: '/api/admin/template-v3/process', body: { template_name: 'template.yaml', proxies: [] } },
  { group: 'Template V3', title: '模板预览', description: '用模板正文和节点数据预览输出，不保存。', method: 'POST', path: '/api/admin/template-v3/preview', body: { template_content: '', proxies: [] } },
  { group: 'Template V3', title: '标签预览', description: '按已保存模板文件和节点标签预览输出。', method: 'POST', path: '/api/admin/template-v3/preview-with-tags', body: { template_filename: 'template.yaml', selected_tags: [] } },
  { group: 'Template V3', title: '转换 V2 模板', description: '把旧模板转换为 V3。', method: 'POST', path: '/api/admin/template-v3/convert-v2', body: { content: '' } },
  { group: 'Template V3', title: '分析订阅', description: '按订阅文件名或订阅正文分析结构和可用字段。', method: 'POST', path: '/api/admin/template-v3/analyze-subscription', body: { subscription_filename: 'config.yaml' } },
  { group: 'Template V3', title: '地区过滤器', description: '读取可用地区过滤器。', method: 'GET', path: '/api/admin/template-v3/region-filters' },
  { group: 'Template V3', title: '抓取远程模板源', description: '从远程 URL 获取模板正文，可选择走后端代理。', method: 'POST', path: '/api/admin/templates/fetch-source', body: { url: 'https://example.com/template.yaml', use_proxy: false } },
  { group: 'Template V3', title: '规则模板可见性', description: '读取被隐藏的规则模板文件。', method: 'GET', path: '/api/admin/rule-templates/visibility' },
  { group: 'Template V3', title: '保存规则模板可见性', description: '隐藏不应出现在模板选择器中的规则文件。', method: 'PUT', path: '/api/admin/rule-templates/visibility', body: { hidden: ['example.yaml'] } },
  { group: '订阅', title: '应用自定义规则', description: '把当前启用的自定义规则应用到 YAML 正文。', method: 'POST', path: '/api/admin/apply-custom-rules', body: { yaml_content: '' } },
  { group: '证书', title: '有效证书', description: '读取当前可用于部署的证书。', method: 'GET', path: '/api/admin/certificates/valid' },
  { group: '证书', title: '证书详情', description: '读取指定证书的域名、有效期与部署信息。', method: 'GET', path: '/api/admin/certificates/1' },
  { group: '证书', title: '自动续期', description: '切换指定证书自动续期。', method: 'PATCH', path: '/api/admin/certificates/auto-renew', body: { id: 1, auto_renew: true } },
  { group: '证书', title: '续期后自动部署', description: '切换指定证书自动部署。', method: 'PATCH', path: '/api/admin/certificates/auto-deploy', body: { id: 1, auto_deploy: true }, dangerous: true },
  { group: '证书', title: '删除证书', description: '删除指定证书和托管材料。', method: 'DELETE', path: '/api/admin/certificates/delete', body: { id: 1 }, dangerous: true },
  { group: '证书', title: '部署主控证书', description: '把已签发证书部署为主控 HTTPS。', method: 'POST', path: '/api/admin/deploy-master-cert', body: { certificate_id: 1 }, dangerous: true },
  { group: 'DNS', title: '更新 DNS 凭据', description: '轮换凭据但保留证书关联。', method: 'PUT', path: '/api/admin/dns-providers/1', body: { name: 'Cloudflare', provider_type: 'cloudflare', credentials: '{"CF_DNS_API_TOKEN":""}' }, dangerous: true },
  { group: 'DNS', title: '删除 DNS 凭据', description: '删除不再使用的 DNS 提供商。', method: 'DELETE', path: '/api/admin/dns-providers/1', dangerous: true },
  { group: '测速', title: '执行节点测速', description: '提交一项节点测速任务。', method: 'POST', path: '/api/admin/speedtest/run', body: { node_id: 1, threads: 1 } },
  { group: '测速', title: '创建测速端', description: '创建家用测速执行端并返回安装凭据。', method: 'POST', path: '/api/admin/speedtest/testers/create', body: { name: 'Home tester' } },
  { group: '测速', title: '撤销测速端', description: '让指定测速端凭据立即失效。', method: 'POST', path: '/api/admin/speedtest/testers/revoke', body: { id: 1 }, dangerous: true },
  { group: '测速', title: '轮换测速端令牌', description: '生成新的测速端连接令牌。', method: 'POST', path: '/api/admin/speedtest/testers/rotate-token', body: { id: 1 }, dangerous: true },
  { group: '日志', title: '主控日志文件', description: '读取可下载的主控日志文件清单。', method: 'GET', path: '/api/admin/logs/files' },
  { group: '日志', title: '删除主控日志', description: '删除指定主控日志文件；把 name 改成 all=1 可清空全部。', method: 'DELETE', path: '/api/admin/logs/files?name=mmwx.log', dangerous: true },
  { group: '日志', title: 'Agent 日志文件', description: '读取目标服务器日志文件清单。', method: 'GET', path: '/api/admin/logs/agent/files?server_id=1' },
  { group: '日志', title: '删除 Agent 日志', description: '删除指定服务器上的日志文件。', method: 'DELETE', path: '/api/admin/logs/agent/files?server_id=1&name=mmw-agent.log', dangerous: true },
  { group: '安全', title: '手动封禁 IP', description: '按安全设置封禁访问来源。', method: 'POST', path: '/api/admin/security/bans', body: { ip: '203.0.113.10', permanent: false }, dangerous: true },
  { group: '安全', title: '解除 IP 封禁', description: '从安全封禁表移除指定 IP。', method: 'DELETE', path: '/api/admin/security/bans/203.0.113.10', dangerous: true },
  { group: '安全', title: 'Turnstile 测试', description: '使用一次浏览器挑战 Token 验证当前 Turnstile 凭据。', method: 'POST', path: '/api/admin/security-settings/turnstile/test', body: { token: '' } },
  { group: '公告', title: '被阻断节点', description: '读取公告投递中被阻断的节点。', method: 'GET', path: '/api/admin/announcements/blocked-nodes' },
  { group: '公告', title: '删除公告', description: '删除指定公告记录。', method: 'DELETE', path: '/api/admin/announcements?id=1', dangerous: true },
  { group: '公告', title: '公告投递策略', description: '读取公告模板与探测来源设置。', method: 'GET', path: '/api/admin/system-settings/announcements' },
  { group: '公告', title: '保存公告投递策略', description: '保存公告类型模板、Bot 与 Mini App 投递策略。', method: 'PUT', path: '/api/admin/system-settings/announcements', body: { config: { types: { general: { enabled: true, title: '公告', template: '', via_bot: false, via_miniapp: true } } }, probe_tester_ids: [1], official_probe: false } },
  { group: '版本', title: '更新 CDN 状态', description: '读取控制器和组件更新是否使用 CDN。', method: 'GET', path: '/api/admin/system-settings/update-cdn' },
  { group: '版本', title: '切换更新 CDN', description: '启用或关闭更新下载 CDN。', method: 'PUT', path: '/api/admin/system-settings/update-cdn', body: { enabled: true } },
  { group: 'Telegram', title: '创建绑定邀请码', description: '为指定账号创建一次性绑定码。', method: 'POST', path: '/api/admin/tgbot/invites', body: { kind: 'bind', bind_username: 'demo', max_uses: 1, remark: '' } },
  { group: 'Telegram', title: '续费申请状态', description: '按 Telegram ID 查看续费申请。', method: 'GET', path: '/api/admin/tgbot/renewal-request/status?telegram_id=123456789' },
  { group: 'Telegram', title: '审批续费申请', description: '使用通知中的审核 Token 执行审批。', method: 'POST', path: '/api/admin/tgbot/renewal-request/approve', body: { token: '', admin_telegram_id: 123456789 }, dangerous: true },
  { group: '数据库', title: '迁移进度', description: '读取正在进行的数据库迁移进度。', method: 'GET', path: '/api/admin/database/migration-progress' },
  { group: '数据库', title: '执行数据库迁移', description: '把数据迁移到已测试的目标数据库。', method: 'POST', path: '/api/admin/database/migrate', body: { driver: 'postgres', host: '', port: 5432, username: '', password: '', database: '' }, dangerous: true },
  { group: '迁移', title: '拉取旧主控备份', description: '从旧妙妙屋主控拉取备份。', method: 'POST', path: '/api/admin/migrate/fetch-mmw-backup', body: { url: '', username: '', password: '' } },
  { group: '迁移', title: '识别独立节点服务器', description: '分析备份中的节点服务器归属。', method: 'GET', path: '/api/admin/migrate/distinct-node-servers' },
  { group: '迁移', title: '修复客户端邮箱', description: '按迁移映射修补客户端邮箱。', method: 'POST', path: '/api/admin/migrate/patch-client-emails', body: {}, dangerous: true },
  { group: '外部订阅', title: '测试节点过滤器', description: '预览某个外部订阅中命中过滤表达式的节点。', method: 'POST', path: '/api/user/external-subscriptions/check-filter', body: { subscription_id: 1, filter: '香港|HK', exclude_filter: '测试', geo_ip_filter: 'HK' } },
  { group: '订阅文件', title: '重置全部短链接', description: '重新生成所有订阅文件的短链接，现有地址会立即失效。', method: 'POST', path: '/api/user/short-link', body: {}, dangerous: true },
]

export function OperationsPage() {
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState('全部')
  const groups = useMemo(() => ['全部', ...Array.from(new Set(endpoints.map((item) => item.group)))], [])
  const visible = useMemo(() => endpoints.filter((item) => {
    const groupMatch = group === '全部' || item.group === group
    const text = `${item.title} ${item.description} ${item.path}`.toLowerCase()
    return groupMatch && text.includes(query.trim().toLowerCase())
  }), [group, query])
  return (
    <Stack>
      <PageHeader description="面向高级运维的原生 API 工作区；路径和请求数据可在执行前修改。" icon={IconTool} title="运维工作台" />
      <Card padding="md" withBorder>
        <Group align="end">
          <TextInput leftSection={<IconSearch size={17} />} label="搜索操作" onChange={(event) => setQuery(event.currentTarget.value)} placeholder="名称、说明或路径" style={{ flex: 1 }} value={query} />
          <Select data={groups} label="分组" onChange={(value) => setGroup(value ?? '全部')} value={group} w={180} />
          <Badge size="lg" variant="light">{visible.length} 项</Badge>
        </Group>
      </Card>
      {visible.length ? <SimpleGrid cols={{ base: 1, xl: 2 }}>{visible.map((item) => <RequestRunner definition={item} key={item.group + item.title} />)}</SimpleGrid> : <Card padding="xl" ta="center" withBorder><IconRefresh size={28} /><Text c="dimmed" mt="sm">没有匹配的操作</Text></Card>}
    </Stack>
  )
}
