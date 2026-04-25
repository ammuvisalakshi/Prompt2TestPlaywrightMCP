/**
 * CDP Screencast Proxy — streams live browser frames via WebSocket.
 *
 * Replaces noVNC + Xvfb + x11vnc with a single lightweight process.
 * Connects to Chrome's DevTools Protocol on localhost:9222, runs
 * Page.startScreencast, and forwards JPEG frames to browser clients.
 *
 * Also forwards mouse/keyboard input from clients back to Chrome.
 *
 * Usage:
 *   CDP_PORT=9222 PROXY_PORT=6080 node cdp-proxy.mjs
 */

import { WebSocketServer, WebSocket } from 'ws'
import http from 'http'

const CDP_PORT   = parseInt(process.env.CDP_PORT   || '9222', 10)
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '6080', 10)
const QUALITY    = parseInt(process.env.CDP_QUALITY || '60', 10)
const MAX_WIDTH  = parseInt(process.env.CDP_MAX_WIDTH || '1280', 10)
const MAX_HEIGHT = parseInt(process.env.CDP_MAX_HEIGHT || '720', 10)

// ── Get Chrome page target's WS URL ─────────────────────────────────────

async function getPageWsUrl() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json`, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const targets = JSON.parse(data)
          const page = targets.find(t => t.type === 'page')
          if (page && page.webSocketDebuggerUrl) {
            resolve(page.webSocketDebuggerUrl)
          } else {
            reject(new Error('No page target found'))
          }
        } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

// ── Wait for CDP to be available ────────────────────────────────────────

async function waitForCdp(maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const url = await getPageWsUrl()
      console.log(`[cdp-proxy] Chrome CDP ready: ${url}`)
      return url
    } catch {
      await new Promise(r => setTimeout(r, 1000))
    }
  }
  throw new Error(`Chrome CDP not available on port ${CDP_PORT} after ${maxAttempts}s`)
}

// ── WebSocket server for UI clients ─────────────────────────────────────

const wss = new WebSocketServer({ port: PROXY_PORT })
console.log(`[cdp-proxy] Listening on port ${PROXY_PORT}`)

wss.on('connection', async (clientWs) => {
  console.log('[cdp-proxy] Client connected')
  let cdpWs = null
  let msgId = 0

  try {
    // Wait for config message from client (optional — can connect immediately)
    const config = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({}), 2000)
      clientWs.once('message', (data) => {
        clearTimeout(timeout)
        try { resolve(JSON.parse(data.toString())) } catch { resolve({}) }
      })
    })

    const quality  = config.quality   || QUALITY
    const maxWidth = config.maxWidth  || MAX_WIDTH
    const maxHeight = config.maxHeight || MAX_HEIGHT

    // Connect to Chrome CDP
    const wsUrl = await getPageWsUrl()
    cdpWs = new WebSocket(wsUrl, { maxPayload: 10 * 1024 * 1024 })

    await new Promise((resolve, reject) => {
      cdpWs.on('open', resolve)
      cdpWs.on('error', reject)
    })

    // Start screencast
    cdpWs.send(JSON.stringify({
      id: ++msgId,
      method: 'Page.startScreencast',
      params: { format: 'jpeg', quality, maxWidth, maxHeight },
    }))

    clientWs.send(JSON.stringify({ event: 'connected' }))
    console.log(`[cdp-proxy] Screencast started (${maxWidth}x${maxHeight} q=${quality})`)

    // Forward frames: CDP → client
    cdpWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.method === 'Page.screencastFrame') {
          const frame = msg.params
          // Send binary JPEG to client
          const buf = Buffer.from(frame.data, 'base64')
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(buf)
          }
          // Ack frame
          cdpWs.send(JSON.stringify({
            id: ++msgId,
            method: 'Page.screencastFrameAck',
            params: { sessionId: frame.sessionId },
          }))
        }
      } catch { /* ignore parse errors */ }
    })

    // Forward input events: client → CDP
    clientWs.on('message', (data) => {
      if (typeof data !== 'string' && !(data instanceof Buffer)) return
      const str = data.toString()
      if (str[0] !== '{') return // skip binary, only process JSON

      try {
        const ev = JSON.parse(str)
        const type = ev.type
        if (!type) return

        if (['mouseMoved', 'mousePressed', 'mouseReleased'].includes(type)) {
          cdpWs.send(JSON.stringify({
            id: ++msgId,
            method: 'Input.dispatchMouseEvent',
            params: {
              type, x: ev.x || 0, y: ev.y || 0,
              button: ev.button || 'left', clickCount: ev.clickCount || 1,
            },
          }))
        } else if (type === 'mouseWheel') {
          cdpWs.send(JSON.stringify({
            id: ++msgId,
            method: 'Input.dispatchMouseEvent',
            params: {
              type: 'mouseWheel', x: ev.x || 0, y: ev.y || 0,
              deltaX: ev.deltaX || 0, deltaY: ev.deltaY || 0,
            },
          }))
        } else if (['keyDown', 'keyUp', 'char'].includes(type)) {
          cdpWs.send(JSON.stringify({
            id: ++msgId,
            method: 'Input.dispatchKeyEvent',
            params: { type, key: ev.key || '', text: ev.text || '', code: ev.code || '' },
          }))
        }
      } catch { /* ignore */ }
    })

    // Handle disconnections
    const cleanup = () => {
      if (cdpWs && cdpWs.readyState === WebSocket.OPEN) {
        cdpWs.send(JSON.stringify({ id: ++msgId, method: 'Page.stopScreencast' }))
        cdpWs.close()
      }
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close()
      console.log('[cdp-proxy] Session ended')
    }

    clientWs.on('close', cleanup)
    clientWs.on('error', cleanup)
    cdpWs.on('close', () => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ event: 'error', message: 'Chrome disconnected' }))
        clientWs.close()
      }
    })

  } catch (err) {
    console.error(`[cdp-proxy] Error: ${err.message}`)
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ event: 'error', message: err.message }))
      clientWs.close()
    }
    if (cdpWs && cdpWs.readyState === WebSocket.OPEN) cdpWs.close()
  }
})
