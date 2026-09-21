import React, { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useTheme } from '../lib/theme'

const SPECTRAL_H = 'linear-gradient(90deg, #5fbeff, #af8ff4, #f05c6b, #ffcd83, #7ef1b3)'

// ── Letter drop config — each falls from a unique angle ──
const ZAKA_LETTERS = [
  { char: 'Z', initial: { x: -200, y: -280, rotate: -65, opacity: 0, scale: 0.3 }, color: '#5fbeff', delay: 0.5 },
  { char: 'A', initial: { x: 180,  y: -260, rotate:  50, opacity: 0, scale: 0.3 }, color: '#af8ff4', delay: 0.85 },
  { char: 'K', initial: { x: -160, y:  260, rotate:  35, opacity: 0, scale: 0.3 }, color: '#f05c6b', delay: 1.2 },
  { char: 'A', initial: { x: 220,  y: -180, rotate: -70, opacity: 0, scale: 0.3 }, color: '#7ef1b3', delay: 1.55 },
]

// ── Sub-lines cascade — spread over 4-7 s ──
const SUB_LINES = [
  { text: 'Crossborder payments made easy',          size: 'text-base',    weight: 'font-semibold', delay: 3.2  },
  { text: 'ONE WALLET · ONE PAYMENT INFRASTRUCTURE', size: 'text-[11px]',  weight: 'font-bold',     delay: 4.1, tracking: 'tracking-[0.12em]' },
  { text: 'SEND & RECEIVE IN SECONDS',               size: 'text-[11px]',  weight: 'font-bold',     delay: 5.0, tracking: 'tracking-[0.12em]' },
  { text: 'Everything recorded onchain.',            size: 'text-[10px]',  weight: 'font-medium',   delay: 5.9 },
]

// ── Floating particles ──
const DOTS = [
  { cx: -110, cy: 45,  size: 5, color: '#5fbeff', delay: 0.3,  dur: 2.2, rd: 1.6 },
  { cx:  90,  cy: 30,  size: 4, color: '#af8ff4', delay: 0.8,  dur: 2.0, rd: 1.4 },
  { cx: -60,  cy: -50, size: 6, color: '#ffcd83', delay: 0.2,  dur: 2.3, rd: 1.8 },
  { cx:  115, cy: -40, size: 7, color: '#7ef1b3', delay: 1.1,  dur: 2.5, rd: 0.8 },
  { cx: -140, cy: -18, size: 4, color: '#f05c6b', delay: 0.6,  dur: 1.9, rd: 1.5 },
  { cx:  42,  cy: 72,  size: 5, color: '#5fbeff', delay: 1.5,  dur: 2.2, rd: 1.0 },
  { cx: -30,  cy: 80,  size: 3, color: '#ffcd83', delay: 0.4,  dur: 1.8, rd: 2.2 },
  { cx:  135, cy: 58,  size: 4, color: '#af8ff4', delay: 1.0,  dur: 2.0, rd: 1.3 },
  { cx: -80,  cy: 100, size: 3, color: '#7ef1b3', delay: 2.2,  dur: 2.1, rd: 1.7 },
  { cx:  65,  cy: -80, size: 5, color: '#f05c6b', delay: 1.8,  dur: 2.4, rd: 1.1 },
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
      transition={{ duration: 2.6, delay, repeat: Infinity, repeatDelay: 1.0, ease: 'easeOut' }}
    />
  )
}

// ── Web Audio: synthesised intro chord + sweep ──
function playSplashSound() {
  try {
    const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return
    const ctx = new AudioCtx()

    const master = ctx.createGain()
    master.gain.setValueAtTime(0, ctx.currentTime)
    master.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.3)
    master.gain.setValueAtTime(0.18, ctx.currentTime + 7.5)
    master.gain.linearRampToValueAtTime(0, ctx.currentTime + 9.0)
    master.connect(ctx.destination)

    const reverb = ctx.createConvolver()
    const rLen = ctx.sampleRate * 2.5
    const rBuf = ctx.createBuffer(2, rLen, ctx.sampleRate)
    for (let ch = 0; ch < 2; ch++) {
      const d = rBuf.getChannelData(ch)
      for (let i = 0; i < rLen; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / rLen, 2.4)
    }
    reverb.buffer = rBuf
    reverb.connect(master)

    // Chord: E-minor-major7 spread — lush fintech feel
    const notes = [
      { freq: 164.81, t: 0.0,  dur: 8.0, vol: 0.55 },  // E3
      { freq: 246.94, t: 0.18, dur: 7.8, vol: 0.45 },  // B3
      { freq: 329.63, t: 0.36, dur: 7.5, vol: 0.40 },  // E4
      { freq: 392.00, t: 0.55, dur: 7.0, vol: 0.35 },  // G4
      { freq: 493.88, t: 0.75, dur: 6.5, vol: 0.28 },  // B4
      { freq: 659.26, t: 1.0,  dur: 5.5, vol: 0.22 },  // E5  (high shimmer)
      { freq: 783.99, t: 1.3,  dur: 4.5, vol: 0.16 },  // G5  (sparkle)
    ]

    notes.forEach(({ freq, t, dur, vol }) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, ctx.currentTime)
      gain.gain.setValueAtTime(0, ctx.currentTime + t)
      gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + t + 0.25)
      gain.gain.setValueAtTime(vol * 0.7, ctx.currentTime + t + dur * 0.6)
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + t + dur)
      osc.connect(gain)
      gain.connect(reverb)
      osc.start(ctx.currentTime + t)
      osc.stop(ctx.currentTime + t + dur + 0.1)
    })

    // Bright impact "ping" at letter-land moment (~2.0s) — arpeggio
    const pings = [
      { freq: 1174.66, t: 2.0, dur: 1.2 },  // D6
      { freq: 1318.51, t: 2.15, dur: 1.0 }, // E6
      { freq: 1567.98, t: 2.30, dur: 0.9 }, // G6
    ]
    pings.forEach(({ freq, t, dur }) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(freq, ctx.currentTime + t)
      gain.gain.setValueAtTime(0, ctx.currentTime + t)
      gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + t + 0.04)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + dur)
      osc.connect(gain)
      gain.connect(master)
      osc.start(ctx.currentTime + t)
      osc.stop(ctx.currentTime + t + dur + 0.05)
    })

    // Sweeping filter whoosh on each letter drop
    ZAKA_LETTERS.forEach(({ delay: ld }) => {
      const osc = ctx.createOscillator()
      const filter = ctx.createBiquadFilter()
      const gain = ctx.createGain()
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(80, ctx.currentTime + ld)
      osc.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + ld + 0.4)
      filter.type = 'bandpass'
      filter.frequency.setValueAtTime(300, ctx.currentTime + ld)
      filter.Q.value = 3
      gain.gain.setValueAtTime(0, ctx.currentTime + ld)
      gain.gain.linearRampToValueAtTime(0.08, ctx.currentTime + ld + 0.05)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ld + 0.45)
      osc.connect(filter)
      filter.connect(gain)
      gain.connect(reverb)
      osc.start(ctx.currentTime + ld)
      osc.stop(ctx.currentTime + ld + 0.5)
    })

    // Text-line soft chime at each subtitle beat
    const chimes = [3.2, 4.1, 5.0, 5.9]
    chimes.forEach((t, i) => {
      const freq = [523.25, 587.33, 659.26, 783.99][i] // C5 D5 E5 G5
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, ctx.currentTime + t)
      gain.gain.setValueAtTime(0, ctx.currentTime + t)
      gain.gain.linearRampToValueAtTime(0.10, ctx.currentTime + t + 0.05)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 1.2)
      osc.connect(gain)
      gain.connect(reverb)
      osc.start(ctx.currentTime + t)
      osc.stop(ctx.currentTime + t + 1.3)
    })

    // Gently close context after 10 s
    setTimeout(() => { void ctx.close() }, 10000)
  } catch {
    // Audio blocked — silent fail, app works fine
  }
}

export default function SplashScreen() {
  const [lettersLanded, setLettersLanded] = useState(false)
  const { isDark: dark } = useTheme()

  useEffect(() => {
    // Try to play sound immediately (works if page loaded via user gesture)
    playSplashSound()

    // Letters all land by ~2.3s — sub-lines start at 3.2s
    const t = setTimeout(() => setLettersLanded(true), 2400)
    return () => clearTimeout(t)
  }, [])

  const bgLight = 'linear-gradient(160deg, #e6eeff 0%, #fdf8f5 45%, #ede8ff 100%)'
  const bgDark  = 'linear-gradient(160deg, #06101d 0%, #0b1829 55%, #090f1c 100%)'

  return (
    <div
      className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden select-none"
      style={{ background: dark ? bgDark : bgLight }}
    >
      {/* ── Ambient blobs ── */}
      {[
        { w:580, h:580, t:'-14%', l:'-14%', c:'rgba(95,190,255,0.30)', bx:[0,26,0], by:[0,20,0], d:11 },
        { w:520, h:520, b:'-14%', r:'-12%', c:'rgba(175,143,244,0.28)', bx:[0,-22,0], by:[0,-24,0], d:13, dl:1.5 },
        { w:400, h:400, t:'38%',  l:'22%',  c:'rgba(240,92,107,0.14)', bx:[0,16,0], by:[0,-14,0], d:9,  dl:3 },
        { w:320, h:320, b:'20%',  l:'-8%',  c:'rgba(126,241,179,0.12)', bx:[0,10,0], by:[0,18,0], d:10, dl:5 },
      ].map(({ w, h, t, l, b, r, c, bx, by, d, dl }, i) => (
        <motion.div key={i} className="fixed pointer-events-none" style={{ width:w, height:h, borderRadius:'50%',
          ...(t ? { top: t } : {}), ...(b ? { bottom: b } : {}),
          ...(l ? { left: l } : {}), ...(r ? { right: r } : {}),
          background:`radial-gradient(circle, ${c} 0%, transparent 65%)`, filter:'blur(80px)' }}
          animate={{ x: bx, y: by }}
          transition={{ duration: d, repeat: Infinity, ease:'easeInOut', delay: dl ?? 0, repeatType:'mirror' }}
        />
      ))}

      {/* ── Floating particles ── */}
      <div className="fixed inset-0 pointer-events-none flex items-center justify-center">
        {DOTS.map((d, i) => (
          <motion.div key={i} className="absolute rounded-full"
            style={{ width:d.size, height:d.size, background:d.color,
              left:`calc(50% + ${d.cx}px)`, top:`calc(50% + ${d.cy}px)`,
              boxShadow:`0 0 ${d.size * 3}px ${d.color}` }}
            initial={{ opacity:0, y:0, scale:0 }}
            animate={{ opacity:[0,0.9,0], y:-65, scale:[0,1.3,0] }}
            transition={{ duration:d.dur, delay:d.delay, repeat:Infinity, repeatDelay:d.rd, ease:'easeOut' }}
          />
        ))}
      </div>

      {/* ── Pulse rings (start after letters land) ── */}
      <div className="fixed inset-0 pointer-events-none flex items-center justify-center">
        <div className="relative" style={{ width:1, height:1, overflow:'visible' }}>
          <PulseRing targetSize={280} delay={2.3} color="rgba(95,190,255,0.45)" />
          <PulseRing targetSize={380} delay={2.9} color="rgba(175,143,244,0.30)" />
          <PulseRing targetSize={480} delay={3.5} color="rgba(255,205,131,0.18)" />
        </div>
      </div>

      {/* ── Center content ── */}
      <div className="relative z-10 flex flex-col items-center gap-6 px-6">

        {/* ZAKA letter-drop row */}
        <div className="relative flex items-end justify-center" style={{ height: 120 }}>
          {/* Spectral glow behind letters — ignites when last letter lands */}
          <motion.div
            className="absolute inset-0 rounded-3xl pointer-events-none"
            style={{ background: SPECTRAL_H, filter: 'blur(48px)' }}
            initial={{ opacity: 0 }}
            animate={lettersLanded ? { opacity: [0, 0.24, 0.12] } : {}}
            transition={{ duration: 1.2, ease: 'easeOut' }}
          />

          {ZAKA_LETTERS.map((ltr, i) => (
            <motion.span
              key={i}
              className="display font-black relative"
              style={{
                fontSize: 'clamp(76px, 19vw, 100px)',
                letterSpacing: '-0.055em',
                lineHeight: 1,
                background: `linear-gradient(160deg, ${ltr.color} 0%, ${dark ? '#c8e4ff' : 'white'} 130%)`,
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
                filter: `drop-shadow(0 0 22px ${ltr.color}90)`,
                marginLeft: i === 0 ? 0 : -8,
              }}
              initial={ltr.initial}
              animate={{ x: 0, y: 0, rotate: 0, opacity: 1, scale: 1 }}
              transition={{
                duration: 0.85,
                delay: ltr.delay,
                ease: [0.16, 1.3, 0.36, 1],  // springy land
              }}
            >
              {ltr.char}
            </motion.span>
          ))}
        </div>

        {/* Spectral underline — draws after last letter lands */}
        <motion.div
          className="rounded-full"
          style={{ height: 3, background: SPECTRAL_H }}
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 96, opacity: 1 }}
          transition={{ duration: 0.8, delay: 2.5, ease: [0.22, 1, 0.36, 1] }}
        />

        {/* Sub-lines — staggered across 3–6 s */}
        <div className="flex flex-col items-center gap-2.5 text-center" style={{ minHeight: 110 }}>
          {SUB_LINES.map((line, i) => (
            <AnimatePresence key={i}>
              {lettersLanded && (
                <motion.p
                  className={`${line.size} ${line.weight} ${'tracking' in line ? line.tracking : ''}`}
                  style={{ color: dark ? 'rgba(200,222,255,0.80)' : 'rgba(18,45,69,0.62)' }}
                  initial={{ opacity: 0, y: 18, filter: 'blur(8px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  transition={{
                    duration: 0.65,
                    delay: line.delay - 2.4,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                >
                  {line.text}
                </motion.p>
              )}
            </AnimatePresence>
          ))}
        </div>

        {/* Progress bar — runs full 9 s */}
        <motion.div
          className="flex flex-col items-center gap-2"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.8, duration: 0.6 }}
        >
          <div className="relative overflow-hidden rounded-full"
            style={{ height: 3, width: 170, background: dark ? 'rgba(255,255,255,0.07)' : 'rgba(18,45,69,0.09)' }}>
            <motion.div
              className="absolute inset-y-0 left-0 rounded-full"
              style={{ background: SPECTRAL_H }}
              initial={{ width: '0%' }}
              animate={{ width: '100%' }}
              transition={{ duration: 8.4, ease: [0.4, 0, 0.2, 1], delay: 0.2 }}
            />
          </div>
          <motion.p
            className="text-[10px] font-semibold uppercase tracking-[0.22em]"
            style={{ color: dark ? 'rgba(200,222,255,0.28)' : 'rgba(18,45,69,0.26)' }}
            animate={{ opacity: [0.35, 1, 0.35] }}
            transition={{ duration: 2.0, repeat: Infinity }}
          >
            Loading
          </motion.p>
        </motion.div>
      </div>

      {/* Bottom spectral sweep */}
      <motion.div
        className="fixed bottom-0 left-0 right-0"
        style={{ height: 3, background: SPECTRAL_H, transformOrigin: 'left' }}
        initial={{ scaleX: 0 }}
        animate={{ scaleX: 1 }}
        transition={{ duration: 8.8, delay: 0.1, ease: [0.4, 0, 0.2, 1] }}
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
