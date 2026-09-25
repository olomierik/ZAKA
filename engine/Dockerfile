# ARCDEX market engine — build from the repository root:
#   docker build -f engine/Dockerfile -t arcdex-engine .
#   docker run --env-file engine/.env -p 8080:8080 arcdex-engine
FROM oven/bun:1.3-slim

WORKDIR /app
# Only the engine's own dependency (viem) — not the frontend's.
COPY engine/package.json engine/bun.lock ./engine/
RUN cd engine && bun install --frozen-lockfile --production

# The engine plus the shared modules it imports from api/ (no Vercel functions run here).
COPY api/_arcLogs.ts api/_arcSwaps.ts api/_marketProtocol.ts api/_supabaseAdmin.ts ./api/
COPY engine/src ./engine/src

ENV NODE_ENV=production PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health').then(r => process.exit(r.status === 503 ? 1 : 0)).catch(() => process.exit(1))"
USER bun
CMD ["bun", "engine/src/main.ts"]
