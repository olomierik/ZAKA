// The site's Content-Security-Policy (netlify.toml [[headers]] for "/*") must allow every inline script and inline
// event handler the HTML ships, by hash, and keep its protective directives. Editing index.html's theme script or the
// fonts' onload handler changes its hash; this check fails until the policy's hash is updated.
//   bun scripts/check-csp.ts          (source HTML; also dist/*.html when a build exists)
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

// The [[headers]] block for "/*", read as its `Name = "value"` lines (the only TOML it uses).
const block = readFileSync('netlify.toml', 'utf8').split('[[headers]]').slice(1).find(b => /^\s*for\s*=\s*"\/\*"/m.test(b)) ?? ''
const all: Record<string, string> = Object.fromEntries([...block.matchAll(/^\s*([A-Za-z-]+)\s*=\s*"([^"]*)"\s*$/gm)].map(m => [m[1], m[2]]))
const csp = all['Content-Security-Policy'] ?? ''

let fails = 0
const check = (ok: boolean, msg: string) => { if (!ok) fails++; console.log(ok ? '  ✓' : '  ✗', msg) }

const directives = new Map(csp.split(';').map(d => d.trim()).filter(Boolean).map(d => { const [k, ...v] = d.split(/\s+/); return [k, v] as const }))
const scriptSrc = directives.get('script-src') ?? []
const hash = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`

console.log('policy')
check(csp.length > 0, 'netlify.toml sets a Content-Security-Policy for /*')
check(!scriptSrc.includes("'unsafe-inline'") && !scriptSrc.includes("'unsafe-eval'"), "script-src allows no 'unsafe-inline' or 'unsafe-eval'")
check(directives.get('object-src')?.join(' ') === "'none'", "object-src 'none'")
check(directives.get('frame-ancestors')?.join(' ') === "'none'", "frame-ancestors 'none'")
check(directives.get('base-uri')?.join(' ') === "'self'", "base-uri 'self'")
for (const h of ['Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy']) check(!!all[h], `${h} is set`)

const pages = ['index.html', 'arcdex.html', ...(existsSync('dist') ? readdirSync('dist').filter(f => f.endsWith('.html')).map(f => `dist/${f}`) : [])]
for (const page of pages) {
  if (!existsSync(page)) continue
  const html = readFileSync(page, 'utf8')
  console.log(page)
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(s => s.trim())
  for (const s of scripts) check(scriptSrc.includes(hash(s)), `inline script ${hash(s)} (${s.slice(0, 40).replace(/\s+/g, ' ')}…) is allowed`)
  const handlers = [...html.matchAll(/\son[a-z]+="([^"]*)"/g)].map(m => m[1])
  for (const h of handlers) check(scriptSrc.includes("'unsafe-hashes'") && scriptSrc.includes(hash(h)), `inline handler "${h}" is allowed by its hash`)
  if (!scripts.length && !handlers.length) console.log('  · no inline scripts or handlers')
}

console.log(fails ? `\n${fails} failed` : '\nall passed')
process.exit(fails ? 1 : 0)
