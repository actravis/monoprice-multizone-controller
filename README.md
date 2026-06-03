# Amp Control

A self-hosted LAN web app for controlling the **Monoprice MPR-6ZHMAUT** 6-zone
multizone amplifier over its RS-232 serial port. Runs on any machine with a
USB-to-serial adapter connected to the amp, serves a responsive web UI, and
exposes a small JSON API.

- **Per-zone control** — power, volume, source, mute, bass, treble, balance.
- **Scenes** — capture the current state of every zone and recall it in one tap.
- **Customizable** — rename zones and sources, pick icons, hide unused zones.
- **Installable PWA** — add it to a phone home screen for an app-like experience.
- **Optional PIN** — protect Settings from accidental edits, enforced server-side.
- **mDNS** — reachable at a friendly `*.local` name with no DNS setup.

The whole frontend is a single static `public/index.html` (no build step); the
backend is a small Node/Express server that talks to the amp over serial.

## Hardware

- Monoprice MPR-6ZHMAUT (or compatible) multizone amplifier, up to 3 daisy-chained.
- A **straight-through** USB-to-RS232 serial cable/adapter (not null-modem).
- The amp's serial link is **9600 baud, 8N1**.

## Requirements

- Node.js 18+
- A serial device the host OS can see (e.g. `/dev/cu.usbserial-XXXX` on macOS,
  `/dev/ttyUSB0` on Linux).

## Quick start

```bash
git clone https://github.com/<you>/amp-control.git
cd amp-control
npm install

# point it at your serial adapter and start
DEVICE=/dev/ttyUSB0 npm start
```

Then open `http://localhost:8080` (or `http://multizone.local:8080` from any
device on the same network).

## Configuration

All configuration is via environment variables — copy `.env.example` for the
full annotated list. The common ones:

| Variable     | Default                    | Description                                   |
|--------------|----------------------------|-----------------------------------------------|
| `DEVICE`     | `/dev/cu.usbserial-210`    | Serial device path for the USB-RS232 adapter. |
| `BAUD`       | `9600`                     | Serial baud rate.                             |
| `PORT`       | `8080`                     | HTTP port for the web UI / API.               |
| `AMP_COUNT`  | `1`                        | Number of daisy-chained amps (1–3).           |
| `MDNS_NAME`  | `multizone`                | Advertises `http://<name>.local`. Empty = off.|
| `CONFIG_PATH`| `./config.json`            | Where shared settings are persisted.          |

User-facing settings (zone/source names, icons, scenes, the PIN) are stored in
`config.json` next to the server. This file is created at runtime and is
**git-ignored** — it holds your personal setup and should never be committed.

## Security model

This app is designed to run on a **trusted home LAN** and has no user accounts.

- The optional Settings PIN is enforced **server-side**: the PIN is never sent
  to clients (only a "PIN is set" flag is), and changes to protected settings
  require the PIN via an `X-Settings-Pin` header. It guards against accidental
  edits — it is **not** a substitute for network security.
- Operational actions (changing volume/source, applying scenes) are
  intentionally open to anyone on the LAN.
- **Do not expose this server to the public internet.** If you need remote
  access, use a VPN or an authenticated reverse proxy.

## HTTP API

| Method | Path                 | Description                                      |
|--------|----------------------|--------------------------------------------------|
| `GET`  | `/api/health`        | Connection status, device, uptime.               |
| `GET`  | `/api/zones`         | State of all known zones.                         |
| `GET`  | `/api/zones/:zone`   | State of one zone (e.g. `11`–`16`, `21`–`26`).    |
| `POST` | `/api/zones/:zone`   | Set attributes, e.g. `{ "power":1, "volume":20 }`.|
| `POST` | `/api/poll`          | Force a refresh from the amp.                     |
| `GET`  | `/api/config`        | Shared config (PIN value omitted).                |
| `PUT`  | `/api/config`        | Update config (protected keys require the PIN).   |
| `POST` | `/api/unlock`        | Verify a PIN without changing anything.           |

Zone attributes accept friendly names or raw codes: `power` (0/1),
`volume` (0–38), `source` (1–6), `mute` (0/1), `bass`/`treble` (0–14),
`balance` (0–20, 10 = center).

## Running as a service

To keep it running across reboots, register the start command with your OS
service manager (a macOS LaunchAgent or a Linux systemd unit running
`npm start` from this directory).

## Development

`probe.js` and `loopback.js` are small helpers for testing the serial link and
the RS-232 wiring respectively; both honor the `DEVICE` environment variable.

## License

[MIT](LICENSE)
