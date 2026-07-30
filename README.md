# 🐔 rtsp-cam-broadcaster

A tiny, self-contained Docker image that takes an **RTSP camera** and
rebroadcasts it as **HLS video** over a **Cloudflare Tunnel** — so you can put a
camera on the public internet **without exposing your home server or opening a
single port**.

Built to serve [cluckcam.org](https://cluckcam.org): a live feed of
Paul's chickens.

```text
  generic RTSP cam feed ──► ffmpeg (H.264 remux, no re-encode) ──► HLS segments (tmpfs)
                                                                  │
   ┌── cam-broadcaster container ──────  Fastify server :8080 ◄──┘
   │                                             │
   └── cloudflared container ─── tunnel ─────────┴──► Cloudflare edge (caches
                                                      .ts segments) ──► viewers
```

Because the video is already H.264, ffmpeg just **remuxes** it (`-c:v copy`) —
near-zero CPU, no quality loss. And because HLS segments are plain static files,
**Cloudflare's CDN caches them**, so your home upload bandwidth stays roughly
flat even if the site goes viral.

---

## What you need

- Docker + Docker Compose
- A domain managed by Cloudflare (e.g. `cluckcam.org`)
- A free Cloudflare **Zero Trust** account (for the tunnel)
- The camera's RTSP URL + credentials

---

## Setup

### 1. Create a Cloudflare Tunnel

1. Cloudflare dashboard → **Zero Trust** → **Networks** → **Tunnels** →
   **Create a tunnel** → **Cloudflared**.
2. Name it (e.g. `cluckcam`) and **Save**.
3. On the "Install connector" screen, **copy the token** — it's the long
   `ey...` string in the shown `cloudflared ... run --token ey...` command.
   That's your `TUNNEL_TOKEN`.
4. Go to the tunnel's **Public Hostname** tab → **Add a public hostname**:
   - **Subdomain / domain:** e.g. `cluckcam.org` (or `www`)
   - **Type:** `HTTP`
   - **URL:** `cam-broadcaster:8080`
5. Save. Cloudflare creates the DNS record for you automatically.

> **Why `cam-broadcaster:8080` and not `localhost:8080`?** The connector runs in
> its own container and reaches the app over the Compose network, where the
> service name is the hostname. `localhost` inside the cloudflared container is
> the cloudflared container.
>
> You run the connector from _this_ stack — not the one-liner Cloudflare shows.
> All you need from that screen is the token.

### 2. Configure

```bash
cp .env.example .env
# edit .env: set RTSP credentials and TUNNEL_TOKEN
```

Minimum required in `.env`:

```dotenv
RTSP_URL=rtsp://...
TUNNEL_TOKEN=eyJ...
```

### 3. Run

```bash
docker compose up -d --build
docker compose logs -f
```

Then open **[cluckcam.org](https://cluckcam.org)**. First frames appear a few
seconds after ffmpeg connects to the camera. 🎉

Two containers come up: `cam-broadcaster` (ffmpeg + the web server) and
`cloudflared` (the tunnel), plus `autoheal` to restart the app if it goes
unhealthy.

> **Upgrading from a single-container release?** The tunnel used to run inside
> the app container, so its public hostname pointed at `localhost:8080`. It now
> runs beside the app and must point at `cam-broadcaster:8080` — update it in
> the Cloudflare dashboard (Zero Trust → Networks → Tunnels → your tunnel →
> Public Hostname) or the site will 502 after the upgrade. Nothing in `.env`
> changes.

---

## Configuration

All via environment variables (see [.env.example](.env.example)). `TUNNEL_TOKEN`
and `TUNNEL_PROTOCOL` are read by **Docker Compose** and passed to the
`cloudflared` container — the app never sees them; everything else is read by
the app itself.

| Variable            | Default              | Description                                     |
| ------------------- | -------------------- | ----------------------------------------------- |
| `RTSP_URL`          | **required**         | Camera RTSP URL. Supports `${VAR}` expansion.   |
| `TUNNEL_TOKEN`      | **required**         | Cloudflare Tunnel token (used by Compose).      |
| `TUNNEL_PROTOCOL`   | `http2`              | Tunnel transport (used by Compose).             |
| `STREAM_TITLE`      | `Paul's Chickens`    | Page title / heading.                           |
| `STREAM_TAGLINE`    | `Live from the coop` | Sub-heading + meta description.                 |
| `ENABLE_AUDIO`      | `false`              | Include camera audio (transcoded to AAC).       |
| `HLS_SEGMENT_TIME`  | `2`                  | Seconds per HLS segment. Lower = less latency.  |
| `HLS_LIST_SIZE`     | `6` (example: `10`)  | Segments kept in the live playlist.             |
| `RTSP_TRANSPORT`    | `tcp`                | `tcp` (reliable) or `udp` (lower latency).      |
| `PORT`              | `8080`               | Internal HTTP port (match the tunnel hostname). |
| `LOG_LEVEL`         | `info`               | `debug` shows raw ffmpeg/cloudflared output.    |
| `FFMPEG_EXTRA_ARGS` | –                    | Extra ffmpeg flags, space-separated (advanced). |

---

## Recommended: let Cloudflare bear the load

Only the **immutable** resources — the ones with a unique URL per version — are
edge-cached, so Cloudflare serves them and origin sends each one just once:

- `/hls/*.ts` — segments (unique filenames).
- `/api/detections/<label>/<hash>/snapshot.jpg` — snapshots, addressed by a hash
  of their own bytes. A URL can only ever name the image it was minted for, so
  `immutable` is honest even across restarts and redeploys. The hash lives in the
  path, not a query string, so it stays cacheable behind a CDN configured to
  strip query strings from the cache key.
- `/assets/*` — the built JS/CSS, including the ~510 KB hls.js chunk. Vite
  content-hashes these filenames, so each build is a fresh, permanently
  cacheable URL.

The **live playlist** (`stream.m3u8`) and the small detections JSON are sent
`no-store` **on purpose**. A live playlist that's even slightly stale leaves the
player without its next segment, so it drains its buffer and stalls after ~15s
("reconnecting"). They're tiny and polled only a few times a minute, so serving
them fresh from origin is cheap.

Cloudflare caches `.jpg` and `.js` by default (given the immutable headers), but
**not `.ts`** — add a Cache Rule for that (segments are your real bandwidth):

- Cloudflare dashboard → your domain → **Caching → Cache Rules → Create**
- **If** `URI Path` **ends with** `.ts`
- **Then** Cache eligibility → **Eligible for cache**; Edge TTL → **Use cache-control header if present**

> ⚠️ If you added an earlier rule matching all of `/hls/`, **narrow it to `.ts`**.
> Caching `.m3u8` is what causes the ~15s "reconnecting" stall.

With that, segment bandwidth (the bulk) is served by the edge regardless of
viewer count. The only per-viewer origin traffic left is the `/api/heartbeat`
POST — live presence can't be cached — now one small POST every 20s that
**pauses while the tab is backgrounded**.

---

## Smoother playback (fixing frequent "reconnecting")

The player is tuned for **stability over latency** — it sits a few segments
behind the live edge, buffers generously, and only shows the overlay after a
sustained freeze. If you still see frequent "reconnecting", work down this list
(highest impact first):

1. **Enable the `.ts` Cache Rule above.** Without it, every viewer pulls the full
   stream bitrate straight from your home uplink — a few viewers can saturate it
   and stall _everyone_. This is the single biggest lever.
2. **Widen the buffer window.** Increase `HLS_LIST_SIZE` (e.g. `10`–`15`) in
   `.env` so the player can buffer more ahead. `SEGMENT_TIME × LIST_SIZE` is the
   ceiling on how much it can hold. `docker compose up -d` to apply (no rebuild).
3. **Keep `RTSP_TRANSPORT=tcp`** (the default). UDP shaves latency but drops
   frames on a lossy link, which shows up as stalls.
4. **Check your home upload headroom.** One 1080p20 H.264 stream is ~4–8 Mbps up.
   If your uplink is tight, edge caching (step 1) is essential, and you may want a
   lower-bitrate camera profile.

Player-side tuning (buffer sizes, freeze thresholds) lives in
[src/client/hooks/useHlsPlayer.ts](src/client/hooks/useHlsPlayer.ts); changes
there need a `docker compose up -d --build` since the client bundle is baked
into the image.

---

## Recently-spotted animals (Frigate over MQTT)

If you run [Frigate](https://frigate.video), the page can show recent snapshots
of the animals it detects. Set `MQTT_HOST` (and the other `MQTT_*` vars) in
`.env` to enable it — leave it blank and the whole feature is off.

How it works: the app subscribes to your broker's `frigate/events` (for the
label + timestamp) and `frigate/<camera>/<label>/snapshot` (the best JPEG), and
renders a **"Recently spotted"** grid under the video, newest first. Everything
rides the MQTT connection — no HTTP calls back to Frigate, no disk writes.

It keeps the **last 5 snapshots per label** in a ring buffer: once a label has
five, the next one pushes the oldest out. So a busy afternoon of deer gives you
five deer cards, and every animal keeps its own history regardless of how active
the others are.

**The grid starts empty on every boot.** Frigate publishes snapshots with MQTT's
retain flag, so the broker replays the last image per label the moment we
subscribe — images that can be days old and carry no timestamp. Those replays are
dropped, so the page only ever shows detections that happened while the current
process was running. (Live detections are unaffected: MQTT requires the broker to
clear the retain flag when forwarding to an already-established subscription, so
only the replay-at-subscribe is recognisable as retained.)

The page renders the **18 most recent** of those, so a full store (50 with the
default ten labels) stays a glance-at-it panel rather than a wall of thumbnails.
`/api/detections` still returns everything stored; the cap is
`MAX_RENDERED_SIGHTINGS` in
[RecentlySpotted.tsx](src/client/components/RecentlySpotted/RecentlySpotted.tsx).

Memory is bounded by construction: 5 snapshots × the labels you track, at
roughly 25 KB per JPEG (~1.3 MB for the default ten labels).

| Variable            | Default                        | Description                          |
| ------------------- | ------------------------------ | ------------------------------------ |
| `MQTT_HOST`         | – (blank disables the feature) | Frigate broker host.                 |
| `MQTT_PORT`         | `1883`                         | Broker port.                         |
| `MQTT_USERNAME`     | –                              | Broker username (optional).          |
| `MQTT_PASSWORD`     | –                              | Broker password (optional).          |
| `MQTT_TLS`          | `false`                        | Use `mqtts://`.                      |
| `MQTT_TOPIC_PREFIX` | `frigate`                      | Frigate's MQTT topic prefix.         |
| `FRIGATE_CAMERA`    | – (any camera)                 | Restrict to one Frigate camera name. |
| `FRIGATE_LABELS`    | `bear,deer,dog,…,rabbit`       | Object labels to surface.            |

Requires Frigate with **snapshots + MQTT enabled**. If the broker is
unreachable the app just retries in the background — the rest of the stream is
unaffected.

## How it stays alive

- **ffmpeg** is supervised in-process: if it dies, it's restarted with
  exponential backoff. That supervision is application-aware — each run gets
  fresh segment filenames, the segment directory is wiped first, and the
  watchdog below can force a restart.
- **cloudflared** runs as its own container, so `restart: unless-stopped` covers
  it dying. For the worse case — the process alive but no longer serving —
  its healthcheck runs `cloudflared tunnel ready`, which calls the tunnel's own
  `/ready` endpoint and fails unless there's a live connection to the edge.
  `autoheal` then restarts it. (The image is distroless, so the probe has to be
  the `cloudflared` binary itself; there's no shell or curl in there.)
- A **watchdog** restarts ffmpeg if the playlist stops advancing (camera drops
  the connection without closing the socket — common on cheap cameras).
- **`/healthz`** returns `200` only when fresh segments exist, driving the
  Docker `HEALTHCHECK`.
- **autoheal** restarts any container that reports unhealthy — Docker's restart
  policy reacts to a process _exiting_, never to one that's merely stopped
  working. Both `cam-broadcaster` and `cloudflared` carry the `autoheal-app`
  label. Failure has to persist ~2.5 min (5 × 30s) before it fires, which is
  deliberate: cloudflared reconnects to the edge routinely and shouldn't be
  killed mid-reconnect.
- The page **auto-recovers**: it shows a "warming up / reconnecting" overlay and
  retries on its own — no manual refresh needed.

---

## Local development

Requires `ffmpeg` on your PATH. No tunnel is involved — `npm run dev` serves the
app locally, so `TUNNEL_TOKEN` isn't needed and `RTSP_URL` is the only variable
you must set.

```bash
npm install
npx playwright install chromium   # once — the component tests run in a real browser
cp .env.example .env              # then edit; add HLS_DIR=./.hls for a local dir
npm run dev
```

`npm run dev` builds the client once, then runs two processes side by side: the
Fastify server on **:8080** (APIs + HLS) and the Vite dev server on **:5173**
with hot module replacement. **Open <http://localhost:5173>** — it proxies
`/api` and `/hls` through to Fastify, so you get real video with instant UI
reloads. `npm run dev:server` / `npm run dev:client` run either half alone.

`.env` in the project root is loaded automatically by `npm start`, `npm run dev`,
and `node dist/server/index.js` (via Node's built-in env-file support). Real
shell environment variables take precedence over the file, and you can point at
a different file with `ENV_FILE=path/to/other.env`. In Docker there's no `.env` —
compose's `env_file:` injects the vars instead.

### Layout

```text
src/
├── client/                    React app, bundled by Vite -> dist/client
│   ├── components/            one folder per component: .tsx + .css + .test.tsx
│   │   ├── Header/            title, LIVE badge, viewer count
│   │   ├── RtspVideoViewer/   <video> + the buffering/reconnecting overlay
│   │   ├── RecentlySpotted/   the sightings grid
│   │   ├── SightingCard/      one snapshot tile
│   │   ├── Lightbox/          enlarged snapshot (native <dialog>)
│   │   └── Footer/
│   ├── hooks/                 useHlsPlayer, useViewerCount, useDetections
│   ├── lib/                   helpers: api.ts, time, labels, bootstrap
│   └── index.html             Vite entry; the server templates it at boot
├── server/                    Fastify + ffmpeg supervision -> dist/server
└── shared/                    types both sides import (the wire contract)
```

Tests live next to what they test (`Header.tsx` / `Header.test.tsx`).

### Toolchain

| Command               | What it does                                                       |
| --------------------- | ------------------------------------------------------------------ |
| `npm run build`       | `vite build` → `dist/client`, then `tsc` → `dist/server`           |
| `npm start`           | Runs the compiled app (needs `npm run build` first)                |
| `npm test`            | Both Vitest projects: `server` (Node) and `client` (real Chromium) |
| `npm run test:client` | Component tests only, via `vitest-browser-react`                   |
| `npm run test:server` | Route/config/MQTT tests only                                       |
| `npm run typecheck`   | `tsc --noEmit` across client, server and configs                   |
| `npm run lint`        | [oxlint](https://oxc.rs) — warnings are errors                     |
| `npm run format`      | [oxfmt](https://oxc.rs) (`--check` in CI via `npm run check`)      |
| `npm run check`       | format + lint + typecheck + tests — the whole gate                 |

Client tests drive a real browser rather than a DOM shim, so focus management,
`<dialog>` semantics and ARIA roles are asserted against actual browser
behaviour. `useHlsPlayer` takes a `loadHls` seam so the fatal-error and
recovery branches are reachable without a live stream.

### How config reaches the page

`vite build` emits `dist/client/index.html` still containing `{{TITLE}}`,
`{{TAGLINE}}` and `{{BOOTSTRAP}}`. Fastify fills them in once at boot from
`STREAM_TITLE` / `STREAM_TAGLINE`: the first two HTML-escaped into the `<title>`
and Open Graph tags (so crawlers and link previews work without running any
JavaScript), the third as a JSON blob React reads on startup. `vite dev` fills
the same placeholders with dev stand-ins.

Everything under `/assets/` is content-hashed by Vite and served
`immutable`; `index.html` is the single `no-cache` entry point, so a deploy
takes effect on the next page load. `hls.js` is a lazily-imported chunk, so it
isn't on the critical path.

---

## Troubleshooting

| Symptom                                                | Likely cause / fix                                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Logs show `401` / `Unauthorized`                       | Wrong RTSP username/password.                                                                                                 |
| Logs show `Connection refused` / timeouts              | Wrong host/port, or try `RTSP_TRANSPORT=udp`.                                                                                 |
| Page loads but video never starts                      | Check `docker compose logs`; confirm ffmpeg is producing segments (`debug`).                                                  |
| `502` at the domain                                    | Tunnel public hostname must point to `localhost:8080` (or your `PORT`).                                                       |
| `tls: first record does not look like a TLS handshake` | Tunnel Service **Type** is `HTTPS` — change it to **`HTTP`**. The app is plain HTTP.                                          |
| Compose: `FRIGATE_RTSP_USER ... not set` / blank creds | Compose interpolates `${...}` in `env_file`. Put credentials inline in `RTSP_URL` (or `export` the vars before `compose up`). |
| No audio                                               | Set `ENABLE_AUDIO=true` (default is off for compatibility).                                                                   |
| Choppy / high latency                                  | Lower `HLS_SEGMENT_TIME` (e.g. `1`); keep `RTSP_TRANSPORT=tcp`.                                                               |

---

## Notes & hardening

- **Disk / SSD wear.** The only high-volume writes — HLS segments — go to RAM
  via the `tmpfs: /hls` mount, never the disk. Container logs are the only thing
  left, and `docker-compose.yml` caps them with the `local` driver
  (`max-size: 5m`, `max-file: 3` → ~15 MB, rotated in place). The app also
  throttles repeated failure logging so an outage loop doesn't spew. Docker has
  no true in-memory log driver; for **zero** log writes to disk, set
  `logging.driver: none` (you lose `docker compose logs`).
- The container runs as root for simplicity (no ports are exposed; all ingress
  is via the tunnel). To run non-root, add a user in the `Dockerfile` and mount
  `/hls` as a writable tmpfs for that user.
- `cloudflared` runs from Cloudflare's official image, **pinned** by tag in
  `docker-compose.yml`. Bump that tag to upgrade; it never auto-updates.
- WebRTC (sub-second latency) is intentionally **not** used: it can't traverse a
  plain Cloudflare Tunnel without Cloudflare Calls/TURN. HLS is the right fit
  here — cacheable, firewall-friendly, and plenty good for a chicken cam.
