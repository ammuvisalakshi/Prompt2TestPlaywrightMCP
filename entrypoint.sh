#!/bin/bash
# ── Playwright MCP Server Entrypoint ────────────────────────────────────
#
# Reads BROWSER_MODE env var at startup:
#   headed   → Chrome (headless) + CDP screencast proxy + MCP via --cdp-endpoint
#   headless → MCP launches its own Chrome (headless, isolated)
#
# "headed" mode starts Chrome ourselves with --remote-debugging-port so
# the CDP screencast proxy can stream live frames to the UI.  The MCP
# server connects to the same Chrome instance via --cdp-endpoint.
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
echo "  Health Port : ${HEALTH_PORT}"
if [ "$BROWSER_MODE" = "headed" ]; then
echo "  CDP Port    : ${CDP_PORT}"
echo "  CDP Proxy   : ${PROXY_PORT}"
fi
echo "========================================"

# ── Health check server (port 8080) — used by NLB ────────────────────────
node -e "
  require('http').createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('ok');
  }).listen(${HEALTH_PORT}, () => console.log('Health server listening on port ${HEALTH_PORT}'));
" &

if [ "$BROWSER_MODE" = "headed" ]; then

    # ── 1. Start Chrome with CDP ─────────────────────────────────────────
    echo "[headed] Starting Chrome (headless) with CDP on port ${CDP_PORT}..."
    /usr/bin/chromium \
        --headless=new \
        --remote-debugging-port=${CDP_PORT} \
        --remote-debugging-address=127.0.0.1 \
        --no-sandbox \
        --disable-gpu \
        --disable-dev-shm-usage \
        --disable-software-rasterizer \
        --window-size=1280,720 \
        about:blank &
    CHROME_PID=$!

    # Wait for CDP to be ready
    echo "[headed] Waiting for Chrome CDP..."
    for i in $(seq 1 20); do
        if curl -s http://127.0.0.1:${CDP_PORT}/json/version > /dev/null 2>&1; then
            echo "[headed] Chrome CDP ready (attempt $i)"
            break
        fi
        sleep 1
    done

    # Get the browser WebSocket URL for MCP --cdp-endpoint
    CDP_WS_URL=$(curl -s http://127.0.0.1:${CDP_PORT}/json/version | node -e "
        let d='';process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{try{console.log(JSON.parse(d).webSocketDebuggerUrl)}catch{console.log('')}})
    ")
    echo "[headed] CDP WebSocket URL: $CDP_WS_URL"

    if [ -z "$CDP_WS_URL" ]; then
        echo "[headed] ERROR: Could not get CDP WebSocket URL. Chrome may have failed to start."
        echo "[headed] Falling back to MCP-managed Chrome (no live view)..."
        exec npx @playwright/mcp \
            --port ${MCP_PORT} \
            --host 0.0.0.0 \
            --allowed-origins "*" \
            --browser chromium \
            --headless
    fi

    # ── 2. Detect public IP + start Caddy ────────────────────────────────
    echo "[headed] Detecting public IP for sslip.io TLS cert..."
    # Try ECS Fargate metadata (v4), then EC2 metadata, then external service
    PUBLIC_IP=""
    if [ -n "$ECS_CONTAINER_METADATA_URI_V4" ]; then
        # Fargate: get task metadata → ENI → public IP
        TASK_META=$(curl -s --connect-timeout 3 "${ECS_CONTAINER_METADATA_URI_V4}/task" 2>/dev/null)
        PUBLIC_IP=$(echo "$TASK_META" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const t=JSON.parse(d);const c=t.Containers||[];for(const x of c){for(const n of (x.Networks||[])){if(n.IPv4Addresses){console.log(n.IPv4Addresses[0]);process.exit(0)}}}}catch{};})" 2>/dev/null)
        # Fargate doesn't expose public IP in metadata — fall back to external
        if [ -z "$PUBLIC_IP" ] || echo "$PUBLIC_IP" | grep -qE '^(10\.|172\.(1[6-9]|2|3[01])\.|192\.168\.)'; then
            PUBLIC_IP=""
        fi
    fi
    if [ -z "$PUBLIC_IP" ]; then
        PUBLIC_IP=$(curl -s --connect-timeout 5 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo "")
    fi
    if [ -z "$PUBLIC_IP" ]; then
        PUBLIC_IP=$(curl -s --connect-timeout 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || echo "")
    fi
    if [ -z "$PUBLIC_IP" ]; then
        PUBLIC_IP=$(curl -s --connect-timeout 5 http://ifconfig.me 2>/dev/null | tr -d '[:space:]' || echo "")
    fi

    if [ -n "$PUBLIC_IP" ]; then
        SSLIP_DOMAIN="$(echo $PUBLIC_IP | tr '.' '-').sslip.io"
        echo "[headed] Public IP: $PUBLIC_IP → domain: $SSLIP_DOMAIN"

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

    # ── 3. Start CDP screencast proxy ────────────────────────────────────
    echo "[headed] Starting CDP screencast proxy on port ${PROXY_PORT}..."
    CDP_PORT=${CDP_PORT} PROXY_PORT=${PROXY_PORT} node /app/cdp-proxy.mjs &

    # ── 4. Start MCP server, connecting to our Chrome instance ───────────
    echo "[headed] Starting Playwright MCP server (connected to Chrome via CDP)..."
    exec npx @playwright/mcp \
        --port ${MCP_PORT} \
        --host 0.0.0.0 \
        --allowed-origins "*" \
        --cdp-endpoint "$CDP_WS_URL"

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
