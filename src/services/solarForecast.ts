import type { AppSettings, SolarForecastSlot } from '../types'

/** System losses (inverter, wiring, soiling) applied to STC scaling. */
const PERFORMANCE_RATIO = 0.85
const SLOT_HOURS = 0.25

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

interface OpenMeteoResponse {
  hourly?: {
    time: string[]
    global_tilted_irradiance?: (number | null)[]
  }
}

/**
 * Fetch ECMWF global tilted irradiance and convert to estimated PV energy per 15-min slot.
 * Open-Meteo azimuth: 0° South, -90° East, 90° West, ±180° North.
 */
export async function fetchSolarForecast(
  settings: AppSettings,
  from: Date,
  until: Date,
): Promise<SolarForecastSlot[]> {
  if (!isSolarConfigured(settings)) return []

  const msPerDay = 24 * 60 * 60 * 1000
  const forecastDays = Math.min(
    16,
    Math.max(1, Math.ceil((until.getTime() - from.getTime()) / msPerDay) + 1),
  )

  const params = new URLSearchParams({
    latitude: String(settings.solarLatitude),
    longitude: String(settings.solarLongitude),
    hourly: 'global_tilted_irradiance',
    tilt: String(settings.solarTilt),
    azimuth: String(settings.solarAzimuth),
    forecast_days: String(forecastDays),
    timezone: 'UTC',
  })

  const response = await fetch(`/api/meteo/v1/ecmwf?${params}`)
  if (!response.ok) {
    throw new Error(`Open-Meteo API ${response.status}: ${await response.text()}`)
  }

  const data = (await response.json()) as OpenMeteoResponse
  const times = data.hourly?.time ?? []
  const gti = data.hourly?.global_tilted_irradiance ?? []
  const wp = settings.solarInstalledWp!

  const slots: SolarForecastSlot[] = []
  for (let i = 0; i < times.length; i++) {
    const hourStart = new Date(times[i].endsWith('Z') ? times[i] : `${times[i]}:00.000Z`)
    const irradiance = Math.max(0, gti[i] ?? 0)
    // STC: 1000 W/m² → rated Wp. Scale by GTI and performance ratio.
    const hourKwh = wp * (irradiance / 1000) * PERFORMANCE_RATIO * 1

    for (let q = 0; q < 4; q++) {
      const start = new Date(hourStart.getTime() + q * 15 * 60 * 1000)
      const end = new Date(start.getTime() + 15 * 60 * 1000)
      if (end <= from || start >= until) continue
      slots.push({
        start,
        end,
        gtiWm2: irradiance,
        solarKwh: hourKwh * SLOT_HOURS, // quarter of the hourly energy
      })
    }
  }

  return slots.sort((a, b) => a.start.getTime() - b.start.getTime())
}

export function solarKwhAt(slots: SolarForecastSlot[], start: Date): number {
  const t = start.getTime()
  const hit = slots.find((s) => s.start.getTime() === t)
  return hit?.solarKwh ?? 0
}
