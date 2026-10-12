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

export function meteoBaseUrl(): string {
  return isNativeApp()
    ? 'https://api.open-meteo.com'
    : '/api/meteo'
}

export function peblarOrigin(host: string): string {
  const cleaned = host.replace(/^https?:\/\//, '').replace(/\/$/, '')
  return `http://${cleaned}`
}
