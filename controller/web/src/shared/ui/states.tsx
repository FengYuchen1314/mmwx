import type { ReactNode } from 'react'
import { Alert, Center, Loader, Stack, Text, ThemeIcon, Title } from '@mantine/core'
import { IconInbox, IconInfoCircle } from '@tabler/icons-react'

export function LoadingState({ label = '正在载入数据…' }: { label?: string }) {
  return (
    <Center mih={180}>
      <Stack align="center" aria-live="polite" gap="sm" role="status">
        <Loader size="sm" />
        <Text c="dimmed" fz="sm">
          {label}
        </Text>
      </Stack>
    </Center>
  )
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <Center mih={220}>
      <Stack align="center" gap="sm" ta="center" maw={440}>
        <ThemeIcon size={48} variant="light" color="gray">
          <IconInbox size={24} />
        </ThemeIcon>
        <Title order={4}>{title}</Title>
        <Text c="dimmed" fz="sm">
          {description}
        </Text>
        {action}
      </Stack>
    </Center>
  )
}

export function ErrorAlert({ children }: { children: ReactNode }) {
  return (
    <Alert color="red" icon={<IconInfoCircle size={18} />} role="alert" title="请求未完成">
      {children}
    </Alert>
  )
}
