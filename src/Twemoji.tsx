import { memo, useMemo } from 'react'
import twemoji from 'twemoji'

export const Twemoji = memo(function Twemoji({ children }: { children: React.ReactNode }) {
  const html = useMemo(() => {
    const element = document.createElement('span')
    element.textContent = String(children || '')
    twemoji.parse(element, {
      folder: 'svg',
      ext: '.svg',
      base: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/',
    })
    return element.innerHTML
  }, [children])
  return <span dangerouslySetInnerHTML={{ __html: html }} />
})
