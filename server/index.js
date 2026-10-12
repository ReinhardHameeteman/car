import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getSchedule,
  getSmartChargingMode,
  PEBLAR_MODES,
  setSchedule,
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
    timeout: 20_000,
    proxyTimeout: 20_000,
    onProxyReq(proxyReq, req) {
      const key = req.headers['x-api-key']
      if (key) proxyReq.setHeader('X-API-Key', key)
    },
  }),
)

app.use(
  '/api/energy',
  createProxyMiddleware({
    target: 'https://epexprijzen.nl',
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

/** @type {{ host: string, password: string, previousMode: string, previousSchedule?: unknown, restoreAt: string, timer?: NodeJS.Timeout } | null} */
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
      previousSchedule: raw.previousSchedule ?? null,
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
  const { host, password, previousMode, previousSchedule, restoreAt } = pendingRestore
  fs.writeFileSync(
    restoreFile,
    JSON.stringify({ host, password, previousMode, previousSchedule, restoreAt }, null, 2),
    'utf8',
  )
}

async function runRestore() {
  if (!pendingRestore) return
  const job = pendingRestore
  pendingRestore = null
  persistPending()
  try {
    if (job.previousSchedule) {
      await setSchedule(job.host, job.password, job.previousSchedule)
    }
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
      try {
        await verifyApiToken(host, token)
      } catch (tokenErr) {
        console.warn('Peblar API token check skipped:', tokenErr)
      }
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

app.post('/api/peblar/apply-schedule', async (req, res) => {
  try {
    const { host, password, token } = peblarCreds(req)
    const restoreAt = String(req.body?.restoreAt || '').trim()
    const schedule = req.body?.schedule
    if (!host || !password) {
      res.status(400).json({ error: 'Peblar host and web password are required.' })
      return
    }
    if (!schedule || typeof schedule !== 'object') {
      res.status(400).json({ error: 'schedule body is required.' })
      return
    }
    if (!restoreAt || Number.isNaN(new Date(restoreAt).getTime())) {
      res.status(400).json({ error: 'restoreAt must be a valid ISO datetime.' })
      return
    }
    // Schedule uses web-password auth. Token check is optional — some firmwares
    // 404 on /api/wlac even when the web UI API works.
    if (token) {
      try {
        await verifyApiToken(host, token)
      } catch (tokenErr) {
        console.warn('Peblar API token check skipped:', tokenErr)
      }
    }

    const previousMode = await getSmartChargingMode(host, password)
    const previousSchedule = await getSchedule(host, password)
    await setSchedule(host, password, schedule)
    await setSmartChargingMode(host, password, 'scheduled')

    if (pendingRestore?.timer) clearTimeout(pendingRestore.timer)
    pendingRestore = { host, password, previousMode, previousSchedule, restoreAt }
    persistPending()
    schedulePendingRestore()

    res.json({ previousMode, activeMode: 'scheduled', restoreAt })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Peblar apply-schedule failed:', message)
    res.status(502).json({ error: message })
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

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() })
})

app.use(express.static(dist))
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(dist, 'index.html'), (err) => {
    if (err) res.status(404).send('Build the app first with npm run build')
  })
})

loadPendingFromDisk()

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Enyaq Charge server on http://0.0.0.0:${port} (reachable on your LAN IP)`)
})
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Stop the other process, then run npm run dev again.`)
  } else {
    console.error(err)
  }
  process.exit(1)
})

