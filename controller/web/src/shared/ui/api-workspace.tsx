import { useEffect, useState, type FormEvent } from 'react'
import {
  Badge,
  Button,
  Card,
  Group,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core'
import { IconPlayerPlay, IconRefresh } from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'

import { messageOf, request, resultRequest, streamRequest } from '@/adapters/mmwx/api'
import type { JsonRecord } from '@/adapters/mmwx/types'
import { JsonPanel } from './json-panel'
import { ErrorAlert, LoadingState } from './states'

export interface EndpointDefinition {
  group: string
  title: string
  description: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
  dangerous?: boolean
  stream?: boolean
}

export function DataBrowser({
  title,
  description,
  path,
}: {
  title: string
  description: string
  path: string
}) {
  const [value, setValue] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = async () => {
    setBusy(true); setError('')
    try { setValue(await request(path)) } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) }
  }
  useEffect(() => { void load() }, [path])
  return (
    <Card padding="lg" shadow="lg" withBorder>
      <Group justify="space-between" mb="md"><Stack gap={0}><Title order={4}>{title}</Title><Text c="dimmed" fz="sm">{description}</Text></Stack><Button leftSection={<IconRefresh size={17} />} loading={busy} onClick={() => void load()} variant="subtle">刷新</Button></Group>
      {error ? <ErrorAlert>{error}</ErrorAlert> : busy && value === undefined ? <LoadingState /> : <JsonPanel value={value} />}
    </Card>
  )
}

export function JsonSettings({
  title,
  description,
  getPath,
  savePath = getPath,
  method = 'PUT',
  readKey,
}: {
  title: string
  description: string
  getPath: string
  savePath?: string
  method?: 'POST' | 'PUT' | 'PATCH'
  readKey?: string
}) {
  const [content, setContent] = useState('{}')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const load = async () => {
    setBusy('load'); setError('')
    try {
      const value = await request(getPath)
      const selected = readKey && value && typeof value === 'object'
        ? (value as JsonRecord)[readKey]
        : value
      setContent(JSON.stringify(selected ?? {}, null, 2))
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }
  useEffect(() => { void load() }, [getPath])
  const save = async () => {
    setBusy('save'); setError('')
    try {
      const payload = JSON.parse(content) as JsonRecord
      await request(savePath, { method, body: JSON.stringify(payload) })
      notifications.show({ color: 'teal', message: '配置已保存', title })
      await load()
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }
  return (
    <Card padding="lg" shadow="lg" withBorder>
      <Group justify="space-between" mb="md"><Stack gap={0}><Title order={4}>{title}</Title><Text c="dimmed" fz="sm">{description}</Text></Stack><Group><Button loading={busy === 'load'} onClick={() => void load()} variant="subtle">重载</Button><Button loading={busy === 'save'} onClick={() => void save()}>保存</Button></Group></Group>
      <Textarea autosize label="配置数据（JSON）" minRows={12} onChange={(event) => setContent(event.currentTarget.value)} value={content} />
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}
    </Card>
  )
}

export function RequestRunner({ definition }: { definition: EndpointDefinition }) {
  const [method, setMethod] = useState(definition.method)
  const [path, setPath] = useState(definition.path)
  const [body, setBody] = useState(JSON.stringify(definition.body ?? {}, null, 2))
  const [result, setResult] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (event?: FormEvent) => {
    event?.preventDefault()
    if (definition.dangerous && !window.confirm(`“${definition.title}”可能改变服务状态，确定执行吗？`)) return
    setBusy(true); setError('')
    try {
      const init: RequestInit = { method }
      if (method !== 'GET' && body.trim()) init.body = JSON.stringify(JSON.parse(body))
      if (definition.stream) {
        const events: unknown[] = []
        setResult(events)
        await streamRequest(path, init, (value) => {
          events.push(value)
          setResult([...events])
        })
      } else {
        setResult(await resultRequest(path, init))
      }
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) }
  }
  return (
    <Card bg="dark.6" padding="md" withBorder>
      <form onSubmit={run}>
        <Stack>
          <Group justify="space-between" align="flex-start"><Stack gap={2}><Group><Title order={5}>{definition.title}</Title>{definition.dangerous ? <Badge color="orange" variant="light">会修改状态</Badge> : null}</Group><Text c="dimmed" fz="sm">{definition.description}</Text></Stack><Badge variant="outline">{definition.group}</Badge></Group>
          <Group align="end" wrap="nowrap"><Select data={['GET', 'POST', 'PUT', 'PATCH', 'DELETE']} label="方法" onChange={(value) => setMethod((value ?? 'GET') as typeof method)} value={method} w={112} /><TextInput label="路径" onChange={(event) => setPath(event.currentTarget.value)} value={path} style={{ flex: 1 }} /></Group>
          {method !== 'GET' ? <Textarea autosize label="请求数据（JSON）" minRows={4} onChange={(event) => setBody(event.currentTarget.value)} value={body} /> : null}
          {error ? <ErrorAlert>{error}</ErrorAlert> : null}
          {result !== undefined ? <JsonPanel value={result} /> : null}
          <Button leftSection={<IconPlayerPlay size={17} />} loading={busy} type="submit">执行</Button>
        </Stack>
      </form>
    </Card>
  )
}
