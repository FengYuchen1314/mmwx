import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  Accordion,
  Alert,
  Anchor,
  Button,
  Card,
  Checkbox,
  Divider,
  FileInput,
  Group,
  PasswordInput,
  Progress,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import {
  IconCloudUpload,
  IconDatabaseImport,
  IconKey,
  IconLock,
  IconRefresh,
  IconShieldCheck,
  IconWorldCheck,
} from '@tabler/icons-react'

import {
  messageOf,
  publicRequest,
  saveSession,
} from '@/adapters/mmwx/api'
import type { LoginResult } from '@/adapters/mmwx/types'
import { correspondingSourceUrl, remnawaveSourceUrl } from '@/shared/lib/source'

interface AuthPageProps {
  onAuthenticated: (profile: LoginResult) => void
}

type SetupState = 'loading' | 'required' | 'ready' | 'error'

function passwordScore(value: string): number {
  return (
    Number(value.length >= 8) +
    Number(value.length >= 12) +
    Number(/[a-zA-Z]/.test(value) && /\d/.test(value)) +
    Number(/[^a-zA-Z0-9]/.test(value))
  )
}

function Captcha({ siteKey, onToken }: { siteKey: string; onToken: (token: string) => void }) {
  const compact = useMediaQuery('(max-width: 25em)', undefined, { getInitialValueInEffect: false })
  useEffect(() => {
    const target = window as typeof window & {
      controlCaptchaDone?: (token: string) => void
      controlCaptchaExpired?: () => void
    }
    target.controlCaptchaDone = onToken
    target.controlCaptchaExpired = () => onToken('')
    if (!document.querySelector('script[data-control-captcha]')) {
      const script = document.createElement('script')
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
      script.async = true
      script.defer = true
      script.dataset.controlCaptcha = '1'
      document.head.appendChild(script)
    }
    return () => {
      delete target.controlCaptchaDone
      delete target.controlCaptchaExpired
    }
  }, [onToken])

  return (
    <div
      className="cf-turnstile control-captcha"
      data-sitekey={siteKey}
      data-callback="controlCaptchaDone"
      data-expired-callback="controlCaptchaExpired"
      data-size={compact ? 'compact' : 'flexible'}
      data-theme="dark"
    />
  )
}

export function AuthPage({ onAuthenticated }: AuthPageProps) {
  const [setupState, setSetupState] = useState<SetupState>('loading')
  const [setupError, setSetupError] = useState('')
  const [form, setForm] = useState({
    username: '',
    nickname: '',
    email: '',
    password: '',
    confirmation: '',
    domain: '',
  })
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [twoFactorToken, setTwoFactorToken] = useState('')
  const [twoFactorCode, setTwoFactorCode] = useState('')
  const [recoveryMode, setRecoveryMode] = useState(false)
  const [captcha, setCaptcha] = useState({ enabled: false, siteKey: '', token: '' })
  const [domainStatus, setDomainStatus] = useState('')
  const [backup, setBackup] = useState<File | null>(null)
  const required = setupState === 'required'
  const score = passwordScore(form.password)

  const setField = (key: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [key]: value }))

  const loadStatus = async () => {
    setSetupState('loading')
    setSetupError('')
    try {
      const status = await publicRequest<{ needs_setup?: boolean }>('/api/setup/status')
      setSetupState(status.needs_setup ? 'required' : 'ready')
    } catch (reason) {
      setSetupError(messageOf(reason, '无法确认安装状态'))
      setSetupState('error')
    }
  }

  useEffect(() => {
    void loadStatus()
    void publicRequest<{ enabled?: boolean; site_key?: string }>('/api/captcha/config')
      .then((value) =>
        setCaptcha({
          enabled: Boolean(value.enabled && value.site_key),
          siteKey: String(value.site_key ?? ''),
          token: '',
        }),
      )
      .catch(() => undefined)
  }, [])

  const validation = useMemo(() => {
    if (!required) return ''
    if (!/^[a-zA-Z0-9-]{3,20}$/.test(form.username.trim())) {
      return '用户名须为 3–20 位字母、数字或短横线。'
    }
    if (form.password.length < 8) return '密码至少需要 8 个字符。'
    if (new TextEncoder().encode(form.password).length > 72) return '密码不能超过 72 字节。'
    if (form.password !== form.confirmation) return '两次输入的密码不一致。'
    if (form.email && !/^[^\s@]+@[^\s@]+$/.test(form.email)) return '邮箱格式不正确。'
    return ''
  }, [form, required])

  const finishLogin = (result: LoginResult) => {
    if (!result.token) throw new Error('服务端没有返回登录凭据')
    saveSession(result.token, remember)
    onAuthenticated(result)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    if (twoFactorToken) {
      if (!twoFactorCode.trim()) return
      setBusy(true)
      try {
        const body = recoveryMode
          ? { two_factor_token: twoFactorToken, recovery_code: twoFactorCode.trim() }
          : { two_factor_token: twoFactorToken, code: twoFactorCode.trim() }
        const result = await publicRequest<LoginResult>(
          recoveryMode ? '/api/login/recovery' : '/api/login/2fa',
          { method: 'POST', body: JSON.stringify(body) },
        )
        finishLogin(result)
      } catch (reason) {
        setError(messageOf(reason))
      } finally {
        setBusy(false)
      }
      return
    }

    if (!form.username.trim() || !form.password || validation) {
      setError(validation || '请输入用户名和密码。')
      return
    }
    if (captcha.enabled && !required && !captcha.token) {
      setError('请先完成人机验证。')
      return
    }

    setBusy(true)
    try {
      if (required) {
        await publicRequest('/api/setup/init', {
          method: 'POST',
          body: JSON.stringify({
            username: form.username.trim(),
            password: form.password,
            nickname: form.nickname.trim() || form.username.trim(),
            email: form.email.trim(),
            domain: form.domain.trim(),
          }),
        })
      }
      const result = await publicRequest<LoginResult>('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          username: form.username.trim(),
          password: form.password,
          remember_me: remember,
          turnstile_token: captcha.token,
        }),
      })
      if (result.requires_2fa && result.two_factor_token) {
        setTwoFactorToken(result.two_factor_token)
        setTwoFactorCode('')
      } else {
        finishLogin(result)
      }
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  const verifyDomain = async () => {
    setDomainStatus('正在验证 DNS 解析…')
    try {
      const result = await publicRequest<{ match?: boolean; message?: string }>(
        '/api/setup/verify-domain',
        { method: 'POST', body: JSON.stringify({ domain: form.domain.trim() }) },
      )
      setDomainStatus(result.message || (result.match ? '域名已指向当前主控。' : '解析尚未匹配。'))
    } catch (reason) {
      setDomainStatus(messageOf(reason))
    }
  }

  const restoreBackup = async () => {
    if (!backup) return
    setBusy(true)
    setError('')
    try {
      const body = new FormData()
      body.append('backup', backup)
      await publicRequest('/api/setup/restore-backup', { method: 'POST', body })
      setDomainStatus('备份已恢复；主控如正在重启，请稍后重新检查。')
      window.setTimeout(() => void loadStatus(), 1800)
    } catch (reason) {
      setError(messageOf(reason, '恢复失败'))
    } finally {
      setBusy(false)
    }
  }

  if (setupState === 'loading') {
    return (
      <main className="control-login">
        <Stack align="center" gap="md">
          <ThemeIcon size={54} radius="xl" variant="light">
            <IconLock size={27} />
          </ThemeIcon>
          <Text c="dimmed">正在连接控制平面…</Text>
        </Stack>
      </main>
    )
  }

  if (setupState === 'error') {
    return (
      <main className="control-login">
        <Card className="control-login-panel" p="xl" shadow="xl" withBorder>
          <Stack>
            <Title order={2}>连接失败</Title>
            <Text c="dimmed">无法判断这是首次安装还是普通登录，已停止继续。</Text>
            <Alert color="red">{setupError}</Alert>
            <Button leftSection={<IconRefresh size={17} />} onClick={() => void loadStatus()}>
              重新检查
            </Button>
          </Stack>
        </Card>
      </main>
    )
  }

  return (
    <main className="control-login">
      <Card className="control-login-panel control-surface" p={{ base: 'lg', sm: 'xl' }} shadow="xl" withBorder>
        <form onSubmit={submit}>
          <Stack gap="lg">
            <Stack align="center" gap={3}>
              <Text className="control-brand" fz={38} lh={1}>
                MMW<span className="control-brand-accent">X</span>
              </Text>
              <Text c="dimmed" fz="sm">
                {twoFactorToken
                  ? '验证第二重身份凭据'
                  : required
                    ? '初始化网络控制平面'
                    : '登录网络控制平面'}
              </Text>
            </Stack>
            <Divider />

            {twoFactorToken ? (
              <>
                <TextInput
                  autoFocus
                  label={recoveryMode ? '恢复码' : '认证器验证码'}
                  leftSection={<IconKey size={17} />}
                  maxLength={recoveryMode ? 64 : 6}
                  onChange={(event) =>
                    setTwoFactorCode(
                      recoveryMode ? event.currentTarget.value : event.currentTarget.value.replace(/\D/g, ''),
                    )
                  }
                  placeholder={recoveryMode ? '输入一枚未使用的恢复码' : '000000'}
                  value={twoFactorCode}
                />
                <Anchor
                  component="button"
                  fz="sm"
                  onClick={() => {
                    setRecoveryMode((value) => !value)
                    setTwoFactorCode('')
                  }}
                  type="button"
                >
                  {recoveryMode ? '改用认证器验证码' : '使用恢复码'}
                </Anchor>
              </>
            ) : (
              <>
                <TextInput
                  autoComplete="username"
                  autoFocus
                  label="用户名"
                  onChange={(event) => setField('username', event.currentTarget.value)}
                  placeholder="your-name"
                  required
                  value={form.username}
                />
                {required ? (
                  <Group grow align="start">
                    <TextInput
                      label="昵称"
                      onChange={(event) => setField('nickname', event.currentTarget.value)}
                      placeholder="可选"
                      value={form.nickname}
                    />
                    <TextInput
                      label="邮箱"
                      onChange={(event) => setField('email', event.currentTarget.value)}
                      placeholder="可选"
                      type="email"
                      value={form.email}
                    />
                  </Group>
                ) : null}
                <PasswordInput
                  autoComplete={required ? 'new-password' : 'current-password'}
                  label="密码"
                  onChange={(event) => setField('password', event.currentTarget.value)}
                  required
                  value={form.password}
                />
                {required ? (
                  <>
                    <PasswordInput
                      autoComplete="new-password"
                      label="确认密码"
                      onChange={(event) => setField('confirmation', event.currentTarget.value)}
                      required
                      value={form.confirmation}
                    />
                    <Stack gap={5}>
                      <Progress color={score < 2 ? 'red' : score < 4 ? 'yellow' : 'teal'} value={score * 25} />
                      <Text c="dimmed" fz="xs">建议使用 12 位以上并混合字母、数字和符号。</Text>
                    </Stack>
                    <Accordion variant="separated">
                      <Accordion.Item value="advanced">
                        <Accordion.Control icon={<IconCloudUpload size={18} />}>
                          域名与数据恢复
                        </Accordion.Control>
                        <Accordion.Panel>
                          <Stack>
                            <TextInput
                              label="主控域名（可选）"
                              onChange={(event) => setField('domain', event.currentTarget.value)}
                              placeholder="panel.example.com"
                              value={form.domain}
                            />
                            <Button
                              disabled={!form.domain.trim()}
                              leftSection={<IconWorldCheck size={17} />}
                              onClick={() => void verifyDomain()}
                              type="button"
                              variant="light"
                            >
                              验证 DNS
                            </Button>
                            {domainStatus ? <Alert color="cyan">{domainStatus}</Alert> : null}
                            <FileInput
                              accept=".zip,.bak,.mmwx"
                              clearable
                              label="恢复完整备份"
                              onChange={setBackup}
                              value={backup}
                            />
                            <Button
                              disabled={!backup || busy}
                              leftSection={<IconDatabaseImport size={17} />}
                              onClick={() => void restoreBackup()}
                              type="button"
                              variant="light"
                            >
                              恢复备份
                            </Button>
                          </Stack>
                        </Accordion.Panel>
                      </Accordion.Item>
                    </Accordion>
                  </>
                ) : (
                  <Checkbox
                    checked={remember}
                    label="记住此设备 30 天"
                    onChange={(event) => setRemember(event.currentTarget.checked)}
                  />
                )}
                {captcha.enabled && !required ? (
                  <Captcha
                    onToken={(token) => setCaptcha((value) => ({ ...value, token }))}
                    siteKey={captcha.siteKey}
                  />
                ) : null}
              </>
            )}

            {error ? <Alert color="red">{error}</Alert> : null}
            <Button
              fullWidth
              leftSection={<IconShieldCheck size={18} />}
              loading={busy}
              size="md"
              type="submit"
            >
              {twoFactorToken ? '验证并登录' : required ? '创建管理员并登录' : '登录'}
            </Button>
            {twoFactorToken ? (
              <Button
                onClick={() => {
                  setTwoFactorToken('')
                  setTwoFactorCode('')
                  setError('')
                }}
                type="button"
                variant="subtle"
              >
                返回账号登录
              </Button>
            ) : null}
            <Text c="dimmed" fz="xs" ta="center">
              {required ? '初始化入口将在首个管理员创建后永久关闭' : 'MMWX Control'}
            </Text>
            <Text c="dimmed" fz="xs" ta="center">
              <Anchor href={correspondingSourceUrl} rel="noreferrer" target="_blank">对应源码与 AGPL 许可证</Anchor>
              {' · '}
              <Anchor href={remnawaveSourceUrl} rel="noreferrer" target="_blank">Remnawave 上游</Anchor>
            </Text>
          </Stack>
        </form>
      </Card>
    </main>
  )
}
