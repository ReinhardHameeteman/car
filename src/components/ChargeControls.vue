<script setup lang="ts">
defineProps<{ busy?: boolean; canControl?: boolean }>()
defineEmits<{ start: []; stop: [] }>()
</script>

<template>
  <section class="panel">
    <h2>Force charge</h2>
    <p class="muted">Starts or stops charging immediately (manual override).</p>
    <div class="actions">
      <button
        class="btn btn-primary"
        type="button"
        :disabled="busy || !canControl"
        @click="$emit('start')"
      >
        Start charging
      </button>
      <button
        class="btn btn-danger"
        type="button"
        :disabled="busy || !canControl"
        @click="$emit('stop')"
      >
        Stop charging
      </button>
    </div>
  </section>
</template>
