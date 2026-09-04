import { useEffect, useRef, type ReactNode } from 'react'
import { Card, Group, Stack, Text, ThemeIcon, Title } from '@mantine/core'
import type { TablerIcon } from '@tabler/icons-react'

interface PageHeaderProps {
  title: string
  description: string
  icon: TablerIcon
  actions?: ReactNode
}

export function PageHeader({ title, description, icon: Icon, actions }: PageHeaderProps) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    document.title = `${title} · MMWX`
    heading.current?.focus({ preventScroll: true })
  }, [title])
  return (
    <Card className="control-surface" mb="md" padding="md" shadow="xl" withBorder>
      <Group justify="space-between" align="center" wrap="wrap">
        <Group gap="md" wrap="nowrap">
          <ThemeIcon size="xl" variant="light">
            <Icon size={22} stroke={1.7} />
          </ThemeIcon>
          <Stack gap={1}>
            <Title className="control-page-title" order={3} ref={heading} tabIndex={-1}>{title}</Title>
            <Text c="dimmed" fz="sm">
              {description}
            </Text>
          </Stack>
        </Group>
        {actions ? <Group gap="sm">{actions}</Group> : null}
      </Group>
    </Card>
  )
}
