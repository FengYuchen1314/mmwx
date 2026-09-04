const repository = 'https://github.com/FengYuchen1314/mmwx'
const revision = String(import.meta.env.VITE_SOURCE_REVISION ?? '').trim()

export const correspondingSourceUrl = /^[0-9a-f]{40}$/i.test(revision)
  ? `${repository}/tree/${revision}`
  : repository

export const remnawaveSourceUrl = 'https://github.com/remnawave/frontend/tree/c2c9ba3b476e4914a3b17e8ce677ab9255e1c02f'
