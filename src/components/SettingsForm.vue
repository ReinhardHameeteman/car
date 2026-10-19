<script setup lang="ts">
import { ref } from 'vue'
import { useSettings } from '../composables/useSettings'

type SettingsTab = 'car' | 'charger' | 'solar'

const { settings } = useSettings()
const emit = defineEmits<{ saved: [] }>()
const tab = ref<SettingsTab>('car')

function save() {
  settings.vin = settings.vin.trim().toUpperCase()
  settings.apiKey = settings.apiKey.trim()
  settings.peblarHost = settings.peblarHost.trim()
  settings.peblarApiToken = settings.peblarApiToken.trim()
  emit('saved')
}

function optionalNumber(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}
</script>

<template>
  <section class="panel">
    <h2>Settings</h2>
    <p class="muted" style="margin-bottom: 0.9rem">
      Stored locally on this device.
    </p>

    <nav class="tabs settings-tabs" aria-label="Settings sections">
      <button type="button" :class="{ active: tab === 'car' }" @click="tab = 'car'">Car</button>
      <button type="button" :class="{ active: tab === 'charger' }" @click="tab = 'charger'">
        Charger
      </button>
      <button type="button" :class="{ active: tab === 'solar' }" @click="tab = 'solar'">Solar</button>
    </nav>

    <template v-if="tab === 'car'">
      <p class="muted" style="margin-bottom: 0.85rem">
        Create an API key in the MyŠkoda app. Used for status, start/stop, and the Škoda scheduler.
      </p>
      <div class="grid-2">
        <div class="field">
          <label for="vin">VIN</label>
          <input
            id="vin"
            v-model="settings.vin"
            maxlength="17"
            autocomplete="off"
            placeholder="17 characters"
          />
        </div>
        <div class="field">
          <label for="apiKey">API key</label>
          <input id="apiKey" v-model="settings.apiKey" type="password" autocomplete="off" />
        </div>
        <div class="field">
          <label for="minSoc">Minimal SOC (%)</label>
          <input
            id="minSoc"
            v-model.number="settings.minSocPercent"
            type="number"
            min="10"
            max="50"
            step="10"
          />
        </div>
        <div class="field">
          <label for="maxSoc">Default max SOC (%)</label>
          <input
            id="maxSoc"
            v-model.number="settings.defaultMaxSocPercent"
            type="number"
            min="50"
            max="100"
            step="10"
          />
        </div>
        <div class="field">
          <label for="capacity">Battery capacity (kWh)</label>
          <input
            id="capacity"
            v-model.number="settings.batteryCapacityKwh"
            type="number"
            min="20"
            max="120"
            step="0.1"
          />
        </div>
        <div class="field">
          <label for="consumption">Consumption (kWh / 100 km)</label>
          <input
            id="consumption"
            v-model.number="settings.consumptionKwhPer100Km"
            type="number"
            min="10"
            max="40"
            step="0.1"
          />
        </div>
      </div>
    </template>

    <template v-else-if="tab === 'charger'">
      <p class="muted" style="margin-bottom: 0.85rem">
        Choose where optimized slots are written, and configure the Peblar charger.
      </p>

      <div class="field" style="margin-bottom: 1rem">
        <label>Scheduler</label>
        <div class="mode-toggle">
          <button
            type="button"
            :class="{ active: settings.schedulerTarget === 'skoda' }"
            @click="settings.schedulerTarget = 'skoda'"
          >
            Škoda profile
          </button>
          <button
            type="button"
            :class="{ active: settings.schedulerTarget === 'peblar' }"
            @click="settings.schedulerTarget = 'peblar'"
          >
            Peblar schedule
          </button>
        </div>
        <p class="muted" style="margin-top: 0.45rem">
          <template v-if="settings.schedulerTarget === 'skoda'">
            Writes preferred charging times to the car; Peblar is temporarily set to default mode.
          </template>
          <template v-else>
            Writes the schedule to Peblar (visible in the Peblar web app) and sets scheduled mode.
          </template>
        </p>
      </div>

      <div class="grid-2">
        <div class="field">
          <label for="peblarHost">Host / IP</label>
          <input
            id="peblarHost"
            v-model="settings.peblarHost"
            autocomplete="off"
            placeholder="192.168.1.50"
          />
        </div>
        <div class="field">
          <label for="peblarToken">API token</label>
          <input
            id="peblarToken"
            v-model="settings.peblarApiToken"
            type="password"
            autocomplete="off"
          />
        </div>
        <div class="field">
          <label for="peblarPassword">Web password</label>
          <input
            id="peblarPassword"
            v-model="settings.peblarPassword"
            type="password"
            autocomplete="off"
          />
        </div>
        <div class="field">
          <label for="power">Home charge power (kW)</label>
          <input
            id="power"
            v-model.number="settings.chargePowerKw"
            type="number"
            min="1.4"
            max="22"
            step="0.1"
          />
        </div>
      </div>
      <p class="muted" style="margin-top: 0.75rem">
        Needs host, API token (Read/Write), and the web UI password for mode/schedule changes.
        On Android the phone must be on the same home Wi‑Fi as the charger (LAN IP is not
        reachable over mobile data).
      </p>
    </template>

    <template v-else>
      <p class="muted" style="margin-bottom: 0.85rem">
        Used with jeroen.nl solar yield forecast. Azimuth: 0° = South, −90° = East, 90° = West.
      </p>
      <div class="grid-2">
        <div class="field">
          <label for="lat">Latitude</label>
          <input
            id="lat"
            type="number"
            step="0.0001"
            :value="settings.solarLatitude ?? ''"
            @input="settings.solarLatitude = optionalNumber(($event.target as HTMLInputElement).value)"
          />
        </div>
        <div class="field">
          <label for="lon">Longitude</label>
          <input
            id="lon"
            type="number"
            step="0.0001"
            :value="settings.solarLongitude ?? ''"
            @input="settings.solarLongitude = optionalNumber(($event.target as HTMLInputElement).value)"
          />
        </div>
        <div class="field">
          <label for="azimuth">Azimuth (°)</label>
          <input
            id="azimuth"
            type="number"
            min="-180"
            max="180"
            step="1"
            :value="settings.solarAzimuth ?? ''"
            @input="settings.solarAzimuth = optionalNumber(($event.target as HTMLInputElement).value)"
          />
        </div>
        <div class="field">
          <label for="tilt">Tilt (°)</label>
          <input
            id="tilt"
            type="number"
            min="0"
            max="90"
            step="1"
            :value="settings.solarTilt ?? ''"
            @input="settings.solarTilt = optionalNumber(($event.target as HTMLInputElement).value)"
          />
        </div>
        <div class="field">
          <label for="wp">Installed power (Wp)</label>
          <input
            id="wp"
            type="number"
            min="1"
            step="1"
            :value="settings.solarInstalledWp ?? ''"
            @input="settings.solarInstalledWp = optionalNumber(($event.target as HTMLInputElement).value)"
          />
        </div>
      </div>
    </template>

    <div class="actions">
      <button class="btn btn-primary" type="button" @click="save">Save settings</button>
    </div>
  </section>
</template>
