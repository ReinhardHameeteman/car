import { computed, reactive, watch } from 'vue'
import type { AppSettings } from '../types'

const STORAGE_KEY = 'enyaq-charge-settings'

const defaults: AppSettings = {
  vin: '',
  apiKey: '',
  minSocPercent: 20,
  defaultMaxSocPercent: 80,
  batteryCapacityKwh: 77,
  consumptionKwhPer100Km: 18,
  chargePowerKw: 11,
  profileId: null,
  solarLatitude: null,
  solarLongitude: null,
  solarAzimuth: null,
  solarTilt: null,
  solarInstalledWp: null,
  peblarHost: '',
  peblarApiToken: '',
  peblarPassword: '',
}

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...defaults }
    return { ...defaults, ...JSON.parse(raw) }
  } catch {
    return { ...defaults }
  }
}

const state = reactive<AppSettings>(load())

watch(
  state,
  (value) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  },
  { deep: true },
)

export function useSettings() {
  const isConfigured = computed(
    () => state.vin.trim().length === 17 && state.apiKey.trim().length > 0,
  )

  function update(partial: Partial<AppSettings>) {
    Object.assign(state, partial)
  }

  function reset() {
    Object.assign(state, { ...defaults })
  }

  return { settings: state, isConfigured, update, reset }
}
