export type ChargeModeValue =
  | 'MANUAL'
  | 'TIMER'
  | 'TIMER_CHARGING_WITH_CLIMATISATION'
  | 'PREFERRED_CHARGING_TIMES'
  | 'ONLY_OWN_CURRENT'
  | 'IMMEDIATE_DISCHARGING'
  | 'HOME_STORAGE_CHARGING'

export type SchedulerTarget = 'skoda' | 'peblar'

export interface AppSettings {
  vin: string
  apiKey: string
  minSocPercent: number
  defaultMaxSocPercent: number
  batteryCapacityKwh: number
  /** Average energy use of the car, used to turn desired km into kWh / SOC. */
  consumptionKwhPer100Km: number
  chargePowerKw: number
  profileId: number | null
  /** Which device owns the cheap-slot schedule when applying a plan. */
  schedulerTarget: SchedulerTarget
  /** Solar array location and orientation (Open-Meteo: azimuth 0° = South). */
  solarLatitude: number | null
  solarLongitude: number | null
  solarAzimuth: number | null
  solarTilt: number | null
  /** Installed DC peak power in watt-peak. */
  solarInstalledWp: number | null
  /** Peblar charger hostname or LAN IP. */
  peblarHost: string
  /** Local REST API token from the Peblar web UI (Read/Write). */
  peblarApiToken: string
  /**
   * Peblar web UI password — required to read/change smart charging mode
   * (`/api/v1/config/user`). The API token alone cannot switch modes.
   */
  peblarPassword: string
}

export interface ChargingLimitBody {
  targetStateOfChargeInPercent: number
}

export interface EnergyPrice {
  start: Date
  end: Date
  priceEurPerKwh: number
  /** Estimated free solar energy available in this slot (kWh), if solar is enabled. */
  solarKwh?: number
}

export interface SolarForecastSlot {
  start: Date
  end: Date
  /** Global tilted irradiance W/m² */
  gtiWm2: number
  /** Estimated AC energy from the array in this slot (kWh) */
  solarKwh: number
}

export interface ChargingTime {
  id: number
  enabled: boolean
  startTime: string
  endTime: string
}

export interface MinBatteryStateOfCharge {
  enabled?: boolean
  minimumBatteryStateOfChargeInPercent?: number
}

export interface ChargingProfileSettings {
  maxChargingCurrent?: string
  minBatteryStateOfCharge?: MinBatteryStateOfCharge
  targetStateOfChargeInPercent?: number
  autoUnlockPlugWhenCharged?: string
}

export interface ChargingTimer {
  id: number
  enabled: boolean
  time?: string
  type: 'ONE_OFF' | 'RECURRING' | string
  oneOffDay?: string
  recurringOn?: string[]
}

export interface ChargingProfile {
  id: number
  name: string
  settings: ChargingProfileSettings
  preferredChargingTimes: ChargingTime[]
  timers: ChargingTimer[]
}

export interface BatteryStatus {
  remainingCruisingRangeInMeters?: number
  stateOfChargeInPercent?: number
}

export interface ChargingStatus {
  chargingRateInKilometersPerHour?: number
  chargePowerInKw?: number
  remainingTimeToFullyChargedInMinutes?: number
  fullyChargedAt?: string
  state?: string
  chargeType?: string
  battery?: BatteryStatus
}

export interface ChargingSettings {
  targetStateOfChargeInPercent?: number
  preferredChargeMode?: ChargeModeValue | string
  availableChargeModes?: string[]
  maxChargeCurrentAc?: string
}

export interface ChargingInfo {
  isVehicleInSavedLocation?: boolean
  status?: ChargingStatus
  settings?: ChargingSettings
  carCapturedTimestamp?: string
}

export interface ChargingProfilesInfo {
  profiles: ChargingProfile[]
  currentVehiclePositionProfile?: {
    id: number
    name: string
    targetStateOfChargeInPercent?: number
    nextChargingTime?: string
  }
  carCapturedTimestamp?: string
}

export interface Vehicle {
  vin: string
  name?: string
  licensePlate?: string
  charging?: ChargingInfo
  chargingProfiles?: ChargingProfilesInfo
  operations?: { name: string }[]
}

export interface VehicleResponse {
  vehicle: Vehicle
  errors?: { type: string; description?: string }[]
}

export interface ChargeWindow {
  start: Date
  end: Date
  avgPrice: number
  energyKwh: number
  costEur: number
  solarKwh: number
  gridKwh: number
}

export interface OptimizeResult {
  targetSocPercent: number
  defaultMaxSocPercent: number
  raisedLimit: boolean
  warning: string | null
  energyNeededKwh: number
  estimatedCostEur: number
  solarEnergyKwh: number
  gridEnergyKwh: number
  solarEnabled: boolean
  windows: ChargeWindow[]
  preferredChargingTimes: ChargingTime[]
  slotsUsed: number
  slotsAvailable: number
  fullRangeKm: number
  rangeAtTargetKm: number
  currentSocPercent: number
  currentRangeKm: number
  prices: EnergyPrice[]
}
