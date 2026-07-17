# 🐔 rtsp-cam-broadcaster

A tiny, self-contained Docker image that takes an **RTSP camera** and
rebroadcasts it as **HLS video** over a **Cloudflare Tunnel** — so you can put a
camera on the public internet **without exposing your home server or opening a
single port**.

Built to serve [cluckcam.org](https://cluckcam.org): a live feed of
Paul's chickens.

```text
  Dahua RTSP cam ──► ffmpeg (H.264 remux, no re-encode) ──► HLS segments (tmpfs)
                                                                  │
                                          Fastify server :8080 ◄──┘
                                                  │
                              cloudflared tunnel ──┴──► Cloudflare edge (caches
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
   - **URL:** `localhost:8080`
5. Save. Cloudflare creates the DNS record for you automatically.

> You run the connector from *this* container — not the one-liner Cloudflare
> shows. All you need from that screen is the token.

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

---

## Configuration

All via environment variables (see [.env.example](.env.example)):

| Variable            | Default             | Description                                            |
| ------------------- | ------------------- | ------------------------------------------------------ |
| `RTSP_URL`          | **required**        | Camera RTSP URL. Supports `${VAR}` expansion.          |
| `TUNNEL_TOKEN`      | **required**        | Cloudflare Tunnel token.                               |
| `STREAM_TITLE`      | `Paul's Chickens`   | Page title / heading.                                  |
| `STREAM_TAGLINE`    | `Live from the coop`| Sub-heading + meta description.                        |
| `ENABLE_AUDIO`      | `false`             | Include camera audio (transcoded to AAC).              |
| `HLS_SEGMENT_TIME`  | `2`                 | Seconds per HLS segment. Lower = less latency.         |
| `HLS_LIST_SIZE`     | `6`                 | Segments kept in the live playlist.                    |
| `RTSP_TRANSPORT`    | `tcp`               | `tcp` (reliable) or `udp` (lower latency).             |
| `PORT`              | `8080`              | Internal HTTP port (match the tunnel hostname).        |
| `LOG_LEVEL`         | `info`              | `debug` shows raw ffmpeg/cloudflared output.           |
| `FFMPEG_EXTRA_ARGS` | –                   | Extra ffmpeg flags, space-separated (advanced).        |

---

## Recommended: cache segments at the edge

The app already sends cache-friendly headers (`.ts` = immutable/long,
`.m3u8` = 1s). To make Cloudflare actually honor them and shield your home
connection under load, add a **Cache Rule**:

- Cloudflare dashboard → your domain → **Caching** → **Cache Rules** → **Create**
- **If** URI Path ends with `.ts` → **Then** Eligible for cache, Edge TTL "Use
  cache-control header if present".

Now a thousand viewers mostly hit Cloudflare, and your camera only feeds one
ffmpeg pull regardless.

---

## Smoother playback (fixing frequent "reconnecting")

The player is tuned for **stability over latency** — it sits a few segments
behind the live edge, buffers generously, and only shows the overlay after a
sustained freeze. If you still see frequent "reconnecting", work down this list
(highest impact first):

1. **Enable the `.ts` Cache Rule above.** Without it, every viewer pulls the full
   stream bitrate straight from your home uplink — a few viewers can saturate it
   and stall *everyone*. This is the single biggest lever.
2. **Widen the buffer window.** Increase `HLS_LIST_SIZE` (e.g. `10`–`15`) in
   `.env` so the player can buffer more ahead. `SEGMENT_TIME × LIST_SIZE` is the
   ceiling on how much it can hold. `docker compose up -d` to apply (no rebuild).
3. **Keep `RTSP_TRANSPORT=tcp`** (the default). UDP shaves latency but drops
   frames on a lossy link, which shows up as stalls.
4. **Check your home upload headroom.** One 1080p20 H.264 stream is ~4–8 Mbps up.
   If your uplink is tight, edge caching (step 1) is essential, and you may want a
   lower-bitrate camera profile.

Player-side tuning (buffer sizes, freeze thresholds) lives in
[public/assets/app.js](public/assets/app.js); changes there need a
`docker compose up -d --build` since the page is baked into the image.

---

## How it stays alive

- **ffmpeg** and **cloudflared** are each supervised: if either dies, it's
  restarted with exponential backoff.
- A **watchdog** restarts ffmpeg if the playlist stops advancing (camera drops
  the connection without closing the socket — common on cheap cameras).
- **`/healthz`** returns `200` only when fresh segments exist, driving the
  Docker `HEALTHCHECK`.
- The page **auto-recovers**: it shows a "warming up / reconnecting" overlay and
  retries on its own — no manual refresh needed.

---

## Local development

Requires `ffmpeg` and `cloudflared` on your PATH.

```bash
npm install
cp .env.example .env           # then edit; add HLS_DIR=./.hls for a local dir
npm run dev
```

`.env` in the project root is loaded automatically by `npm start`, `npm run dev`,
and `node dist/index.js` (via Node's built-in env-file support). Real shell
environment variables take precedence over the file, and you can point at a
different file with `ENV_FILE=path/to/other.env`. In Docker there's no `.env` —
compose's `env_file:` injects the vars instead.

`npm run build` compiles to `dist/`; `npm start` runs the compiled app;
`npm run typecheck` type-checks without emitting.

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
- `cloudflared` is pulled as `latest` at build time. Pin it by editing the
  download URL in the `Dockerfile` to a specific release tag for reproducibility.
- WebRTC (sub-second latency) is intentionally **not** used: it can't traverse a
  plain Cloudflare Tunnel without Cloudflare Calls/TURN. HLS is the right fit
  here — cacheable, firewall-friendly, and plenty good for a chicken cam.
