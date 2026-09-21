import React, { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

const SPECTRAL_H = 'linear-gradient(90deg, #5fbeff, #af8ff4, #f05c6b, #ffcd83, #7ef1b3)'

// ── Tagline lines that rotate
const LINES = [
  'Send money instantly.',
  'Zero hidden fees.',
  'Works with M-Pesa.',
  'Your money, your way.',
]

// ── Particles: scattered around center, float UP and fade
const DOTS = [
  { cx: -70, cy:  30, size: 6, color: '#5fbeff', delay: 0.4, dur: 1.8, repeatDelay: 1.6 },
  { cx:  55, cy:  20, size: 4, color: '#af8ff4', delay: 0.9, dur: 2.0, repeatDelay: 1.2 },
  { cx: -40, cy: -30, size: 5, color: '#ffcd83', delay: 0.2, dur: 1.9, repeatDelay: 1.8 },
  { cx:  80, cy: -20, size: 7, color: '#7ef1b3', delay: 1.2, dur: 2.2, repeatDelay: 0.8 },
  { cx: -90, cy: -10, size: 4, color: '#f05c6b', delay: 0.6, dur: 1.7, repeatDelay: 1.4 },
  { cx:  30, cy:  50, size: 5, color: '#5fbeff', delay: 1.5, dur: 2.0, repeatDelay: 1.0 },
  { cx: -20, cy:  55, size: 3, color: '#ffcd83', delay: 0.3, dur: 1.6, repeatDelay: 2.0 },
  { cx:  95, cy:  40, size: 4, color: '#af8ff4', delay: 1.0, dur: 1.8, repeatDelay: 1.3 },
]

// ── Pulse ring — expands FROM the logo center outward with overflow:visible
function PulseRing({ targetSize, delay, color }: { targetSize: number; delay: number; color: string }) {
  return (
    <motion.div
      className="absolute rounded-full pointer-events-none"
      style={{
        width: targetSize,
        height: targetSize,
        top: '50%',
        left: '50%',
        marginTop: -(targetSize / 2),
        marginLeft: -(targetSize / 2),
        border: `1.5px solid ${color}`,
      }}
      initial={{ opacity: 0.7, scale: 0.55 }}
      animate={{ opacity: 0, scale: 1 }}
      transition={{
        duration: 2.2,
        delay,
        repeat: Infinity,
        repeatDelay: 0.6,
        ease: 'easeOut',
      }}
    />
  )
}

// ── Progress bar as a pure CSS animation so it doesn't depend on framer animate()
function ProgressBar({ duration }: { duration: number }) {
  return (
    <div
      className="relative overflow-hidden rounded-full"
      style={{ height: 3, width: 180, background: 'rgba(18,45,69,0.10)' }}
    >
      <motion.div
        className="absolute inset-y-0 left-0 rounded-full"
        style={{ background: SPECTRAL_H }}
        initial={{ width: '0%' }}
        animate={{ width: '100%' }}
        transition={{ duration, ease: [0.4, 0, 0.2, 1], delay: 0.4 }}
      />
    </div>
  )
}

export default function SplashScreen() {
  const [taglineIdx, setTaglineIdx] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTaglineIdx((i) => (i + 1) % LINES.length), 1800)
    return () => clearInterval(id)
  }, [])

  return (
    <div
      className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden select-none"
      style={{ background: 'linear-gradient(160deg, #eef3ff 0%, #fdf9f5 50%, #f3eeff 100%)' }}
    >
      {/* ── Ambient blobs — large, blurred, gently drifting ── */}
      <motion.div
        className="fixed pointer-events-none"
        style={{
          width: 520, height: 520, borderRadius: '50%',
          top: '-12%', left: '-14%',
          background: 'radial-gradient(circle, rgba(95,190,255,0.28) 0%, transparent 65%)',
          filter: 'blur(72px)',
        }}
        animate={{ x: [0, 22, 0], y: [0, 16, 0] }}
        transition={{ duration: 9, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="fixed pointer-events-none"
        style={{
          width: 480, height: 480, borderRadius: '50%',
          bottom: '-14%', right: '-12%',
          background: 'radial-gradient(circle, rgba(175,143,244,0.26) 0%, transparent 65%)',
          filter: 'blur(68px)',
        }}
        animate={{ x: [0, -18, 0], y: [0, -20, 0] }}
        transition={{ duration: 11, repeat: Infinity, ease: 'easeInOut', delay: 1.5 }}
      />
      <motion.div
        className="fixed pointer-events-none"
        style={{
          width: 360, height: 360, borderRadius: '50%',
          top: '38%', left: '28%',
          background: 'radial-gradient(circle, rgba(255,205,131,0.22) 0%, transparent 65%)',
          filter: 'blur(60px)',
        }}
        animate={{ x: [0, 12, 0], y: [0, -10, 0] }}
        transition={{ duration: 7, repeat: Infinity, ease: 'easeInOut', delay: 3 }}
      />

      {/* ── Floating particles — positioned relative to page center ── */}
      <div className="fixed inset-0 pointer-events-none flex items-center justify-center">
        {DOTS.map((d, i) => (
          <motion.div
            key={i}
            className="absolute rounded-full"
            style={{
              width: d.size,
              height: d.size,
              background: d.color,
              left: `calc(50% + ${d.cx}px)`,
              top: `calc(50% + ${d.cy}px)`,
              boxShadow: `0 0 ${d.size * 2}px ${d.color}`,
            }}
            initial={{ opacity: 0, y: 0, scale: 0 }}
            animate={{ opacity: [0, 0.9, 0], y: -48, scale: [0, 1.2, 0] }}
            transition={{
              duration: d.dur,
              delay: d.delay,
              repeat: Infinity,
              repeatDelay: d.repeatDelay,
              ease: 'easeOut',
            }}
          />
        ))}
      </div>

      {/* ── Center stage ── */}
      <div className="relative z-10 flex flex-col items-center gap-8">

        {/* Logo with pulse rings — overflow:visible so rings can escape the box */}
        <div
          className="relative flex items-center justify-center"
          style={{ width: 96, height: 96, overflow: 'visible' }}
        >
          {/* Rings expand outward past the logo bounds */}
          <PulseRing targetSize={220} delay={0}    color="rgba(95,190,255,0.55)" />
          <PulseRing targetSize={280} delay={0.55} color="rgba(175,143,244,0.40)" />
          <PulseRing targetSize={340} delay={1.1}  color="rgba(255,205,131,0.30)" />

          {/* Spectral glow behind logo */}
          <motion.div
            className="absolute rounded-full"
            style={{
              width: 120, height: 120,
              top: '50%', left: '50%',
              marginTop: -60, marginLeft: -60,
              background: SPECTRAL_H,
              filter: 'blur(28px)',
            }}
            animate={{ opacity: [0.15, 0.30, 0.15], scale: [0.9, 1.08, 0.9] }}
            transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
          />

          {/* Logo tile */}
          <motion.div
            className="relative z-10 flex items-center justify-center rounded-[26px]"
            style={{
              width: 96, height: 96,
              background: 'linear-gradient(145deg, #1261a6 0%, #0a3d6b 100%)',
              boxShadow: '0 20px 60px rgba(18,45,69,0.40), 0 0 0 1px rgba(255,255,255,0.14) inset',
            }}
            initial={{ opacity: 0, scale: 0.4, rotate: -15 }}
            animate={{ opacity: 1, scale: 1, rotate: 0 }}
            transition={{ duration: 0.75, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
          >
            {/* Spectral top strip */}
            <div
              className="absolute top-0 left-0 right-0 rounded-t-[26px]"
              style={{ height: 3, background: SPECTRAL_H }}
            />
            {/* Glass shine */}
            <div
              className="absolute inset-0 rounded-[26px]"
              style={{ background: 'linear-gradient(145deg, rgba(255,255,255,0.16) 0%, transparent 55%)' }}
            />
            <motion.span
              className="display relative text-4xl font-black text-white"
              style={{ letterSpacing: '-0.04em', textShadow: '0 2px 16px rgba(0,0,0,0.30)' }}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.55, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            >
              Z
            </motion.span>
          </motion.div>
        </div>

        {/* App name + spectral underline */}
        <motion.div
          className="flex flex-col items-center gap-3"
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.65, delay: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <h1
            className="display text-6xl font-black"
            style={{
              color: '#0d2540',
              letterSpacing: '-0.06em',
              textShadow: '0 4px 24px rgba(18,45,69,0.12)',
            }}
          >
            ZAKA
          </h1>
          <motion.div
            className="rounded-full"
            style={{ height: 3, background: SPECTRAL_H }}
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 72, opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.95, ease: [0.22, 1, 0.36, 1] }}
          />
        </motion.div>

        {/* Rolling tagline */}
        <motion.div
          style={{ height: 22, width: 240, overflow: 'hidden', position: 'relative' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.0, duration: 0.5 }}
        >
          <AnimatePresence mode="wait">
            <motion.p
              key={taglineIdx}
              className="absolute inset-0 text-center text-sm font-medium"
              style={{ color: 'rgba(18,45,69,0.50)' }}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -14 }}
              transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
            >
              {LINES[taglineIdx]}
            </motion.p>
          </AnimatePresence>
        </motion.div>

        {/* Progress */}
        <motion.div
          className="flex flex-col items-center gap-2.5"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.7, duration: 0.4 }}
        >
          <ProgressBar duration={2.6} />
          <motion.p
            className="text-[10px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: 'rgba(18,45,69,0.32)' }}
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
        transition={{ duration: 2.8, delay: 0.3, ease: [0.4, 0, 0.2, 1] }}
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
