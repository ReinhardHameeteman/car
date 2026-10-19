# Enyaq Charge

Vue.js PWA that plans cost-optimized charging for a Škoda Enyaq using:

- [MyŠkoda Public API](https://public.api.connect.skoda-auto.cz/docs)
- Dutch day-ahead electricity prices via [epexprijzen.nl](https://epexprijzen.nl/api-documentatie) (Zonneplan quarterly)
  (falls back to hourly prices expanded to 15-minute slots when quarter-hour data is unavailable)

## Features

- Store **VIN**, **API key**, min SOC (default 20%), battery capacity and home charge power
- Show current charging status
- Force **start** / **stop** charging
- Plan charging from **desired km** + **finished-by** datetime
- Pick the cheapest 15-minute slots and write them as preferred charging times
- Raise the charge limit above the default 80% when the trip needs more range (with a warning)
- Installable on Android as a PWA

## Setup

Requirements: Node.js 20+ on your PATH.

If you used the portable Node under `.tools/node`, add it to PATH first:

```powershell
$env:PATH = "C:\dev\prive\car\.tools\node;$env:PATH"
```

```bash
npm install
npm run dev
```

- App: http://localhost:5173  
- API proxy: http://localhost:8787  

Create an API key in the **MyŠkoda** app, then enter VIN + key under **Settings**.

## Android app (Capacitor) — recommended

Native Android build with `CapacitorHttp` enabled, so `fetch()` talks to Skoda directly (no laptop proxy, no CORS).

Requirements: Node 20+, [Android Studio](https://developer.android.com/studio).

```bash
npm install
npm run android
```

That builds the web UI, syncs into `android/`, and opens Android Studio. Run on a device/emulator from there.

```bash
npm run cap:sync   # rebuild + sync after UI changes
```

In the Capacitor app, Skoda / epexprijzen / Open‑Meteo are called directly. Peblar is called on your LAN (`http://charger-ip`) when the phone is on home Wi‑Fi.

## PWA + laptop proxy (optional)

For browser/PWA use, the Skoda API needs a proxy (no CORS). Build and run:

```bash
npm run build
npm start
```

Expose with HTTPS (Cloudflare Tunnel, etc.), open in Chrome, then **Install app**.

| App path | Upstream |
|---|---|
| `/api/skoda/*` | `https://public.api.connect.skoda-auto.cz/*` |
| `/api/energy/*` | `https://epexprijzen.nl/*` |
| `/api/jeroen/*` | `https://jeroen.nl/*` (MCP solar forecast) |
| `/api/peblar/*` | Peblar on your LAN |

## How the plan works

1. Estimate full range from the car’s current SOC + remaining range
2. Compute the target SOC needed for the requested kilometres
3. If that exceeds the usable window between **min SOC** and the **default 80%** limit, raise the max SOC and show a warning
4. Fetch day-ahead 15-minute prices until the finish time
5. Select the cheapest slots that deliver the required kWh at your configured charge power
6. Merge into at most 4 preferred charging windows and apply them to the active charging profile
7. Set charge mode to `PREFERRED_CHARGING_TIMES`

## Rate limits

The Skoda public API is limited (currently ~20 requests/hour per VIN). Avoid rapid refresh loops.

## Disclaimer

Unofficial helper around Škoda’s public API. Use at your own risk; verify charge limits and schedules in the MyŠkoda app after applying a plan.
