import { useEffect, useMemo, useState, type ElementType } from 'react'
import {
  Alert,
  AppShell,
  Avatar,
  Box,
  Burger,
  Button,
  Divider,
  Group,
  Menu,
  NavLink,
  ScrollArea,
  Stack,
  Text,
} from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import {
  IconActivity,
  IconAdjustments,
  IconBell,
  IconBrandGithub,
  IconBook,
  IconCertificate,
  IconChevronDown,
  IconDashboard,
  IconDatabase,
  IconFileCode,
  IconFolder,
  IconGauge,
  IconKey,
  IconLink,
  IconLogout,
  IconNetwork,
  IconPackage,
  IconServer,
  IconSettings,
  IconShield,
  IconSparkles,
  IconTerminal2,
  IconUsers,
  IconUserShield,
} from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, useLocation } from 'react-router'

import { request } from '@/adapters/mmwx/api'
import type { Announcement, Permissions, Profile } from '@/adapters/mmwx/types'
import { correspondingSourceUrl } from '@/shared/lib/source'

interface DashboardLayoutProps {
  profile: Profile
  permissions: Permissions
  onLogout: () => void
}

interface NavItem {
  label: string
  path: string
  icon: ElementType
  page?: string
  admin?: boolean
}

interface NavGroup {
  label: string
  icon: ElementType
  items: NavItem[]
}

const groups: NavGroup[] = [
  {
    label: '总览',
    icon: IconDashboard,
    items: [{ label: '运行总览', path: '/', icon: IconDashboard }],
  },
  {
    label: '基础设施',
    icon: IconNetwork,
    items: [
      { label: '服务管理', path: '/xray-servers', icon: IconServer, admin: true },
      { label: '节点管理', path: '/nodes', icon: IconNetwork, page: 'nodes' },
      { label: '流量中心', path: '/traffic-center', icon: IconActivity, admin: true },
    ],
  },
  {
    label: '访问与订阅',
    icon: IconUsers,
    items: [
      { label: '用户管理', path: '/users', icon: IconUsers, admin: true },
      { label: '套餐管理', path: '/packages', icon: IconPackage, admin: true },
      { label: '订阅中心', path: '/subscription', icon: IconLink, page: 'subscription' },
      { label: '订阅生成', path: '/generator', icon: IconSparkles, page: 'generator' },
    ],
  },
  {
    label: '策略与模板',
    icon: IconFileCode,
    items: [
      { label: '模板管理', path: '/templates', icon: IconBook, page: 'templates' },
      { label: '订阅文件', path: '/subscribe-files', icon: IconFolder, page: 'subscribe-files' },
      { label: '覆写管理', path: '/custom-rules', icon: IconAdjustments, page: 'custom-rules' },
    ],
  },
  {
    label: '运维',
    icon: IconGauge,
    items: [
      { label: '证书与 DNS', path: '/certificates', icon: IconCertificate, admin: true },
      { label: '测速与探针', path: '/monitoring', icon: IconGauge, admin: true },
      { label: '通知与公告', path: '/notifications', icon: IconBell, admin: true },
      { label: '日志与安全', path: '/logs', icon: IconTerminal2, admin: true },
      { label: '运维工作台', path: '/operations', icon: IconKey, admin: true },
    ],
  },
  {
    label: '系统',
    icon: IconSettings,
    items: [
      { label: '系统设置', path: '/system-settings', icon: IconSettings, admin: true },
      { label: '高级设置', path: '/advanced-system-settings', icon: IconAdjustments, admin: true },
      { label: '数据与版本', path: '/data', icon: IconDatabase, admin: true },
      { label: '账号与安全', path: '/account', icon: IconUserShield },
    ],
  },
]

function isActive(pathname: string, path: string): boolean {
  return path === '/' ? pathname === '/' : pathname.startsWith(path)
}

export function DashboardLayout({ profile, permissions, onLogout }: DashboardLayoutProps) {
  const [opened, { toggle, close }] = useDisclosure(false)
  const [dismissed, setDismissed] = useState<Array<string | number>>([])
  const location = useLocation()
  const isAdmin = Boolean(permissions.is_admin || profile.is_admin || profile.role === 'admin')
  const allowed = useMemo(() => new Set(permissions.pages ?? []), [permissions.pages])

  const visibleGroups = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          items: group.items.filter((item) => {
            if (item.admin) return isAdmin
            if (isAdmin || !item.page) return true
            return allowed.has(item.page)
          }),
        }))
        .filter((group) => group.items.length > 0),
    [allowed, isAdmin],
  )

  const announcements = useQuery({
    queryKey: ['announcements', 'active'],
    queryFn: () => request<{ announcements?: Announcement[] }>('/api/announcements/active'),
  })

  useEffect(() => close(), [location.pathname, close])

  const activeAnnouncements = (announcements.data?.announcements ?? []).filter(
    (item) => !dismissed.includes(item.id ?? ''),
  )

  return (
    <><a className="control-skip-link" href="#control-main">跳到主要内容</a><AppShell
      header={{ height: { base: 64, md: 116 } }}
      navbar={{ width: 300, breakpoint: 'md', collapsed: { desktop: true, mobile: !opened } }}
      padding={{ base: 'sm', sm: 'md', xl: 'xl' }}
    >
      <AppShell.Header bg="dark.7">
        <Group h={64} justify="space-between" px={{ base: 'sm', sm: 'lg' }} wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger aria-label="切换导航" hiddenFrom="md" opened={opened} onClick={toggle} size="sm" />
            <Button component={Link} p={0} to="/" variant="transparent">
              <Text className="control-brand" c="white" fz={24}>
                MMW<span className="control-brand-accent">X</span>
              </Text>
            </Button>
            <Divider hiddenFrom="md" orientation="vertical" />
            <Text c="dimmed" fz="xs" hiddenFrom="sm">
              CONTROL
            </Text>
          </Group>

          <Group gap="xs" wrap="nowrap">
            <Menu position="bottom-end" shadow="xl" width={240}>
              <Menu.Target>
                <Button
                  aria-label={`账户菜单：${profile.nickname || profile.username || '当前账户'}`}
                  leftSection={
                    <Avatar color="cyan" radius="xl" size={26} src={profile.avatar_url || undefined}>
                      {(profile.nickname || profile.username || 'U').slice(0, 1).toUpperCase()}
                    </Avatar>
                  }
                  rightSection={<IconChevronDown size={13} />}
                  variant="subtle"
                >
                  <Text maw={120} truncate visibleFrom="sm">
                    {profile.nickname || profile.username || '账户'}
                  </Text>
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{isAdmin ? '管理员' : '成员'} · {profile.username}</Menu.Label>
                <Menu.Item component={Link} leftSection={<IconUserShield size={17} />} to="/account">
                  账号与安全
                </Menu.Item>
                <Menu.Item component="a" href={correspondingSourceUrl} leftSection={<IconBrandGithub size={17} />} rel="noreferrer" target="_blank">
                  源码与许可证
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item color="red" leftSection={<IconLogout size={17} />} onClick={onLogout}>
                  退出登录
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>

        <Group h={52} gap={4} px="lg" visibleFrom="md" wrap="nowrap">
          {visibleGroups.map((group) => {
            const Icon = group.icon
            const sectionActive = group.items.some((item) => isActive(location.pathname, item.path))
            if (group.items.length === 1) {
              const item = group.items[0]
              if (!item) return null
              return (
                <Button
                  color={sectionActive ? 'cyan' : 'gray'}
                  component={Link}
                  key={group.label}
                  leftSection={<Icon size={16} />}
                  to={item.path}
                  variant={sectionActive ? 'light' : 'subtle'}
                >
                  {group.label}
                </Button>
              )
            }
            return (
              <Menu key={group.label} position="bottom-start" shadow="xl" trigger="click-hover" width={230}>
                <Menu.Target>
                  <Button
                    color={sectionActive ? 'cyan' : 'gray'}
                    leftSection={<Icon size={16} />}
                    rightSection={<IconChevronDown size={12} />}
                    variant={sectionActive ? 'light' : 'subtle'}
                  >
                    {group.label}
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  {group.items.map((item) => {
                    const ItemIcon = item.icon
                    return (
                      <Menu.Item
                        bg={isActive(location.pathname, item.path) ? 'dark.5' : undefined}
                        component={Link}
                        key={item.path}
                        leftSection={<ItemIcon size={17} />}
                        to={item.path}
                      >
                        {item.label}
                      </Menu.Item>
                    )
                  })}
                </Menu.Dropdown>
              </Menu>
            )
          })}
        </Group>
      </AppShell.Header>

      <AppShell.Navbar className="control-nav-mobile" p="sm">
        <AppShell.Section grow component={ScrollArea}>
          <Stack gap="md">
            {visibleGroups.map((group) => (
              <Box key={group.label}>
                <Text c="dimmed" fw={700} fz="xs" mb={4} px="sm" tt="uppercase">
                  {group.label}
                </Text>
                {group.items.map((item) => {
                  const Icon = item.icon
                  return (
                    <NavLink
                      active={isActive(location.pathname, item.path)}
                      component={Link}
                      key={item.path}
                      label={item.label}
                      leftSection={<Icon size={18} />}
                      to={item.path}
                    />
                  )
                })}
              </Box>
            ))}
          </Stack>
        </AppShell.Section>
        <AppShell.Section>
          <Divider my="sm" />
          <NavLink color="red" label="退出登录" leftSection={<IconLogout size={18} />} onClick={onLogout} />
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main id="control-main">
        <Box className="control-main">
          <div aria-live="polite">{activeAnnouncements.slice(0, 3).map((item, index) => (
            <Alert
              color={item.type === 'maintenance' ? 'orange' : 'cyan'}
              icon={item.type === 'maintenance' ? <IconSettings size={18} /> : <IconShield size={18} />}
              key={item.id ?? index}
              mb="sm"
              title={item.title || '系统公告'}
              withCloseButton
              onClose={() => setDismissed((value) => [...value, item.id ?? ''])}
            >
              {item.body}
            </Alert>
          ))}</div>
          <Outlet />
        </Box>
      </AppShell.Main>
    </AppShell></>
  )
}
