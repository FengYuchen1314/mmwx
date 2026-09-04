import { useEffect, useMemo, useState } from 'react'
import { Button, Card, Checkbox, CopyButton, Group, NumberInput, ScrollArea, Select, SimpleGrid, Stack, Text, Title } from '@mantine/core'
import { IconCheck, IconCopy, IconLink, IconSparkles } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'

import { listFrom, messageOf, request } from '@/adapters/mmwx/api'
import type { JsonRecord, Node } from '@/adapters/mmwx/types'
import { PageHeader } from '@/shared/ui/page-header'
import { EmptyState, ErrorAlert, LoadingState } from '@/shared/ui/states'

export function GeneratorPage() {
  const [selected, setSelected] = useState<Array<string | number>>([])
  const [expires, setExpires] = useState(600)
  const [maxAccess, setMaxAccess] = useState(10)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<JsonRecord | null>(null)
  const query = useQuery({ queryKey: ['nodes', 'generator'], queryFn: async () => listFrom<Node>(await request('/api/admin/nodes'), ['nodes']).filter((node) => Boolean(node.clash_config)) })
  useEffect(() => { if (query.data && !selected.length) setSelected(query.data.map((node) => node.id ?? '')) }, [query.data, selected.length])
  const nodes = query.data ?? []
  const generate = async () => {
    setBusy(true); setError('')
    try {
      const proxies = nodes.filter((node) => selected.includes(node.id ?? '')).map((node) => typeof node.clash_config === 'string' ? JSON.parse(node.clash_config) : node.clash_config).filter(Boolean)
      if (!proxies.length) throw new Error('请至少选择一个带 Clash 配置的节点。')
      setResult(await request<JsonRecord>('/api/admin/temp-subscription', { method: 'POST', body: JSON.stringify({ proxies, max_access: maxAccess, expire_seconds: expires }) }))
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) }
  }
  const url = useMemo(() => result?.url ? new URL(String(result.url), window.location.origin).toString() : '', [result])
  return (
    <>
      <PageHeader description="按节点生成受有效期与访问次数保护的临时订阅" icon={IconSparkles} title="订阅生成" />
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <Card padding="lg" shadow="lg" withBorder><Stack><Title order={4}>生成配置</Title><SimpleGrid cols={2}><Select data={[{ value: '60', label: '1 分钟' }, { value: '600', label: '10 分钟' }, { value: '1800', label: '30 分钟' }, { value: '3600', label: '1 小时' }]} label="有效期" onChange={(value) => setExpires(Number(value ?? 600))} value={String(expires)} /><NumberInput label="最大访问次数" max={100} min={1} onChange={(value) => setMaxAccess(Number(value || 1))} value={maxAccess} /></SimpleGrid><Text fw={600} fz="sm">选择节点</Text>{query.isLoading ? <LoadingState /> : <ScrollArea h={330}><Stack gap="xs">{nodes.map((node, index) => { const id = node.id ?? index; return <Checkbox checked={selected.includes(id)} key={String(id)} label={`${String(node.node_name ?? node.name ?? id)} · ${String(node.protocol ?? '')}`} onChange={(event) => setSelected((current) => event.currentTarget.checked ? [...current, id] : current.filter((item) => item !== id))} /> })}</Stack></ScrollArea>}{error ? <ErrorAlert>{error}</ErrorAlert> : null}<Button leftSection={<IconSparkles size={17} />} loading={busy} onClick={() => void generate()}>生成临时订阅</Button></Stack></Card>
        <Card padding="lg" shadow="lg" withBorder><Stack><Title order={4}>生成结果</Title>{result && url ? <><Text ff="monospace" fz="sm" style={{ overflowWrap: 'anywhere' }}>{url}</Text><Text c="dimmed" fz="sm">到期：{String(result.expire_at ?? '—')} · 可访问 {String(result.max_access ?? maxAccess)} 次</Text><Group><CopyButton value={url}>{({ copied, copy }) => <Button leftSection={copied ? <IconCheck size={17} /> : <IconCopy size={17} />} onClick={copy} variant="light">{copied ? '已复制' : '复制链接'}</Button>}</CopyButton><Button component="a" href={url} leftSection={<IconLink size={17} />} rel="noreferrer" target="_blank">打开订阅</Button></Group></> : <EmptyState description="完成左侧配置后生成。" title="等待生成" />}</Stack></Card>
      </SimpleGrid>
    </>
  )
}
