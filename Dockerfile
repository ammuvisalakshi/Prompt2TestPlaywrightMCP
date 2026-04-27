# ── Playwright MCP Server ────────────────────────────────────────────────
# ARM64 (Graviton) — consistent with agent container, cheaper on Fargate
#
# Supports two modes via BROWSER_MODE env var:
#   headed    → Chromium + Xvfb (virtual display) + noVNC (web viewer on :6080)
#   headless  → Chromium headless only
#
# Ports:
#   3000 → Playwright MCP server (SSE transport)
#   6080 → noVNC web viewer (headed mode only)

FROM public.ecr.aws/docker/library/node:20-slim

# ── System dependencies ──────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Chromium browser + dependencies
    chromium \
    chromium-sandbox \
    # Virtual display (headed mode)
    xvfb \
    # VNC server (headed mode)
    x11vnc \
    # noVNC web viewer dependencies
    novnc \
    websockify \
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
    # TLS root certificates (required for Caddy ACME / Let's Encrypt)
    ca-certificates \
    # Detect public IP for sslip.io cert
    curl \
    # Reverse proxy — serves noVNC + MCP on port 443 so corporate VPNs don't block
    caddy \
    && rm -rf /var/lib/apt/lists/*

# ── Install @playwright/mcp globally ────────────────────────────────────
RUN npm install -g @playwright/mcp@latest

# ── Install Playwright browsers ──────────────────────────────────────────
# Install all browser types that @playwright/mcp might need, including
# chrome-for-testing (required by newer versions) and system dependencies.
RUN npx playwright install --with-deps chromium chrome 2>/dev/null || \
    npx playwright install --with-deps chromium 2>/dev/null || true
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# ── Copy entrypoint ──────────────────────────────────────────────────────
WORKDIR /app
COPY entrypoint.sh /app/entrypoint.sh
COPY Caddyfile /app/Caddyfile
RUN chmod +x /app/entrypoint.sh

# ── Runtime env defaults ─────────────────────────────────────────────────
# Override BROWSER_MODE at ECS task level: headed | headless
ENV BROWSER_MODE=headless
ENV MCP_PORT=3000
ENV NOVNC_PORT=6080
ENV DISPLAY_NUM=99

# ── Ports ────────────────────────────────────────────────────────────────
# 3000 — Playwright MCP SSE endpoint (agent connects here)
# 6080 — noVNC web viewer (DEV headed mode — QA watches browser live)
EXPOSE 80 443 3000 6080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/app/entrypoint.sh"]
