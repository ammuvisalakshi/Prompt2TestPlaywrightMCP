# ── Playwright MCP Server ────────────────────────────────────────────────
# ARM64 (Graviton) — consistent with agent container, cheaper on Fargate
#
# Supports two modes via BROWSER_MODE env var:
#   headed    → Chromium + CDP screencast proxy (live browser view on :6080)
#   headless  → Chromium headless only
#
# Ports:
#   3000 → Playwright MCP server (SSE transport)
#   6080 → CDP screencast proxy (headed mode — live browser view via WebSocket)

FROM public.ecr.aws/docker/library/node:20-slim

# ── System dependencies ──────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Chromium browser + dependencies
    chromium \
    chromium-sandbox \
    # Playwright browser dependencies
    libglib2.0-0 \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    fonts-liberation \
    # Process management
    procps \
    # Detect public IP for sslip.io cert
    curl \
    # Reverse proxy — serves MCP + CDP proxy on port 443 with auto TLS
    caddy \
    && rm -rf /var/lib/apt/lists/*

# ── Install @playwright/mcp globally ────────────────────────────────────
RUN npm install -g @playwright/mcp@latest

# ── Install Playwright browsers (Chromium) ───────────────────────────────
RUN npx playwright install chromium 2>/dev/null || true
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# ── Copy entrypoint + CDP proxy ─────────────────────────────────────────
WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev
COPY entrypoint.sh /app/entrypoint.sh
COPY cdp-proxy.mjs /app/cdp-proxy.mjs
COPY Caddyfile /app/Caddyfile
RUN chmod +x /app/entrypoint.sh

# ── Runtime env defaults ─────────────────────────────────────────────────
ENV BROWSER_MODE=headless
ENV MCP_PORT=3000
ENV CDP_PORT=9222
ENV PROXY_PORT=6080

# ── Ports ────────────────────────────────────────────────────────────────
# 3000 — Playwright MCP SSE endpoint (agent connects here)
# 6080 — CDP screencast WebSocket (UI connects via Caddy on 443)
EXPOSE 80 443 3000 6080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/app/entrypoint.sh"]
