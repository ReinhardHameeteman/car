<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ChargeControls from './components/ChargeControls.vue'
import PlanForm from './components/PlanForm.vue'
import PlanResult from './components/PlanResult.vue'
import SettingsForm from './components/SettingsForm.vue'
import StatusPanel from './components/StatusPanel.vue'
import { useBatteryState } from './composables/useBatteryState'
import { useSettings } from './composables/useSettings'
import { fetchEnergyPrices } from './services/energyPrices'
import { optimizeChargingProfile } from './services/optimizer'
import {
  applyPeblarSchedule,
  isPeblarConfigured,
  preparePeblarForProfileCharging,
  runDuePeblarRestore,
  schedulePeblarRestoreCheck,
} from './services/peblarApi'
import { fetchSolarForecast, isSolarConfigured, solarKwhAt } from './services/solarForecast'
import {
  getVehicle,
  setChargeMode,
  setChargingLimit,
  SkodaApiError,
  startCharging,
  stopCharging,
  updateChargingProfile,
} from './services/skodaApi'
import type { ChargingProfile, OptimizeResult, Vehicle } from './types'

const { settings, isConfigured } = useSettings()
const { battery, applyFromApi, markManualEdit } = useBatteryState()

const tab = ref<'status' | 'plan' | 'settings'>('status')
const vehicle = ref<Vehicle | null>(null)
const loading = ref(false)
const actionBusy = ref(false)
const planning = ref(false)
const applying = ref(false)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const plan = ref<OptimizeResult | null>(null)
const skodaRateLimited = ref(false)
const deferredPrompt = ref<BeforeInstallPromptEvent | null>(null)

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const charging = computed(() => vehicle.value?.charging)
const status = computed(() => charging.value?.status)
const canApplyPlan = computed(() => {
  if (!plan.value) return false
  if (settings.schedulerTarget === 'peblar') return isPeblarConfigured(settings)
  return isConfigured.value
})

onMounted(() => {
  window.addEventListener('beforeinstallprompt', ((e: Event) => {
    e.preventDefault()
    deferredPrompt.value = e as BeforeInstallPromptEvent
  }) as EventListener)

  void runDuePeblarRestore()
    .then((restored) => {
      if (restored) notice.value = 'Peblar charging mode restored.'
    })
    .catch(() => {
      /* retry next launch */
    })
  schedulePeblarRestoreCheck()

  if (isConfigured.value) {
    void refresh()
  } else if (settings.schedulerTarget === 'peblar' && isPeblarConfigured(settings)) {
    /* Peblar-only: status can use manual SOC */
  } else {
    tab.value = 'settings'
  }
})

function isRateLimitError(e: unknown): boolean {
  if (e instanceof SkodaApiError) return e.isRateLimitExceeded
  const text = formatErr(e)
  return /rate.?limit exceeded|rate-limit-exceeded/i.test(text)
}

async function refresh() {
  if (!isConfigured.value) {
    error.value = 'Configure VIN and API key first, or edit battery SOC below.'
    tab.value = 'status'
    return
  }
  loading.value = true
  error.value = null
  try {
    const response = await getVehicle(settings.apiKey, settings.vin)
    vehicle.value = response.vehicle
    skodaRateLimited.value = false
    const nextSoc = response.vehicle.charging?.status?.battery?.stateOfChargeInPercent
    const meters = response.vehicle.charging?.status?.battery?.remainingCruisingRangeInMeters
    if (nextSoc != null) {
      applyFromApi(nextSoc, meters != null ? meters / 1000 : null)
    }
    if (!settings.profileId && response.vehicle.chargingProfiles?.profiles?.length) {
      const current = response.vehicle.chargingProfiles.currentVehiclePositionProfile
      settings.profileId = current?.id ?? response.vehicle.chargingProfiles.profiles[0].id
    }
    if (response.errors?.length) {
      notice.value = response.errors.map((e) => e.description || e.type).join(' · ')
    } else {
      notice.value = null
    }
  } catch (e) {
    if (isRateLimitError(e)) {
      skodaRateLimited.value = true
      error.value = formatErr(e)
      tab.value = 'status'
    } else {
      error.value = formatErr(e)
    }
  } finally {
    loading.value = false
  }
}

async function onStart() {
  actionBusy.value = true
  error.value = null
  try {
    await startCharging(settings.apiKey, settings.vin)
    notice.value = 'Start charging requested.'
    await refresh()
  } catch (e) {
    if (isRateLimitError(e)) skodaRateLimited.value = true
    error.value = formatErr(e)
  } finally {
    actionBusy.value = false
  }
}

async function onStop() {
  actionBusy.value = true
  error.value = null
  try {
    await stopCharging(settings.apiKey, settings.vin)
    notice.value = 'Stop charging requested.'
    await refresh()
  } catch (e) {
    if (isRateLimitError(e)) skodaRateLimited.value = true
    error.value = formatErr(e)
  } finally {
    actionBusy.value = false
  }
}

async function onPlan(payload: {
  mode: 'km' | 'soc'
  desiredKm?: number
  targetSocPercent?: number
  finishBy: string
  useSolar: boolean
}) {
  planning.value = true
  error.value = null
  try {
    if (
      battery.source == null &&
      !skodaRateLimited.value &&
      isConfigured.value
    ) {
      await refresh()
    }
    const finishBy = new Date(payload.finishBy)
    if (Number.isNaN(finishBy.getTime()) || finishBy <= new Date()) {
      throw new Error('Finish time must be in the future.')
    }
    if (payload.mode === 'km') {
      if (!payload.desiredKm || payload.desiredKm <= 0) {
        throw new Error('Enter a desired distance greater than 0 km.')
      }
    } else if (
      payload.targetSocPercent == null ||
      payload.targetSocPercent < 50 ||
      payload.targetSocPercent > 100
    ) {
      throw new Error('Target SOC must be between 50% and 100%.')
    }

    const useSolar = payload.useSolar && isSolarConfigured(settings)
    if (payload.useSolar && !useSolar) {
      throw new Error('Fill in all solar settings (lat, lon, azimuth, tilt, Wp) to use solar power.')
    }

    const from = new Date()
    const prices = await fetchEnergyPrices(from, finishBy)
    if (!prices.length) {
      throw new Error('No day-ahead prices available for that window yet (tomorrow’s prices appear ~15:00 CET).')
    }

    if (useSolar) {
      const solar = await fetchSolarForecast({ ...settings }, from, finishBy)
      for (const slot of prices) {
        slot.solarKwh = solarKwhAt(solar, slot.start)
      }
    }

    const profile = selectedProfile()
    plan.value = optimizeChargingProfile({
      settings: { ...settings },
      prices,
      mode: payload.mode,
      desiredKm: payload.mode === 'km' ? payload.desiredKm : undefined,
      targetSocPercent: payload.mode === 'soc' ? payload.targetSocPercent : undefined,
      finishBy,
      currentSocPercent: battery.socPercent,
      currentRangeKm: battery.rangeKm ?? 0,
      existingTimes: profile?.preferredChargingTimes,
      useSolar,
    })
  } catch (e) {
    error.value = formatErr(e)
  } finally {
    planning.value = false
  }
}

function selectedProfile(): ChargingProfile | undefined {
  const profiles = vehicle.value?.chargingProfiles?.profiles ?? []
  if (!profiles.length) return undefined
  return (
    profiles.find((p) => p.id === settings.profileId) ||
    profiles.find(
      (p) => p.id === vehicle.value?.chargingProfiles?.currentVehiclePositionProfile?.id,
    ) ||
    profiles[0]
  )
}

async function onApply() {
  if (!plan.value) return
  applying.value = true
  error.value = null
  try {
    const restoreAt =
      plan.value.windows.length > 0
        ? new Date(Math.max(...plan.value.windows.map((w) => w.end.getTime())))
        : new Date()

    if (settings.schedulerTarget === 'peblar') {
      if (!isPeblarConfigured(settings)) {
        throw new Error('Configure Peblar host, API token and web password first.')
      }
      if (!plan.value.windows.length) {
        throw new Error('No charging windows to write to Peblar.')
      }

      // Peblar-only — no Škoda calls (profile/rate-limit issues must not block apply).
      const peblar = await applyPeblarSchedule({ ...settings }, plan.value.windows, restoreAt)
      notice.value =
        `Peblar schedule applied · target ${plan.value.targetSocPercent}% · ` +
        `restore ${peblar.previousMode} after ${restoreAt.toLocaleString()}`
    } else {
      if (!vehicle.value) await refresh()
      const profile = selectedProfile()
      if (!profile) throw new Error('No charging profile found on the vehicle.')

      const updated: ChargingProfile = {
        ...profile,
        preferredChargingTimes: plan.value.preferredChargingTimes,
        settings: {
          ...profile.settings,
          targetStateOfChargeInPercent: plan.value.targetSocPercent,
          minBatteryStateOfCharge: {
            enabled: true,
            minimumBatteryStateOfChargeInPercent: settings.minSocPercent,
          },
          maxChargingCurrent: profile.settings.maxChargingCurrent ?? 'MAXIMUM',
          autoUnlockPlugWhenCharged: profile.settings.autoUnlockPlugWhenCharged ?? 'OFF',
        },
        timers: profile.timers ?? [],
      }

      const carNotes: string[] = []
      try {
        await updateChargingProfile(settings.apiKey, settings.vin, updated)
        settings.profileId = profile.id
      } catch (e) {
        carNotes.push(`profile: ${formatErr(e)}`)
      }
      try {
        await setChargingLimit(settings.apiKey, settings.vin, plan.value.targetSocPercent)
      } catch (e) {
        carNotes.push(`limit: ${formatErr(e)}`)
      }
      try {
        await setChargeMode(settings.apiKey, settings.vin, 'PREFERRED_CHARGING_TIMES')
      } catch (e) {
        carNotes.push(`mode: ${formatErr(e)}`)
      }

      let peblarNote = ''
      if (isPeblarConfigured(settings) && plan.value.windows.length > 0) {
        try {
          const peblar = await preparePeblarForProfileCharging({ ...settings }, restoreAt)
          peblarNote =
            peblar.previousMode === 'default'
              ? ' · Peblar already in default mode'
              : ` · Peblar ${peblar.previousMode} → default until ${restoreAt.toLocaleString()}`
        } catch (e) {
          peblarNote = ` · Peblar: ${formatErr(e)}`
        }
      } else if (settings.peblarHost.trim() && !isPeblarConfigured(settings)) {
        peblarNote = ' · Peblar skipped (set host, API token and web password)'
      }

      if (carNotes.length) {
        notice.value =
          `Applied with warnings · target ${plan.value.targetSocPercent}%` +
          peblarNote +
          ` · ${carNotes.join(' · ')}`
      } else {
        notice.value =
          `Profile “${profile.name}” updated · target ${plan.value.targetSocPercent}% · preferred times set` +
          peblarNote
      }
      void refresh()
    }
  } catch (e) {
    error.value = formatErr(e)
  } finally {
    applying.value = false
  }
}

async function installApp() {
  if (!deferredPrompt.value) return
  await deferredPrompt.value.prompt()
  await deferredPrompt.value.userChoice
  deferredPrompt.value = null
}

function formatErr(e: unknown): string {
  if (e instanceof SkodaApiError) {
    if (e.isRateLimitExceeded) {
      return (
        'Škoda API rate limit exceeded (20/hour). Edit battery SOC on the Status tab, or wait and refresh. ' +
        'Peblar Apply does not use Škoda.'
      )
    }
    if (e.isVehicleNotAccepting) {
      return (
        'The car is offline or not accepting commands right now. ' +
        'We retried automatically — try again in a minute (or wake the car via MyŠkoda).'
      )
    }
    return [e.message, e.detail].filter(Boolean).join(' — ')
  }
  if (e && typeof e === 'object' && 'detail' in e) {
    const err = e as { message?: string; detail?: string }
    return [err.message, err.detail].filter(Boolean).join(' — ')
  }
  if (e instanceof TypeError && /fetch/i.test(e.message)) {
    return (
      'Failed to reach the app server — your phone cannot reach the laptop proxy. ' +
      'Keep the server running, stay on the same Wi‑Fi, allow Node through Windows Firewall, ' +
      'or reopen the current HTTPS tunnel URL.'
    )
  }
  return e instanceof Error ? e.message : String(e)
}
</script>

<template>
  <div class="app-shell">
    <header class="brand">
      <h1>Enyaq Charge</h1>
      <p>Price-aware charging profiles for your Škoda, using Dutch 15-minute day-ahead electricity prices.</p>
      <div class="actions" style="margin-top: 0.75rem">
        <button
          v-if="deferredPrompt"
          class="btn btn-secondary"
          type="button"
          @click="installApp"
        >
          Install on Android
        </button>
      </div>
    </header>

    <nav class="tabs">
      <button type="button" :class="{ active: tab === 'status' }" @click="tab = 'status'">Status</button>
      <button type="button" :class="{ active: tab === 'plan' }" @click="tab = 'plan'">Plan</button>
      <button type="button" :class="{ active: tab === 'settings' }" @click="tab = 'settings'">Settings</button>
    </nav>

    <div v-if="error" class="alert alert-error">{{ error }}</div>
    <div v-else-if="notice" class="alert">{{ notice }}</div>

    <template v-if="tab === 'status'">
      <StatusPanel
        v-model:soc="battery.socPercent"
        v-model:range-km="battery.rangeKm"
        :vehicle-name="vehicle?.name"
        :state="status?.state"
        :power-kw="status?.chargePowerInKw"
        :charge-type="status?.chargeType"
        :mode="charging?.settings?.preferredChargeMode"
        :target-soc="charging?.settings?.targetStateOfChargeInPercent"
        :in-saved-location="charging?.isVehicleInSavedLocation"
        :loading="loading"
        :rate-limited="skodaRateLimited"
        :source="battery.source"
        :updated-at="battery.updatedAt"
        @refresh="refresh"
        @edit="markManualEdit"
      />
      <ChargeControls
        :busy="actionBusy"
        :can-control="isConfigured && !skodaRateLimited"
        @start="onStart"
        @stop="onStop"
      />
    </template>

    <template v-else-if="tab === 'plan'">
      <PlanForm
        :planning="planning"
        :applying="applying"
        :can-apply="canApplyPlan"
        @plan="onPlan"
        @apply="onApply"
      />
      <PlanResult :result="plan" />
    </template>

    <template v-else>
      <SettingsForm
        @saved="() => {
          notice = 'Settings saved.'
          if (isConfigured && !skodaRateLimited) refresh()
        }"
      />
    </template>
  </div>
</template>
