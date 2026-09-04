import { useEffect, useState, type FormEvent } from 'react'
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  PasswordInput,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core'
import {
  IconBrandTelegram,
  IconCheck,
  IconCopy,
  IconKey,
  IconLock,
  IconPlus,
  IconRefresh,
  IconShieldCheck,
  IconTrash,
  IconUserShield,
} from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'

import { listFrom, messageOf, request } from '@/adapters/mmwx/api'
import type { JsonRecord, Profile } from '@/adapters/mmwx/types'
import { dateText } from '@/shared/lib/format'
import { JsonSettings } from '@/shared/ui/api-workspace'
import { PageHeader } from '@/shared/ui/page-header'
import { ErrorAlert, LoadingState } from '@/shared/ui/states'

interface AccountPageProps {
  profile: Profile
  onProfileChange: (profile: Profile) => void
}

type ApiToken = JsonRecord & { id?: number | string; name?: string; created_at?: string; last_used_at?: string }

function notify(message: string) {
  notifications.show({ color: 'teal', message, title: '账户中心' })
}

export function AccountPage({ profile: initialProfile, onProfileChange }: AccountPageProps) {
  const [profile, setProfile] = useState(initialProfile)
  const [form, setForm] = useState({
    username: String(initialProfile.username ?? ''),
    email: String(initialProfile.email ?? ''),
    nickname: String(initialProfile.nickname ?? ''),
    avatar_url: String(initialProfile.avatar_url ?? ''),
  })
  const [password, setPassword] = useState({ current: '', next: '', confirm: '' })
  const [twoFactor, setTwoFactor] = useState<JsonRecord>()
  const [setup, setSetup] = useState<JsonRecord>()
  const [setupPassword, setSetupPassword] = useState('')
  const [code, setCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [tokens, setTokens] = useState<ApiToken[]>([])
  const [tokenName, setTokenName] = useState('')
  const [createdToken, setCreatedToken] = useState('')
  const [telegram, setTelegram] = useState<JsonRecord>()
  const [telegramInvite, setTelegramInvite] = useState<JsonRecord>()
  const [subscriptionToken, setSubscriptionToken] = useState<JsonRecord>()
  const [subscriptionShortCode, setSubscriptionShortCode] = useState('')
  const [busy, setBusy] = useState('load')
  const [error, setError] = useState('')

  const load = async () => {
    setBusy('load'); setError('')
    const results = await Promise.allSettled([
      request<Profile>('/api/user/profile'),
      request<JsonRecord>('/api/user/2fa/status'),
      request<JsonRecord>('/api/user/api-tokens'),
      request<JsonRecord>('/api/user/telegram-binding'),
      request<JsonRecord>('/api/user/token'),
    ])
    const [profileResult, twoFactorResult, tokensResult, telegramResult, subscriptionResult] = results
    if (profileResult?.status === 'fulfilled') {
      const next = profileResult.value
      setProfile(next); onProfileChange(next)
      setForm({ username: String(next.username ?? ''), email: String(next.email ?? ''), nickname: String(next.nickname ?? ''), avatar_url: String(next.avatar_url ?? '') })
    }
    if (twoFactorResult?.status === 'fulfilled') setTwoFactor(twoFactorResult.value)
    if (tokensResult?.status === 'fulfilled') setTokens(listFrom<ApiToken>(tokensResult.value, ['tokens']))
    if (telegramResult?.status === 'fulfilled') setTelegram(telegramResult.value)
    if (subscriptionResult?.status === 'fulfilled') {
      setSubscriptionToken(subscriptionResult.value)
      setSubscriptionShortCode(String(subscriptionResult.value.custom_user_short_code ?? ''))
    }
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length === results.length) setError(messageOf((failures[0] as PromiseRejectedResult | undefined)?.reason, '账户资料加载失败'))
    else if (failures.length) setError(`${failures.length} 项附加资料暂时无法加载，其余功能仍可使用。`)
    setBusy('')
  }

  useEffect(() => { void load() }, [])

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault(); setBusy('profile'); setError('')
    try {
      const result = await request<JsonRecord>('/api/user/settings', { method: 'PUT', body: JSON.stringify(form) })
      const next = (result.profile && typeof result.profile === 'object' ? result.profile : result) as Profile
      setProfile(next); onProfileChange(next); notify('个人资料已保存')
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }

  const changePassword = async (event: FormEvent) => {
    event.preventDefault()
    if (password.next.length < 8) return setError('新密码至少需要 8 个字符。')
    if (password.next !== password.confirm) return setError('两次输入的新密码不一致。')
    setBusy('password'); setError('')
    try {
      await request('/api/user/password', { method: 'POST', body: JSON.stringify({ current_password: password.current, new_password: password.next }) })
      setPassword({ current: '', next: '', confirm: '' }); notify('密码已更新')
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }

  const startTwoFactor = async () => {
    setBusy('2fa'); setError('')
    try {
      setSetup(await request<JsonRecord>('/api/user/2fa/setup', { method: 'POST', body: JSON.stringify({ password: setupPassword }) }))
      setSetupPassword(''); notify('认证器密钥已生成，请完成验证')
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }

  const verifyTwoFactor = async () => {
    if (!/^\d{6}$/.test(code)) return setError('请输入 6 位认证器验证码。')
    setBusy('2fa'); setError('')
    try {
      const result = await request<JsonRecord>('/api/user/2fa/verify-setup', { method: 'POST', body: JSON.stringify({ code }) })
      setRecoveryCodes(listFrom<string>(result.recovery_codes ?? result, ['recovery_codes']))
      setTwoFactor({ enabled: true }); setSetup(undefined); setCode(''); notify('两步验证已启用')
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }

  const disableTwoFactor = async () => {
    if (!/^\d{6}$/.test(code)) return setError('请输入 6 位认证器验证码。')
    if (!window.confirm('确定关闭两步验证吗？')) return
    setBusy('2fa'); setError('')
    try {
      await request('/api/user/2fa/disable', { method: 'POST', body: JSON.stringify({ code }) })
      setTwoFactor({ enabled: false }); setCode(''); notify('两步验证已关闭')
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }

  const createToken = async (event: FormEvent) => {
    event.preventDefault(); setBusy('token'); setError('')
    try {
      const result = await request<JsonRecord>('/api/user/api-tokens', { method: 'POST', body: JSON.stringify({ name: tokenName.trim() || 'API Token' }) })
      setCreatedToken(String(result.token ?? '')); setTokenName(''); await load(); notify('API Token 已创建')
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }

  const revokeToken = async (token: ApiToken) => {
    if (!window.confirm(`确定吊销“${String(token.name ?? 'API Token')}”吗？`)) return
    setBusy('token'); setError('')
    try {
      await request(`/api/user/api-tokens/${encodeURIComponent(String(token.id ?? ''))}`, { method: 'DELETE' })
      await load(); notify('API Token 已吊销')
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }

  const createTelegramInvite = async () => {
    setBusy('telegram'); setError('')
    try { setTelegramInvite(await request<JsonRecord>('/api/user/telegram-binding', { method: 'POST', body: '{}' })) }
    catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }

  const unbindTelegram = async () => {
    if (!window.confirm('确定解除 Telegram 绑定吗？')) return
    setBusy('telegram'); setError('')
    try { await request('/api/user/telegram-binding', { method: 'DELETE' }); setTelegram({ bound: false }); setTelegramInvite(undefined); notify('Telegram 已解绑') }
    catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }

  const resetSubscriptionToken = async () => {
    if (!window.confirm('重置后所有使用旧 Token 的订阅地址会立即失效，确定继续吗？')) return
    setBusy('subscription'); setError('')
    try { setSubscriptionToken(await request<JsonRecord>('/api/user/token', { method: 'POST' })); notify('订阅 Token 已轮换') }
    catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }

  const saveSubscriptionShortCode = async () => {
    setBusy('subscription-code'); setError('')
    try {
      const result = await request<JsonRecord>('/api/user/token', { method: 'PUT', body: JSON.stringify({ custom_user_short_code: subscriptionShortCode }) })
      setSubscriptionToken(result)
      setSubscriptionShortCode(String(result.custom_user_short_code ?? ''))
      notify('订阅短码已更新')
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }

  if (busy === 'load' && !profile.username) return <LoadingState label="正在加载账户资料" />

  const role = Boolean(profile.is_admin || profile.role === 'admin') ? '管理员' : '成员'
  const enabled2fa = Boolean(twoFactor?.enabled)
  const telegramBound = Boolean(telegram?.bound)

  return (
    <Stack>
      <PageHeader actions={<Button leftSection={<IconRefresh size={17} />} loading={busy === 'load'} onClick={() => void load()} variant="light">刷新资料</Button>} description="管理个人资料、登录安全、程序令牌与订阅偏好。" icon={IconUserShield} title="账号与安全" />
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}
      <Card padding="lg" shadow="lg" withBorder>
        <Group wrap="nowrap">
          <Avatar color="cyan" radius="xl" size={52} src={String(profile.avatar_url ?? '') || undefined}>{String(profile.nickname ?? profile.username ?? 'U').slice(0, 1).toUpperCase()}</Avatar>
          <Stack gap={1} style={{ minWidth: 0 }}><Group><Title order={4}>{String(profile.nickname ?? profile.username ?? '当前账户')}</Title><Badge variant="light">{role}</Badge></Group><Text c="dimmed" fz="sm">{String(profile.email ?? profile.username ?? '')}</Text></Stack>
        </Group>
      </Card>
      <Tabs defaultValue="profile" keepMounted={false} variant="pills">
        <Tabs.List mb="md"><Tabs.Tab leftSection={<IconUserShield size={16} />} value="profile">个人资料</Tabs.Tab><Tabs.Tab leftSection={<IconLock size={16} />} value="security">登录安全</Tabs.Tab><Tabs.Tab leftSection={<IconKey size={16} />} value="access">令牌与绑定</Tabs.Tab><Tabs.Tab leftSection={<IconShieldCheck size={16} />} value="preferences">订阅偏好</Tabs.Tab></Tabs.List>

        <Tabs.Panel value="profile">
          <Card padding="lg" shadow="lg" withBorder>
            <Title order={4} mb="xs">个人资料</Title><Text c="dimmed" fz="sm" mb="lg">用于面板账户入口和通知身份。</Text>
            <form onSubmit={saveProfile}><Stack>
              <SimpleGrid cols={{ base: 1, sm: 2 }}><TextInput disabled={Boolean(profile.is_admin)} label="用户名" onChange={(event) => setForm((value) => ({ ...value, username: event.currentTarget.value }))} required value={form.username} /><TextInput label="昵称" onChange={(event) => setForm((value) => ({ ...value, nickname: event.currentTarget.value }))} value={form.nickname} /></SimpleGrid>
              <TextInput label="邮箱" onChange={(event) => setForm((value) => ({ ...value, email: event.currentTarget.value }))} type="email" value={form.email} />
              <TextInput label="头像地址" onChange={(event) => setForm((value) => ({ ...value, avatar_url: event.currentTarget.value }))} placeholder="https://example.com/avatar.png" type="url" value={form.avatar_url} />
              <Group justify="flex-end"><Button loading={busy === 'profile'} type="submit">保存资料</Button></Group>
            </Stack></form>
          </Card>
        </Tabs.Panel>

        <Tabs.Panel value="security">
          <SimpleGrid cols={{ base: 1, xl: 2 }}>
            <Card padding="lg" shadow="lg" withBorder>
              <Title order={4}>修改密码</Title><Text c="dimmed" fz="sm" mb="lg">建议使用独立、足够长的密码。</Text>
              <form onSubmit={changePassword}><Stack><PasswordInput autoComplete="current-password" label="当前密码" onChange={(event) => setPassword((value) => ({ ...value, current: event.currentTarget.value }))} required value={password.current} /><PasswordInput autoComplete="new-password" label="新密码" onChange={(event) => setPassword((value) => ({ ...value, next: event.currentTarget.value }))} required value={password.next} /><PasswordInput autoComplete="new-password" label="确认新密码" onChange={(event) => setPassword((value) => ({ ...value, confirm: event.currentTarget.value }))} required value={password.confirm} /><Button loading={busy === 'password'} type="submit">更新密码</Button></Stack></form>
            </Card>
            <Card padding="lg" shadow="lg" withBorder>
              <Group justify="space-between"><Title order={4}>两步验证</Title><Badge color={enabled2fa ? 'teal' : 'gray'} variant="light">{enabled2fa ? '已启用' : '未启用'}</Badge></Group>
              <Text c="dimmed" fz="sm" mb="lg">登录时使用认证器动态验证码。</Text>
              {recoveryCodes.length ? <Alert color="orange" title="立即保存恢复码"><Stack><Code block>{recoveryCodes.join('\n')}</Code><CopyButton value={recoveryCodes.join('\n')}>{({ copied, copy }) => <Button leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />} onClick={copy} variant="light">{copied ? '已复制' : '复制恢复码'}</Button>}</CopyButton></Stack></Alert> : null}
              {setup ? <Stack><Alert title="认证器密钥"><Code>{String(setup.secret ?? '')}</Code><Text fz="xs" mt="xs" style={{ overflowWrap: 'anywhere' }}>{String(setup.url ?? '')}</Text></Alert><TextInput inputMode="numeric" label="6 位验证码" maxLength={6} onChange={(event) => setCode(event.currentTarget.value.replace(/\D/g, ''))} value={code} /><Button loading={busy === '2fa'} onClick={() => void verifyTwoFactor()}>验证并启用</Button></Stack> : enabled2fa ? <Stack><TextInput inputMode="numeric" label="认证器验证码" maxLength={6} onChange={(event) => setCode(event.currentTarget.value.replace(/\D/g, ''))} value={code} /><Button color="red" loading={busy === '2fa'} onClick={() => void disableTwoFactor()} variant="light">关闭两步验证</Button></Stack> : <Stack><PasswordInput label="当前密码" onChange={(event) => setSetupPassword(event.currentTarget.value)} value={setupPassword} /><Button loading={busy === '2fa'} onClick={() => void startTwoFactor()}>开始设置</Button></Stack>}
            </Card>
          </SimpleGrid>
        </Tabs.Panel>

        <Tabs.Panel value="access">
          <Stack>
            <Card padding="lg" shadow="lg" withBorder>
              <Group justify="space-between" mb="lg"><Stack gap={0}><Title order={4}>用户 API Token</Title><Text c="dimmed" fz="sm">供脚本、MCP 和自动化程序使用；明文只显示一次。</Text></Stack><Badge>{tokens.length} 枚</Badge></Group>
              {createdToken ? <Alert color="orange" mb="md" title="立即复制新 Token"><Group wrap="nowrap"><Code style={{ flex: 1, overflowWrap: 'anywhere' }}>{createdToken}</Code><CopyButton value={createdToken}>{({ copied, copy }) => <Button leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />} onClick={copy} variant="light">{copied ? '已复制' : '复制'}</Button>}</CopyButton></Group></Alert> : null}
              <form onSubmit={createToken}><Group align="end" mb="lg"><TextInput label="名称" onChange={(event) => setTokenName(event.currentTarget.value)} placeholder="家庭服务器" style={{ flex: 1 }} value={tokenName} /><Button leftSection={<IconPlus size={17} />} loading={busy === 'token'} type="submit">创建</Button></Group></form>
              <Stack>{tokens.map((token) => <Card bg="dark.6" key={String(token.id)} padding="sm" withBorder><Group justify="space-between"><Stack gap={1}><Text fw={700}>{String(token.name ?? 'API Token')}</Text><Text c="dimmed" fz="xs">创建 {dateText(token.created_at)} · 最近使用 {dateText(token.last_used_at)}</Text></Stack><Button color="red" leftSection={<IconTrash size={16} />} onClick={() => void revokeToken(token)} size="xs" variant="subtle">吊销</Button></Group></Card>)}</Stack>
            </Card>
            <SimpleGrid cols={{ base: 1, xl: 2 }}>
              <Card padding="lg" shadow="lg" withBorder><Group justify="space-between"><Title order={4}>Telegram</Title><Badge color={telegramBound ? 'teal' : 'gray'}>{telegramBound ? '已绑定' : '未绑定'}</Badge></Group><Text c="dimmed" fz="sm" mb="lg">接收通知并通过机器人完成自助操作。</Text>{telegramBound ? <Stack><Text>@{String(telegram?.telegram_username ?? telegram?.telegram_id ?? '已绑定')}</Text><Button color="red" loading={busy === 'telegram'} onClick={() => void unbindTelegram()} variant="light">解除绑定</Button></Stack> : telegramInvite ? <Stack><Alert title="一次性绑定码"><Code>{String(telegramInvite.command ?? telegramInvite.code ?? '')}</Code></Alert><Button leftSection={<IconRefresh size={16} />} onClick={() => void load()} variant="light">刷新绑定状态</Button></Stack> : <Button leftSection={<IconBrandTelegram size={17} />} loading={busy === 'telegram'} onClick={() => void createTelegramInvite()}>生成绑定码</Button>}</Card>
              <Card padding="lg" shadow="lg" withBorder><Title order={4}>订阅 Token 与短码</Title><Text c="dimmed" fz="sm" mb="lg">个人订阅地址的鉴权凭据与可读短码。</Text><Code block>{subscriptionToken ? `${String(subscriptionToken.token ?? '').slice(0, 8)}••••••••${String(subscriptionToken.token ?? '').slice(-6)}` : '未载入'}</Code><TextInput description={`当前生效：${String(subscriptionToken?.user_short_code ?? '—')}；留空恢复系统自动短码`} label="自定义用户短码" mt="md" onChange={(event) => setSubscriptionShortCode(event.currentTarget.value)} value={subscriptionShortCode} /><Group mt="lg"><Button loading={busy === 'subscription-code'} onClick={() => void saveSubscriptionShortCode()} variant="light">保存短码</Button><Button color="red" loading={busy === 'subscription'} onClick={() => void resetSubscriptionToken()} variant="subtle">轮换订阅 Token</Button></Group></Card>
            </SimpleGrid>
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="preferences">
          <SimpleGrid cols={{ base: 1, xl: 2 }}>
            <JsonSettings description="外部订阅同步、匹配、缓存和输出兼容策略。" getPath="/api/user/config" title="订阅与同步" />
            <JsonSettings description="当前账号的默认订阅模板。" getPath="/api/user/default-template" title="默认模板" />
          </SimpleGrid>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  )
}
