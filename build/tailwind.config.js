module.exports = {
  content: ['/home/user/Personal/acmusicevents/site/index.html'],
  theme: {
    extend: {
      colors: {
        night: '#070A16', panel: '#0E1226', line: '#232A4D',
        neon: '#5B6CFF', neonsoft: '#93A2FF', glow: '#FFB347',
        dim: '#8C93B8', paper: '#EDF0FA',
      },
      fontFamily: {
        display: ['Anton', 'Impact', 'sans-serif'],
        body: ['Archivo', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: { neon: '0 0 24px rgba(91,108,255,.45), 0 0 64px rgba(91,108,255,.18)' },
    },
  },
}
