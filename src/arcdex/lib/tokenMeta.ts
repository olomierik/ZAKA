// Symbol / image / live price for any Argus coin by address, from the
// same live market list the Terminal uses (one shared fetch per minute).

import { useEffect, useState } from 'react'
import { getArgusMarket, type ArgusPool } from '../api/argusMarket'

export interface TokenMeta { address: string; symbol: string; name: string; image: string | null; priceUsd: number; pool: string }

let cache: { at: number; map: Promise<Map<string, TokenMeta>> } | null = null

export function loadTokenMeta(): Promise<Map<string, TokenMeta>> {
  if (!cache || Date.now() - cache.at > 60_000) {
    const toMap = (pools: ArgusPool[]) => new Map(pools.map(p => [p.token.address, {
      address: p.token.address, symbol: p.token.symbol, name: p.token.name, image: p.token.image, priceUsd: p.priceUsd, pool: p.pool,
    }]))
    cache = { at: Date.now(), map: getArgusMarket().then(toMap).catch(() => new Map()) }
  }
  return cache.map
}

export function useTokenMeta(): Map<string, TokenMeta> {
  const [m, setM] = useState<Map<string, TokenMeta>>(new Map())
  useEffect(() => { void loadTokenMeta().then(setM) }, [])
  return m
}
