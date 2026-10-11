import type { AppSettings } from '../types'
import { isNativeApp, peblarOrigin } from './apiBase'

export type PeblarSmartChargingMode =
  | 'default'
  | 'fast_solar'
  | 'smart_solar'
  | 'pure_solar'
  | 'scheduled'

const RESTORE_KEY = 'enyaq-peblar-restore'

export function isPeblarConfigured(settings: AppSettings): boolean {
  return (
    settings.peblarHost.trim().length > 0 &&
    settings.peblarApiToken.trim().length > 0 &&
    settings.peblarPassword.trim().length > 0
  )
}

function peblarProxyHeaders(settings: AppSettings): HeadersInit {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Peblar-Host': settings.peblarHost.trim(),
    'X-Peblar-Password': settings.peblarPassword.trim(),
    'X-Peblar-Token': settings.peblarApiToken.trim(),
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json()
    return body.error || JSON.stringify(body)
  } catch {
    return response.statusText
  }
}

function modeFromUserConfig(body: Record<string, unknown> | null): PeblarSmartChargingMode {
  if (!body) return 'default'
  if (body.ScheduledChargingEnable === true) return 'scheduled'
  if (body.SolarChargingEnable === true) {
    const solar = body.SolarChargingMode
    if (solar === 'MaxSolar') return 'fast_solar'
    if (solar === 'OptimizedSolar') return 'smart_solar'
    if (solar === 'PureSolar') return 'pure_solar'
  }
  return 'default'
}

function patchBodyForMode(mode: PeblarSmartChargingMode): Record<string, unknown> {
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

function cookieFromResponse(response: Response): string {
  // CapacitorHttp may expose set-cookie; browsers often hide it.
  const anyHeaders = response.headers as Headers & { getSetCookie?: () => string[] }
  if (typeof anyHeaders.getSetCookie === 'function') {
    const list = anyHeaders.getSetCookie()
    if (list?.length) return list.map((c) => c.split(';')[0].trim()).join('; ')
  }
  const raw = response.headers.get('set-cookie')
  if (!raw) return ''
  return raw
    .split(/,(?=[^;]+?=)/)
    .map((c) => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ')
}

async function peblarLogin(host: string, password: string): Promise<string> {
  const response = await fetch(`${peblarOrigin(host)}/api/v1/auth/login`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ Password: password, PersistentSession: true }),
  })
  if (!response.ok) {
    throw new Error(`Peblar login failed (${response.status}): ${await response.text()}`)
  }
  const cookie = cookieFromResponse(response)
  if (!cookie) {
    throw new Error(
      'Peblar login succeeded but no session cookie was returned. CapacitorHttp is required for Peblar on Android.',
    )
  }
  return cookie
}

async function peblarRequest(
  host: string,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${peblarOrigin(host)}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Peblar ${method} ${path} failed (${response.status}): ${text}`)
  }
  return text ? (JSON.parse(text) as Record<string, unknown>) : null
}

async function getSmartChargingModeNative(
  host: string,
  password: string,
): Promise<PeblarSmartChargingMode> {
  const cookie = await peblarLogin(host, password)
  const config = await peblarRequest(host, cookie, 'GET', '/api/v1/config/user')
  return modeFromUserConfig(config)
}

async function setSmartChargingModeNative(
  host: string,
  password: string,
  mode: PeblarSmartChargingMode,
): Promise<void> {
  const cookie = await peblarLogin(host, password)
  await peblarRequest(host, cookie, 'PATCH', '/api/v1/config/user', patchBodyForMode(mode))
}

async function verifyApiTokenNative(host: string, apiToken: string): Promise<void> {
  const response = await fetch(`${peblarOrigin(host)}/api/wlac/v1/system`, {
    headers: { Accept: 'application/json', Authorization: apiToken },
  })
  if (!response.ok) {
    throw new Error(`Peblar API token check failed (${response.status}): ${await response.text()}`)
  }
}

interface PendingRestore {
  host: string
  password: string
  previousMode: PeblarSmartChargingMode
  restoreAt: string
}

function savePendingRestore(job: PendingRestore) {
  localStorage.setItem(RESTORE_KEY, JSON.stringify(job))
}

function loadPendingRestore(): PendingRestore | null {
  try {
    const raw = localStorage.getItem(RESTORE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as PendingRestore
  } catch {
    return null
  }
}

function clearPendingRestore() {
  localStorage.removeItem(RESTORE_KEY)
}

/** Switch Peblar to default mode and schedule restoring the previous mode. */
export async function preparePeblarForProfileCharging(
  settings: AppSettings,
  restoreAt: Date,
): Promise<{ previousMode: PeblarSmartChargingMode; restoreAt: string }> {
  if (isNativeApp()) {
    const host = settings.peblarHost.trim()
    const password = settings.peblarPassword.trim()
    const token = settings.peblarApiToken.trim()
    await verifyApiTokenNative(host, token)
    const previousMode = await getSmartChargingModeNative(host, password)
    if (previousMode !== 'default') {
      await setSmartChargingModeNative(host, password, 'default')
    }
    savePendingRestore({
      host,
      password,
      previousMode,
      restoreAt: restoreAt.toISOString(),
    })
    schedulePeblarRestoreCheck()
    return { previousMode, restoreAt: restoreAt.toISOString() }
  }

  const response = await fetch('/api/peblar/prepare', {
    method: 'POST',
    headers: peblarProxyHeaders(settings),
    body: JSON.stringify({
      host: settings.peblarHost.trim(),
      password: settings.peblarPassword.trim(),
      apiToken: settings.peblarApiToken.trim(),
      restoreAt: restoreAt.toISOString(),
    }),
  })
  if (!response.ok) {
    throw new Error(await readError(response))
  }
  return response.json()
}

export async function getPeblarRestoreStatus(): Promise<{
  pending: boolean
  previousMode?: PeblarSmartChargingMode
  restoreAt?: string
}> {
  if (isNativeApp()) {
    const job = loadPendingRestore()
    if (!job) return { pending: false }
    return { pending: true, previousMode: job.previousMode, restoreAt: job.restoreAt }
  }

  const response = await fetch('/api/peblar/restore-status')
  if (!response.ok) {
    throw new Error(await readError(response))
  }
  return response.json()
}

/** Run due Peblar restores (native: localStorage job; checked on launch / timer). */
export async function runDuePeblarRestore(): Promise<boolean> {
  if (!isNativeApp()) return false
  const job = loadPendingRestore()
  if (!job) return false
  if (new Date(job.restoreAt).getTime() > Date.now()) return false
  await setSmartChargingModeNative(job.host, job.password, job.previousMode)
  clearPendingRestore()
  return true
}

let restoreTimer: ReturnType<typeof setTimeout> | null = null

export function schedulePeblarRestoreCheck() {
  if (!isNativeApp()) return
  if (restoreTimer) clearTimeout(restoreTimer)
  const job = loadPendingRestore()
  if (!job) return
  const delay = Math.max(0, new Date(job.restoreAt).getTime() - Date.now())
  restoreTimer = setTimeout(() => {
    void runDuePeblarRestore().catch(() => {
      // Retry on next app open.
    })
  }, delay)
}
