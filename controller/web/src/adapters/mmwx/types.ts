export type JsonRecord = Record<string, unknown>

export interface Profile extends JsonRecord {
  username?: string
  email?: string
  nickname?: string
  avatar_url?: string
  role?: string
  is_admin?: boolean
  telegram_id?: number
  telegram_username?: string
}

export interface LoginResult extends Profile {
  token?: string
  expires_at?: string
  requires_2fa?: boolean
  two_factor_token?: string
}

export interface Permissions extends JsonRecord {
  is_admin?: boolean
  pages?: string[]
  routed_outbound_enabled?: boolean
  enable_override_scripts?: boolean
  quota?: Record<string, { used?: number; max?: number }>
}

export interface Branding extends JsonRecord {
  site_title?: string
  brand_title?: string
  logo_url?: string
}

export interface Announcement extends JsonRecord {
  id?: number | string
  title?: string
  body?: string
  type?: string
}

export interface TrafficSummary extends JsonRecord {
  metrics?: {
    total_used_gb?: number
    total_remaining_gb?: number
    usage_percentage?: number
  }
  history?: Array<{ date?: string; used_gb?: number }>
}

export interface Server extends JsonRecord {
  id?: number | string
  name?: string
  ip_address?: string
  pull_address?: string
  status?: string
  ws_connected?: boolean
  xray_running?: boolean
  current_upload_speed?: number
  current_download_speed?: number
}

export interface Node extends JsonRecord {
  id?: number | string
  name?: string
  tag?: string
  address?: string
  server?: string
  port?: number | string
  protocol?: string
  enabled?: boolean
}

export interface User extends JsonRecord {
  id?: number | string
  username?: string
  nickname?: string
  email?: string
  role?: string
  is_active?: boolean
  package_name?: string
}

export interface ProbeServer extends JsonRecord {
  id?: number | string
  name?: string
  region?: string
  online?: boolean
  status?: string
  latency_ms?: number
  uptime_percentage?: number
  current_upload_speed?: number
  current_download_speed?: number
}

export interface ProbePayload extends JsonRecord {
  enabled?: boolean
  block_login?: boolean
  title?: string
  description?: string
  servers?: ProbeServer[]
  updated_at?: string
}
