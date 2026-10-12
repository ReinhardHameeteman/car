import type { EnergyPrice } from '../types'
import { energyBaseUrl } from './apiBase'

interface EpexPricePoint {
  t: string
  price: number
}

interface EpexPricesResponse {
  today?: EpexPricePoint[]
  tomorrow?: EpexPricePoint[]
  energy_tax?: number
  provider_charge?: number
  spot_coefficient?: number
}

/** Expand hourly prices into four identical 15-minute slots. */
function expandHourlyToQuarter(hourly: EnergyPrice[]): EnergyPrice[] {
  const slots: EnergyPrice[] = []
  for (const hour of hourly) {
    for (let i = 0; i < 4; i++) {
      const start = new Date(hour.start.getTime() + i * 15 * 60 * 1000)
      slots.push({
        start,
        end: new Date(start.getTime() + 15 * 60 * 1000),
        priceEurPerKwh: hour.priceEurPerKwh,
      })
    }
  }
  return slots
}

function medianGapMinutes(points: EpexPricePoint[]): number {
  if (points.length < 2) return 15
  const gaps: number[] = []
  for (let i = 1; i < points.length; i++) {
    const gap =
      (new Date(points[i].t).getTime() - new Date(points[i - 1].t).getTime()) / 60_000
    if (gap > 0) gaps.push(gap)
  }
  if (!gaps.length) return 15
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)]
}

function toSlots(points: EpexPricePoint[], slotMinutes: number): EnergyPrice[] {
  return points
    .map((item) => {
      const start = new Date(item.t)
      return {
        start,
        end: new Date(start.getTime() + slotMinutes * 60 * 1000),
        priceEurPerKwh: item.price,
      }
    })
    .sort((a, b) => a.start.getTime() - b.start.getTime())
}

/**
 * Fetch NL day-ahead electricity prices (Zonneplan via epexprijzen.nl) as 15-minute slots.
 * Prices are all-in EUR/kWh as returned by the provider endpoint.
 */
export async function fetchEnergyPrices(from: Date, until: Date): Promise<EnergyPrice[]> {
  const response = await fetch(`${energyBaseUrl()}/api/v1/prices/zonneplan/quarterly`)
  if (!response.ok) {
    throw new Error(`epexprijzen API ${response.status}: ${await response.text()}`)
  }

  const data = (await response.json()) as EpexPricesResponse
  const points = [...(data.today ?? []), ...(data.tomorrow ?? [])].sort(
    (a, b) => new Date(a.t).getTime() - new Date(b.t).getTime(),
  )
  if (!points.length) {
    throw new Error('No day-ahead prices available from epexprijzen.nl yet.')
  }

  const gap = medianGapMinutes(points)
  const slotMinutes = gap <= 20 ? 15 : 60
  let slots = toSlots(points, slotMinutes)
  if (slotMinutes === 60) {
    slots = expandHourlyToQuarter(slots)
  }

  return slots.filter((slot) => slot.end > from && slot.start < until)
}
