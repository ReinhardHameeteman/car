import type { AppSettings } from '../types'

export type PeblarSmartChargingMode =
  | 'default'
  | 'fast_solar'
  | 'smart_solar'
  | 'pure_solar'
  | 'scheduled'

export function isPeblarConfigured(settings: AppSettings): boolean {
  return (
    settings.peblarHost.trim().length > 0 &&
    settings.peblarApiToken.trim().length > 0 &&
    settings.peblarPassword.trim().length > 0
  )
}

function peblarHeaders(settings: AppSettings): HeadersInit {
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

/** Switch Peblar to default mode and schedule restoring the previous mode. */
export async function preparePeblarForProfileCharging(
  settings: AppSettings,
  restoreAt: Date,
): Promise<{ previousMode: PeblarSmartChargingMode; restoreAt: string }> {
  const response = await fetch('/api/peblar/prepare', {
    method: 'POST',
    headers: peblarHeaders(settings),
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
  const response = await fetch('/api/peblar/restore-status')
  if (!response.ok) {
    throw new Error(await readError(response))
  }
  return response.json()
}
