import { captureReferral } from './arcdex/lib/referral'

// arcdex.online/ is the landing page — a small bundle with no wallet
// libraries, so it loads fast for new visitors. Every other path (/app,
// /token/…, /profile/…, …) is the trading app. /r/<name> referral links
// are remembered first, then land on the landing page.
captureReferral()

const root = document.getElementById('root')!
const path = window.location.pathname
if (path === '/' || path === '/index.html') {
  void import('./arcdex/landing/Landing').then(m => m.mountLanding(root))
} else {
  void import('./appMain').then(m => m.mountApp(root))
}
