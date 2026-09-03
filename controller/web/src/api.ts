export type JsonObject = Record<string, unknown>

const TOKEN_KEY = 'mmwx_token'
const COOKIE_KEY = 'traffic_info_access_token'

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

async function decode<T>(response: Response): Promise<T> {
  const text = await response.text()
  let data: unknown = {}
  if (text) {
    try { data = JSON.parse(text) } catch { data = { message: text } }
  }
  if (!response.ok) {
    const object = data as JsonObject
    throw new Error(String(object.error ?? object.message ?? `请求失败（${response.status}）`))
  }
  return data as T
}

export async function publicApi<T>(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('Content-Type', 'application/json')
  return decode<T>(await fetch(path, { ...init, headers }))
}

export async function api<T>(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  const token = readToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, { ...init, headers })
  if (response.status === 401) window.dispatchEvent(new Event('mmwx:unauthorized'))
  return decode<T>(response)
}

export function asList<T>(value: unknown, keys: string[] = []): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === 'object') {
    const object = value as JsonObject
    for (const key of keys) if (Array.isArray(object[key])) return object[key] as T[]
  }
  return []
}
