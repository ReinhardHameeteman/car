import type {
  AppSettings,
  ChargingTime,
  ChargeWindow,
  EnergyPrice,
  OptimizeResult,
} from '../types'

const SLOT_HOURS = 0.25
const MAX_WINDOWS = 4

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

/** Skoda typically accepts SOC targets in steps of 10 between 50 and 100. */
export function roundSocTarget(percent: number): number {
  const stepped = Math.ceil(percent / 10) * 10
  return clamp(stepped, 50, 100)
}

function formatHm(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

function fullRangeFromConsumption(
  batteryCapacityKwh: number,
  consumptionKwhPer100Km: number,
): number {
  if (consumptionKwhPer100Km <= 0) return 0
  return (batteryCapacityKwh / consumptionKwhPer100Km) * 100
}

type RankedSlot = EnergyPrice & {
  maxChargeKwh: number
  solarKwhUsed: number
  gridKwh: number
  slotCost: number
}

function rankSlot(slot: EnergyPrice, chargePowerKw: number): RankedSlot {
  const maxChargeKwh = chargePowerKw * SLOT_HOURS
  const solarKwhUsed = Math.min(maxChargeKwh, Math.max(0, slot.solarKwh ?? 0))
  const gridKwh = Math.max(0, maxChargeKwh - solarKwhUsed)
  const slotCost = gridKwh * slot.priceEurPerKwh
  return { ...slot, maxChargeKwh, solarKwhUsed, gridKwh, slotCost }
}

/**
 * Select slots that minimize grid cost (solar Wh is free), then merge into
 * at most 4 preferred charging windows (Skoda profile limit).
 */
function buildWindows(
  prices: EnergyPrice[],
  energyNeededKwh: number,
  chargePowerKw: number,
): { windows: ChargeWindow[]; slotsUsed: number } {
  const kwhPerSlot = chargePowerKw * SLOT_HOURS
  if (kwhPerSlot <= 0 || energyNeededKwh <= 0 || prices.length === 0) {
    return { windows: [], slotsUsed: 0 }
  }

  const slotsNeeded = Math.ceil(energyNeededKwh / kwhPerSlot)
  const ranked = prices
    .map((p) => rankSlot(p, chargePowerKw))
    .sort((a, b) => {
      if (a.slotCost !== b.slotCost) return a.slotCost - b.slotCost
      // Prefer more solar when grid cost ties (including both fully solar / free).
      if (b.solarKwhUsed !== a.solarKwhUsed) return b.solarKwhUsed - a.solarKwhUsed
      return a.priceEurPerKwh - b.priceEurPerKwh
    })

  const selected = ranked.slice(0, Math.min(slotsNeeded, ranked.length))
  selected.sort((a, b) => a.start.getTime() - b.start.getTime())

  type MutableWindow = {
    start: Date
    end: Date
    prices: number[]
    energyKwh: number
    costEur: number
    solarKwh: number
    gridKwh: number
  }

  const windows: MutableWindow[] = []
  for (const slot of selected) {
    const last = windows[windows.length - 1]
    if (last && last.end.getTime() === slot.start.getTime()) {
      last.end = slot.end
      last.prices.push(slot.priceEurPerKwh)
      last.energyKwh += slot.maxChargeKwh
      last.costEur += slot.slotCost
      last.solarKwh += slot.solarKwhUsed
      last.gridKwh += slot.gridKwh
    } else {
      windows.push({
        start: slot.start,
        end: slot.end,
        prices: [slot.priceEurPerKwh],
        energyKwh: slot.maxChargeKwh,
        costEur: slot.slotCost,
        solarKwh: slot.solarKwhUsed,
        gridKwh: slot.gridKwh,
      })
    }
  }

  // If more than 4 windows, merge pairs that add the least extra grid cost.
  while (windows.length > MAX_WINDOWS) {
    let bestIndex = 0
    let bestExtra = Number.POSITIVE_INFINITY
    for (let i = 0; i < windows.length - 1; i++) {
      const left = windows[i]
      const right = windows[i + 1]
      const gapSlots = prices
        .filter((p) => p.start >= left.end && p.end <= right.start)
        .map((p) => rankSlot(p, chargePowerKw))
      const extra = gapSlots.reduce((sum, p) => sum + p.slotCost, 0)
      if (extra < bestExtra) {
        bestExtra = extra
        bestIndex = i
      }
    }

    const left = windows[bestIndex]
    const right = windows[bestIndex + 1]
    const gapSlots = prices
      .filter((p) => p.start >= left.end && p.end <= right.start)
      .map((p) => rankSlot(p, chargePowerKw))
    for (const gap of gapSlots) {
      left.prices.push(gap.priceEurPerKwh)
      left.energyKwh += gap.maxChargeKwh
      left.costEur += gap.slotCost
      left.solarKwh += gap.solarKwhUsed
      left.gridKwh += gap.gridKwh
    }
    left.end = right.end
    left.prices.push(...right.prices)
    left.energyKwh += right.energyKwh
    left.costEur += right.costEur
    left.solarKwh += right.solarKwh
    left.gridKwh += right.gridKwh
    windows.splice(bestIndex + 1, 1)
  }

  return {
    windows: windows.map((w) => ({
      start: w.start,
      end: w.end,
      avgPrice: w.prices.reduce((a, b) => a + b, 0) / w.prices.length,
      energyKwh: w.energyKwh,
      costEur: w.costEur,
      solarKwh: w.solarKwh,
      gridKwh: w.gridKwh,
    })),
    slotsUsed: selected.length,
  }
}

function toPreferredTimes(windows: ChargeWindow[], existing?: ChargingTime[]): ChargingTime[] {
  const ids = existing?.map((t) => t.id) ?? [1, 2, 3, 4]
  while (ids.length < MAX_WINDOWS) ids.push(ids.length + 1)

  return ids.slice(0, MAX_WINDOWS).map((id, index) => {
    const window = windows[index]
    if (!window) {
      return {
        id,
        enabled: false,
        startTime: existing?.[index]?.startTime ?? '22:00',
        endTime: existing?.[index]?.endTime ?? '06:00',
      }
    }
    return {
      id,
      enabled: true,
      startTime: formatHm(window.start),
      endTime: formatHm(window.end),
    }
  })
}

export function optimizeChargingProfile(input: {
  settings: AppSettings
  prices: EnergyPrice[]
  /** Plan from trip distance (adds min SOC as reserve). */
  desiredKm?: number
  /** Plan from an absolute target SOC (min SOC is not added again). */
  targetSocPercent?: number
  finishBy: Date
  currentSocPercent: number
  currentRangeKm: number
  existingTimes?: ChargingTime[]
  useSolar?: boolean
}): OptimizeResult {
  const {
    settings,
    prices,
    finishBy,
    currentSocPercent,
    currentRangeKm,
    existingTimes,
  } = input

  const consumption = settings.consumptionKwhPer100Km
  const fullRangeKm = fullRangeFromConsumption(
    settings.batteryCapacityKwh,
    consumption,
  )

  const defaultMax = settings.defaultMaxSocPercent
  let raisedLimit = false
  let warning: string | null = null
  let requiredSoc: number
  let desiredKm: number

  if (input.targetSocPercent != null && !Number.isNaN(input.targetSocPercent)) {
    requiredSoc = clamp(input.targetSocPercent, 1, 100)
    desiredKm = Math.max(
      0,
      fullRangeKm * ((requiredSoc - settings.minSocPercent) / 100),
    )
  } else {
    desiredKm = Math.max(0, input.desiredKm ?? 0)
    const tripEnergyKwh = (desiredKm / 100) * consumption
    const socForTrip =
      settings.batteryCapacityKwh > 0
        ? (tripEnergyKwh / settings.batteryCapacityKwh) * 100
        : 100
    requiredSoc = Math.min(100, socForTrip + settings.minSocPercent)
  }

  const maxKmAtDefault =
    fullRangeKm * ((defaultMax - settings.minSocPercent) / 100)
  let targetSocPercent = roundSocTarget(requiredSoc)

  if (targetSocPercent > defaultMax || desiredKm > maxKmAtDefault) {
    raisedLimit = true
    targetSocPercent = Math.max(targetSocPercent, roundSocTarget(requiredSoc))
    warning =
      input.targetSocPercent != null
        ? `Target SOC ${Math.round(requiredSoc)}% is above the default ${defaultMax}% limit. ` +
          `Raising charge limit to ${targetSocPercent}%.`
        : `Desired ${Math.round(desiredKm)} km plus min SOC reserve (${settings.minSocPercent}%) ` +
          `exceeds the default ${defaultMax}% limit (~${Math.round(maxKmAtDefault)} km at ` +
          `${consumption} kWh/100 km). Raising charge limit to ${targetSocPercent}%.`
  }

  const socToCharge = Math.max(0, targetSocPercent - currentSocPercent)
  const energyNeededKwh = (socToCharge / 100) * settings.batteryCapacityKwh

  const now = new Date()
  const solarEnabled = Boolean(input.useSolar)
  const usablePrices = prices
    .filter((p) => p.end > now && p.start < finishBy)
    .map((p) => ({
      ...p,
      solarKwh: solarEnabled ? p.solarKwh ?? 0 : 0,
    }))

  const { windows, slotsUsed } = buildWindows(
    usablePrices,
    energyNeededKwh,
    settings.chargePowerKw,
  )

  const estimatedCostEur = windows.reduce((sum, w) => sum + w.costEur, 0)
  const solarEnergyKwh = windows.reduce((sum, w) => sum + w.solarKwh, 0)
  const gridEnergyKwh = windows.reduce((sum, w) => sum + w.gridKwh, 0)
  const preferredChargingTimes = toPreferredTimes(windows, existingTimes)

  return {
    targetSocPercent,
    defaultMaxSocPercent: defaultMax,
    raisedLimit,
    warning,
    energyNeededKwh,
    estimatedCostEur,
    solarEnergyKwh,
    gridEnergyKwh,
    solarEnabled,
    windows,
    preferredChargingTimes,
    slotsUsed,
    slotsAvailable: usablePrices.length,
    fullRangeKm,
    rangeAtTargetKm: fullRangeKm * (targetSocPercent / 100),
    currentSocPercent,
    currentRangeKm,
    prices: usablePrices,
  }
}
