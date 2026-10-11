import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getSmartChargingMode,
  PEBLAR_MODES,
  setSmartChargingMode,
  verifyApiToken,
} from './peblar.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist')
const restoreFile = path.join(root, 'data', 'peblar-restore.json')
const port = Number(process.env.PORT || 8787)

const app = express()
app.use(express.json({ limit: '256kb' }))

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-API-Key, X-Peblar-Host, X-Peblar-Password, X-Peblar-Token',
  )
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,OPTIONS')
  if (req.method === 'OPTIONS') {
    res.sendStatus(204)
    return
  }
  next()
})

app.use(
  '/api/skoda',
  createProxyMiddleware({
    target: 'https://public.api.connect.skoda-auto.cz',
    changeOrigin: true,
    pathRewrite: { '^/api/skoda': '' },
    onProxyReq(proxyReq, req) {
      const key = req.headers['x-api-key']
      if (key) proxyReq.setHeader('X-API-Key', key)
    },
  }),
)

app.use(
  '/api/energy',
  createProxyMiddleware({
    target: 'https://api.energyzero.nl',
    changeOrigin: true,
    pathRewrite: { '^/api/energy': '' },
  }),
)

app.use(
  '/api/meteo',
  createProxyMiddleware({
    target: 'https://api.open-meteo.com',
    changeOrigin: true,
    pathRewrite: { '^/api/meteo': '' },
  }),
)

/** @type {{ host: string, password: string, previousMode: string, restoreAt: string, timer?: NodeJS.Timeout } | null} */
let pendingRestore = null

function ensureDataDir() {
  fs.mkdirSync(path.dirname(restoreFile), { recursive: true })
}

function loadPendingFromDisk() {
  try {
    if (!fs.existsSync(restoreFile)) return
    const raw = JSON.parse(fs.readFileSync(restoreFile, 'utf8'))
    if (!raw?.host || !raw?.password || !raw?.previousMode || !raw?.restoreAt) return
    pendingRestore = {
      host: raw.host,
      password: raw.password,
      previousMode: raw.previousMode,
      restoreAt: raw.restoreAt,
    }
    schedulePendingRestore()
  } catch (err) {
    console.warn('Could not load Peblar restore job:', err)
  }
}

function persistPending() {
  ensureDataDir()
  if (!pendingRestore) {
    if (fs.existsSync(restoreFile)) fs.unlinkSync(restoreFile)
    return
  }
  const { host, password, previousMode, restoreAt } = pendingRestore
  fs.writeFileSync(
    restoreFile,
    JSON.stringify({ host, password, previousMode, restoreAt }, null, 2),
    'utf8',
  )
}

async function runRestore() {
  if (!pendingRestore) return
  const job = pendingRestore
  pendingRestore = null
  persistPending()
  try {
    await setSmartChargingMode(job.host, job.password, /** @type {any} */ (job.previousMode))
    console.log(`Peblar mode restored to ${job.previousMode}`)
  } catch (err) {
    console.error('Peblar restore failed:', err)
    // Keep a failed job so the client can retry.
    pendingRestore = job
    persistPending()
  }
}

function schedulePendingRestore() {
  if (!pendingRestore) return
  if (pendingRestore.timer) clearTimeout(pendingRestore.timer)
  const delay = new Date(pendingRestore.restoreAt).getTime() - Date.now()
  if (delay <= 0) {
    void runRestore()
    return
  }
  pendingRestore.timer = setTimeout(() => {
    void runRestore()
  }, delay)
  console.log(`Peblar restore to ${pendingRestore.previousMode} scheduled at ${pendingRestore.restoreAt}`)
}

function peblarCreds(req) {
  const host = String(req.headers['x-peblar-host'] || req.body?.host || '').trim()
  const password = String(req.headers['x-peblar-password'] || req.body?.password || '').trim()
  const token = String(req.headers['x-peblar-token'] || req.body?.apiToken || '').trim()
  return { host, password, token }
}

app.get('/api/peblar/mode', async (req, res) => {
  try {
    const { host, password } = peblarCreds(req)
    if (!host || !password) {
      res.status(400).json({ error: 'Peblar host and web password are required.' })
      return
    }
    const mode = await getSmartChargingMode(host, password)
    res.json({ mode })
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.put('/api/peblar/mode', async (req, res) => {
  try {
    const { host, password } = peblarCreds(req)
    const mode = String(req.body?.mode || '').trim()
    if (!host || !password) {
      res.status(400).json({ error: 'Peblar host and web password are required.' })
      return
    }
    if (!PEBLAR_MODES.includes(/** @type {any} */ (mode))) {
      res.status(400).json({ error: `Invalid mode. Use one of: ${PEBLAR_MODES.join(', ')}` })
      return
    }
    await setSmartChargingMode(host, password, /** @type {any} */ (mode))
    res.json({ mode })
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/peblar/verify-token', async (req, res) => {
  try {
    const { host, token } = peblarCreds(req)
    if (!host || !token) {
      res.status(400).json({ error: 'Peblar host and API token are required.' })
      return
    }
    const system = await verifyApiToken(host, token)
    res.json({ ok: true, system })
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/peblar/prepare', async (req, res) => {
  try {
    const { host, password, token } = peblarCreds(req)
    const restoreAt = String(req.body?.restoreAt || '').trim()
    if (!host || !password) {
      res.status(400).json({ error: 'Peblar host and web password are required.' })
      return
    }
    if (!restoreAt || Number.isNaN(new Date(restoreAt).getTime())) {
      res.status(400).json({ error: 'restoreAt must be a valid ISO datetime.' })
      return
    }
    if (token) {
      await verifyApiToken(host, token)
    }

    const previousMode = await getSmartChargingMode(host, password)
    if (previousMode !== 'default') {
      await setSmartChargingMode(host, password, 'default')
    }

    if (pendingRestore?.timer) clearTimeout(pendingRestore.timer)
    pendingRestore = { host, password, previousMode, restoreAt }
    persistPending()
    schedulePendingRestore()

    res.json({ previousMode, activeMode: 'default', restoreAt })
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.get('/api/peblar/restore-status', (_req, res) => {
  if (!pendingRestore) {
    res.json({ pending: false })
    return
  }
  res.json({
    pending: true,
    previousMode: pendingRestore.previousMode,
    restoreAt: pendingRestore.restoreAt,
    host: pendingRestore.host,
  })
})

app.post('/api/peblar/restore-now', async (_req, res) => {
  try {
    if (!pendingRestore) {
      res.json({ restored: false, reason: 'No pending restore.' })
      return
    }
    await runRestore()
    res.json({ restored: !pendingRestore })
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.use(express.static(dist))
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(dist, 'index.html'), (err) => {
    if (err) res.status(404).send('Build the app first with npm run build')
  })
})

loadPendingFromDisk()

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() })
})

app.listen(port, '0.0.0.0', () => {
  console.log(`Enyaq Charge server on http://0.0.0.0:${port} (reachable on your LAN IP)`)
})
