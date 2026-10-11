import type { AppSettings, ChargeWindow } from '../types'
import { isNativeApp, peblarOrigin } from './apiBase'

export type PeblarSmartChargingMode =
  | 'default'
  | 'fast_solar'
  | 'smart_solar'
  | 'pure_solar'
  | 'scheduled'

export interface PeblarScheduleSlot {
  CurrentLimit: number
  StartTime: number
}

export type PeblarWeekSchedule = {
  Monday: PeblarScheduleSlot[]
  Tuesday: PeblarScheduleSlot[]
  Wednesday: PeblarScheduleSlot[]
  Thursday: PeblarScheduleSlot[]
  Friday: PeblarScheduleSlot[]
  Saturday: PeblarScheduleSlot[]
  Sunday: PeblarScheduleSlot[]
}

const RESTORE_KEY = 'enyaq-peblar-restore'
const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

type DayName = (typeof DAY_NAMES)[number]

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

function chargeCurrentAmps(chargePowerKw: number): number {
  const phases = chargePowerKw >= 7 ? 3 : 1
  return Math.max(6, Math.min(32, Math.round((chargePowerKw * 1000) / (230 * phases))))
}

function emptyDay(): PeblarScheduleSlot[] {
  return [{ CurrentLimit: 0, StartTime: 0 }]
}

export function emptyWeekSchedule(): PeblarWeekSchedule {
  return {
    Monday: emptyDay(),
    Tuesday: emptyDay(),
    Wednesday: emptyDay(),
    Thursday: emptyDay(),
    Friday: emptyDay(),
    Saturday: emptyDay(),
    Sunday: emptyDay(),
  }
}

function minutesSinceMidnight(d: Date): number {
  return d.getHours() * 60 + d.getMinutes()
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Convert optimized charge windows into a weekly Peblar schedule (recurring). */
export function buildPeblarScheduleFromWindows(
  windows: ChargeWindow[],
  chargePowerKw: number,
): PeblarWeekSchedule {
  const amps = chargeCurrentAmps(chargePowerKw)
  const byDay = new Map<DayName, { start: number; end: number }[]>()

  for (const window of windows) {
    let cursor = new Date(window.start)
    const end = new Date(window.end)
    while (cursor < end) {
      const dayStart = startOfLocalDay(cursor)
      const nextDay = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)
      const segmentEnd = end < nextDay ? end : nextDay
      const dayName = DAY_NAMES[cursor.getDay()] as DayName
      const list = byDay.get(dayName) ?? []
      list.push({
        start: minutesSinceMidnight(cursor),
        end: segmentEnd.getTime() === nextDay.getTime() ? 24 * 60 : minutesSinceMidnight(segmentEnd),
      })
      byDay.set(dayName, list)
      cursor = nextDay
    }
  }

  const week = emptyWeekSchedule()
  for (const dayName of Object.keys(week) as (keyof PeblarWeekSchedule)[]) {
    const segments = byDay.get(dayName as DayName)
    if (!segments?.length) continue

    segments.sort((a, b) => a.start - b.start)
    const events: { t: number; amps: number }[] = [{ t: 0, amps: 0 }]
    for (const seg of segments) {
      if (seg.start >= seg.end) continue
      events.push({ t: seg.start, amps })
      if (seg.end < 24 * 60) events.push({ t: seg.end, amps: 0 })
    }
    events.sort((a, b) => a.t - b.t || a.amps - b.amps)

    const slots: PeblarScheduleSlot[] = []
    let lastAmps: number | null = null
    for (const ev of events) {
      if (lastAmps === ev.amps && slots.length) continue
      slots.push({ CurrentLimit: ev.amps, StartTime: ev.t })
      lastAmps = ev.amps
    }
    week[dayName] = slots.length ? slots : emptyDay()
  }
  return week
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

async function getScheduleNative(host: string, password: string): Promise<PeblarWeekSchedule> {
  const cookie = await peblarLogin(host, password)
  const schedule = await peblarRequest(host, cookie, 'GET', '/api/v1/config/scheduledcharging/schedules')
  return (schedule ?? emptyWeekSchedule()) as PeblarWeekSchedule
}

async function setScheduleNative(
  host: string,
  password: string,
  schedule: PeblarWeekSchedule,
): Promise<void> {
  const cookie = await peblarLogin(host, password)
  await peblarRequest(host, cookie, 'POST', '/api/v1/config/scheduledcharging/schedules', schedule)
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
  previousSchedule?: PeblarWeekSchedule | null
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

/** Switch Peblar to default mode (Skoda-owned schedule) and restore later. */
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

/** Write optimized windows to Peblar schedule, enable scheduled mode, restore later. */
export async function applyPeblarSchedule(
  settings: AppSettings,
  windows: ChargeWindow[],
  restoreAt: Date,
): Promise<{ previousMode: PeblarSmartChargingMode; restoreAt: string }> {
  const schedule = buildPeblarScheduleFromWindows(windows, settings.chargePowerKw)

  if (isNativeApp()) {
    const host = settings.peblarHost.trim()
    const password = settings.peblarPassword.trim()
    const token = settings.peblarApiToken.trim()
    await verifyApiTokenNative(host, token)
    const previousMode = await getSmartChargingModeNative(host, password)
    const previousSchedule = await getScheduleNative(host, password)
    await setScheduleNative(host, password, schedule)
    await setSmartChargingModeNative(host, password, 'scheduled')
    savePendingRestore({
      host,
      password,
      previousMode,
      previousSchedule,
      restoreAt: restoreAt.toISOString(),
    })
    schedulePeblarRestoreCheck()
    return { previousMode, restoreAt: restoreAt.toISOString() }
  }

  const response = await fetch('/api/peblar/apply-schedule', {
    method: 'POST',
    headers: peblarProxyHeaders(settings),
    body: JSON.stringify({
      host: settings.peblarHost.trim(),
      password: settings.peblarPassword.trim(),
      apiToken: settings.peblarApiToken.trim(),
      restoreAt: restoreAt.toISOString(),
      schedule,
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
  if (job.previousSchedule) {
    await setScheduleNative(job.host, job.password, job.previousSchedule)
  }
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
