<script setup lang="ts">
defineProps<{
  state?: string
  soc?: number
  rangeKm?: number
  powerKw?: number
  chargeType?: string
  mode?: string
  targetSoc?: number
  inSavedLocation?: boolean
  vehicleName?: string
  updatedAt?: string
  loading?: boolean
}>()

defineEmits<{ refresh: [] }>()

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
        <p class="muted" v-if="updatedAt">Updated {{ new Date(updatedAt).toLocaleString() }}</p>
      </div>
      <button class="btn btn-secondary" type="button" :disabled="loading" @click="$emit('refresh')">
        {{ loading ? 'Refreshing…' : 'Refresh' }}
      </button>
    </div>

    <div style="margin: 0.9rem 0 1rem">
      <span class="badge" :class="badgeClass(state)">{{ labelState(state) }}</span>
      <span v-if="inSavedLocation" class="badge badge-ok" style="margin-left: 0.4rem">Saved location</span>
    </div>

    <div class="stat-row">
      <div class="stat">
        <div class="label">Battery</div>
        <div class="value">{{ soc ?? '—' }}%</div>
      </div>
      <div class="stat">
        <div class="label">Range</div>
        <div class="value">{{ rangeKm != null ? Math.round(rangeKm) : '—' }} km</div>
      </div>
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
