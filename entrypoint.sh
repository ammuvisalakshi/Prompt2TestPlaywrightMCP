#!/bin/bash
# ── Playwright MCP Server Entrypoint ────────────────────────────────────
#
# Reads BROWSER_MODE env var at startup:
#   headed   → starts Playwright MCP (headed Chromium) + CDP screencast proxy
#   headless → starts Playwright MCP (headless Chromium only)
#
# Environment variables:
#   BROWSER_MODE   headed | headless  (default: headless)
#   MCP_PORT       MCP SSE port       (default: 3000)
#   CDP_PORT       Chrome CDP port    (default: 9222)
#   PROXY_PORT     CDP proxy port     (default: 6080)
#   HEALTH_PORT    ALB health check   (default: 8080)

set -e

# Kill any leftover browser processes and wipe profile locks
pkill -f chromium 2>/dev/null || true
pkill -f chrome 2>/dev/null || true
rm -f /tmp/.com.google.Chrome.* /tmp/chrome_* 2>/dev/null || true
rm -rf /tmp/playwright-* /root/.config/chromium /root/.config/google-chrome 2>/dev/null || true

BROWSER_MODE=${BROWSER_MODE:-headless}
MCP_PORT=${MCP_PORT:-3000}
CDP_PORT=${CDP_PORT:-9222}
PROXY_PORT=${PROXY_PORT:-6080}
HEALTH_PORT=${HEALTH_PORT:-8080}

echo "========================================"
echo "  Playwright MCP Server"
echo "  Mode        : ${BROWSER_MODE}"
echo "  MCP Port    : ${MCP_PORT}"
echo "  CDP Port    : ${CDP_PORT}"
echo "  Health Port : ${HEALTH_PORT}"
if [ "$BROWSER_MODE" = "headed" ]; then
echo "  CDP Proxy   : ${PROXY_PORT}"
fi
echo "========================================"

# ── Health check server (port 8080) — used by NLB ────────────────────────
# Runs in background, responds 200 OK to any request
node -e "
  require('http').createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('ok');
  }).listen(${HEALTH_PORT}, () => console.log('Health server listening on port ${HEALTH_PORT}'));
" &

if [ "$BROWSER_MODE" = "headed" ]; then

    echo "[headed] Detecting public IP for sslip.io TLS cert..."
    PUBLIC_IP=$(curl -s --connect-timeout 5 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || curl -s --connect-timeout 5 https://checkip.amazonaws.com 2>/dev/null || echo "")

    if [ -n "$PUBLIC_IP" ]; then
        # Convert dots to dashes for sslip.io: 44.195.45.47 → 44-195-45-47
        SSLIP_DOMAIN="$(echo $PUBLIC_IP | tr '.' '-').sslip.io"
        echo "[headed] Public IP: $PUBLIC_IP → domain: $SSLIP_DOMAIN"

        # Generate Caddyfile — proxy MCP + CDP screencast through TLS
        cat > /app/Caddyfile.live <<CADDYEOF
$SSLIP_DOMAIN {
    handle /sse {
        reverse_proxy localhost:${MCP_PORT}
    }
    handle /message {
        reverse_proxy localhost:${MCP_PORT}
    }
    handle {
        @websocket {
            header Connection *Upgrade*
            header Upgrade websocket
        }
        reverse_proxy @websocket localhost:${PROXY_PORT}
        reverse_proxy localhost:${PROXY_PORT}
    }
}
CADDYEOF
        CADDY_CONFIG="/app/Caddyfile.live"
    else
        echo "[headed] Could not detect public IP — falling back to self-signed cert"
        CADDY_CONFIG="/app/Caddyfile"
    fi

    echo "[headed] Starting Caddy reverse proxy..."
    caddy start --config "$CADDY_CONFIG"
    echo "[headed] Caddy ready — wss://$SSLIP_DOMAIN (CDP screencast)"

    # Start CDP screencast proxy (background) — waits for Chrome CDP to be ready
    echo "[headed] Starting CDP screencast proxy on port ${PROXY_PORT}..."
    CDP_PORT=${CDP_PORT} PROXY_PORT=${PROXY_PORT} node /app/cdp-proxy.mjs &

    echo "[headed] Starting Playwright MCP server on port ${MCP_PORT}..."
    exec npx @playwright/mcp \
        --port ${MCP_PORT} \
        --host 0.0.0.0 \
        --allowed-origins "*" \
        --browser chromium \
        --browser-args="--remote-debugging-port=${CDP_PORT} --remote-debugging-address=127.0.0.1"

else

    echo "[headless] Starting Playwright MCP server on port ${MCP_PORT}..."
    exec npx @playwright/mcp \
        --port ${MCP_PORT} \
        --host 0.0.0.0 \
        --allowed-origins "*" \
        --browser chromium \
        --headless \
        --isolated

fi
