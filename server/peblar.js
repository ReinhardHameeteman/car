/**
 * Peblar smart-charging helpers.
 * Mode changes use the charger web API (/api/v1/config/user) after password login.
 * The local REST API token (WLAC) cannot change smart charging mode by itself.
 */

import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'

export const PEBLAR_MODES = /** @type {const} */ ([
  'default',
  'fast_solar',
  'smart_solar',
  'pure_solar',
  'scheduled',
])

/**
 * @typedef {'default' | 'fast_solar' | 'smart_solar' | 'pure_solar' | 'scheduled'} PeblarMode
 */

/**
 * @param {string} host
 */
function origin(host) {
  const cleaned = host.replace(/^https?:\/\//, '').replace(/\/$/, '')
  return `http://${cleaned}`
}

/**
 * @param {string} urlString
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} options
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>}
 */
function request(urlString, options = {}) {
  const url = new URL(urlString)
  const lib = url.protocol === 'https:' ? https : http
  const body = options.body

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: options.method || 'GET',
        headers: {
          ...(options.headers || {}),
          ...(body
            ? { 'Content-Length': Buffer.byteLength(body) }
            : {}),
        },
        timeout: 10000,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Peblar request timed out'))
    })
    if (body) req.write(body)
    req.end()
  })
}

/**
 * @param {http.IncomingHttpHeaders} headers
 */
function cookieFromHeaders(headers) {
  const raw = headers['set-cookie']
  if (!raw) return ''
  const list = Array.isArray(raw) ? raw : [raw]
  return list.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ')
}

/**
 * @param {unknown} body
 * @returns {PeblarMode}
 */
export function modeFromUserConfig(body) {
  if (!body || typeof body !== 'object') return 'default'
  const cfg = /** @type {Record<string, unknown>} */ (body)
  if (cfg.ScheduledChargingEnable === true) return 'scheduled'
  if (cfg.SolarChargingEnable === true) {
    const solar = cfg.SolarChargingMode
    if (solar === 'MaxSolar') return 'fast_solar'
    if (solar === 'OptimizedSolar') return 'smart_solar'
    if (solar === 'PureSolar') return 'pure_solar'
  }
  return 'default'
}

/**
 * @param {PeblarMode} mode
 */
export function patchBodyForMode(mode) {
  if (mode === 'scheduled') {
    return { ScheduledChargingEnable: true, SolarChargingEnable: false }
  }
  if (mode === 'fast_solar') {
    return {
      ScheduledChargingEnable: false,
      SolarChargingEnable: true,
      SolarChargingMode: 'MaxSolar',
    }
  }
  if (mode === 'smart_solar') {
    return {
      ScheduledChargingEnable: false,
      SolarChargingEnable: true,
      SolarChargingMode: 'OptimizedSolar',
    }
  }
  if (mode === 'pure_solar') {
    return {
      ScheduledChargingEnable: false,
      SolarChargingEnable: true,
      SolarChargingMode: 'PureSolar',
    }
  }
  return { ScheduledChargingEnable: false, SolarChargingEnable: false }
}

/**
 * @param {string} host
 * @param {string} password
 */
export async function peblarLogin(host, password) {
  const res = await request(`${origin(host)}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ Password: password, PersistentSession: true }),
  })
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Peblar login failed (${res.status}): ${res.body || res.status}`)
  }
  const cookie = cookieFromHeaders(res.headers)
  if (!cookie) {
    throw new Error('Peblar login succeeded but no session cookie was returned.')
  }
  return cookie
}

/**
 * @param {string} host
 * @param {string} cookie
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 */
async function peblarRequest(host, cookie, method, path, body) {
  const res = await request(`${origin(host)}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  })
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Peblar ${method} ${path} failed (${res.status}): ${res.body || res.status}`)
  }
  return res.body ? JSON.parse(res.body) : null
}

/**
 * @param {string} host
 * @param {string} password
 * @returns {Promise<PeblarMode>}
 */
export async function getSmartChargingMode(host, password) {
  const cookie = await peblarLogin(host, password)
  const config = await peblarRequest(host, cookie, 'GET', '/api/v1/config/user')
  return modeFromUserConfig(config)
}

/**
 * @param {string} host
 * @param {string} password
 * @param {PeblarMode} mode
 */
export async function setSmartChargingMode(host, password, mode) {
  const cookie = await peblarLogin(host, password)
  await peblarRequest(host, cookie, 'PATCH', '/api/v1/config/user', patchBodyForMode(mode))
  return mode
}

/**
 * @param {string} host
 * @param {string} apiToken
 */
export async function verifyApiToken(host, apiToken) {
  const res = await request(`${origin(host)}/api/wlac/v1/system`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: apiToken,
    },
  })
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Peblar API token check failed (${res.status}): ${res.body || res.status}`)
  }
  return res.body ? JSON.parse(res.body) : null
}

/**
 * @param {string} host
 * @param {string} password
 */
export async function getSchedule(host, password) {
  const cookie = await peblarLogin(host, password)
  return peblarRequest(host, cookie, 'GET', '/api/v1/config/scheduledcharging/schedules')
}

/**
 * @param {string} host
 * @param {string} password
 * @param {unknown} schedule
 */
export async function setSchedule(host, password, schedule) {
  const cookie = await peblarLogin(host, password)
  await peblarRequest(host, cookie, 'POST', '/api/v1/config/scheduledcharging/schedules', schedule)
  return schedule
}
