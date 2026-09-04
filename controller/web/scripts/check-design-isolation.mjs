import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1')
const scanRoots = ['src', '../internal/web/dist']
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.ts', '.tsx'])
const forbidden = [
  'mmx-',
  'uss-',
  'data-probe-theme',
  'pixel-card',
  'auth-shell',
  'MMWX · OPEN CONTROL PANEL',
  'mmwx:appearance-updated',
  'mmwx_theme',
  'mmwx_auth_language',
  '#f29a72',
  'M9 18 7 7l11 6',
  'probe-app',
  'probeTheme',
]
const oldArtifacts = new Set(['index-BKLyFMPo.css', 'index-gUVMLJR4.js'])
const failures = []

async function walk(directory) {
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) { await walk(path); continue }
    const label = relative(root, path).replaceAll('\\', '/')
    if (oldArtifacts.has(entry.name)) failures.push(`${label}: legacy artifact filename`)
    if (!textExtensions.has(extname(entry.name))) continue
    const content = await readFile(path, 'utf8')
    for (const marker of forbidden) if (content.includes(marker)) failures.push(`${label}: ${marker}`)
  }
}

for (const directory of scanRoots) await walk(join(root, directory))

if (failures.length) {
  console.error(`Legacy design isolation check failed:\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('Legacy design isolation check passed.')
