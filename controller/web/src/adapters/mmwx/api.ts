import type { JsonRecord } from './types'

const SESSION_KEY = 'mmwx_token'
const SESSION_COOKIE = 'traffic_info_access_token'
const API_BASE = String(import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly payload: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`
}

function trustedApiUrl(path: string): string {
  const target = new URL(apiUrl(path), window.location.origin)
  const configured = new URL(API_BASE || window.location.origin, window.location.origin)
  if (target.origin !== configured.origin) {
    throw new ApiError('已阻止向外部站点发送登录凭据', 0, { target: target.origin })
  }
  return target.toString()
}

function readCookie(): string {
  const item = document.cookie
    .split('; ')
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
  if (!item) return ''
  const raw = decodeURIComponent(item.slice(SESSION_COOKIE.length + 1))
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'string' ? parsed : raw
  } catch {
    return raw
  }
}

export function readSession(): string {
  return localStorage.getItem(SESSION_KEY) ?? sessionStorage.getItem(SESSION_KEY) ?? readCookie()
}

export function saveSession(token: string, remember: boolean): void {
  localStorage.removeItem(SESSION_KEY)
  sessionStorage.removeItem(SESSION_KEY)
  ;(remember ? localStorage : sessionStorage).setItem(SESSION_KEY, token)
  const maxAge = remember ? '; max-age=2592000' : ''
  document.cookie = `${SESSION_COOKIE}=${encodeURIComponent(JSON.stringify(token))}; path=/; SameSite=Lax${maxAge}`
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY)
  sessionStorage.removeItem(SESSION_KEY)
  document.cookie = `${SESSION_COOKIE}=; path=/; max-age=0; SameSite=Lax`
}

async function parseResponse<T>(response: Response, allowBusinessFailure: boolean): Promise<T> {
  const text = await response.text()
  let payload: unknown = {}
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { message: text }
    }
  }

  const object = payload && typeof payload === 'object' ? (payload as JsonRecord) : {}
  const failed = object.success === false && !allowBusinessFailure
  if (!response.ok || failed) {
    const message = String(
      object.error ?? object.message ?? object.msg ?? `请求失败（${response.status}）`,
    )
    throw new ApiError(message, response.status, payload)
  }
  return payload as T
}

async function execute<T>(
  path: string,
  init: RequestInit,
  authenticated: boolean,
  allowBusinessFailure: boolean,
): Promise<T> {
  const headers = new Headers(init.headers)
  if (authenticated) {
    const token = readSession()
    if (token) {
      headers.set('MM-Authorization', token)
      headers.set('Authorization', `Bearer ${token}`)
    }
  }
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const target = authenticated ? trustedApiUrl(path) : apiUrl(path)
  const response = await fetch(target, { ...init, headers })
  if (authenticated && response.status === 401) {
    window.dispatchEvent(new CustomEvent('control:session-expired'))
  }
  return parseResponse<T>(response, allowBusinessFailure)
}

export function publicRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  return execute<T>(path, init, false, false)
}

export function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  return execute<T>(path, init, true, false)
}

export function resultRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  return execute<T>(path, init, true, true)
}

export async function streamRequest(
  path: string,
  init: RequestInit = {},
  onEvent?: (event: unknown) => void,
): Promise<unknown[]> {
  const headers = new Headers(init.headers)
  const token = readSession()
  if (token) {
    headers.set('MM-Authorization', token)
    headers.set('Authorization', `Bearer ${token}`)
  }
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(trustedApiUrl(path), { ...init, headers })
  if (response.status === 401) window.dispatchEvent(new CustomEvent('control:session-expired'))
  if (!response.ok) await parseResponse(response, false)
  if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) {
    const value = await parseResponse<unknown>(response, false)
    onEvent?.(value)
    return [value]
  }

  const events: unknown[] = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const emit = (block: string) => {
    const lines = block.split(/\r?\n/)
    const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim()
    const dataLines = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart())
    const raw = dataLines.length ? dataLines.join('\n') : block.trim()
    if (!raw) return
    let payload: unknown = raw
    try { payload = JSON.parse(raw) } catch { /* command output can be plain text */ }
    const event = eventName ? { event: eventName, data: payload } : payload
    events.push(event)
    onEvent?.(event)

    const object = payload && typeof payload === 'object' ? payload as JsonRecord : {}
    const state = String(object.type ?? object.step ?? object.status ?? eventName ?? '').toLowerCase()
    if (object.success === false || state === 'error' || state === 'failed') {
      throw new ApiError(String(object.message ?? object.error ?? '流式操作失败'), response.status, payload)
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      buffer = buffer.replace(/\r\n/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        emit(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
      }
      if (done) break
    }
    emit(buffer)
  } catch (reason) {
    await reader.cancel().catch(() => undefined)
    throw reason
  }
  return events
}

export async function download(path: string, init: RequestInit = {}): Promise<void> {
  const headers = new Headers(init.headers)
  const token = readSession()
  if (token) headers.set('MM-Authorization', token)
  const response = await fetch(trustedApiUrl(path), { ...init, headers })
  if (!response.ok) await parseResponse(response, false)
  const blob = await response.blob()
  const disposition = response.headers.get('Content-Disposition') ?? ''
  const match = disposition.match(/filename\*?=(?:UTF-8''|\")?([^\";]+)/i)
  const filename = match?.[1]
    ? decodeURIComponent(match[1].replace(/\"/g, '').trim())
    : 'mmwx-download'
  const href = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(href)
}

export function listFrom<T>(value: unknown, keys: readonly string[] = []): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === 'object') {
    const object = value as JsonRecord
    for (const key of keys) {
      if (Array.isArray(object[key])) return object[key] as T[]
    }
  }
  return []
}

export function messageOf(reason: unknown, fallback = '操作失败'): string {
  return reason instanceof Error ? reason.message : fallback
}
