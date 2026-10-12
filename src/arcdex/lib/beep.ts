// A short tone for alerts (the discovery panel's trade alerts, price alerts). Quiet, and silent where audio is
// blocked (no user gesture yet, or no audio at all).

export function beep() {
  try {
    const ctx = new AudioContext()
    const o = ctx.createOscillator(), g = ctx.createGain()
    o.frequency.value = 880; g.gain.value = 0.06
    o.connect(g); g.connect(ctx.destination); o.start()
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25)
    o.stop(ctx.currentTime + 0.26)
  } catch { /* audio blocked */ }
}
