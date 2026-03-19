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

BROWSER_MODE=${BROWSER_MODE:-headless}
MCP_PORT=${MCP_PORT:-3000}
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

    echo "[headed] Starting Playwright MCP server on port ${MCP_PORT}..."
    exec npx @playwright/mcp \
        --port ${MCP_PORT} \
        --host 0.0.0.0 \
        --allowed-origins "*" \
        --browser chromium

else

    echo "[headless] Starting Playwright MCP server on port ${MCP_PORT}..."
    exec npx @playwright/mcp \
        --port ${MCP_PORT} \
        --host 0.0.0.0 \
        --allowed-origins "*" \
        --browser chromium \
        --headless

fi
