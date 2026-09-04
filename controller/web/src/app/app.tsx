import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, Card, Center, Stack, Text, ThemeIcon, Title } from '@mantine/core'
import { IconLockAccess, IconMapOff, IconRefresh } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router'

import { ApiError, clearSession, messageOf, publicRequest, readSession, request } from '@/adapters/mmwx/api'
import type { Branding, LoginResult, Permissions, ProbePayload, Profile } from '@/adapters/mmwx/types'
import { AuthPage } from '@/pages/auth/auth-page'
import { ProbePage } from '@/pages/probe/probe-page'
import { ErrorAlert, LoadingState } from '@/shared/ui/states'
import { DashboardLayout } from '@/widgets/dashboard-layout'

type BootState = 'loading' | 'ready' | 'guest' | 'error'

const AccountPage = lazy(() => import('@/pages/account/account-page').then((module) => ({ default: module.AccountPage })))
const accessPages = () => import('@/pages/access/access-pages')
const UsersPage = lazy(() => accessPages().then((module) => ({ default: module.UsersPage })))
const PackagesPage = lazy(() => accessPages().then((module) => ({ default: module.PackagesPage })))
const adminPages = () => import('@/pages/admin/admin-pages')
const TrafficPage = lazy(() => adminPages().then((module) => ({ default: module.TrafficPage })))
const CertificatesPage = lazy(() => adminPages().then((module) => ({ default: module.CertificatesPage })))
const MonitoringPage = lazy(() => adminPages().then((module) => ({ default: module.MonitoringPage })))
const NotificationsPage = lazy(() => adminPages().then((module) => ({ default: module.NotificationsPage })))
const LogsPage = lazy(() => adminPages().then((module) => ({ default: module.LogsPage })))
const SystemSettingsPage = lazy(() => adminPages().then((module) => ({ default: module.SystemSettingsPage })))
const AdvancedSettingsPage = lazy(() => adminPages().then((module) => ({ default: module.AdvancedSettingsPage })))
const DataPage = lazy(() => adminPages().then((module) => ({ default: module.DataPage })))
const OperationsPage = lazy(() => adminPages().then((module) => ({ default: module.OperationsPage })))
const DashboardPage = lazy(() => import('@/pages/dashboard/dashboard-page').then((module) => ({ default: module.DashboardPage })))
const NodesPage = lazy(() => import('@/pages/infrastructure/nodes-page').then((module) => ({ default: module.NodesPage })))
const ServersPage = lazy(() => import('@/pages/infrastructure/servers-page').then((module) => ({ default: module.ServersPage })))
const libraryPages = () => import('@/pages/library/library-pages')
const TemplatesPage = lazy(() => libraryPages().then((module) => ({ default: module.TemplatesPage })))
const SubscribeFilesPage = lazy(() => libraryPages().then((module) => ({ default: module.SubscribeFilesPage })))
const CustomRulesPage = lazy(() => libraryPages().then((module) => ({ default: module.CustomRulesPage })))
const GeneratorPage = lazy(() => import('@/pages/subscriptions/generator-page').then((module) => ({ default: module.GeneratorPage })))
const SubscriptionsPage = lazy(() => import('@/pages/subscriptions/subscriptions-page').then((module) => ({ default: module.SubscriptionsPage })))

function StatusPage({ kind }: { kind: 'forbidden' | 'missing' }) {
  const forbidden = kind === 'forbidden'
  return (
    <Center mih="60vh">
      <Card maw={520} padding="xl" ta="center" withBorder>
        <ThemeIcon color={forbidden ? 'orange' : 'gray'} mb="md" size={64} variant="light">{forbidden ? <IconLockAccess size={32} /> : <IconMapOff size={32} />}</ThemeIcon>
        <Title order={2}>{forbidden ? '没有访问权限' : '页面不存在'}</Title>
        <Text c="dimmed" mt="sm">{forbidden ? '当前账号没有访问这个功能。管理员可在“系统设置 → 普通用户权限”中调整。' : '这个地址不属于当前控制面板，可能已经移动或被移除。'}</Text>
        <Button component="a" href="/" mt="xl" variant="light">返回总览</Button>
      </Card>
    </Center>
  )
}

function PermissionGuard({ admin, page, profile, permissions, children }: { admin?: boolean; page?: string; profile: Profile; permissions: Permissions; children: ReactNode }) {
  const isAdmin = Boolean(profile.is_admin || profile.role === 'admin' || permissions.is_admin)
  if (admin && !isAdmin) return <StatusPage kind="forbidden" />
  if (!isAdmin && page && !(permissions.pages ?? []).includes(page)) return <StatusPage kind="forbidden" />
  return children
}

async function loadIdentity(): Promise<{ profile: Profile; permissions: Permissions }> {
  const [profile, permissions] = await Promise.all([
    request<Profile>('/api/user/profile'),
    request<Permissions>('/api/user/permissions'),
  ])
  return { profile, permissions }
}

export function App() {
  const [boot, setBoot] = useState<BootState>('loading')
  const [profile, setProfile] = useState<Profile>({})
  const [permissions, setPermissions] = useState<Permissions>({})
  const [probe, setProbe] = useState<ProbePayload | null>(null)
  const [error, setError] = useState('')
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const explicitProbe = location.pathname === '/probe'
  const hiddenLogin = location.pathname === '/admin-login'
  const guestGate = location.pathname === '/' || location.pathname === '/login'

  const load = useCallback(async () => {
    setBoot('loading'); setError('')
    void publicRequest<Branding & { branding?: Branding }>('/api/branding').then((response) => {
      const branding = response.branding ?? response
      const title = String(branding.site_title ?? branding.brand_title ?? '').trim()
      document.title = title ? `${title} · MMWX` : 'MMWX Control'
    }).catch(() => { document.title = 'MMWX Control' })

    const token = readSession()
    if (token && !explicitProbe) {
      try {
        const identity = await loadIdentity()
        setProfile(identity.profile); setPermissions(identity.permissions); setBoot('ready'); return
      } catch (reason) {
        if (reason instanceof ApiError && reason.status === 401) clearSession()
        else { setError(messageOf(reason)); setBoot('error'); return }
      }
    }

    if (explicitProbe || guestGate) {
      try { setProbe(await publicRequest<ProbePayload>('/api/public/probe-servers')) }
      catch { setProbe(null) }
    }
    setBoot('guest')
  }, [explicitProbe, guestGate])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const expire = () => {
      clearSession(); queryClient.clear(); setProfile({}); setPermissions({}); setBoot('guest')
      navigate('/admin-login', { replace: true })
    }
    window.addEventListener('control:session-expired', expire)
    return () => window.removeEventListener('control:session-expired', expire)
  }, [navigate, queryClient])

  const authenticated = boot === 'ready'
  const onAuthenticated = async (_login: LoginResult) => {
    setBoot('loading'); setError('')
    try {
      const identity = await loadIdentity()
      setProfile(identity.profile); setPermissions(identity.permissions); setBoot('ready')
      const destination = hiddenLogin || location.pathname === '/login' || location.pathname === '/' ? '/' : location.pathname
      navigate(destination, { replace: true })
    } catch (reason) {
      clearSession(); setError(messageOf(reason, '登录成功，但无法加载账户权限')); setBoot('error')
    }
  }

  const onLogout = () => {
    clearSession(); queryClient.clear(); setProfile({}); setPermissions({}); setBoot('guest'); navigate('/admin-login', { replace: true })
  }

  const page = useCallback((children: ReactNode, options: { admin?: boolean; permission?: string } = {}) => (
    <PermissionGuard admin={options.admin} page={options.permission} permissions={permissions} profile={profile}>{children}</PermissionGuard>
  ), [permissions, profile])

  const routeTree = useMemo(() => (
    <Routes>
      <Route element={<DashboardLayout onLogout={onLogout} permissions={permissions} profile={profile} />}>
        <Route index element={<DashboardPage permissions={permissions} profile={profile} />} />
        <Route path="xray-servers" element={page(<ServersPage />, { admin: true })} />
        <Route path="nodes" element={page(<NodesPage permissions={permissions} profile={profile} />, { permission: 'nodes' })} />
        <Route path="users" element={page(<UsersPage />, { admin: true })} />
        <Route path="packages" element={page(<PackagesPage />, { admin: true })} />
        <Route path="subscription" element={page(<SubscriptionsPage permissions={permissions} profile={profile} />, { permission: 'subscription' })} />
        <Route path="generator" element={page(<GeneratorPage />, { permission: 'generator' })} />
        <Route path="traffic-center" element={page(<TrafficPage />, { admin: true })} />
        <Route path="templates" element={page(<TemplatesPage permissions={permissions} profile={profile} />, { permission: 'templates' })} />
        <Route path="subscribe-files" element={page(<SubscribeFilesPage />, { permission: 'subscribe-files' })} />
        <Route path="custom-rules" element={page(<CustomRulesPage permissions={permissions} />, { permission: 'custom-rules' })} />
        <Route path="certificates" element={page(<CertificatesPage />, { admin: true })} />
        <Route path="monitoring" element={page(<MonitoringPage />, { admin: true })} />
        <Route path="notifications" element={page(<NotificationsPage />, { admin: true })} />
        <Route path="logs" element={page(<LogsPage />, { admin: true })} />
        <Route path="system-settings" element={page(<SystemSettingsPage />, { admin: true })} />
        <Route path="advanced-system-settings" element={page(<AdvancedSettingsPage />, { admin: true })} />
        <Route path="data" element={page(<DataPage />, { admin: true })} />
        <Route path="operations" element={page(<OperationsPage />, { admin: true })} />
        <Route path="account" element={<AccountPage onProfileChange={setProfile} profile={profile} />} />
        <Route path="admin-login" element={<Navigate replace to="/" />} />
        <Route path="login" element={<Navigate replace to="/" />} />
        <Route path="*" element={<StatusPage kind="missing" />} />
      </Route>
    </Routes>
  ), [onLogout, page, permissions, profile])

  if (explicitProbe) return <ProbePage initialPayload={probe} />
  if (boot === 'loading') return <Center mih="100vh"><LoadingState label="正在连接控制平面" /></Center>
  if (boot === 'error') return <Center mih="100vh"><Card maw={540} padding="xl" withBorder><Stack><Title order={2}>无法载入控制面板</Title><ErrorAlert>{error}</ErrorAlert><Button leftSection={<IconRefresh size={17} />} onClick={() => void load()}>重新加载</Button></Stack></Card></Center>
  if (!authenticated && probe?.enabled && (location.pathname === '/' || (location.pathname === '/login' && probe.block_login))) return <ProbePage initialPayload={probe} />
  if (!authenticated) return <AuthPage onAuthenticated={(value) => void onAuthenticated(value)} />
  return <Suspense fallback={<LoadingState label="正在载入功能模块" />}>{routeTree}</Suspense>
}
