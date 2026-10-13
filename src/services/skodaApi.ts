import type {
  ChargeModeValue,
  ChargingLimitBody,
  ChargingProfile,
  VehicleResponse,
} from '../types'
import { skodaBaseUrl } from './apiBase'

export class SkodaApiError extends Error {
  status: number
  detail?: string
  /** RFC 9457 problem type URI, e.g. .../vehicle-not-accepting-requests */
  problemType?: string
  retryAfterSec?: number

  constructor(
    status: number,
    message: string,
    detail?: string,
    extras?: { problemType?: string; retryAfterSec?: number },
  ) {
    super(message)
    this.status = status
    this.detail = detail
    this.problemType = extras?.problemType
    this.retryAfterSec = extras?.retryAfterSec
  }

  get isVehicleNotAccepting(): boolean {
    return (
      this.status === 429 &&
      (this.problemType?.includes('vehicle-not-accepting-requests') === true ||
        /not accepting requests/i.test(this.detail || ''))
    )
  }

  get isRateLimitExceeded(): boolean {
    return (
      this.status === 429 &&
      !this.isVehicleNotAccepting &&
      (this.problemType?.includes('rate-limit-exceeded') === true ||
        /rate limit/i.test(this.detail || this.message))
    )
  }
}

const DEFAULT_TIMEOUT_MS = 15_000
/** Keep Apply responsive — car-offline retries used to stack into multi-minute hangs. */
const COMMAND_TIMEOUT_MS = 12_000
const COMMAND_MAX_ATTEMPTS = 2
const COMMAND_DEFAULT_WAIT_SEC = 8
const COMMAND_MAX_WAIT_SEC = 20

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseRetryAfter(header: string | null, detail?: string): number | undefined {
  if (header) {
    const n = Number(header)
    if (Number.isFinite(n) && n >= 0) return Math.min(120, Math.ceil(n))
  }
  const match = detail?.match(/retry after\s+(\d+)\s*seconds?/i)
  if (match) return Math.min(120, Number(match[1]))
  return undefined
}

async function requestOnce<T>(
  apiKey: string,
  path: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (init.signal) {
    init.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  let response: Response
  try {
    response = await fetch(`${skodaBaseUrl()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        ...(init.headers || {}),
      },
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new SkodaApiError(0, `Skoda API timed out after ${timeoutMs / 1000}s`, path)
    }
    throw new SkodaApiError(
      0,
      'Failed to reach the app server',
      'Your phone cannot reach the laptop proxy. Keep npm start (or npm run dev) running, use the same Wi‑Fi, allow Node through Windows Firewall, or reopen the current HTTPS tunnel URL.',
    )
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    let detail: string | undefined
    let problemType: string | undefined
    try {
      const problem = (await response.json()) as {
        detail?: string
        title?: string
        type?: string
      }
      detail = problem.detail || problem.title || JSON.stringify(problem)
      problemType = problem.type
    } catch {
      detail = await response.text()
    }
    throw new SkodaApiError(response.status, `Skoda API ${response.status}`, detail, {
      problemType,
      retryAfterSec: parseRetryAfter(response.headers.get('Retry-After'), detail),
    })
  }

  if (response.status === 202 || response.status === 204) {
    return undefined as T
  }

  const text = await response.text()
  return text ? (JSON.parse(text) as T) : (undefined as T)
}

/**
 * Vehicle commands often fail while the car is asleep / not accepting requests.
 * Retry a few times using Retry-After (vehicle-not-accepting-requests).
 * Does not retry API-key rate-limit-exceeded (that needs a longer wait).
 */
async function requestCommand<T>(
  apiKey: string,
  path: string,
  init: RequestInit = {},
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= COMMAND_MAX_ATTEMPTS; attempt++) {
    try {
      return await requestOnce<T>(apiKey, path, init, timeoutMs)
    } catch (err) {
      lastError = err
      if (!(err instanceof SkodaApiError) || !err.isVehicleNotAccepting) {
        throw err
      }
      if (attempt >= COMMAND_MAX_ATTEMPTS) break
      const waitSec = Math.min(
        COMMAND_MAX_WAIT_SEC,
        err.retryAfterSec ?? COMMAND_DEFAULT_WAIT_SEC,
      )
      await sleep(waitSec * 1000)
    }
  }
  throw lastError
}

async function request<T>(
  apiKey: string,
  path: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  return requestOnce<T>(apiKey, path, init, timeoutMs)
}

export async function getVehicle(
  apiKey: string,
  vin: string,
  include = 'info,charging,chargingProfiles,operations',
): Promise<VehicleResponse> {
  const params = new URLSearchParams({ include })
  return request<VehicleResponse>(apiKey, `/api/v1/vehicles/${vin}?${params}`)
}

export async function startCharging(apiKey: string, vin: string): Promise<void> {
  await requestCommand(apiKey, `/api/v1/vehicles/${vin}/charging/start`, { method: 'POST' })
}

export async function stopCharging(apiKey: string, vin: string): Promise<void> {
  await requestCommand(apiKey, `/api/v1/vehicles/${vin}/charging/stop`, { method: 'POST' })
}

export async function setChargeMode(
  apiKey: string,
  vin: string,
  chargeMode: ChargeModeValue,
): Promise<void> {
  await requestCommand(apiKey, `/api/v1/vehicles/${vin}/charging/mode`, {
    method: 'PUT',
    body: JSON.stringify({ chargeMode }),
  })
}

export async function setChargingLimit(
  apiKey: string,
  vin: string,
  targetStateOfChargeInPercent: number,
): Promise<void> {
  await requestCommand(apiKey, `/api/v1/vehicles/${vin}/charging/limit`, {
    method: 'PUT',
    body: JSON.stringify({ targetStateOfChargeInPercent } satisfies ChargingLimitBody),
  })
}

export async function updateChargingProfile(
  apiKey: string,
  vin: string,
  profile: ChargingProfile,
): Promise<void> {
  await requestCommand(apiKey, `/api/v1/vehicles/${vin}/charging-profiles/${profile.id}`, {
    method: 'PUT',
    body: JSON.stringify(profile),
  })
}
