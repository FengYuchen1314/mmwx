export type ThemeName = 'pixel' | 'flat' | 'anime'

export interface ProbeAppearance {
  theme: ThemeName
  color_mode?: 'light' | 'dark' | 'system'
  revision?: string
}

export interface ProbeBucket {
  ms: number
  loss: number
}

export interface ProbePingSeries {
  key?: string
  label: string
  isp?: string
  current_ms: number
  loss_pct: number
  buckets: ProbeBucket[]
}

export interface ProbeServer {
  name?: string
  online: boolean
  upload_speed?: number
  download_speed?: number
  traffic_used?: number
  traffic_limit?: number
  cumulative_up?: number
  cumulative_down?: number
  cpu_pct?: number
  loadavg?: string
  mem_used?: number
  mem_total?: number
  disk_used?: number
  disk_total?: number
  ping?: ProbePingSeries[]
}

export interface ProbePayload {
  enabled: boolean
  title?: string
  logo?: string
  appearance?: ProbeAppearance
  servers?: ProbeServer[]
}
