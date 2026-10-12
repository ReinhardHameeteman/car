import { reactive, watch } from 'vue'

const STORAGE_KEY = 'enyaq-battery-state'

export interface BatteryState {
  socPercent: number
  rangeKm: number | null
  updatedAt: string | null
  /** 'api' when last filled by Refresh; 'manual' when the user edited the fields. */
  source: 'api' | 'manual' | null
}

function load(): BatteryState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { socPercent: 50, rangeKm: null, updatedAt: null, source: null }
    }
    const parsed = JSON.parse(raw) as Partial<BatteryState>
    return {
      socPercent:
        typeof parsed.socPercent === 'number'
          ? Math.max(0, Math.min(100, Math.round(parsed.socPercent)))
          : 50,
      rangeKm:
        typeof parsed.rangeKm === 'number' && Number.isFinite(parsed.rangeKm)
          ? Math.max(0, Math.round(parsed.rangeKm))
          : null,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      source: parsed.source === 'api' || parsed.source === 'manual' ? parsed.source : null,
    }
  } catch {
    return { socPercent: 50, rangeKm: null, updatedAt: null, source: null }
  }
}

const battery = reactive<BatteryState>(load())

watch(
  battery,
  (value) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  },
  { deep: true },
)

export function useBatteryState() {
  function applyFromApi(socPercent: number, rangeKm: number | null) {
    battery.socPercent = Math.max(0, Math.min(100, Math.round(socPercent)))
    battery.rangeKm =
      rangeKm != null && Number.isFinite(rangeKm) ? Math.max(0, Math.round(rangeKm)) : null
    battery.updatedAt = new Date().toISOString()
    battery.source = 'api'
  }

  function markManualEdit() {
    if (!Number.isFinite(battery.socPercent)) battery.socPercent = 50
    else battery.socPercent = Math.max(0, Math.min(100, Math.round(battery.socPercent)))
    if (battery.rangeKm != null && !Number.isFinite(battery.rangeKm)) battery.rangeKm = null
    else if (battery.rangeKm != null) battery.rangeKm = Math.max(0, Math.round(battery.rangeKm))
    battery.updatedAt = new Date().toISOString()
    battery.source = 'manual'
  }

  return { battery, applyFromApi, markManualEdit }
}
