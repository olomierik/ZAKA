import { useEffect, useState } from 'react'

// Coin logos, small and fast (2026-10-05). Launchpads store logos on IPFS, whose public gateway answered in 35–50
// seconds on the Markets page (most logos never showed), and some are multi-megabyte files ("…under2.9mb.png") drawn
// at 28px. Every coin logo goes through wsrv.nl, a free image cache on Cloudflare's network: it fetches the file once,
// resizes it to the size it's drawn at (×2 for sharp screens) and serves it from the cache to every visitor after.
// IPFS links go to a faster gateway first. Local and inline images are left alone.

const IPFS_GATEWAY = 'https://dweb.link/ipfs/'
/** An IPFS path from ipfs://… or any gateway's /ipfs/… link. */
const IPFS_PATH = /^(?:ipfs:\/\/(?:ipfs\/)?|https?:\/\/[^/]+\/ipfs\/)(.+)$/i

export function logoSrc(src: string | null | undefined, px = 32): string | null {
  if (!src) return null
  const s = src.trim()
  if (!s || s.startsWith('data:') || s.startsWith('/') || s.startsWith('blob:')) return s || null
  const ipfs = IPFS_PATH.exec(s)
  const url = ipfs ? IPFS_GATEWAY + ipfs[1] : s
  if (!/^https?:\/\//i.test(url)) return null
  const size = Math.min(256, Math.max(16, Math.round(px * 2)))
  return `https://wsrv.nl/?url=${encodeURIComponent(url)}&w=${size}&h=${size}&fit=cover&output=webp&maxage=14d`
}

/** A logo through the cache, then (if the cache can't serve it) the original link, then none: the caller draws its
 * letters. Starts over when the link changes. */
export function useLogo(src: string | null | undefined, px = 32): { url: string | null; onError: () => void } {
  const [stage, setStage] = useState(0)
  useEffect(() => setStage(0), [src])
  const url = !src ? null : stage === 0 ? logoSrc(src, px) : stage === 1 ? src : null
  return { url, onError: () => setStage(s => s + 1) }
}
