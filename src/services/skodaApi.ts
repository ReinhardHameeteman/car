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

  constructor(status: number, message: string, detail?: string) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

async function request<T>(
  apiKey: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${skodaBaseUrl()}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        ...(init.headers || {}),
      },
    })
  } catch {
    throw new SkodaApiError(
      0,
      'Failed to reach the app server',
      'Your phone cannot reach the laptop proxy. Keep npm start (or npm run dev) running, use the same Wi‑Fi, allow Node through Windows Firewall, or reopen the current HTTPS tunnel URL.',
    )
  }

  if (!response.ok) {
    let detail: string | undefined
    try {
      const problem = await response.json()
      detail = problem.detail || problem.title || JSON.stringify(problem)
    } catch {
      detail = await response.text()
    }
    throw new SkodaApiError(response.status, `Skoda API ${response.status}`, detail)
  }

  if (response.status === 202 || response.status === 204) {
    return undefined as T
  }

  const text = await response.text()
  return text ? (JSON.parse(text) as T) : (undefined as T)
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
  await request(apiKey, `/api/v1/vehicles/${vin}/charging/start`, { method: 'POST' })
}

export async function stopCharging(apiKey: string, vin: string): Promise<void> {
  await request(apiKey, `/api/v1/vehicles/${vin}/charging/stop`, { method: 'POST' })
}

export async function setChargeMode(
  apiKey: string,
  vin: string,
  chargeMode: ChargeModeValue,
): Promise<void> {
  await request(apiKey, `/api/v1/vehicles/${vin}/charging/mode`, {
    method: 'PUT',
    body: JSON.stringify({ chargeMode }),
  })
}

export async function setChargingLimit(
  apiKey: string,
  vin: string,
  targetStateOfChargeInPercent: number,
): Promise<void> {
  await request(apiKey, `/api/v1/vehicles/${vin}/charging/limit`, {
    method: 'PUT',
    body: JSON.stringify({ targetStateOfChargeInPercent } satisfies ChargingLimitBody),
  })
}

export async function updateChargingProfile(
  apiKey: string,
  vin: string,
  profile: ChargingProfile,
): Promise<void> {
  await request(apiKey, `/api/v1/vehicles/${vin}/charging-profiles/${profile.id}`, {
    method: 'PUT',
    body: JSON.stringify(profile),
  })
}
