<script setup lang="ts">
import { computed, reactive } from 'vue'
import { useSettings } from '../composables/useSettings'
import { isPeblarConfigured } from '../services/peblarApi'
import { isSolarConfigured } from '../services/solarForecast'

export type PlanMode = 'km' | 'soc'

const emit = defineEmits<{
  plan: [
    payload: {
      mode: PlanMode
      desiredKm?: number
      targetSocPercent?: number
      finishBy: string
      useSolar: boolean
    },
  ]
  apply: []
}>()

defineProps<{
  planning?: boolean
  applying?: boolean
  canApply?: boolean
}>()

const { settings } = useSettings()

const form = reactive({
  mode: 'km' as PlanMode,
  desiredKm: 150,
  targetSocPercent: 80,
  finishBy: defaultFinishBy(),
  useSolar: false,
})

const solarReady = computed(() => isSolarConfigured(settings))
const peblarReady = computed(() => isPeblarConfigured(settings))
const applyLabel = computed(() =>
  settings.schedulerTarget === 'peblar' ? 'Apply to Peblar' : 'Apply to car',
)

function defaultFinishBy() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(7, 0, 0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function onPlan() {
  emit('plan', {
    mode: form.mode,
    desiredKm: form.mode === 'km' ? Number(form.desiredKm) : undefined,
    targetSocPercent: form.mode === 'soc' ? Number(form.targetSocPercent) : undefined,
    finishBy: form.finishBy,
    useSolar: form.useSolar && solarReady.value,
  })
}
</script>

<template>
  <section class="panel">
    <h2>Charging plan</h2>
    <p class="muted" style="margin-bottom: 0.9rem">
      Minimizes cost using Dutch 15-minute day-ahead prices, then writes the schedule to
      {{ settings.schedulerTarget === 'peblar' ? 'Peblar' : 'the car' }}
      (see Settings → Charging schedule).
    </p>

    <div class="field" style="margin-bottom: 0.85rem">
      <label>Plan by</label>
      <div class="mode-toggle">
        <button
          type="button"
          :class="{ active: form.mode === 'km' }"
          @click="form.mode = 'km'"
        >
          Desired km
        </button>
        <button
          type="button"
          :class="{ active: form.mode === 'soc' }"
          @click="form.mode = 'soc'"
        >
          Target SOC
        </button>
      </div>
    </div>

    <div class="grid-2">
      <div v-if="form.mode === 'km'" class="field">
        <label for="km">Desired km</label>
        <input id="km" v-model.number="form.desiredKm" type="number" min="1" max="800" step="1" />
      </div>
      <div v-else class="field">
        <label for="soc">Target SOC (%)</label>
        <input
          id="soc"
          v-model.number="form.targetSocPercent"
          type="number"
          min="50"
          max="100"
          step="10"
        />
      </div>
      <div class="field">
        <label for="finish">Finished by</label>
        <input id="finish" v-model="form.finishBy" type="datetime-local" />
      </div>
    </div>

    <label class="solar-toggle">
      <input v-model="form.useSolar" type="checkbox" :disabled="!solarReady" />
      <span>
        Prefer solar power (free)
        <span v-if="!solarReady" class="muted"> — set latitude, longitude, azimuth, tilt and Wp in Settings</span>
      </span>
    </label>

    <p
      v-if="settings.schedulerTarget === 'peblar' && !peblarReady"
      class="alert"
      style="margin-top: 0.85rem"
    >
      Peblar scheduler selected — fill in Peblar host, API token and web password in Settings.
    </p>

    <div class="actions">
      <button class="btn btn-secondary" type="button" :disabled="planning" @click="onPlan">
        {{ planning ? 'Calculating…' : 'Calculate plan' }}
      </button>
      <button
        class="btn btn-primary"
        type="button"
        :disabled="!canApply || applying || (settings.schedulerTarget === 'peblar' && !peblarReady)"
        @click="$emit('apply')"
      >
        {{ applying ? 'Applying…' : applyLabel }}
      </button>
    </div>
  </section>
</template>
