# ARCDEX market engine — build from the repository root:
#   docker build -f engine/Dockerfile -t arcdex-engine .
#   docker run --env-file engine/.env -p 8080:8080 arcdex-engine
FROM oven/bun:1.3-slim

WORKDIR /app
# Only the engine's own dependency (viem) — not the frontend's.
COPY engine/package.json engine/bun.lock ./engine/
RUN cd engine && bun install --frozen-lockfile --production
# The api/ files sit in /app/api, outside engine/: without node_modules above them Bun auto-installs their packages
# on start and fails (2026-10-03: "ENOENT while resolving package '@noble/hashes/crypto'", every deploy since the
# site's functions moved here failed its health check). They resolve the engine's own packages through this link.
RUN ln -s /app/engine/node_modules /app/node_modules

# The engine plus the shared modules it imports from api/.
# engine/test/image.test.ts fails if the engine imports one that isn't listed here.
COPY api/_arcLogs.ts api/_arcSwaps.ts api/_curves.ts api/_marketProtocol.ts api/_quantProtocol.ts api/_supabaseAdmin.ts ./api/
# The site's read functions it serves instead of Vercel (engine/src/site/siteApi.ts, 2026-10-02).
COPY api/_argusBonded.ts api/_argusCore.ts api/_curveIndex.ts api/_curvesRoute.ts api/_geckoterminal.ts api/_holdersCore.ts api/_launchpadCore.ts api/_launchpads.ts api/argus.ts api/dex.ts api/gecko.ts api/holders.ts api/index-trades.ts api/launchpad.ts api/radar.ts ./api/
# Its write functions too (2026-10-03, the site on Netlify serves only its files).
COPY api/_session.ts api/session.ts api/social.ts api/upload.ts ./api/
COPY engine/src ./engine/src

ENV NODE_ENV=production PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health').then(r => process.exit(r.status === 503 ? 1 : 0)).catch(() => process.exit(1))"
USER bun
CMD ["bun", "engine/src/main.ts"]
