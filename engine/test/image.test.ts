// The Docker image holds engine/src and only the api/ files the Dockerfile
// copies. A shared module the engine imports but the image leaves out
// crashes the engine on start (2026-09-27: api/_curves.ts, down 2.5 days),
// and one railway.toml doesn't watch never redeploys the engine when edited.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

function tsFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap(f => {
    const p = `${dir}/${f}`
    return statSync(join(ROOT, p)).isDirectory() ? tsFiles(p) : p.endsWith('.ts') ? [p] : []
  })
}

/** Every file outside engine/ that engine/src reaches through relative imports (transitively). */
function sharedImports(): string[] {
  const seen = new Set<string>()
  const queue = tsFiles('engine/src')
  const out = new Set<string>()
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const m of read(file).matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)) {
      const target = relative(ROOT, resolve(ROOT, dirname(file), m[1])).replace(/\\/g, '/') + (m[1].endsWith('.ts') ? '' : '.ts')
      if (!target.startsWith('engine/')) { out.add(target); queue.push(target) }
    }
  }
  return [...out].sort()
}

describe('engine image', () => {
  const shared = sharedImports()
  const copied = [...read('engine/Dockerfile').matchAll(/^COPY\s+(.+)\s+\S+$/gm)].flatMap(m => m[1].split(/\s+/))
  const watched = JSON.parse(/watchPatterns\s*=\s*(\[[^\]]*\])/.exec(read('railway.toml'))![1]) as string[]
  const covers = (pattern: string, file: string) => pattern === file || (pattern.endsWith('/**') && file.startsWith(pattern.slice(0, -2)))

  test('finds the shared modules', () => {
    expect(shared).toContain('api/_marketProtocol.ts')
    expect(shared).toContain('api/_curves.ts')
  })
  test('the Dockerfile copies every shared module the engine imports', () => {
    expect(shared.filter(f => !copied.includes(f))).toEqual([])
  })
  test('railway.toml redeploys the engine when one of them changes', () => {
    expect(shared.filter(f => !watched.some(p => covers(p, f)))).toEqual([])
  })
  test('the api/ files it copies find the engine packages (2026-10-03: viem from /app/api crashed the engine on start)', () => {
    const bare = shared.filter(f => /from\s+'[^.'][^']*'/.test(read(f).replace(/^import type .*$/gm, '')))
    expect(bare.length).toBeGreaterThan(0) // session.ts, social.ts… import viem
    expect(read('engine/Dockerfile')).toMatch(/^RUN ln -s \/app\/engine\/node_modules \/app\/node_modules$/m)
  })
})
