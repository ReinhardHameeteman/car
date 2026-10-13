import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'nl.example.skodapwa',
  appName: 'Skoda PWA',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    // Required so CapacitorHttp / WebView can call Peblar over plain HTTP on the LAN.
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
}

export default config
