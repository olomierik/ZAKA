// Line icons for the terminal (12–16px, currentColor).

const P = { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const

export const IcBolt = ({ s = 12 }: { s?: number }) => <svg {...P} width={s} height={s} fill="currentColor" stroke="none"><path d="M13.5 2L4.5 13.5h6L9.5 22l10-12.5h-6.5z" /></svg>
export const IcCopy = () => <svg {...P}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>
export const IcStar = ({ on }: { on?: boolean }) => <svg {...P} fill={on ? 'currentColor' : 'none'}><path d="M12 3l2.7 5.6 6.1.8-4.4 4.3 1 6.1L12 17l-5.4 2.8 1-6.1-4.4-4.3 6.1-.8z" /></svg>
export const IcUser = () => <svg {...P}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
export const IcUsers = () => <svg {...P}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 20h3.5a6 6 0 0 0-3.5-5.5" /></svg>
export const IcSearch = () => <svg {...P}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
export const IcShield = () => <svg {...P}><path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z" /></svg>
export const IcRocket = () => <svg {...P}><path d="M5 15c-1.5 1.5-2 4-2 6 2 0 4.5-.5 6-2M9 13l2 2M14.5 4.5C17 3 20 3 21 3c0 1-.1 4-1.5 6.5L13 16l-5-5z" /></svg>
export const IcPulse = () => <svg {...P}><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>
export const IcFilter = () => <svg {...P} width={14} height={14}><path d="M4 5h16l-6.5 7.5V19l-3 1.5v-8z" /></svg>
export const IcBell = ({ on }: { on?: boolean }) => <svg {...P} width={14} height={14} fill={on ? 'currentColor' : 'none'}><path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9zM10 20a2.2 2.2 0 0 0 4 0" /></svg>
export const IcSliders = () => <svg {...P} width={14} height={14}><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></svg>
export const IcSparkle = () => <svg {...P} width={14} height={14}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6" /></svg>
export const IcDrop = () => <svg {...P} width={14} height={14}><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" /></svg>
export const IcFlag = () => <svg {...P} width={14} height={14}><path d="M5 21V4M5 4h11l-2 4 2 4H5" /></svg>
export const IcX = () => <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M17.8 3h3.1l-6.8 7.7L22 21h-6.2l-4.9-6.3L5.3 21H2.2l7.2-8.3L2 3h6.4l4.4 5.8zm-1.1 16.2h1.7L7.4 4.7H5.6z" /></svg>
export const IcPause = () => <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
export const IcGrid = () => <svg {...P} width={14} height={14}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
export const IcEyeOff = () => <svg {...P}><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3.2 4M6.6 6.6C3.9 8.4 2.5 12 2.5 12S6 19 12 19c1.6 0 3-.4 4.3-1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>
export const IcTarget = () => <svg {...P} width={14} height={14}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>
export const IcMin = () => <svg {...P} width={13} height={13}><path d="M15 5l-7 7 7 7" /></svg>
export const IcMax = () => <svg {...P} width={13} height={13}><path d="M9 5l7 7-7 7" /></svg>
export const IcFire = () => <svg {...P} width={13} height={13}><path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5 0 2 1 3 2 3 0-3-1-5.5 1-8.5z" /></svg>
