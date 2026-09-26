import { captureReferral } from './arcdex/lib/referral'

// arcdex.online/ is the landing page — a small bundle with no wallet
// libraries, so it loads fast for new visitors. /whitepaper is the
// whitepaper (in production Vercel serves it from whitepaper.html, for its
// link previews; this covers dev and `vite preview`). Every other path
// (/app, /token/…, /profile/…, …) is the trading app. /r/<name> referral
// links are remembered first, then land on the landing page.
captureReferral()

const root = document.getElementById('root')!
const path = window.location.pathname
if (path === '/' || path === '/index.html') {
  void import('./arcdex/landing/Landing').then(m => m.mountLanding(root))
} else if (path === '/whitepaper' || path === '/whitepaper/') {
  void import('./arcdex/landing/Whitepaper').then(m => m.mountWhitepaper(root))
} else {
  void import('./appMain').then(m => m.mountApp(root))
}
