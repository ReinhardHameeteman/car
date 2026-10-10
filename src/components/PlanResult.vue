<script setup lang="ts">
import { computed, reactive } from 'vue'
import { useSettings } from '../composables/useSettings'
import type { EnergyPrice, OptimizeResult } from '../types'

const props = defineProps<{
  result: OptimizeResult | null
}>()

const { settings } = useSettings()

const tip = reactive({
  show: false,
  text: '',
  x: 0,
  y: 0,
})

function slotTip(slot: EnergyPrice): string {
  const parts = [
    slot.start.toLocaleString([], {
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }),
    `€${slot.priceEurPerKwh.toFixed(3)}/kWh`,
  ]
  if (props.result?.solarEnabled && (slot.solarKwh ?? 0) > 0) {
    parts.push(`solar ${slot.solarKwh!.toFixed(2)} kWh`)
  }
  return parts.join(' · ')
}

function onBarEnter(event: MouseEvent, slot: EnergyPrice) {
  tip.show = true
  tip.text = slotTip(slot)
  tip.x = event.clientX
  tip.y = event.clientY
}

function onBarMove(event: MouseEvent, slot: EnergyPrice) {
  tip.show = true
  tip.text = slotTip(slot)
  tip.x = event.clientX
  tip.y = event.clientY
}

function onBarLeave() {
  tip.show = false
}

const chartWidth = 640
const chartHeight = 180
const pad = { top: 16, right: 12, bottom: 36, left: 44 }

const timeRange = computed(() => {
  const prices = props.result?.prices ?? []
  if (!prices.length) {
    const now = Date.now()
    return { start: now, end: now + 3600000 }
  }
  return {
    start: prices[0].start.getTime(),
    end: prices[prices.length - 1].end.getTime(),
  }
})

const maxPrice = computed(() => {
  const prices = props.result?.prices ?? []
  if (!prices.length) return 1
  return Math.max(...prices.map((p) => Math.abs(p.priceEurPerKwh)), 0.01)
})

const minPrice = computed(() => {
  const prices = props.result?.prices ?? []
  if (!prices.length) return 0
  return Math.min(...prices.map((p) => p.priceEurPerKwh))
})

function xAt(time: number): number {
  const { start, end } = timeRange.value
  const span = Math.max(end - start, 1)
  const inner = chartWidth - pad.left - pad.right
  return pad.left + ((time - start) / span) * inner
}

function priceY(price: number): number {
  const inner = chartHeight - pad.top - pad.bottom
  const min = Math.min(minPrice.value, 0)
  const max = maxPrice.value
  const span = Math.max(max - min, 0.01)
  return pad.top + inner - ((price - min) / span) * inner
}

const pricePath = computed(() => {
  const prices = props.result?.prices ?? []
  if (!prices.length) return ''
  return prices
    .map((slot, i) => {
      const x0 = xAt(slot.start.getTime())
      const x1 = xAt(slot.end.getTime())
      const y = priceY(slot.priceEurPerKwh)
      return i === 0 ? `M ${x0} ${y} L ${x1} ${y}` : `L ${x0} ${y} L ${x1} ${y}`
    })
    .join(' ')
})

const chargeRects = computed(() => {
  if (!props.result) return []
  return props.result.windows.map((w) => {
    const x = xAt(w.start.getTime())
    const width = Math.max(2, xAt(w.end.getTime()) - x)
    return {
      x,
      width,
      label: `${formatTime(w.start)}–${formatTime(w.end)}`,
      cost: w.costEur,
    }
  })
})

const solarBands = computed(() => {
  const result = props.result
  if (!result?.solarEnabled) return []
  const maxSolar = Math.max(...result.prices.map((p) => p.solarKwh ?? 0), 0.001)
  return result.prices
    .filter((p) => (p.solarKwh ?? 0) > 0.01)
    .map((p) => {
      const x = xAt(p.start.getTime())
      return {
        x,
        width: Math.max(1, xAt(p.end.getTime()) - x),
        opacity: 0.12 + 0.35 * ((p.solarKwh ?? 0) / maxSolar),
      }
    })
})

  /** SOC over time: flat when idle, rises during charge windows. */
  const socPoints = computed(() => {
  const result = props.result
  if (!result) return [] as { x: number; y: number; t: number; soc: number }[]

  const charging = new Set<number>()
  for (const w of result.windows) {
    for (const slot of result.prices) {
      if (slot.start >= w.start && slot.end <= w.end) {
        charging.add(slot.start.getTime())
      }
    }
  }

  const socPerChargeSlot =
    result.slotsUsed > 0
      ? (result.targetSocPercent - result.currentSocPercent) / result.slotsUsed
      : 0

  let soc = result.currentSocPercent
  const points: { x: number; y: number; t: number; soc: number }[] = []
  const innerH = chartHeight - pad.top - pad.bottom

  const push = (t: number, value: number) => {
    const y = pad.top + innerH - (Math.min(100, Math.max(0, value)) / 100) * innerH
    points.push({ x: xAt(t), y, t, soc: value })
  }

  if (!result.prices.length) {
    push(timeRange.value.start, soc)
    push(timeRange.value.end, result.targetSocPercent)
    return points
  }

  push(result.prices[0].start.getTime(), soc)
  for (const slot of result.prices) {
    if (charging.has(slot.start.getTime()) && soc < result.targetSocPercent) {
      soc = Math.min(result.targetSocPercent, soc + socPerChargeSlot)
    }
    push(slot.end.getTime(), soc)
  }
  return points
})

const socPath = computed(() => {
  const pts = socPoints.value
  if (!pts.length) return ''
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
})

const axisTicks = computed(() => {
  const { start, end } = timeRange.value
  const span = end - start
  const count = span > 36 * 3600000 ? 6 : span > 12 * 3600000 ? 5 : 4
  const ticks: { x: number; label: string }[] = []
  for (let i = 0; i <= count; i++) {
    const t = start + (span * i) / count
    ticks.push({
      x: xAt(t),
      label: new Date(t).toLocaleString([], {
        weekday: i === 0 || i === count ? 'short' : undefined,
        hour: '2-digit',
        minute: '2-digit',
      }),
    })
  }
  return ticks
})

function formatTime(d: Date) {
  return d.toLocaleString([], {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function isSelected(slot: EnergyPrice): boolean {
  if (!props.result) return false
  return props.result.windows.some((w) => slot.start >= w.start && slot.end <= w.end)
}

function barHeight(price: number): string {
  return `${Math.max(8, (Math.abs(price) / maxPrice.value) * 100)}%`
}
</script>

<template>
  <section v-if="result" class="panel plan-result">
    <h2>Optimized plan</h2>

    <div class="cost-hero">
      <div class="cost-hero-label">Total estimated charging cost</div>
      <div class="cost-hero-value">€{{ result.estimatedCostEur.toFixed(2) }}</div>
      <p class="muted">
        {{ result.energyNeededKwh.toFixed(1) }} kWh · target {{ result.targetSocPercent }}%
        ({{ Math.round(result.rangeAtTargetKm) }} km)
        · {{ settings.consumptionKwhPer100Km }} kWh/100 km
      </p>
      <p v-if="result.solarEnabled" class="muted" style="margin-top: 0.35rem">
        Solar {{ result.solarEnergyKwh.toFixed(1) }} kWh free ·
        grid {{ result.gridEnergyKwh.toFixed(1) }} kWh
      </p>
    </div>

    <div v-if="result.warning" class="alert">{{ result.warning }}</div>

    <div class="chart-block">
      <div class="chart-title">When the car will charge</div>
      <p class="muted chart-subtitle">
        Green bands = charging.
        <template v-if="result.solarEnabled"> Amber underlay = forecast solar.</template>
        Yellow line = day-ahead price. White line = estimated SOC.
      </p>

      <svg
        class="timeline-chart"
        :viewBox="`0 0 ${chartWidth} ${chartHeight}`"
        role="img"
        aria-label="Charging schedule and price graph"
      >
        <!-- solar availability underlay -->
        <rect
          v-for="(band, i) in solarBands"
          :key="'s' + i"
          :x="band.x"
          :y="pad.top"
          :width="band.width"
          :height="chartHeight - pad.top - pad.bottom"
          class="solar-band"
          :opacity="band.opacity"
        />

        <!-- charge windows -->
        <rect
          v-for="(rect, i) in chargeRects"
          :key="'w' + i"
          :x="rect.x"
          :y="pad.top"
          :width="rect.width"
          :height="chartHeight - pad.top - pad.bottom"
          class="charge-band"
        />

        <!-- zero / grid -->
        <line
          :x1="pad.left"
          :x2="chartWidth - pad.right"
          :y1="priceY(0)"
          :y2="priceY(0)"
          class="grid-line"
        />

        <!-- price step line -->
        <path v-if="pricePath" :d="pricePath" class="price-line" fill="none" />

        <!-- SOC progression -->
        <path v-if="socPath" :d="socPath" class="soc-line" fill="none" />

        <!-- axes -->
        <line
          :x1="pad.left"
          :x2="pad.left"
          :y1="pad.top"
          :y2="chartHeight - pad.bottom"
          class="axis"
        />
        <line
          :x1="pad.left"
          :x2="chartWidth - pad.right"
          :y1="chartHeight - pad.bottom"
          :y2="chartHeight - pad.bottom"
          class="axis"
        />

        <text :x="pad.left - 6" :y="pad.top + 4" class="axis-label" text-anchor="end">100%</text>
        <text
          :x="pad.left - 6"
          :y="chartHeight - pad.bottom"
          class="axis-label"
          text-anchor="end"
        >
          0%
        </text>

        <g v-for="(tick, i) in axisTicks" :key="'t' + i">
          <line
            :x1="tick.x"
            :x2="tick.x"
            :y1="chartHeight - pad.bottom"
            :y2="chartHeight - pad.bottom + 4"
            class="axis"
          />
          <text
            :x="tick.x"
            :y="chartHeight - 10"
            class="axis-label"
            text-anchor="middle"
          >
            {{ tick.label }}
          </text>
        </g>
      </svg>
    </div>

    <div class="stat-row">
      <div class="stat">
        <div class="label">From SOC</div>
        <div class="value">{{ result.currentSocPercent }}%</div>
      </div>
      <div class="stat">
        <div class="label">To SOC</div>
        <div class="value">{{ result.targetSocPercent }}%</div>
      </div>
      <div class="stat">
        <div class="label">Charge slots</div>
        <div class="value">{{ result.slotsUsed }}</div>
      </div>
      <div class="stat">
        <div class="label">Windows</div>
        <div class="value">{{ result.windows.length }}</div>
      </div>
    </div>

    <div class="chart-block">
      <div class="chart-title">Selected price slots</div>
      <div class="price-chart" aria-label="Day-ahead price bars">
        <div
          v-for="(slot, i) in result.prices"
          :key="i"
          class="price-bar"
          :class="{ selected: isSelected(slot) }"
          :style="{ height: barHeight(slot.priceEurPerKwh) }"
          @mouseenter="onBarEnter($event, slot)"
          @mousemove="onBarMove($event, slot)"
          @mouseleave="onBarLeave"
        />
      </div>
      <Teleport to="body">
        <div
          v-if="tip.show"
          class="price-tip"
          :style="{ left: `${tip.x + 12}px`, top: `${tip.y + 12}px` }"
        >
          {{ tip.text }}
        </div>
      </Teleport>
    </div>

    <div class="window-list">
      <div v-for="(w, i) in result.windows" :key="i" class="window-item">
        <div>
          <strong>Window {{ i + 1 }}</strong>
          <div class="muted">{{ formatTime(w.start) }} → {{ formatTime(w.end) }}</div>
        </div>
        <div style="text-align: right">
          <div>€{{ w.costEur.toFixed(2) }}</div>
          <div class="muted">
            {{ w.energyKwh.toFixed(1) }} kWh
            <template v-if="result.solarEnabled">
              · solar {{ w.solarKwh.toFixed(1) }} / grid {{ w.gridKwh.toFixed(1) }}
            </template>
            · €{{ w.avgPrice.toFixed(3) }}/kWh
          </div>
        </div>
      </div>
      <p v-if="!result.windows.length" class="muted">
        No charging needed — battery already covers the trip. Estimated cost €0.00.
      </p>
    </div>
  </section>
</template>
