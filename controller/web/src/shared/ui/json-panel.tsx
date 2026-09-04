import { Code, CopyButton, Group, ScrollArea, Text, Tooltip, ActionIcon } from '@mantine/core'
import { IconCheck, IconCopy } from '@tabler/icons-react'

export function JsonPanel({ value, empty = '暂无返回数据' }: { value: unknown; empty?: string }) {
  const content = value === undefined || value === null ? '' : JSON.stringify(value, null, 2)
  if (!content) return <Text c="dimmed">{empty}</Text>
  return (
    <ScrollArea h={430} type="auto">
      <Group justify="flex-end" pos="sticky" top={0} style={{ zIndex: 1 }}>
        <CopyButton value={content} timeout={1500}>
          {({ copied, copy }) => (
            <Tooltip label={copied ? '已复制' : '复制 JSON'}>
              <ActionIcon aria-label={copied ? 'JSON 已复制' : '复制 JSON'} color={copied ? 'teal' : 'gray'} onClick={copy} variant="subtle">
                {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
              </ActionIcon>
            </Tooltip>
          )}
        </CopyButton>
      </Group>
      <Code block className="control-json">
        {content}
      </Code>
    </ScrollArea>
  )
}
