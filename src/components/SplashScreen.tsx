import React, { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useTheme } from '../lib/theme'

const SPECTRAL_H = 'linear-gradient(90deg, #5fbeff, #af8ff4, #f05c6b, #ffcd83, #7ef1b3)'

// ── Each ZAKA letter drops from a unique angle and position ──
const ZAKA_LETTERS = [
  {
    char: 'Z',
    // drops from top-left, rotated
    initial: { x: -160, y: -220, rotate: -55, opacity: 0, scale: 0.4 },
    color: '#5fbeff',
  },
  {
    char: 'A',
    // drops from top-right, rotated the other way
    initial: { x: 140, y: -200, rotate: 40, opacity: 0, scale: 0.4 },
    color: '#af8ff4',
  },
  {
    char: 'K',
    // drops from bottom-left, slight rotation
    initial: { x: -120, y: 200, rotate: 30, opacity: 0, scale: 0.4 },
    color: '#f05c6b',
  },
  {
    char: 'A',
    // drops from far right, strong twist
    initial: { x: 180, y: -140, rotate: -60, opacity: 0, scale: 0.4 },
    color: '#7ef1b3',
  },
]

// Sub-headline lines that appear after ZAKA lands
const SUB_LINES = [
  { text: 'Crossborder payments made easy', size: 'text-base', weight: 'font-semibold', delay: 1.85 },
  { text: 'ONE WALLET · ONE PAYMENT INFRASTRUCTURE', size: 'text-[11px]', weight: 'font-bold', delay: 2.1, tracking: 'tracking-[0.12em]' },
  { text: 'SEND & RECEIVE IN SECONDS', size: 'text-[11px]', weight: 'font-bold', delay: 2.35, tracking: 'tracking-[0.12em]' },
  { text: 'Everything recorded onchain.', size: 'text-[10px]', weight: 'font-medium', delay: 2.6 },
]

// Floating particles
const DOTS = [
  { cx: -110, cy: 45,  size: 5, color: '#5fbeff', delay: 0.3, dur: 2.0, rd: 1.6 },
  { cx:  90,  cy: 30,  size: 4, color: '#af8ff4', delay: 0.8, dur: 1.8, rd: 1.2 },
  { cx: -60,  cy: -50, size: 6, color: '#ffcd83', delay: 0.2, dur: 2.1, rd: 1.9 },
  { cx:  110, cy: -35, size: 7, color: '#7ef1b3', delay: 1.1, dur: 2.3, rd: 0.8 },
  { cx: -130, cy: -15, size: 4, color: '#f05c6b', delay: 0.6, dur: 1.7, rd: 1.4 },
  { cx:  40,  cy: 70,  size: 5, color: '#5fbeff', delay: 1.4, dur: 2.0, rd: 1.0 },
  { cx: -25,  cy: 75,  size: 3, color: '#ffcd83', delay: 0.4, dur: 1.6, rd: 2.1 },
  { cx:  130, cy: 55,  size: 4, color: '#af8ff4', delay: 1.0, dur: 1.9, rd: 1.3 },
]

function PulseRing({ targetSize, delay, color }: { targetSize: number; delay: number; color: string }) {
  return (
    <motion.div
      className="absolute rounded-full pointer-events-none"
      style={{
        width: targetSize, height: targetSize,
        top: '50%', left: '50%',
        marginTop: -(targetSize / 2), marginLeft: -(targetSize / 2),
        border: `1.5px solid ${color}`,
      }}
      initial={{ opacity: 0.7, scale: 0.5 }}
      animate={{ opacity: 0, scale: 1 }}
      transition={{ duration: 2.4, delay, repeat: Infinity, repeatDelay: 0.8, ease: 'easeOut' }}
    />
  )
}

export default function SplashScreen() {
  const [lettersLanded, setLettersLanded] = useState(false)
  const { isDark: dark } = useTheme()

  // After the last letter lands (~1.5s), start showing sub-lines
  useEffect(() => {
    const t = setTimeout(() => setLettersLanded(true), 1500)
    return () => clearTimeout(t)
  }, [])

  const bgLight = 'linear-gradient(160deg, #e8f0ff 0%, #fdf9f5 45%, #f0eaff 100%)'
  const bgDark  = 'linear-gradient(160deg, #080f1a 0%, #0d1829 55%, #0b1522 100%)'

  return (
    <div
      className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden select-none"
      style={{ background: dark ? bgDark : bgLight }}
    >
      {/* ── Ambient blobs ── */}
      <motion.div className="fixed pointer-events-none" style={{ width:560, height:560, borderRadius:'50%', top:'-15%', left:'-15%', background:'radial-gradient(circle, rgba(95,190,255,0.30) 0%, transparent 65%)', filter:'blur(80px)' }}
        animate={{ x:[0,24,0], y:[0,18,0] }} transition={{ duration:10, repeat:Infinity, ease:'easeInOut' }} />
      <motion.div className="fixed pointer-events-none" style={{ width:500, height:500, borderRadius:'50%', bottom:'-15%', right:'-12%', background:'radial-gradient(circle, rgba(175,143,244,0.28) 0%, transparent 65%)', filter:'blur(75px)' }}
        animate={{ x:[0,-20,0], y:[0,-22,0] }} transition={{ duration:12, repeat:Infinity, ease:'easeInOut', delay:1.5 }} />
      <motion.div className="fixed pointer-events-none" style={{ width:380, height:380, borderRadius:'50%', top:'40%', left:'25%', background:'radial-gradient(circle, rgba(240,92,107,0.14) 0%, transparent 65%)', filter:'blur(65px)' }}
        animate={{ x:[0,14,0], y:[0,-12,0] }} transition={{ duration:8, repeat:Infinity, ease:'easeInOut', delay:3 }} />

      {/* ── Floating particles ── */}
      <div className="fixed inset-0 pointer-events-none flex items-center justify-center">
        {DOTS.map((d, i) => (
          <motion.div key={i} className="absolute rounded-full"
            style={{ width:d.size, height:d.size, background:d.color, left:`calc(50% + ${d.cx}px)`, top:`calc(50% + ${d.cy}px)`, boxShadow:`0 0 ${d.size*2.5}px ${d.color}` }}
            initial={{ opacity:0, y:0, scale:0 }}
            animate={{ opacity:[0,0.85,0], y:-55, scale:[0,1.2,0] }}
            transition={{ duration:d.dur, delay:d.delay, repeat:Infinity, repeatDelay:d.rd, ease:'easeOut' }}
          />
        ))}
      </div>

      {/* ── Pulse rings ── */}
      <div className="fixed inset-0 pointer-events-none flex items-center justify-center">
        <div className="relative" style={{ width:1, height:1, overflow:'visible' }}>
          <PulseRing targetSize={260} delay={1.6}  color="rgba(95,190,255,0.45)" />
          <PulseRing targetSize={340} delay={2.1}  color="rgba(175,143,244,0.30)" />
          <PulseRing targetSize={420} delay={2.6}  color="rgba(255,205,131,0.20)" />
        </div>
      </div>

      {/* ── Center stage ── */}
      <div className="relative z-10 flex flex-col items-center gap-6 px-6">

        {/* ── ZAKA letter-drop ── */}
        <div className="relative flex items-end justify-center" style={{ height: 120 }}>
          {/* Spectral glow slab behind letters */}
          <motion.div
            className="absolute inset-0 rounded-3xl pointer-events-none"
            style={{ background: SPECTRAL_H, filter: 'blur(42px)', opacity: 0 }}
            animate={lettersLanded ? { opacity: [0, 0.22, 0.14] } : {}}
            transition={{ duration: 1.0, ease: 'easeOut' }}
          />

          {ZAKA_LETTERS.map((ltr, i) => (
            <motion.span
              key={i}
              className="display font-black relative"
              style={{
                fontSize: 'clamp(72px, 18vw, 96px)',
                letterSpacing: '-0.055em',
                lineHeight: 1,
                // spectral per-letter color on landing
                background: `linear-gradient(160deg, ${ltr.color} 0%, white 120%)`,
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
                filter: `drop-shadow(0 0 18px ${ltr.color}80)`,
                // shift letters slightly to tighten kerning
                marginLeft: i === 0 ? 0 : -6,
              }}
              initial={ltr.initial}
              animate={{ x: 0, y: 0, rotate: 0, opacity: 1, scale: 1 }}
              transition={{
                duration: 0.75,
                delay: 0.3 + i * 0.18,
                ease: [0.18, 1.2, 0.36, 1],   // springy overshoot
              }}
            >
              {ltr.char}
            </motion.span>
          ))}
        </div>

        {/* ── Spectral underline ── */}
        <motion.div
          className="rounded-full"
          style={{ height: 3, background: SPECTRAL_H }}
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 88, opacity: 1 }}
          transition={{ duration: 0.7, delay: 1.55, ease: [0.22, 1, 0.36, 1] }}
        />

        {/* ── Sub-lines cascade ── */}
        <div className="flex flex-col items-center gap-2 text-center" style={{ minHeight: 96 }}>
          {SUB_LINES.map((line, i) => (
            <AnimatePresence key={i}>
              {lettersLanded && (
                <motion.p
                  className={`${line.size} ${line.weight} ${'tracking' in line ? line.tracking : ''}`}
                  style={{ color: dark ? 'rgba(200,220,255,0.75)' : 'rgba(18,45,69,0.60)' }}
                  initial={{ opacity: 0, y: 14, filter: 'blur(6px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  transition={{ duration: 0.55, delay: line.delay - 1.5, ease: [0.22, 1, 0.36, 1] }}
                >
                  {line.text}
                </motion.p>
              )}
            </AnimatePresence>
          ))}
        </div>

        {/* ── Progress bar ── */}
        <motion.div
          className="flex flex-col items-center gap-2"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.0, duration: 0.5 }}
        >
          <div className="relative overflow-hidden rounded-full" style={{ height: 3, width: 160, background: dark ? 'rgba(255,255,255,0.08)' : 'rgba(18,45,69,0.10)' }}>
            <motion.div
              className="absolute inset-y-0 left-0 rounded-full"
              style={{ background: SPECTRAL_H }}
              initial={{ width: '0%' }}
              animate={{ width: '100%' }}
              transition={{ duration: 2.8, ease: [0.4, 0, 0.2, 1], delay: 0.3 }}
            />
          </div>
          <motion.p
            className="text-[10px] font-semibold uppercase tracking-[0.20em]"
            style={{ color: dark ? 'rgba(200,220,255,0.30)' : 'rgba(18,45,69,0.28)' }}
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1.8, repeat: Infinity }}
          >
            Loading
          </motion.p>
        </motion.div>
      </div>

      {/* ── Bottom spectral sweep ── */}
      <motion.div
        className="fixed bottom-0 left-0 right-0"
        style={{ height: 3, background: SPECTRAL_H, transformOrigin: 'left' }}
        initial={{ scaleX: 0 }}
        animate={{ scaleX: 1 }}
        transition={{ duration: 3.0, delay: 0.2, ease: [0.4, 0, 0.2, 1] }}
      />

      <style>{`
        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after {
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
            transition-duration: 0.01ms !important;
          }
        }
      `}</style>
    </div>
  )
}
