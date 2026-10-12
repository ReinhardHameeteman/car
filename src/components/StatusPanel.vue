<script setup lang="ts">
defineProps<{
  state?: string
  powerKw?: number
  chargeType?: string
  mode?: string
  targetSoc?: number
  inSavedLocation?: boolean
  vehicleName?: string
  loading?: boolean
  rateLimited?: boolean
  source?: 'api' | 'manual' | null
  updatedAt?: string | null
}>()

const soc = defineModel<number>('soc', { required: true })
const rangeKm = defineModel<number | null>('rangeKm', { required: true })

defineEmits<{
  refresh: []
  edit: []
}>()

function labelState(state?: string) {
  if (!state) return 'Unknown'
  return state.replaceAll('_', ' ').toLowerCase()
}

function badgeClass(state?: string) {
  if (state === 'CHARGING') return 'badge-ok'
  if (state === 'READY_FOR_CHARGING' || state === 'CONSERVING') return 'badge-warn'
  return 'badge-idle'
}
</script>

<template>
  <section class="panel">
    <div style="display: flex; justify-content: space-between; gap: 0.75rem; align-items: start">
      <div>
        <h2>{{ vehicleName || 'Vehicle status' }}</h2>
        <p class="muted" v-if="updatedAt">
          {{ source === 'manual' ? 'Edited' : 'Updated' }}
          {{ new Date(updatedAt).toLocaleString() }}
        </p>
      </div>
      <button class="btn btn-secondary" type="button" :disabled="loading" @click="$emit('refresh')">
        {{ loading ? 'Refreshing…' : 'Refresh' }}
      </button>
    </div>

    <div v-if="rateLimited" class="alert alert-error" style="margin-top: 0.85rem">
      Škoda API limit reached (20 requests/hour). Edit the fields below or wait and refresh later.
    </div>

    <div style="margin: 0.9rem 0 1rem">
      <span class="badge" :class="badgeClass(state)">{{ labelState(state) }}</span>
      <span v-if="source === 'manual'" class="badge badge-warn" style="margin-left: 0.4rem">Edited</span>
      <span v-else-if="source === 'api'" class="badge badge-ok" style="margin-left: 0.4rem">From Škoda</span>
      <span v-if="inSavedLocation" class="badge badge-ok" style="margin-left: 0.4rem">Saved location</span>
    </div>

    <div class="grid-2" style="margin-bottom: 0.85rem">
      <div class="field">
        <label for="battery-soc">Battery SOC (%)</label>
        <input
          id="battery-soc"
          v-model.number="soc"
          type="number"
          min="0"
          max="100"
          step="1"
          @change="$emit('edit')"
        />
      </div>
      <div class="field">
        <label for="battery-range">Range (km)</label>
        <input
          id="battery-range"
          v-model.number="rangeKm"
          type="number"
          min="0"
          max="800"
          step="1"
          placeholder="optional"
          @change="$emit('edit')"
        />
      </div>
    </div>

    <div class="stat-row">
      <div class="stat">
        <div class="label">Power</div>
        <div class="value">{{ powerKw != null ? powerKw.toFixed(1) : '—' }} kW</div>
      </div>
      <div class="stat">
        <div class="label">Target / mode</div>
        <div class="value" style="font-size: 1rem">
          {{ targetSoc ?? '—' }}% · {{ mode?.replaceAll('_', ' ') || '—' }}
        </div>
      </div>
    </div>
  </section>
</template>
