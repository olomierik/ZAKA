import { useState } from 'react'

// A trader's avatar: their profile picture if they set one, otherwise a
// deterministic pattern generated from their address, so every wallet is
// recognisable at a glance (on the chart, in feeds, on leaderboards).

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

export function identiconSvg(address: string, size = 40): string {
  const a = address.toLowerCase()
  const h = hash(a)
  const hue = h % 360
  const fg = `hsl(${hue} 70% 58%)`
  const bg = `hsl(${(hue + 180) % 360} 35% 16%)`
  let cells = ''
  const c = size / 5
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if ((hash(a + x + ',' + y) & 1) === 0) continue
      cells += `<rect x="${x * c}" y="${y * c}" width="${c}" height="${c}"/>`
      if (x < 2) cells += `<rect x="${(4 - x) * c}" y="${y * c}" width="${c}" height="${c}"/>`
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="${bg}"/><g fill="${fg}">${cells}</g></svg>`
}

export function identiconUrl(address: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(identiconSvg(address))}`
}

export default function Avatar({ address, url, size = 28, ring }: { address: string; url?: string | null; size?: number; ring?: string }) {
  const [broken, setBroken] = useState(false)
  const src = url && !broken ? url : identiconUrl(address)
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      onError={() => setBroken(true)}
      style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, border: ring ? `2px solid ${ring}` : undefined, background: 'var(--bg-2)' }}
    />
  )
}
