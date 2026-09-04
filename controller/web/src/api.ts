export type JsonObject = Record<string, unknown>

const TOKEN_KEY = 'mmwx_token'
const COOKIE_KEY = 'traffic_info_access_token'
const API_BASE = String(import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

function resolvePath(path: string) {
  if (/^https?:\/\//i.test(path)) return path
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`
}

export function apiURL(path: string) {
  return resolvePath(path)
}

function cookieToken() {
  const part = document.cookie.split('; ').find((item) => item.startsWith(`${COOKIE_KEY}=`))
  if (!part) return ''
  const raw = decodeURIComponent(part.slice(COOKIE_KEY.length + 1))
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'string' ? parsed : raw
  } catch {
    return raw
  }
}

export function readToken() {
  return localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY) ?? cookieToken()
}

export function saveToken(token: string, remember: boolean) {
  localStorage.removeItem(TOKEN_KEY)
  sessionStorage.removeItem(TOKEN_KEY)
  ;(remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token)
  const maxAge = remember ? '; max-age=2592000' : ''
  document.cookie = `${COOKIE_KEY}=${encodeURIComponent(JSON.stringify(token))}; path=/; SameSite=Lax${maxAge}`
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
  sessionStorage.removeItem(TOKEN_KEY)
  document.cookie = `${COOKIE_KEY}=; path=/; max-age=0; SameSite=Lax`
}

async function decode<T>(response: Response, allowSuccessFalse = false): Promise<T> {
  const text = await response.text()
  let data: unknown = {}
  if (text) {
    try { data = JSON.parse(text) } catch { data = { message: text } }
  }
  if (!response.ok) {
    const object = data as JsonObject
    throw new Error(String(object.error ?? object.message ?? object.msg ?? `请求失败（${response.status}）`))
  }
  // A handful of legacy handlers deliberately return HTTP 200 with
  // { success: false }. Treat that shape consistently with non-2xx errors so
  // every form gets the same failure semantics.
  if (!allowSuccessFalse && data && typeof data === 'object' && (data as JsonObject).success === false) {
    const object = data as JsonObject
    throw new Error(String(object.error ?? object.message ?? object.msg ?? '操作失败'))
  }
  return data as T
}

export async function publicApi<T>(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  return decode<T>(await fetch(resolvePath(path), { ...init, headers }))
}

export async function api<T>(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  const token = readToken()
  if (token) {
    headers.set('MM-Authorization', token)
    headers.set('Authorization', `Bearer ${token}`)
  }
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(resolvePath(path), { ...init, headers })
  if (response.status === 401) window.dispatchEvent(new Event('mmwx:unauthorized'))
  return decode<T>(response)
}

// Some diagnostic endpoints use HTTP 200 + success:false as a measured
// business result (for example, a conclusively unreachable network path).
// Keep that response intact so the UI can show its evidence and certainty.
export async function apiResult<T>(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  const token = readToken()
  if (token) {
    headers.set('MM-Authorization', token)
    headers.set('Authorization', `Bearer ${token}`)
  }
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(resolvePath(path), { ...init, headers })
  if (response.status === 401) window.dispatchEvent(new Event('mmwx:unauthorized'))
  return decode<T>(response, true)
}

export async function downloadApi(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  const token = readToken()
  if (token) {
    headers.set('MM-Authorization', token)
    headers.set('Authorization', `Bearer ${token}`)
  }
  const response = await fetch(resolvePath(path), { ...init, headers })
  if (response.status === 401) window.dispatchEvent(new Event('mmwx:unauthorized'))
  if (!response.ok) {
    let message = `下载失败（${response.status}）`
    try {
      const data = await response.json() as JsonObject
      message = String(data.error ?? data.message ?? data.msg ?? message)
    } catch { /* response is not JSON */ }
    throw new Error(message)
  }
  const blob = await response.blob()
  const disposition = response.headers.get('Content-Disposition') ?? ''
  const match = disposition.match(/filename\*?=(?:UTF-8''|\")?([^\";]+)/i)
  const filename = match ? decodeURIComponent(match[1].replace(/\"/g, '').trim()) : 'download'
  const href = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(href)
}

export function asList<T>(value: unknown, keys: string[] = []): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === 'object') {
    const object = value as JsonObject
    for (const key of keys) if (Array.isArray(object[key])) return object[key] as T[]
  }
  return []
}
