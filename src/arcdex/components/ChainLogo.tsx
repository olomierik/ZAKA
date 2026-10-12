// Small chain and coin marks for the terminal (drawn here, no third-party files): Arc, Robinhood Chain, Solana,
// BNB Chain, ETH and USDC.

import { useId } from 'react'
import type { TChain } from '../lib/chains'

type Mark = TChain | 'eth' | 'usdc' | 'strk'

export default function ChainLogo({ chain, size = 16 }: { chain: Mark; size?: number }) {
  // A gradient's id must be unique on the page (one logo may be hidden).
  const gid = `g${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const p = { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, className: 'chain-logo' } as const
  switch (chain) {
    case 'arc':
      return (
        <svg {...p}><circle cx="12" cy="12" r="12" fill="#0d1410" /><path d="M6.5 16.5a5.5 5.5 0 0 1 11 0" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" /><circle cx="12" cy="16.5" r="1.6" fill="#00ec97" /></svg>
      )
    case 'hood':
      return (
        <svg {...p}><circle cx="12" cy="12" r="12" fill="#ccff00" /><path d="M7 17.5c1.2-4.8 4.6-9 10-11.2-1.6 3.2-3.4 5.9-5.6 7.9l2.1-.2c-1.8 1.7-4 2.8-6.5 3.5z" fill="#0d1410" /></svg>
      )
    case 'sol':
      return (
        <svg {...p}>
          <defs><linearGradient id={gid} x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor="#9945ff" /><stop offset="1" stopColor="#14f195" /></linearGradient></defs>
          <circle cx="12" cy="12" r="12" fill="#0d1410" />
          <path d="M7.6 15.6h8.6l-1.8 1.8H5.8zM7.6 6.6h8.6l-1.8 1.8H5.8zM14.4 11.1H5.8l1.8 1.8h8.6z" fill={`url(#${gid})`} />
        </svg>
      )
    case 'bnb':
      return (
        <svg {...p}><circle cx="12" cy="12" r="12" fill="#f0b90b" /><path d="M12 6.2l1.9 1.9L12 10 10.1 8.1zM12 14l1.9 1.9L12 17.8l-1.9-1.9zM8.1 10.1L10 12l-1.9 1.9L6.2 12zM15.9 10.1L17.8 12l-1.9 1.9L14 12zM12 10.6l1.4 1.4-1.4 1.4-1.4-1.4z" fill="#0d1410" /></svg>
      )
    case 'eth':
      return (
        <svg {...p}><circle cx="12" cy="12" r="12" fill="#627eea" /><path d="M12 4.5l4.6 7.6L12 14.8l-4.6-2.7zM12 15.8l4.6-2.7L12 19.5l-4.6-6.4z" fill="#fff" /></svg>
      )
    case 'usdc':
      return (
        <svg {...p}><circle cx="12" cy="12" r="12" fill="#2775ca" /><path d="M13.9 13.6c0-1.1-.7-1.5-2-1.7-1-.1-1.2-.4-1.2-.8s.3-.7 1-.7c.6 0 .9.2 1.1.7l1.1-.3c-.2-.8-.8-1.3-1.6-1.4v-.9h-1v.9c-1 .1-1.6.8-1.6 1.6 0 1 .6 1.4 2 1.6.9.1 1.2.3 1.2.8s-.5.8-1.1.8c-.8 0-1.1-.3-1.2-.8l-1.1.3c.2.9.9 1.4 1.8 1.5v.9h1v-.9c1-.1 1.6-.8 1.6-1.6z" fill="#fff" /><path d="M9.6 6.6a6 6 0 0 0 0 10.8M14.4 6.6a6 6 0 0 1 0 10.8" fill="none" stroke="#fff" strokeWidth="1" /></svg>
      )
    case 'strk':
      return (
        <svg {...p}><circle cx="12" cy="12" r="12" fill="#0c0c4f" /><path d="M12 6l1.5 4.5L18 12l-4.5 1.5L12 18l-1.5-4.5L6 12l4.5-1.5z" fill="#ec796b" /></svg>
      )
  }
}
