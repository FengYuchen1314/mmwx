export function formatSpeed(value: unknown): string {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return '0 B/s'
  if (amount >= 1024 ** 3) return `${(amount / 1024 ** 3).toFixed(1)} GB/s`
  if (amount >= 1024 ** 2) return `${(amount / 1024 ** 2).toFixed(1)} MB/s`
  if (amount >= 1024) return `${(amount / 1024).toFixed(1)} KB/s`
  return `${amount.toFixed(0)} B/s`
}

export function formatBytes(value: unknown): string {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const index = Math.min(Math.floor(Math.log(amount) / Math.log(1024)), units.length - 1)
  return `${(amount / 1024 ** index).toFixed(index > 1 ? 2 : 0)} ${units[index]}`
}

export function asText(value: unknown, fallback = '—'): string {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function dateText(value: unknown): string {
  if (!value) return '—'
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN')
}

export function localDateInputValue(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
