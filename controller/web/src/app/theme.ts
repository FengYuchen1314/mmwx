import { createTheme } from '@mantine/core'

// Derived from Remnawave frontend's Mantine theme at c2c9ba3.
export const theme = createTheme({
  cursorType: 'pointer',
  fontFamily:
    'Montserrat, Vazirmatn, "Noto Sans SC", "Microsoft YaHei UI", system-ui, sans-serif',
  fontFamilyMonospace: '"Fira Mono", "JetBrains Mono", Consolas, monospace',
  breakpoints: {
    xs: '30em',
    sm: '40em',
    md: '48em',
    lg: '64em',
    xl: '80em',
    '2xl': '96em',
    '3xl': '120em',
    '4xl': '160em',
  },
  focusRing: 'auto',
  white: '#ffffff',
  black: '#24292f',
  colors: {
    dark: [
      '#c9d1d9',
      '#b1bac4',
      '#8b949e',
      '#6e7681',
      '#484f58',
      '#30363d',
      '#21262d',
      '#161b22',
      '#0d1117',
      '#010409',
    ],
  },
  primaryShade: 8,
  primaryColor: 'cyan',
  autoContrast: true,
  luminanceThreshold: 0.3,
  headings: { fontWeight: '600' },
  defaultRadius: 'md',
})
