# homebridge-kidde-ring

A [Homebridge](https://homebridge.io) plugin that brings **Kidde Smart Smoke + Carbon Monoxide Alarms with Ring compatibility** into Apple HomeKit.

Supported models (the hubless Wi-Fi "works with Ring" line, set up with the **Ring app** — no Ring hub or subscription required):

| Model | Description | Ring device type |
|---|---|---|
| **RGCUAR-RW** | Smart Smoke + CO Alarm, hardwired | `sensor_bluejay_wsc` |
| RGCUDR-RW | Smart Smoke + CO Alarm, battery | `sensor_bluejay_sc` |
| RGSAR-RW / RGSDR-RW | Smart Smoke Alarm, hardwired | `sensor_bluejay_ws` |

Each alarm appears in HomeKit as a **Smoke Sensor**, a **Carbon Monoxide Sensor** (combo models, including CO level in ppm), and a **Battery** service with low-battery status — so you get native HomeKit notifications, automations, and Siri support.

> **Note:** These Ring-branded Kidde alarms use Ring's cloud, *not* the Kidde HomeSafe cloud. If you have Kidde HomeSafe models set up with the Kidde app (e.g. P4010ACSCOAQ-WF), this plugin does not cover them.

## How it works

The alarms have no local API. This plugin authenticates with your Ring account and opens Ring's real-time push (WebSocket) connection for each location — the same channel the Ring app uses — so smoke/CO alarm events reach HomeKit within seconds, with a periodic full refresh as a safety net. This works even without any Ring hub, using the `clap/tickets` discovery technique from [dgreif/ring#1674](https://github.com/dgreif/ring/issues/1674) and [ha-ring-smoke-detectors](https://github.com/simplytoast1/ha-ring-smoke-detectors).

## Installation

1. Install via the Homebridge UI (search for `homebridge-kidde-ring`), or:

   ```sh
   npm install -g homebridge-kidde-ring
   ```

2. Get a Ring refresh token (required if your Ring account has two-factor authentication, which Ring enforces by default):

   ```sh
   npx -p homebridge-kidde-ring kidde-ring-auth
   ```

   Enter your Ring email, password, and the 2FA code you receive. Copy the printed token.

3. Add the platform to your Homebridge `config.json` (or use the plugin settings UI):

   ```json
   {
     "platforms": [
       {
         "platform": "KiddeRing",
         "name": "Kidde Ring",
         "refreshToken": "<token from kidde-ring-auth>"
       }
     ]
   }
   ```

4. Restart Homebridge. Your alarms are discovered automatically from all Ring locations on the account.

## Configuration reference

| Option | Default | Description |
|---|---|---|
| `refreshToken` | — | Ring refresh token from `kidde-ring-auth` (recommended). |
| `email` / `password` | — | Direct login; only works on Ring accounts **without** 2FA. |
| `locationIds` | all | Array of Ring location IDs to include. |
| `refreshIntervalMinutes` | `60` | Fallback full-refresh interval; live updates are pushed regardless. |
| `lowBatteryThreshold` | `20` | Battery % at or below which HomeKit shows a low-battery warning. |

Ring rotates refresh tokens on every login; the plugin persists the rotated token to `kidde-ring-token.json` in the Homebridge storage folder automatically, so you only need to generate a token once.

## Troubleshooting

- **"Ring requires two-factor authentication"** — run `npx -p homebridge-kidde-ring kidde-ring-auth` and put the resulting token in the config.
- **No devices found** — confirm the alarm shows up and is online in the Ring app, and that you logged in with the same Ring account. Enable Homebridge debug mode (`-D`) to see discovered locations and assets.
- **Token invalid after re-login elsewhere** — generating tokens invalidates older ones in some cases; re-run `kidde-ring-auth` and update the config.

## Adding more Kidde products

Support for additional Ring-compatible Kidde models is straightforward if they surface as `sensor_bluejay_*` assets (see `src/smokeWebSocket.ts`). Kidde HomeSafe-app models use a completely different cloud API and would belong in a separate plugin.

## Credits

- Protocol groundwork: [dgreif/ring](https://github.com/dgreif/ring) (ring-client-api) and [tsightler](https://github.com/tsightler)'s hubless-detector discovery in [dgreif/ring#1674](https://github.com/dgreif/ring/issues/1674)
- [simplytoast1/ha-ring-smoke-detectors](https://github.com/simplytoast1/ha-ring-smoke-detectors) — Home Assistant integration this plugin's Ring client is modeled on
- [tache/homeassistant-kidde](https://github.com/tache/homeassistant-kidde) — Kidde HomeSafe reference

## Disclaimer

Unofficial software. Not affiliated with, endorsed by, or supported by Kidde, Carrier, Ring, or Amazon. **Do not rely on this plugin for life-safety notifications** — the alarm itself and the Ring app remain your primary alerting paths.
