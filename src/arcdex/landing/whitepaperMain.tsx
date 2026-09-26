// whitepaper.html's entry: /whitepaper served on its own (Vercel rewrites
// it there), so X and other link previews read that page's own title,
// description and image. src/main.tsx mounts the same page in dev and
// `vite preview`, where the rewrite doesn't apply.
import { mountWhitepaper } from './Whitepaper'

mountWhitepaper(document.getElementById('root')!)
