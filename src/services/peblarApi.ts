import { CapacitorHttp, type HttpHeaders, type HttpResponse } from '@capacitor/core'
import type { AppSettings, ChargeWindow } from '../types'
import { isNativeApp, peblarConnectionHint, peblarOrigin } from './apiBase'

/** Keep native Peblar calls short — stacked logins were hanging Apply for minutes. */
const NATIVE_TIMEOUT_MS = 8_000

export type PeblarSmartChargingMode =
  | 'default'
  | 'fast_solar'
  | 'smart_solar'
  | 'pure_solar'
  | 'scheduled'

export interface PeblarScheduleSlot {
  /** Charge current limit in milliamps (0 = no charging). UI shows amps. */
  CurrentLimit: number
  /** Seconds since midnight. */
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
  const text = await response.text()
  try {
    const body = JSON.parse(text) as { error?: string }
    if (body.error) return body.error
  } catch {
    /* plain text */
  }
  return text.trim() || `${response.status} ${response.statusText}`
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

function cookieFromCapacitorHeaders(headers: HttpHeaders): string {
  const raw =
    headers['Set-Cookie'] ||
    headers['set-cookie'] ||
    headers['Set-cookie'] ||
    Object.entries(headers).find(([k]) => k.toLowerCase() === 'set-cookie')?.[1]
  if (!raw) return ''
  return String(raw)
    .split(/,(?=[^;]+?=)/)
    .map((c) => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ')
}

async function nativeHttp(
  host: string,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; data?: unknown } = {},
): Promise<HttpResponse> {
  // CapacitorHttp timeouts are not always honored on Android — race a hard deadline.
  const request = CapacitorHttp.request({
    url: `${peblarOrigin(host)}${path}`,
    method,
    headers: {
      Accept: 'application/json',
      ...(options.data != null ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    data: options.data,
    connectTimeout: NATIVE_TIMEOUT_MS,
    readTimeout: NATIVE_TIMEOUT_MS,
  })
  const deadline = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`Peblar request timed out after ${NATIVE_TIMEOUT_MS / 1000}s`)),
      NATIVE_TIMEOUT_MS,
    )
  })
  try {
    return await Promise.race([request, deadline])
  } catch (err) {
    throw new Error(peblarConnectionHint(host, err))
  }
}

async function peblarLogin(host: string, password: string): Promise<string> {
  const response = await nativeHttp(host, 'POST', '/api/v1/auth/login', {
    data: { Password: password, PersistentSession: true },
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Peblar login failed (${response.status}): ${JSON.stringify(response.data)}`)
  }
  const cookie = cookieFromCapacitorHeaders(response.headers)
  if (!cookie) {
    throw new Error(
      'Peblar login succeeded but no session cookie was returned. Rebuild the Android app with CapacitorHttp + cleartext enabled.',
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
  const response = await nativeHttp(host, method, path, {
    headers: { Cookie: cookie },
    data: body,
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Peblar ${method} ${path} failed (${response.status}): ${JSON.stringify(response.data)}`,
    )
  }
  if (response.data == null || response.data === '') return null
  if (typeof response.data === 'object') return response.data as Record<string, unknown>
  if (typeof response.data === 'string') {
    return response.data ? (JSON.parse(response.data) as Record<string, unknown>) : null
  }
  return null
}

/** Home charge power (kW) → schedule CurrentLimit in milliamps. */
function chargeCurrentMilliamps(chargePowerKw: number): number {
  const kw = Number(chargePowerKw)
  const safeKw = Number.isFinite(kw) && kw > 0 ? kw : 11
  const phases = safeKw >= 7 ? 3 : 1
  const amps = Math.max(6, Math.min(32, Math.round((safeKw * 1000) / (230 * phases))))
  return amps * 1000
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

const SECONDS_PER_DAY = 24 * 60 * 60

function secondsSinceMidnight(d: Date): number {
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Convert optimized charge windows into a weekly Peblar schedule (recurring). */
export function buildPeblarScheduleFromWindows(
  windows: ChargeWindow[],
  chargePowerKw: number,
): PeblarWeekSchedule {
  const milliamps = chargeCurrentMilliamps(chargePowerKw)
  const byDay = new Map<DayName, { start: number; end: number }[]>()

  for (const window of windows) {
    let cursor = new Date(window.start)
    const end = new Date(window.end)
    while (cursor < end) {
      const dayStart = startOfLocalDay(cursor)
      const nextDay = new Date(dayStart.getTime() + SECONDS_PER_DAY * 1000)
      const segmentEnd = end < nextDay ? end : nextDay
      const dayName = DAY_NAMES[cursor.getDay()] as DayName
      const list = byDay.get(dayName) ?? []
      list.push({
        start: secondsSinceMidnight(cursor),
        end:
          segmentEnd.getTime() === nextDay.getTime()
            ? SECONDS_PER_DAY
            : secondsSinceMidnight(segmentEnd),
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
    // Prefer non-zero when two events share a timestamp (window end == next start).
    const events: { t: number; ma: number }[] = [{ t: 0, ma: 0 }]
    for (const seg of segments) {
      if (seg.start >= seg.end) continue
      events.push({ t: seg.start, ma: milliamps })
      if (seg.end < SECONDS_PER_DAY) events.push({ t: seg.end, ma: 0 })
    }
    events.sort((a, b) => a.t - b.t || b.ma - a.ma)

    const slots: PeblarScheduleSlot[] = []
    let lastMa: number | null = null
    for (const ev of events) {
      if (lastMa === ev.ma && slots.length) continue
      slots.push({ CurrentLimit: ev.ma, StartTime: ev.t })
      lastMa = ev.ma
    }
    week[dayName] = slots.length ? slots : emptyDay()
  }
  return week
}

/** One login, then read mode + schedule, write schedule, enable scheduled mode. */
async function applyScheduleNative(
  host: string,
  password: string,
  schedule: PeblarWeekSchedule,
): Promise<{ previousMode: PeblarSmartChargingMode; previousSchedule: PeblarWeekSchedule }> {
  const cookie = await peblarLogin(host, password)
  const config = await peblarRequest(host, cookie, 'GET', '/api/v1/config/user')
  const previousMode = modeFromUserConfig(config)
  const previousSchedule = ((await peblarRequest(
    host,
    cookie,
    'GET',
    '/api/v1/config/scheduledcharging/schedules',
  )) ?? emptyWeekSchedule()) as PeblarWeekSchedule
  await peblarRequest(
    host,
    cookie,
    'POST',
    '/api/v1/config/scheduledcharging/schedules',
    schedule,
  )
  await peblarRequest(host, cookie, 'PATCH', '/api/v1/config/user', patchBodyForMode('scheduled'))
  return { previousMode, previousSchedule }
}

async function prepareDefaultModeNative(
  host: string,
  password: string,
): Promise<PeblarSmartChargingMode> {
  const cookie = await peblarLogin(host, password)
  const config = await peblarRequest(host, cookie, 'GET', '/api/v1/config/user')
  const previousMode = modeFromUserConfig(config)
  if (previousMode !== 'default') {
    await peblarRequest(host, cookie, 'PATCH', '/api/v1/config/user', patchBodyForMode('default'))
  }
  return previousMode
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
    const previousMode = await prepareDefaultModeNative(host, password)
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
    const { previousMode, previousSchedule } = await applyScheduleNative(host, password, schedule)
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

async function restoreNative(job: PendingRestore): Promise<void> {
  const cookie = await peblarLogin(job.host, job.password)
  if (job.previousSchedule) {
    await peblarRequest(
      job.host,
      cookie,
      'POST',
      '/api/v1/config/scheduledcharging/schedules',
      job.previousSchedule,
    )
  }
  await peblarRequest(
    job.host,
    cookie,
    'PATCH',
    '/api/v1/config/user',
    patchBodyForMode(job.previousMode),
  )
}

/** Run due Peblar restores (native: localStorage job; checked on launch / timer). */
export async function runDuePeblarRestore(): Promise<boolean> {
  if (!isNativeApp()) return false
  const job = loadPendingRestore()
  if (!job) return false
  if (new Date(job.restoreAt).getTime() > Date.now()) return false
  await restoreNative(job)
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
