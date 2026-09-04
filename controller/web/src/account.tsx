import { FormEvent, ReactNode, useCallback, useEffect, useState } from 'react'
import { api } from './api'
import './account.css'

export type AccountProfile = {
  username: string
  email: string
  nickname: string
  avatar_url: string
  role: string
  is_admin: boolean
  telegram_id?: number
  telegram_username?: string
}

export interface AccountPageProps {
  initialProfile?: Partial<AccountProfile>
  onProfileChange?: (profile: AccountProfile) => void
  isAdmin?: boolean
  className?: string
}

type Feedback = { message: string; error: boolean }
type AccountTab = 'profile' | 'security' | 'access' | 'preferences'
type TwoFactorStatus = { enabled: boolean }
type TwoFactorSetup = { secret: string; url: string }
type UserAPIToken = { id: number; name: string; created_at: string; last_used_at?: string | null }
type APITokenList = { success: boolean; tokens: UserAPIToken[] }
type CreatedAPIToken = { success: boolean; token: string; name: string }
type TelegramStatus = {
  username: string
  bound: boolean
  telegram_id: number
  telegram_username: string
  bot_url: string
}
type TelegramInvite = {
  success: boolean
  code: string
  command: string
  expires_at: string
  bot_url: string
}
type SubscriptionToken = {
  token: string
  user_short_code: string
  custom_user_short_code: string
}
type UserConfig = {
  subscription_url: string
  force_sync_external: boolean
  match_rule: 'node_name' | 'server_port' | 'type_server_port'
  sync_scope: 'saved_only' | 'all'
  keep_node_name: boolean
  cache_expire_minutes: number
  sync_traffic: boolean
  node_name_filter: string
  append_sub_info: boolean
  custom_rules_enabled: boolean
  enable_short_link: boolean
  use_new_template_system: boolean
  enable_proxy_provider: boolean
  node_order: number[]
  proxy_groups_source_url: string
  client_compatibility_mode: boolean
  enable_sub_info_nodes: boolean
  sub_info_v2ray_only: boolean
  sub_info_expire_prefix: string
  sub_info_traffic_prefix: string
}

const emptyProfile: AccountProfile = {
  username: '', email: '', nickname: '', avatar_url: '', role: '', is_admin: false,
}

const defaultConfig: UserConfig = {
  subscription_url: '',
  force_sync_external: false,
  match_rule: 'node_name',
  sync_scope: 'saved_only',
  keep_node_name: true,
  cache_expire_minutes: 0,
  sync_traffic: false,
  node_name_filter: '剩余|流量|到期|订阅|时间|重置',
  append_sub_info: false,
  custom_rules_enabled: true,
  enable_short_link: false,
  use_new_template_system: true,
  enable_proxy_provider: false,
  node_order: [],
  proxy_groups_source_url: '',
  client_compatibility_mode: false,
  enable_sub_info_nodes: false,
  sub_info_v2ray_only: false,
  sub_info_expire_prefix: '',
  sub_info_traffic_prefix: '',
}

const iconPaths: Record<string, string> = {
  refresh: 'M20 6v5h-5M4 18v-5h5m10.5-2A8 8 0 0 0 6 7.5L4 11m16 2-2 3.5A8 8 0 0 1 4.5 14',
  user: 'M20 21a8 8 0 0 0-16 0m8-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Zm-3-10 2 2 4-4',
  key: 'M21 2 13.6 9.4m-3.2 3.2a5 5 0 1 1-7.1 7.1 5 5 0 0 1 7.1-7.1Zm0 0L14 16l2-2 2 2 3-3-2-2 2-2-2-2',
  sliders: 'M4 6h16M4 12h16M4 18h16M8 4v4m8 2v4m-5 2v4',
  copy: 'M8 8h12v12H8V8Zm-4 8V4h12',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16m-10 4v6m4-6v6m-8-10 1 14h10l1-14M9 7V4h6v3',
  link: 'M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1',
  eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  eyeOff: 'm3 3 18 18M10.6 10.6A2 2 0 0 0 13.4 13.4M9.9 5.2A11 11 0 0 1 22 12a14.7 14.7 0 0 1-2.1 3.2M6.2 6.2A14.3 14.3 0 0 0 2 12s3.5 6 10 6c1.2 0 2.3-.2 3.3-.5',
  telegram: 'm21.4 3.3-3.2 16c-.2 1.1-.9 1.4-1.8.9l-4.8-3.5-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9 8.9-8c.4-.3-.1-.5-.6-.2L5.9 13.2 1.2 11.7c-1-.3-1-1 .2-1.5L19.8 3c.9-.3 1.8.2 1.6.3Z',
  check: 'm5 12 4 4L19 6',
  external: 'M14 3h7v7m0-7-9 9M11 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6',
  download: 'M12 3v12m-5-5 5 5 5-5M5 21h14',
}

function Icon({ name, size = 17 }: { name: string; size?: number }) {
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name] ?? iconPaths.user}/></svg>
}

function Button({ children, variant = 'primary', icon, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; icon?: string }) {
  return <button {...props} className={`btn ${variant} mmx-button ${props.className ?? ''}`}>{icon && <Icon name={icon}/>} {children}</button>
}

function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`pixel-card mmx-card ${className}`}>{children}</section>
}

function CardHead({ icon, title, description, aside }: { icon: string; title: string; description: string; aside?: ReactNode }) {
  return <div className="mmx-card-head"><span className="mmx-card-icon"><Icon name={icon} size={19}/></span><div><h2>{title}</h2><p>{description}</p></div>{aside && <div className="mmx-card-aside">{aside}</div>}</div>
}

function Notice({ feedback }: { feedback: Feedback }) {
  return feedback.message ? <div className={`notice ${feedback.error ? 'error' : ''}`} role={feedback.error ? 'alert' : 'status'}>{feedback.message}</div> : null
}

function Spinner() {
  return <div className="loading"><span className="operation-spinner"/>正在加载账户资料…</div>
}

function Switch({ title, description, checked, onChange, disabled = false }: { title: string; description: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return <label className={`setting mmx-switch-row ${disabled ? 'is-disabled' : ''}`}><div><strong>{title}</strong><small>{description}</small></div><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)}/><span className="switch"/></label>
}

function normalizeProfile(value: Partial<AccountProfile> | undefined): AccountProfile {
  return { ...emptyProfile, ...value, is_admin: Boolean(value?.is_admin || value?.role === 'admin') }
}

function normalizeConfig(value: Partial<UserConfig>): UserConfig {
  return {
    ...defaultConfig,
    ...value,
    match_rule: value.match_rule === 'server_port' || value.match_rule === 'type_server_port' ? value.match_rule : 'node_name',
    sync_scope: value.sync_scope === 'all' ? 'all' : 'saved_only',
    node_order: Array.isArray(value.node_order) ? value.node_order.map(Number).filter(Number.isFinite) : [],
  }
}

const messageOf = (reason: unknown, fallback = '操作失败') => reason instanceof Error ? reason.message : fallback

function formatDate(value?: string | null) {
  if (!value) return '尚未使用'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function maskSecret(value: string) {
  if (!value) return '—'
  if (value.length <= 12) return '••••••••'
  return `${value.slice(0, 6)}••••••••${value.slice(-6)}`
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const area = document.createElement('textarea')
  area.value = value
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  const copied = document.execCommand('copy')
  area.remove()
  if (!copied) throw new Error('浏览器不允许复制，请手动选择文本')
}

function telegramStartURL(botURL: string, code: string) {
  if (!botURL) return ''
  try {
    const parsed = new URL(botURL)
    if (parsed.hostname === 't.me' || parsed.hostname === 'telegram.me') parsed.searchParams.set('start', code)
    return parsed.toString()
  } catch {
    return botURL
  }
}

export function AccountPage({ initialProfile, onProfileChange, isAdmin = false, className = '' }: AccountPageProps) {
  const firstProfile = normalizeProfile(initialProfile)
  const [tab, setTab] = useState<AccountTab>('profile')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>({ message: '', error: false })
  const [profile, setProfile] = useState<AccountProfile>(firstProfile)
  const [profileForm, setProfileForm] = useState(firstProfile)
  const [profileBusy, setProfileBusy] = useState(false)
  const [avatarFailed, setAvatarFailed] = useState(false)
  const [passwordForm, setPasswordForm] = useState({ current: '', next: '', confirm: '' })
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false)
  const [twoFactorStatusLoaded, setTwoFactorStatusLoaded] = useState(false)
  const [twoFactorSetup, setTwoFactorSetup] = useState<TwoFactorSetup | null>(null)
  const [twoFactorPassword, setTwoFactorPassword] = useState('')
  const [twoFactorCode, setTwoFactorCode] = useState('')
  const [disableCode, setDisableCode] = useState('')
  const [twoFactorBusy, setTwoFactorBusy] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [apiTokens, setAPITokens] = useState<UserAPIToken[]>([])
  const [apiTokenName, setAPITokenName] = useState('')
  const [createdAPIToken, setCreatedAPIToken] = useState<CreatedAPIToken | null>(null)
  const [apiTokenBusy, setAPITokenBusy] = useState(false)
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null)
  const [telegramInvite, setTelegramInvite] = useState<TelegramInvite | null>(null)
  const [telegramBusy, setTelegramBusy] = useState(false)
  const [subscription, setSubscription] = useState<SubscriptionToken>({ token: '', user_short_code: '', custom_user_short_code: '' })
  const [tokenLoaded, setTokenLoaded] = useState(false)
  const [shortCode, setShortCode] = useState('')
  const [showSubscriptionToken, setShowSubscriptionToken] = useState(false)
  const [subscriptionBusy, setSubscriptionBusy] = useState('')
  const [config, setConfig] = useState<UserConfig>(defaultConfig)
  const [configLoaded, setConfigLoaded] = useState(false)
  const [configBusy, setConfigBusy] = useState(false)

  const announce = useCallback((message: string, error = false) => setFeedback({ message, error }), [])

  const loadAll = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setTwoFactorStatusLoaded(false)
    setTokenLoaded(false)
    setConfigLoaded(false)
    setFeedback({ message: '', error: false })
    const results = await Promise.allSettled([
      api<AccountProfile>('/api/user/profile'),
      api<TwoFactorStatus>('/api/user/2fa/status'),
      api<APITokenList>('/api/user/api-tokens'),
      api<TelegramStatus>('/api/user/telegram-binding'),
      api<SubscriptionToken>('/api/user/token'),
      api<UserConfig>('/api/user/config'),
    ])
    const failed: string[] = []
    if (results[0].status === 'fulfilled') {
      const next = normalizeProfile(results[0].value)
      setProfile(next)
      setProfileForm(next)
      setAvatarFailed(false)
    } else failed.push('个人资料')
    if (results[1].status === 'fulfilled') {
      setTwoFactorEnabled(Boolean(results[1].value.enabled))
      setTwoFactorStatusLoaded(true)
    }
    else failed.push('两步验证状态')
    if (results[2].status === 'fulfilled') setAPITokens(Array.isArray(results[2].value.tokens) ? results[2].value.tokens : [])
    else failed.push('API Token')
    if (results[3].status === 'fulfilled') setTelegram(results[3].value)
    else failed.push('Telegram 绑定')
    if (results[4].status === 'fulfilled') {
      setSubscription(results[4].value)
      setShortCode(results[4].value.custom_user_short_code ?? '')
      setTokenLoaded(true)
    } else failed.push('订阅 Token')
    if (results[5].status === 'fulfilled') {
      setConfig(normalizeConfig(results[5].value))
      setConfigLoaded(true)
    }
    else failed.push('订阅偏好')
    if (failed.length) setFeedback({ message: `以下资料暂时无法加载：${failed.join('、')}。其余功能仍可使用。`, error: true })
    setLoading(false)
    setRefreshing(false)
  }, [])

  useEffect(() => { void loadAll() }, [loadAll])

  const setProfileField = (key: keyof AccountProfile, value: string) => {
    setProfileForm((old) => ({ ...old, [key]: value }))
    if (key === 'avatar_url') setAvatarFailed(false)
  }

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault()
    const username = profileForm.username.trim()
    if (!username) return announce('用户名不能为空。', true)
    setProfileBusy(true)
    try {
      const result = await api<{ profile: AccountProfile }>('/api/user/settings', {
        method: 'PUT',
        body: JSON.stringify({
          username,
          email: profileForm.email.trim(),
          nickname: profileForm.nickname.trim(),
          avatar_url: profileForm.avatar_url.trim(),
        }),
      })
      const next = normalizeProfile(result.profile)
      setProfile(next)
      setProfileForm(next)
      onProfileChange?.(next)
      announce(profile.username !== next.username ? '个人资料已保存，用户名已更新。' : '个人资料已保存。')
    } catch (reason) {
      announce(messageOf(reason, '无法保存个人资料'), true)
    } finally {
      setProfileBusy(false)
    }
  }

  const changePassword = async (event: FormEvent) => {
    event.preventDefault()
    const next = passwordForm.next
    if (next.trim() === '' || [...next].length < 8) return announce('新密码至少需要 8 个字符。', true)
    if (new TextEncoder().encode(next).length > 72) return announce('新密码不能超过 72 个字节。', true)
    if (next !== passwordForm.confirm) return announce('两次输入的新密码不一致。', true)
    setPasswordBusy(true)
    try {
      await api('/api/user/password', {
        method: 'POST',
        body: JSON.stringify({ current_password: passwordForm.current, new_password: next }),
      })
      setPasswordForm({ current: '', next: '', confirm: '' })
      announce('密码已更新。下次登录请使用新密码。')
    } catch (reason) {
      announce(messageOf(reason, '无法修改密码'), true)
    } finally {
      setPasswordBusy(false)
    }
  }

  const startTwoFactorSetup = async (event: FormEvent) => {
    event.preventDefault()
    if (!twoFactorStatusLoaded) return announce('两步验证状态尚未载入，已阻止生成新密钥。请刷新后重试。', true)
    setTwoFactorBusy('setup')
    try {
      const result = await api<TwoFactorSetup>('/api/user/2fa/setup', {
        method: 'POST', body: JSON.stringify({ password: twoFactorPassword }),
      })
      setTwoFactorSetup(result)
      setTwoFactorPassword('')
      setTwoFactorCode('')
      announce('密钥已生成。请先添加到认证器，再输入验证码完成启用。')
    } catch (reason) {
      announce(messageOf(reason, '无法开始两步验证设置'), true)
    } finally {
      setTwoFactorBusy('')
    }
  }

  const verifyTwoFactor = async (event: FormEvent) => {
    event.preventDefault()
    if (!twoFactorStatusLoaded) return announce('两步验证状态尚未载入，已阻止验证。请刷新后重试。', true)
    if (!/^\d{6}$/.test(twoFactorCode.trim())) return announce('请输入认证器生成的 6 位验证码。', true)
    setTwoFactorBusy('verify')
    try {
      const result = await api<{ recovery_codes: string[] }>('/api/user/2fa/verify-setup', {
        method: 'POST', body: JSON.stringify({ code: twoFactorCode.trim() }),
      })
      setRecoveryCodes(Array.isArray(result.recovery_codes) ? result.recovery_codes : [])
      setTwoFactorEnabled(true)
      setTwoFactorSetup(null)
      setTwoFactorCode('')
      announce('两步验证已启用。请立即保存恢复码，它们不会再次显示。')
    } catch (reason) {
      announce(messageOf(reason, '验证码校验失败'), true)
    } finally {
      setTwoFactorBusy('')
    }
  }

  const disableTwoFactor = async (event: FormEvent) => {
    event.preventDefault()
    if (!twoFactorStatusLoaded) return announce('两步验证状态尚未载入，已阻止关闭操作。请刷新后重试。', true)
    if (!/^\d{6}$/.test(disableCode.trim())) return announce('请输入认证器生成的 6 位验证码。', true)
    if (!window.confirm('确定关闭两步验证吗？账户将只由密码保护。')) return
    setTwoFactorBusy('disable')
    try {
      await api('/api/user/2fa/disable', { method: 'POST', body: JSON.stringify({ code: disableCode.trim() }) })
      setTwoFactorEnabled(false)
      setDisableCode('')
      setRecoveryCodes([])
      announce('两步验证已关闭。')
    } catch (reason) {
      announce(messageOf(reason, '无法关闭两步验证'), true)
    } finally {
      setTwoFactorBusy('')
    }
  }

  const copy = async (value: string, label: string) => {
    try {
      await copyText(value)
      announce(`${label}已复制。`)
    } catch (reason) {
      announce(messageOf(reason, '复制失败'), true)
    }
  }

  const downloadRecoveryCodes = () => {
    const blob = new Blob([`妙妙屋 X 两步验证恢复码\n\n${recoveryCodes.join('\n')}\n`], { type: 'text/plain;charset=utf-8' })
    const href = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = href
    anchor.download = 'mmwx-recovery-codes.txt'
    anchor.click()
    URL.revokeObjectURL(href)
  }

  const loadAPITokens = async () => {
    const result = await api<APITokenList>('/api/user/api-tokens')
    setAPITokens(Array.isArray(result.tokens) ? result.tokens : [])
  }

  const createAPIToken = async (event: FormEvent) => {
    event.preventDefault()
    setAPITokenBusy(true)
    try {
      const result = await api<CreatedAPIToken>('/api/user/api-tokens', {
        method: 'POST', body: JSON.stringify({ name: apiTokenName.trim() || 'API Token' }),
      })
      setCreatedAPIToken(result)
      setAPITokenName('')
      await loadAPITokens()
      announce('API Token 已创建。请现在复制，关闭提示后无法再次查看明文。')
    } catch (reason) {
      announce(messageOf(reason, '无法创建 API Token'), true)
    } finally {
      setAPITokenBusy(false)
    }
  }

  const revokeAPIToken = async (token: UserAPIToken) => {
    if (!window.confirm(`确定吊销“${token.name}”吗？使用它的程序会立即失去访问权限。`)) return
    setAPITokenBusy(true)
    try {
      await api(`/api/user/api-tokens/${encodeURIComponent(token.id)}`, { method: 'DELETE' })
      await loadAPITokens()
      announce(`API Token“${token.name}”已吊销。`)
    } catch (reason) {
      announce(messageOf(reason, '无法吊销 API Token'), true)
    } finally {
      setAPITokenBusy(false)
    }
  }

  const loadTelegram = async () => setTelegram(await api<TelegramStatus>('/api/user/telegram-binding'))

  const createTelegramInvite = async () => {
    setTelegramBusy(true)
    try {
      const result = await api<TelegramInvite>('/api/user/telegram-binding', { method: 'POST', body: JSON.stringify({}) })
      setTelegramInvite(result)
      announce('Telegram 绑定码已生成，24 小时内有效。')
    } catch (reason) {
      announce(messageOf(reason, '无法生成 Telegram 绑定码'), true)
    } finally {
      setTelegramBusy(false)
    }
  }

  const refreshTelegram = async () => {
    setTelegramBusy(true)
    try {
      await loadTelegram()
      announce('Telegram 绑定状态已刷新。')
    } catch (reason) {
      announce(messageOf(reason, '无法刷新 Telegram 状态'), true)
    } finally {
      setTelegramBusy(false)
    }
  }

  const unbindTelegram = async () => {
    if (!window.confirm('确定解除 Telegram 绑定吗？相关通知和机器人身份关联将停止。')) return
    setTelegramBusy(true)
    try {
      await api('/api/user/telegram-binding', { method: 'DELETE' })
      setTelegramInvite(null)
      await loadTelegram()
      announce('Telegram 已解绑。')
    } catch (reason) {
      announce(messageOf(reason, '无法解绑 Telegram'), true)
    } finally {
      setTelegramBusy(false)
    }
  }

  const resetSubscriptionToken = async () => {
    if (!tokenLoaded) return announce('订阅 Token 尚未载入，已阻止重置。请刷新后重试。', true)
    if (!window.confirm('确定重置订阅 Token 吗？所有使用旧 Token 的订阅地址会立即失效。')) return
    setSubscriptionBusy('token')
    try {
      const result = await api<SubscriptionToken>('/api/user/token', { method: 'POST' })
      setSubscription(result)
      setShortCode(result.custom_user_short_code ?? '')
      setShowSubscriptionToken(true)
      announce('订阅 Token 已重置，请更新所有客户端中的订阅地址。')
    } catch (reason) {
      announce(messageOf(reason, '无法重置订阅 Token'), true)
    } finally {
      setSubscriptionBusy('')
    }
  }

  const saveShortCode = async (override?: string) => {
    if (!tokenLoaded) return announce('订阅 Token 尚未载入，已阻止修改短码。请刷新后重试。', true)
    const value = (override ?? shortCode).trim()
    if (value && !/^[A-Za-z0-9_-]{2,16}$/.test(value)) return announce('短码须为 2–16 位字母、数字、下划线或横杠。', true)
    setSubscriptionBusy('short-code')
    try {
      const result = await api<SubscriptionToken>('/api/user/token', {
        method: 'PUT', body: JSON.stringify({ custom_user_short_code: value }),
      })
      setSubscription(result)
      setShortCode(result.custom_user_short_code ?? '')
      announce(value ? '自定义短码已保存。' : '已恢复使用系统自动短码。')
    } catch (reason) {
      announce(messageOf(reason, '无法保存短码'), true)
    } finally {
      setSubscriptionBusy('')
    }
  }

  const setConfigField = <K extends keyof UserConfig>(key: K, value: UserConfig[K]) => setConfig((old) => ({ ...old, [key]: value }))

  const saveConfig = async (event: FormEvent) => {
    event.preventDefault()
    if (!configLoaded) return announce('订阅偏好尚未完整载入，已阻止保存。请刷新后重试。', true)
    setConfigBusy(true)
    try {
      const result = await api<Partial<UserConfig>>('/api/user/config', {
        method: 'PUT',
        body: JSON.stringify({
          force_sync_external: config.force_sync_external,
          match_rule: config.match_rule,
          sync_scope: config.sync_scope,
          keep_node_name: config.keep_node_name,
          cache_expire_minutes: Math.max(0, Number(config.cache_expire_minutes) || 0),
          sync_traffic: config.sync_traffic,
          node_name_filter: config.node_name_filter,
          append_sub_info: config.append_sub_info,
          custom_rules_enabled: true,
          enable_short_link: config.enable_short_link,
          use_new_template_system: config.use_new_template_system,
          enable_proxy_provider: config.enable_proxy_provider,
          ...(isAdmin ? {
            proxy_groups_source_url: config.proxy_groups_source_url.trim(),
            client_compatibility_mode: config.client_compatibility_mode,
            enable_sub_info_nodes: config.enable_sub_info_nodes,
            sub_info_v2ray_only: config.sub_info_v2ray_only,
            sub_info_expire_prefix: config.sub_info_expire_prefix,
            sub_info_traffic_prefix: config.sub_info_traffic_prefix,
          } : {}),
        }),
      })
      setConfig((old) => normalizeConfig({ ...old, ...result, subscription_url: old.subscription_url, node_order: old.node_order }))
      announce('订阅与同步偏好已保存并立即生效。')
    } catch (reason) {
      announce(messageOf(reason, '无法保存偏好'), true)
    } finally {
      setConfigBusy(false)
    }
  }

  const tabs: { id: AccountTab; label: string; description: string; icon: string }[] = [
    { id: 'profile', label: '个人资料', description: '账号身份与公开信息', icon: 'user' },
    { id: 'security', label: '登录安全', description: '密码与两步验证', icon: 'shield' },
    { id: 'access', label: '令牌与绑定', description: 'API、订阅和 Telegram', icon: 'key' },
    { id: 'preferences', label: '订阅偏好', description: '同步、输出与兼容性', icon: 'sliders' },
  ]

  return <div className={`mmx-account ${className}`}>
    <div className="page-header">
      <div><h1>账户中心</h1><p>管理个人资料、登录安全、访问令牌与订阅偏好</p></div>
      <div className="page-actions"><Button variant="secondary" icon="refresh" disabled={refreshing} onClick={() => void loadAll(true)}>{refreshing ? '刷新中…' : '刷新资料'}</Button></div>
    </div>
    <Notice feedback={feedback}/>
    {loading ? <Card><Spinner/></Card> : <div className="mmx-account-layout">
      <aside className="mmx-account-tabs" role="tablist" aria-label="账户设置分类">
        <div className="mmx-account-summary">
          <span className="mmx-avatar">
            {profile.avatar_url && !avatarFailed ? <img src={profile.avatar_url} alt="" onError={() => setAvatarFailed(true)}/> : (profile.nickname || profile.username || 'U').slice(0, 1).toUpperCase()}
          </span>
          <div><strong>{profile.nickname || profile.username || '当前用户'}</strong><small>{profile.email || profile.username}</small></div>
          <span className="mmx-role">{profile.is_admin ? '管理员' : '用户'}</span>
        </div>
        {tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}><span><Icon name={item.icon}/></span><div><strong>{item.label}</strong><small>{item.description}</small></div></button>)}
      </aside>

      <div className="mmx-account-content">
        {tab === 'profile' && <div className="mmx-card-stack" role="tabpanel">
          <Card>
            <CardHead icon="user" title="个人资料" description="这些信息会显示在面板中的账户入口"/>
            <form className="mmx-form" onSubmit={saveProfile}>
              <div className="mmx-profile-preview">
                <span className="mmx-avatar large">{profileForm.avatar_url && !avatarFailed ? <img src={profileForm.avatar_url} alt="头像预览" onError={() => setAvatarFailed(true)}/> : (profileForm.nickname || profileForm.username || 'U').slice(0, 1).toUpperCase()}</span>
                <div><strong>{profileForm.nickname || profileForm.username || '未设置昵称'}</strong><small>{profileForm.role === 'admin' ? '管理员账户' : '普通用户账户'}</small></div>
              </div>
              <div className="field-row">
                <label><span>用户名</span><input required minLength={3} maxLength={20} autoComplete="username" value={profileForm.username} disabled={profile.is_admin} onChange={(event) => setProfileField('username', event.target.value)}/><small className="mmx-field-help">{profile.is_admin ? '为避免破坏初始管理身份，管理员用户名不可修改。' : '3–20 位字母、数字或横杠。修改后立即生效。'}</small></label>
                <label><span>昵称</span><input maxLength={80} autoComplete="nickname" value={profileForm.nickname} onChange={(event) => setProfileField('nickname', event.target.value)} placeholder="显示名称"/></label>
              </div>
              <label><span>邮箱</span><input type="email" maxLength={254} autoComplete="email" value={profileForm.email} onChange={(event) => setProfileField('email', event.target.value)} placeholder="name@example.com"/></label>
              <label><span>头像地址</span><input type="url" value={profileForm.avatar_url} onChange={(event) => setProfileField('avatar_url', event.target.value)} placeholder="https://example.com/avatar.png"/><small className="mmx-field-help">留空时使用昵称或用户名的首字母。</small></label>
              <div className="mmx-form-actions"><Button type="submit" disabled={profileBusy}>{profileBusy ? '保存中…' : '保存个人资料'}</Button></div>
            </form>
          </Card>
        </div>}

        {tab === 'security' && <div className="mmx-card-stack" role="tabpanel">
          <Card>
            <CardHead icon="key" title="修改密码" description="更新成功后，下次登录开始使用新密码"/>
            <form className="mmx-form" onSubmit={changePassword}>
              <label><span>当前密码</span><input required type="password" autoComplete="current-password" value={passwordForm.current} onChange={(event) => setPasswordForm((old) => ({ ...old, current: event.target.value }))}/></label>
              <div className="field-row">
                <label><span>新密码</span><input required type="password" minLength={8} autoComplete="new-password" value={passwordForm.next} onChange={(event) => setPasswordForm((old) => ({ ...old, next: event.target.value }))}/><small className="mmx-field-help">至少 8 个字符、最多 72 个字节，建议使用独立的长密码。</small></label>
                <label><span>确认新密码</span><input required type="password" minLength={8} autoComplete="new-password" value={passwordForm.confirm} onChange={(event) => setPasswordForm((old) => ({ ...old, confirm: event.target.value }))}/></label>
              </div>
              <div className="mmx-form-actions"><Button type="submit" disabled={passwordBusy}>{passwordBusy ? '更新中…' : '更新密码'}</Button></div>
            </form>
          </Card>

          <Card className="mmx-two-factor-card">
            <CardHead icon="shield" title="两步验证" description="登录时额外验证认证器中的动态验证码" aside={<span className={`badge ${twoFactorStatusLoaded && twoFactorEnabled ? 'success' : ''}`}>{twoFactorStatusLoaded ? (twoFactorEnabled ? '已启用' : '未启用') : '状态未知'}</span>}/>
            {recoveryCodes.length > 0 && <div className="mmx-recovery-box">
              <div><strong>立即保存恢复码</strong><p>每个恢复码仅可用于一次紧急登录；后端不会再次返回这些明文。</p></div>
              <div className="mmx-recovery-codes">{recoveryCodes.map((code) => <code key={code}>{code}</code>)}</div>
              <div className="mmx-inline-actions"><Button variant="secondary" icon="copy" onClick={() => void copy(recoveryCodes.join('\n'), '恢复码')}>复制全部</Button><Button variant="secondary" icon="download" onClick={downloadRecoveryCodes}>下载文本</Button><Button variant="ghost" onClick={() => setRecoveryCodes([])}>我已保存</Button></div>
            </div>}
            {!twoFactorStatusLoaded ? <div className="form-note mmx-danger-note">两步验证状态读取失败。为避免替换已有密钥，设置与关闭操作已锁定；请刷新资料后重试。</div> : twoFactorEnabled ? <form className="mmx-form" onSubmit={disableTwoFactor}>
              <div className="form-note">关闭两步验证需要当前认证器中的 6 位验证码。恢复码不能用于此操作。</div>
              <label><span>认证器验证码</span><input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={disableCode} onChange={(event) => setDisableCode(event.target.value.replace(/\D/g, ''))} placeholder="000000"/></label>
              <div className="mmx-form-actions"><Button type="submit" variant="danger" disabled={Boolean(twoFactorBusy)}>{twoFactorBusy === 'disable' ? '关闭中…' : '关闭两步验证'}</Button></div>
            </form> : twoFactorSetup ? <form className="mmx-form" onSubmit={verifyTwoFactor}>
              <div className="mmx-secret-box"><div><span>认证器密钥</span><code>{twoFactorSetup.secret}</code></div><Button type="button" variant="secondary" icon="copy" onClick={() => void copy(twoFactorSetup.secret, '认证器密钥')}>复制</Button></div>
              <div className="form-note">在 Google Authenticator、Microsoft Authenticator、1Password 等应用中扫描/导入该 otpauth 地址，或手动输入上方密钥。</div>
              <div className="mmx-inline-actions"><a className="btn secondary mmx-link-button" href={twoFactorSetup.url}><Icon name="external"/>在认证器中打开</a><Button type="button" variant="ghost" icon="copy" onClick={() => void copy(twoFactorSetup.url, 'otpauth 地址')}>复制 otpauth 地址</Button></div>
              <label><span>验证并启用</span><input required autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={twoFactorCode} onChange={(event) => setTwoFactorCode(event.target.value.replace(/\D/g, ''))} placeholder="输入认证器中的 6 位验证码"/></label>
              <div className="mmx-form-actions"><Button type="button" variant="secondary" onClick={() => { setTwoFactorSetup(null); setTwoFactorCode('') }}>取消设置</Button><Button type="submit" disabled={Boolean(twoFactorBusy)}>{twoFactorBusy === 'verify' ? '验证中…' : '验证并启用'}</Button></div>
            </form> : <form className="mmx-form" onSubmit={startTwoFactorSetup}>
              <div className="form-note">启用前先用当前密码确认身份。随后需要在认证器中添加密钥并验证一次。</div>
              <label><span>当前密码</span><input required type="password" autoComplete="current-password" value={twoFactorPassword} onChange={(event) => setTwoFactorPassword(event.target.value)} placeholder="输入当前登录密码"/></label>
              <div className="mmx-form-actions"><Button type="submit" disabled={Boolean(twoFactorBusy)}>{twoFactorBusy === 'setup' ? '生成中…' : '开始设置'}</Button></div>
            </form>}
          </Card>
        </div>}

        {tab === 'access' && <div className="mmx-card-stack" role="tabpanel">
          <Card>
            <CardHead icon="key" title="用户 API Token" description="供 MCP、脚本与其他程序调用你的授权接口" aside={<span className="badge">{apiTokens.length} 枚</span>}/>
            {createdAPIToken && <div className="mmx-created-token">
              <div><strong>{createdAPIToken.name} 已创建</strong><p>明文只显示这一次，请立即复制并保存在密码管理器中。</p></div>
              <code>{createdAPIToken.token}</code>
              <div className="mmx-inline-actions"><Button variant="secondary" icon="copy" onClick={() => void copy(createdAPIToken.token, 'API Token')}>复制 Token</Button><Button variant="ghost" onClick={() => setCreatedAPIToken(null)}>关闭明文</Button></div>
            </div>}
            <form className="mmx-inline-form" onSubmit={createAPIToken}><label><span>新 Token 名称</span><input maxLength={64} disabled={Boolean(createdAPIToken)} value={apiTokenName} onChange={(event) => setAPITokenName(event.target.value)} placeholder={createdAPIToken ? '请先保存并关闭上方明文' : '例如：家庭服务器 MCP'}/></label><Button type="submit" icon="plus" disabled={apiTokenBusy || Boolean(createdAPIToken)}>{apiTokenBusy ? '处理中…' : '创建 Token'}</Button></form>
            {apiTokens.length ? <div className="mmx-token-list">{apiTokens.map((token) => <article key={token.id}><span className="mmx-list-icon"><Icon name="key"/></span><div><strong>{token.name}</strong><small>创建：{formatDate(token.created_at)} · 最近使用：{formatDate(token.last_used_at)}</small></div><Button variant="danger" icon="trash" disabled={apiTokenBusy} onClick={() => void revokeAPIToken(token)}>吊销</Button></article>)}</div> : <div className="mmx-empty-inline"><strong>还没有 API Token</strong><span>创建后可用于程序化访问；明文只会返回一次。</span></div>}
          </Card>

          <Card>
            <CardHead icon="telegram" title="Telegram 绑定" description="将面板账号与 Telegram 机器人身份关联" aside={<span className={`badge ${telegram?.bound ? 'success' : ''}`}>{telegram?.bound ? '已绑定' : '未绑定'}</span>}/>
            {telegram?.bound ? <div className="mmx-binding-status"><span className="mmx-list-icon telegram"><Icon name="telegram" size={20}/></span><div><strong>{telegram.telegram_username ? `@${telegram.telegram_username.replace(/^@/, '')}` : `Telegram #${telegram.telegram_id}`}</strong><small>Telegram ID：{telegram.telegram_id}</small></div><Button variant="danger" disabled={telegramBusy} onClick={() => void unbindTelegram()}>解除绑定</Button></div> : <>
              {telegramInvite ? <div className="mmx-invite-box">
                <div><strong>绑定码：<code>{telegramInvite.code}</code></strong><small>有效期至 {formatDate(telegramInvite.expires_at)}</small></div>
                <code>{telegramInvite.command}</code>
                <div className="mmx-inline-actions"><Button variant="secondary" icon="copy" onClick={() => void copy(telegramInvite.command, '绑定命令')}>复制命令</Button>{telegramStartURL(telegramInvite.bot_url, telegramInvite.code) && <a className="btn primary mmx-link-button" href={telegramStartURL(telegramInvite.bot_url, telegramInvite.code)} target="_blank" rel="noreferrer"><Icon name="external"/>打开 Telegram</a>}<Button variant="ghost" icon="refresh" disabled={telegramBusy} onClick={() => void refreshTelegram()}>我已绑定，刷新</Button></div>
              </div> : <div className="mmx-empty-inline"><strong>尚未绑定 Telegram</strong><span>生成一次性绑定码后，在机器人中发送对应的 /start 命令。</span></div>}
              {!telegramInvite && <div className="mmx-form-actions"><Button icon="link" disabled={telegramBusy} onClick={() => void createTelegramInvite()}>{telegramBusy ? '生成中…' : '生成绑定码'}</Button></div>}
            </>}
          </Card>

          <Card>
            <CardHead icon="link" title="订阅 Token 与短码" description="用于个人订阅鉴权和短链接识别"/>
            {!tokenLoaded && <div className="form-note mmx-danger-note">订阅 Token 读取失败。为避免清空现有短码或误触轮换，相关操作已锁定；请刷新资料后重试。</div>}
            <div className="mmx-secret-box"><div><span>订阅 Token</span><code>{showSubscriptionToken ? subscription.token || '—' : maskSecret(subscription.token)}</code></div><div className="mmx-inline-actions"><Button variant="ghost" icon={showSubscriptionToken ? 'eyeOff' : 'eye'} onClick={() => setShowSubscriptionToken((old) => !old)}>{showSubscriptionToken ? '隐藏' : '显示'}</Button><Button variant="secondary" icon="copy" disabled={!subscription.token} onClick={() => void copy(subscription.token, '订阅 Token')}>复制</Button></div></div>
            <div className="form-note mmx-danger-note">重置 Token 会让所有旧订阅地址立即失效。仅在 Token 泄露或需要主动轮换时使用。</div>
            <div className="mmx-form-actions"><Button variant="danger" disabled={!tokenLoaded || Boolean(subscriptionBusy)} onClick={() => void resetSubscriptionToken()}>{subscriptionBusy === 'token' ? '重置中…' : '重置订阅 Token'}</Button></div>
            <hr className="mmx-divider"/>
            <div className="mmx-short-code-head"><div><strong>个人短码</strong><small>当前生效：<code>{subscription.user_short_code || '—'}</code>{subscription.custom_user_short_code ? '（自定义）' : '（系统自动）'}</small></div></div>
            <div className="mmx-inline-form"><label><span>自定义短码</span><input minLength={2} maxLength={16} pattern="[A-Za-z0-9_-]{2,16}" disabled={!tokenLoaded} value={shortCode} onChange={(event) => setShortCode(event.target.value)} placeholder="留空使用系统自动短码"/><small className="mmx-field-help">2–16 位字母、数字、下划线或横杠；系统保留字不可使用。</small></label><div className="mmx-stacked-actions"><Button disabled={!tokenLoaded || Boolean(subscriptionBusy)} onClick={() => void saveShortCode()}>{subscriptionBusy === 'short-code' ? '保存中…' : '保存短码'}</Button>{subscription.custom_user_short_code && <Button variant="secondary" disabled={!tokenLoaded || Boolean(subscriptionBusy)} onClick={() => { setShortCode(''); void saveShortCode('') }}>恢复自动</Button>}</div></div>
          </Card>
        </div>}

        {tab === 'preferences' && <form className="mmx-card-stack" role="tabpanel" onSubmit={saveConfig}>
          {!configLoaded && <div className="form-note mmx-danger-note">订阅偏好读取失败。为避免用默认值覆盖现有设置，整个表单已锁定；请刷新资料后重试。</div>}
          <fieldset className="mmx-preferences-fields" disabled={!configLoaded}>
          <Card>
            <CardHead icon="refresh" title="外部订阅同步" description="控制外部节点同步时的匹配、命名和缓存行为"/>
            <div className="setting-list">
              <Switch title="强制同步外部订阅" description="同步时覆盖已保存节点中可更新的字段" checked={config.force_sync_external} onChange={(value) => setConfigField('force_sync_external', value)}/>
              <Switch title="保留原节点名称" description="导入或同步时尽量沿用外部订阅中的节点名称" checked={config.keep_node_name} onChange={(value) => setConfigField('keep_node_name', value)}/>
              <Switch title="同步流量信息" description="将外部订阅提供的流量与到期信息一并更新" checked={config.sync_traffic} onChange={(value) => setConfigField('sync_traffic', value)}/>
            </div>
            <div className="field-row mmx-form-grid">
              <label><span>节点匹配规则</span><select value={config.match_rule} onChange={(event) => setConfigField('match_rule', event.target.value as UserConfig['match_rule'])}><option value="node_name">按节点名称</option><option value="server_port">按服务器与端口</option><option value="type_server_port">按协议、服务器与端口</option></select></label>
              <label><span>同步范围</span><select value={config.sync_scope} onChange={(event) => setConfigField('sync_scope', event.target.value as UserConfig['sync_scope'])}><option value="saved_only">仅同步已保存节点</option><option value="all">同步全部匹配节点</option></select></label>
              <label><span>缓存有效期（分钟）</span><input type="number" min={0} value={config.cache_expire_minutes} onChange={(event) => setConfigField('cache_expire_minutes', Math.max(0, Number(event.target.value) || 0))}/><small className="mmx-field-help">0 表示不使用缓存。</small></label>
              <label><span>节点名称过滤表达式</span><input value={config.node_name_filter} onChange={(event) => setConfigField('node_name_filter', event.target.value)} placeholder="剩余|流量|到期|订阅|时间|重置"/><small className="mmx-field-help">匹配这些关键词的伪节点会被过滤。</small></label>
            </div>
          </Card>

          <Card>
            <CardHead icon="link" title="订阅输出" description="短链接、模板与 Proxy Provider 输出方式"/>
            {config.subscription_url && <label className="mmx-readonly-field"><span>系统订阅地址</span><input readOnly value={config.subscription_url}/></label>}
            <div className="setting-list">
              <Switch title="附加订阅信息" description="在客户端支持时写入剩余流量和到期信息" checked={config.append_sub_info} onChange={(value) => setConfigField('append_sub_info', value)}/>
              <Switch title="启用短链接" description="允许为订阅输出使用短链接形式" checked={config.enable_short_link} onChange={(value) => setConfigField('enable_short_link', value)}/>
              <Switch title="使用新版模板系统" description="使用当前模板渲染流程生成订阅" checked={config.use_new_template_system} onChange={(value) => setConfigField('use_new_template_system', value)}/>
              <Switch title="启用 Proxy Provider" description="为 Mihomo 等客户端输出 Proxy Provider 结构" checked={config.enable_proxy_provider} onChange={(value) => setConfigField('enable_proxy_provider', value)}/>
              <Switch title="自定义规则" description="安全规则始终启用，不允许在用户侧关闭" checked disabled onChange={() => undefined}/>
            </div>
            {isAdmin && <label className="mmx-block-field"><span>代理组配置来源（全局）</span><input type="url" value={config.proxy_groups_source_url} onChange={(event) => setConfigField('proxy_groups_source_url', event.target.value)} placeholder="https://example.com/proxy-groups.json"/><small className="mmx-field-help">仅管理员可修改；留空使用系统默认来源。</small></label>}
          </Card>

          {isAdmin && <Card>
            <CardHead icon="sliders" title="兼容性与信息节点" description="针对老旧客户端和订阅信息展示进行微调"/>
            <div className="setting-list">
              <Switch title="客户端兼容模式" description="自动过滤目标客户端无法识别的节点配置" checked={config.client_compatibility_mode} onChange={(value) => setConfigField('client_compatibility_mode', value)}/>
              <Switch title="生成订阅信息节点" description="将到期时间和剩余流量作为特殊节点写入订阅" checked={config.enable_sub_info_nodes} onChange={(value) => setConfigField('enable_sub_info_nodes', value)}/>
              <Switch title="仅 V2Ray 类订阅生成信息节点" description="避免在其他输出格式中加入提示节点" checked={config.sub_info_v2ray_only} disabled={!config.enable_sub_info_nodes} onChange={(value) => setConfigField('sub_info_v2ray_only', value)}/>
            </div>
            <div className="field-row mmx-form-grid">
              <label><span>到期信息前缀</span><input disabled={!config.enable_sub_info_nodes} value={config.sub_info_expire_prefix} onChange={(event) => setConfigField('sub_info_expire_prefix', event.target.value)} placeholder="到期时间"/></label>
              <label><span>流量信息前缀</span><input disabled={!config.enable_sub_info_nodes} value={config.sub_info_traffic_prefix} onChange={(event) => setConfigField('sub_info_traffic_prefix', event.target.value)} placeholder="剩余流量"/></label>
            </div>
          </Card>}
          </fieldset>
          <div className="mmx-sticky-save"><span>节点拖拽顺序由“节点管理”页面单独维护，保存这里的偏好不会清空它。</span><Button type="submit" disabled={!configLoaded || configBusy}>{configBusy ? '保存中…' : '保存全部偏好'}</Button></div>
        </form>}
      </div>
    </div>}
  </div>
}

export default AccountPage
