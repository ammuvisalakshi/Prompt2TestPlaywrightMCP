/**
 * CDP Screencast Proxy — streams live browser frames via WebSocket.
 *
 * Serves a self-contained viewer HTML page on HTTP GET requests,
 * and streams CDP screencast frames on WebSocket connections.
 * Navigate to https://{sslip_domain}/ to see the live browser.
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

// ── Viewer HTML — served on HTTP GET ────────────────────────────────────

const VIEWER_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Prompt2Test — Live Browser</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0f172a;display:flex;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,sans-serif;color:#e2e8f0}
#status{position:absolute;top:12px;left:50%;transform:translateX(-50%);font-size:13px;color:#94a3b8;z-index:1}
canvas{max-width:100vw;max-height:100vh;border-radius:4px;cursor:default}</style></head>
<body><div id="status">Connecting to browser...</div><canvas id="c" width="1280" height="720"></canvas>
<script>
var wsProto=location.protocol==="https:"?"wss:":"ws:";
var wsUrl=wsProto+"//"+location.host;
var canvas=document.getElementById("c"),ctx=canvas.getContext("2d"),status=document.getElementById("status");
var ws,retries=0,maxRetries=30;
function connect(){
  status.textContent="Connecting... (attempt "+(retries+1)+")";status.style.opacity="1";
  ws=new WebSocket(wsUrl);ws.binaryType="arraybuffer";
  ws.onopen=function(){ws.send(JSON.stringify({quality:65,maxWidth:1280,maxHeight:720}))};
  ws.onmessage=function(e){
    if(typeof e.data==="string"){try{var m=JSON.parse(e.data);if(m.event==="connected"){status.textContent="Connected — watching live";setTimeout(function(){status.style.opacity="0.3"},2000)}else if(m.event==="error"){status.textContent="Error: "+m.message}}catch(x){}}
    else{var blob=new Blob([e.data],{type:"image/jpeg"});var url=URL.createObjectURL(blob);var img=new Image();img.onload=function(){ctx.drawImage(img,0,0,1280,720);URL.revokeObjectURL(url)};img.src=url}
  };
  ws.onerror=function(){};
  ws.onclose=function(){retries++;if(retries<maxRetries){status.textContent="Reconnecting in 3s... (attempt "+(retries+1)+")";status.style.opacity="1";setTimeout(connect,3000)}else{status.textContent="Browser session ended"}};
}
connect();
canvas.onmousedown=function(e){var r=canvas.getBoundingClientRect();ws&&ws.readyState===1&&ws.send(JSON.stringify({type:"mousePressed",x:Math.round((e.clientX-r.left)*(1280/r.width)),y:Math.round((e.clientY-r.top)*(720/r.height)),button:"left",clickCount:1}))};
canvas.onmouseup=function(e){var r=canvas.getBoundingClientRect();ws&&ws.readyState===1&&ws.send(JSON.stringify({type:"mouseReleased",x:Math.round((e.clientX-r.left)*(1280/r.width)),y:Math.round((e.clientY-r.top)*(720/r.height)),button:"left",clickCount:1}))};
canvas.onmousemove=function(e){var r=canvas.getBoundingClientRect();ws&&ws.readyState===1&&ws.send(JSON.stringify({type:"mouseMoved",x:Math.round((e.clientX-r.left)*(1280/r.width)),y:Math.round((e.clientY-r.top)*(720/r.height))}))};
</script></body></html>`

// ── HTTP server (serves viewer HTML) + WebSocket server ─────────────────

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' })
  res.end(VIEWER_HTML)
})

const wss = new WebSocketServer({ server })
console.log(`[cdp-proxy] Starting on port ${PROXY_PORT}`)

server.listen(PROXY_PORT, () => {
  console.log(`[cdp-proxy] Listening on port ${PROXY_PORT} (HTTP viewer + WebSocket screencast)`)
})

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

// ── WebSocket handler ───────────────────────────────────────────────────

wss.on('connection', async (clientWs) => {
  console.log('[cdp-proxy] Client connected')
  let cdpWs = null
  let msgId = 0

  try {
    // Wait for config message from client
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
          const buf = Buffer.from(frame.data, 'base64')
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(buf)
          }
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
      if (str[0] !== '{') return

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
