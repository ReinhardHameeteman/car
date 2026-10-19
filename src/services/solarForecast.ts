import type { AppSettings, SolarForecastSlot } from '../types'
import { jeroenBaseUrl } from './apiBase'

const SLOT_HOURS = 0.25
const HOUR_HOURS = 1

export function isSolarConfigured(settings: AppSettings): boolean {
  const { solarLatitude, solarLongitude, solarAzimuth, solarTilt, solarInstalledWp } = settings
  return (
    solarLatitude != null &&
    !Number.isNaN(solarLatitude) &&
    solarLongitude != null &&
    !Number.isNaN(solarLongitude) &&
    solarAzimuth != null &&
    !Number.isNaN(solarAzimuth) &&
    solarTilt != null &&
    !Number.isNaN(solarTilt) &&
    solarInstalledWp != null &&
    !Number.isNaN(solarInstalledWp) &&
    solarInstalledWp > 0
  )
}

type HourlyRow = [string, number, string]

interface JeroenDay {
  date: string
  hourly_kwh_system?: HourlyRow[]
}

interface JeroenForecast {
  days?: JeroenDay[]
}

interface McpCallResult {
  result?: {
    structuredContent?: JeroenForecast
    content?: Array<{ type: string; text?: string }>
  }
  error?: { message?: string; code?: number }
}

/**
 * Fetch PV yield from jeroen.nl MCP (`get_solar_forecast`) and expand to 15-min slots.
 * Azimuth: 0° South, −90° East, 90° West (same convention as jeroen.nl).
 */
export async function fetchSolarForecast(
  settings: AppSettings,
  from: Date,
  until: Date,
): Promise<SolarForecastSlot[]> {
  if (!isSolarConfigured(settings)) return []

  const msPerDay = 24 * 60 * 60 * 1000
  const days = Math.min(
    7,
    Math.max(1, Math.ceil((until.getTime() - from.getTime()) / msPerDay) + 1),
  )

  const response = await fetch(`${jeroenBaseUrl()}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'get_solar_forecast',
        arguments: {
          latitude: settings.solarLatitude,
          longitude: settings.solarLongitude,
          tilt: settings.solarTilt,
          azimuth: settings.solarAzimuth,
          kwp: settings.solarInstalledWp! / 1000,
          days,
          include_hourly: true,
        },
      },
    }),
  })

  if (!response.ok) {
    throw new Error(`jeroen.nl MCP ${response.status}: ${await response.text()}`)
  }

  const payload = (await response.json()) as McpCallResult
  if (payload.error) {
    throw new Error(payload.error.message ?? `jeroen.nl MCP error ${payload.error.code}`)
  }

  const forecast = parseForecast(payload)
  const slots: SolarForecastSlot[] = []

  for (const day of forecast.days ?? []) {
    for (const row of day.hourly_kwh_system ?? []) {
      const [, hourKwh, utc] = row
      if (typeof hourKwh !== 'number' || !utc) continue
      const hourStart = new Date(utc.endsWith('Z') ? utc : `${utc}Z`)
      const energy = Math.max(0, hourKwh)

      for (let q = 0; q < 4; q++) {
        const start = new Date(hourStart.getTime() + q * 15 * 60 * 1000)
        const end = new Date(start.getTime() + 15 * 60 * 1000)
        if (end <= from || start >= until) continue
        slots.push({
          start,
          end,
          gtiWm2: 0,
          solarKwh: energy * (SLOT_HOURS / HOUR_HOURS),
        })
      }
    }
  }

  return slots.sort((a, b) => a.start.getTime() - b.start.getTime())
}

function parseForecast(payload: McpCallResult): JeroenForecast {
  const structured = payload.result?.structuredContent
  if (structured?.days) return structured

  const text = payload.result?.content?.find((c) => c.type === 'text')?.text
  if (text) {
    try {
      return JSON.parse(text) as JeroenForecast
    } catch {
      /* fall through */
    }
  }
  return {}
}

export function solarKwhAt(slots: SolarForecastSlot[], start: Date): number {
  const t = start.getTime()
  const hit = slots.find((s) => s.start.getTime() === t)
  return hit?.solarKwh ?? 0
}
