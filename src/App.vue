<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ChargeControls from './components/ChargeControls.vue'
import PlanForm from './components/PlanForm.vue'
import PlanResult from './components/PlanResult.vue'
import SettingsForm from './components/SettingsForm.vue'
import StatusPanel from './components/StatusPanel.vue'
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
  startCharging,
  stopCharging,
  updateChargingProfile,
} from './services/skodaApi'
import type { ChargingProfile, OptimizeResult, Vehicle } from './types'

const { settings, isConfigured } = useSettings()

const tab = ref<'status' | 'plan' | 'settings'>('status')
const vehicle = ref<Vehicle | null>(null)
const loading = ref(false)
const actionBusy = ref(false)
const planning = ref(false)
const applying = ref(false)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const plan = ref<OptimizeResult | null>(null)
const deferredPrompt = ref<BeforeInstallPromptEvent | null>(null)

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const charging = computed(() => vehicle.value?.charging)
const status = computed(() => charging.value?.status)
const soc = computed(() => status.value?.battery?.stateOfChargeInPercent)
const rangeKm = computed(() => {
  const meters = status.value?.battery?.remainingCruisingRangeInMeters
  return meters != null ? meters / 1000 : undefined
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
  } else {
    tab.value = 'settings'
  }
})

async function refresh() {
  if (!isConfigured.value) {
    error.value = 'Configure VIN and API key first.'
    tab.value = 'settings'
    return
  }
  loading.value = true
  error.value = null
  try {
    const response = await getVehicle(settings.apiKey, settings.vin)
    vehicle.value = response.vehicle
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
    error.value = e instanceof Error ? e.message + ('detail' in e ? `: ${(e as { detail?: string }).detail}` : '') : String(e)
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
    if (!vehicle.value) await refresh()
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
      desiredKm: payload.mode === 'km' ? payload.desiredKm : undefined,
      targetSocPercent: payload.mode === 'soc' ? payload.targetSocPercent : undefined,
      finishBy,
      currentSocPercent: soc.value ?? settings.minSocPercent,
      currentRangeKm: rangeKm.value ?? 0,
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
    if (!vehicle.value) await refresh()
    const profile = selectedProfile()
    if (!profile) throw new Error('No charging profile found on the vehicle.')

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

      // Car charges whenever Peblar allows current; target SOC still set on the vehicle.
      const updated: ChargingProfile = {
        ...profile,
        preferredChargingTimes: (profile.preferredChargingTimes ?? []).map((t) => ({
          ...t,
          enabled: false,
        })),
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
      await updateChargingProfile(settings.apiKey, settings.vin, updated)
      await setChargingLimit(settings.apiKey, settings.vin, plan.value.targetSocPercent)
      await setChargeMode(settings.apiKey, settings.vin, 'MANUAL')
      settings.profileId = profile.id

      const peblar = await applyPeblarSchedule({ ...settings }, plan.value.windows, restoreAt)
      notice.value =
        `Peblar schedule applied · car manual · target ${plan.value.targetSocPercent}% · ` +
        `restore ${peblar.previousMode} after ${restoreAt.toLocaleString()}`
    } else {
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

      await updateChargingProfile(settings.apiKey, settings.vin, updated)
      await setChargingLimit(settings.apiKey, settings.vin, plan.value.targetSocPercent)
      await setChargeMode(settings.apiKey, settings.vin, 'PREFERRED_CHARGING_TIMES')
      settings.profileId = profile.id

      let peblarNote = ''
      if (isPeblarConfigured(settings) && plan.value.windows.length > 0) {
        const peblar = await preparePeblarForProfileCharging({ ...settings }, restoreAt)
        peblarNote =
          peblar.previousMode === 'default'
            ? ' · Peblar already in default mode'
            : ` · Peblar ${peblar.previousMode} → default until ${restoreAt.toLocaleString()}`
      } else if (settings.peblarHost.trim() && !isPeblarConfigured(settings)) {
        peblarNote = ' · Peblar skipped (set host, API token and web password)'
      }

      notice.value =
        `Profile “${profile.name}” updated · target ${plan.value.targetSocPercent}% · preferred times set` +
        peblarNote
    }

    await refresh()
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
        :vehicle-name="vehicle?.name"
        :state="status?.state"
        :soc="soc"
        :range-km="rangeKm"
        :power-kw="status?.chargePowerInKw"
        :charge-type="status?.chargeType"
        :mode="charging?.settings?.preferredChargeMode"
        :target-soc="charging?.settings?.targetStateOfChargeInPercent"
        :in-saved-location="charging?.isVehicleInSavedLocation"
        :updated-at="charging?.carCapturedTimestamp"
        :loading="loading"
        @refresh="refresh"
      />
      <ChargeControls
        :busy="actionBusy"
        :can-control="isConfigured"
        @start="onStart"
        @stop="onStop"
      />
    </template>

    <template v-else-if="tab === 'plan'">
      <PlanForm
        :planning="planning"
        :applying="applying"
        :can-apply="!!plan && isConfigured"
        @plan="onPlan"
        @apply="onApply"
      />
      <PlanResult :result="plan" />
    </template>

    <template v-else>
      <SettingsForm @saved="() => { notice = 'Settings saved.'; if (isConfigured) refresh() }" />
      <section class="panel">
        <h2>Install tip</h2>
        <p class="muted">
          Open this app over HTTPS on your phone (or via your home server URL), then use
          Chrome’s “Install app” / “Add to Home screen”. The proxy server is required so
          browser calls to Skoda and EnergyZero are not blocked by CORS.
        </p>
      </section>
    </template>
  </div>
</template>
