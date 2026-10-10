import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'Enyaq Charge',
        short_name: 'Enyaq',
        description: 'Cost-optimized charging for Škoda Enyaq',
        theme_color: '#0b3d2e',
        background_color: '#071a14',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: '/',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api/skoda': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/api/energy': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/api/meteo': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/api/peblar': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
})
