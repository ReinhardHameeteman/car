import type { EnergyPrice } from '../types'
import { energyBaseUrl } from './apiBase'

interface EnergyZeroPrice {
  readingDate: string
  price: number
}

interface EnergyZeroResponse {
  Prices?: EnergyZeroPrice[]
}

async function fetchRaw(from: Date, until: Date, interval: '3' | '4'): Promise<EnergyZeroPrice[]> {
  const params = new URLSearchParams({
    fromDate: from.toISOString(),
    tillDate: new Date(until.getTime() - 1).toISOString(),
    interval,
    usageType: '1',
    inclBtw: 'true',
  })

  const response = await fetch(`${energyBaseUrl()}/v1/energyprices?${params}`)
  if (!response.ok) {
    throw new Error(`EnergyZero API ${response.status}: ${await response.text()}`)
  }

  const data = (await response.json()) as EnergyZeroResponse
  return data.Prices ?? []
}

function toSlots(items: EnergyZeroPrice[], slotMinutes: number): EnergyPrice[] {
  return items
    .map((item) => {
      const start = new Date(item.readingDate)
      return {
        start,
        end: new Date(start.getTime() + slotMinutes * 60 * 1000),
        priceEurPerKwh: item.price,
      }
    })
    .sort((a, b) => a.start.getTime() - b.start.getTime())
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

/**
 * Fetch NL day-ahead electricity prices as 15-minute slots (EUR/kWh incl. VAT).
 * Prefers EnergyZero quarter-hour data; falls back to hourly prices expanded to 15 minutes.
 */
export async function fetchEnergyPrices(from: Date, until: Date): Promise<EnergyPrice[]> {
  const quarter = toSlots(await fetchRaw(from, until, '3'), 15)
  const slots =
    quarter.length > 0
      ? quarter
      : expandHourlyToQuarter(toSlots(await fetchRaw(from, until, '4'), 60))

  return slots.filter((slot) => slot.end > from && slot.start < until)
}
