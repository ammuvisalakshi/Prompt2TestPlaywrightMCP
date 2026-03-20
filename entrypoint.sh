#!/bin/bash
# ── Playwright MCP Server Entrypoint ────────────────────────────────────
#
# Reads BROWSER_MODE env var at startup:
#   headed   → starts Xvfb + x11vnc + noVNC + Playwright MCP (headed Chromium)
#   headless → starts Playwright MCP (headless Chromium only)
#
# Environment variables:
#   BROWSER_MODE   headed | headless  (default: headless)
#   MCP_PORT       MCP SSE port       (default: 3000)
#   NOVNC_PORT     noVNC web port     (default: 6080)
#   HEALTH_PORT    ALB health check   (default: 8080)
#   DISPLAY_NUM    Xvfb display num   (default: 99)

set -e

# Kill any leftover browser processes and wipe profile locks
pkill -f chromium 2>/dev/null || true
pkill -f chrome 2>/dev/null || true
rm -f /tmp/.com.google.Chrome.* /tmp/chrome_* 2>/dev/null || true
rm -rf /tmp/playwright-* /root/.config/chromium /root/.config/google-chrome 2>/dev/null || true

BROWSER_MODE=${BROWSER_MODE:-headless}
MCP_PORT=${MCP_PORT:-3000}
MCP_INTERNAL_PORT=3001
NOVNC_PORT=${NOVNC_PORT:-6080}
HEALTH_PORT=${HEALTH_PORT:-8080}
DISPLAY_NUM=${DISPLAY_NUM:-99}
DISPLAY=:${DISPLAY_NUM}

echo "========================================"
echo "  Playwright MCP Server"
echo "  Mode        : ${BROWSER_MODE}"
echo "  MCP Port    : ${MCP_PORT}"
echo "  Health Port : ${HEALTH_PORT}"
if [ "$BROWSER_MODE" = "headed" ]; then
echo "  noVNC       : ${NOVNC_PORT}"
fi
echo "========================================"

# ── Health check server (port 8080) — used by ALB ────────────────────────
# Runs in background, responds 200 OK to any request
node -e "
  require('http').createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('ok');
  }).listen(${HEALTH_PORT}, () => console.log('Health server listening on port ${HEALTH_PORT}'));
" &

# ── Host-rewriting proxy (port 3000 external → port 3001 internal) ────────
# playwright-mcp rejects connections whose Host header != localhost.
# This proxy accepts external ALB traffic and rewrites Host before forwarding.
node -e "
  const http = require('http');
  const INTERNAL = ${MCP_INTERNAL_PORT};
  http.createServer((req, res) => {
    const opts = {
      hostname: 'localhost',
      port: INTERNAL,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: 'localhost:' + INTERNAL }
    };
    const proxy = http.request(opts, (upstream) => {
      res.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(res);
      // Forward upstream close back to client
      upstream.on('close', () => res.end());
    });
    proxy.on('error', (e) => { res.writeHead(502); res.end(e.message); });
    // When client disconnects, immediately close upstream so playwright-mcp
    // receives the close signal and tears down the browser context.
    req.on('close', () => proxy.destroy());
    req.pipe(proxy);
  }).listen(${MCP_PORT}, '0.0.0.0', () => console.log('Proxy listening on 0.0.0.0:${MCP_PORT} → localhost:' + INTERNAL));
" &

if [ "$BROWSER_MODE" = "headed" ]; then

    echo "[headed] Starting Xvfb virtual display on :${DISPLAY_NUM}..."
    Xvfb :${DISPLAY_NUM} -screen 0 1280x800x24 -ac +extension GLX +render -noreset &
    XVFB_PID=$!
    export DISPLAY=:${DISPLAY_NUM}

    # Wait for Xvfb to be ready
    sleep 2

    echo "[headed] Starting x11vnc VNC server..."
    x11vnc \
        -display :${DISPLAY_NUM} \
        -nopw \
        -forever \
        -shared \
        -quiet \
        -bg \
        -rfbport 5900

    echo "[headed] Starting noVNC web viewer on port ${NOVNC_PORT}..."
    websockify \
        --web=/usr/share/novnc \
        --daemon \
        ${NOVNC_PORT} \
        localhost:5900

    echo "[headed] noVNC ready — open http://<HOST>:${NOVNC_PORT}/vnc.html to watch the browser"

    echo "[headed] Starting Playwright MCP server on internal port ${MCP_INTERNAL_PORT}..."
    exec npx @playwright/mcp \
        --port ${MCP_INTERNAL_PORT} \
        --browser chromium \
        --isolated

else

    echo "[headless] Starting Playwright MCP server on internal port ${MCP_INTERNAL_PORT}..."
    exec npx @playwright/mcp \
        --port ${MCP_INTERNAL_PORT} \
        --browser chromium \
        --headless \
        --isolated

fi
