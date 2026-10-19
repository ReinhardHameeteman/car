import { Capacitor } from '@capacitor/core'

/** True inside the Capacitor Android/iOS shell (CapacitorHttp patches fetch). */
export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform()
}

export function skodaBaseUrl(): string {
  return isNativeApp()
    ? 'https://public.api.connect.skoda-auto.cz'
    : '/api/skoda'
}

export function energyBaseUrl(): string {
  return isNativeApp()
    ? 'https://epexprijzen.nl'
    : '/api/energy'
}

export function jeroenBaseUrl(): string {
  return isNativeApp() ? 'https://jeroen.nl' : '/api/jeroen'
}

export function peblarOrigin(host: string): string {
  const cleaned = host
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
  return `http://${cleaned}`
}

/** Friendlier message when the phone cannot reach a LAN Peblar IP. */
export function peblarConnectionHint(host: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (
    !/failed to connect|connection refused|network is unreachable|timed out|timeout|ECONNREFUSED|ENETUNREACH|Cleartext/i.test(
      raw,
    )
  ) {
    return raw
  }
  const ip = host.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || 'the Peblar IP'
  return (
    `Cannot reach Peblar at ${ip}. ` +
    `Put the phone on the same home Wi‑Fi as the charger (not mobile data / guest Wi‑Fi), ` +
    `confirm the IP in Settings, then retry.`
  )
}
