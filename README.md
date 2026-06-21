# flareburner

A small HTTP API that opens pages in a **real Chrome browser** to get past
Cloudflare ("Just a moment…") challenges, then returns the page's **cookies**
and **HTML**. Built on [`puppeteer-real-browser`](https://www.npmjs.com/package/puppeteer-real-browser).

Use it like an API: `POST` a URL, get back the solved page.

- Warm **browser pool** — Chrome stays running between requests (fast, handles concurrency).
- **Cookie reuse / fast-path** — replay a previous `cf_clearance` and skip the browser when possible.
- **Per-request options** — choose what's returned (html / cookies / json), take screenshots, set headers, etc.
- **Binary passthrough** — `POST /binary` fetches a Cloudflare-protected image (or any binary) and streams back the **raw bytes**, reusing harvested clearance so most hits skip the browser.
- **Health endpoint + optional API key** — safe to expose.

---

## Table of contents

- [Requirements](#requirements)
- [Install](#install)
- [Run it](#run-it)
- [Configuration (.env)](#configuration-env)
- [The secret key (API auth)](#the-secret-key-api-auth)
- [API reference](#api-reference)
  - [`GET /health`](#get-health)
  - [`GET /`](#get-)
  - [`POST /v1`](#post-v1)
  - [`POST /binary`](#post-binary)
- [Request body options](#request-body-options)
- [Response shapes](#response-shapes)
- [Cookie reuse & the fast-path](#cookie-reuse--the-fast-path)
- [curl cookbook](#curl-cookbook)
- [CLI (no server)](#cli-no-server)
- [Deploying to a Linux VPS](#deploying-to-a-linux-vps)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)

---

## Requirements

- **Node.js 18+** (20+ recommended — uses global `fetch` and `AbortSignal.timeout`).
- **Google Chrome / Chromium** installed.
  - Linux: `/usr/bin/google-chrome-stable` (what the VPS script installs).
  - Windows: a Playwright Chromium download under `…\AppData\Local\ms-playwright\` is auto-detected.
  - Detection logic lives in `resolveChromePath()` in `index.js` (checks the standard Linux Chrome paths, then the local Playwright Chromium folder).

> On a headless Linux server the non-headless browser needs a virtual display
> (Xvfb). `puppeteer-real-browser` starts it automatically; the deploy script
> installs the `xvfb` package for you.

## Install

```bash
npm install
```

## Run it

```bash
node server.js            # listens on http://localhost:4001
node server.js 8080       # override the port via CLI arg
npm start                 # same as: node server.js
```

On startup you'll see whether auth is on:

```
flareburner: warming 1 browser(s) (headless=false)…
flareburner API listening on http://0.0.0.0:4001
  GET  /health
  POST /v1   (open)        <-- or "(API key required)" when a key is set
```

---

## Configuration (.env)

Copy the example and edit it:

```bash
cp .env.example .env
```

Config is loaded in this order (later wins): **`.env` file → real environment
variables → CLI port argument**.

| Variable      | Default               | Description |
|---------------|-----------------------|-------------|
| `PORT`        | `4001`                | HTTP port. (CLI arg `node server.js <port>` overrides everything.) |
| `API_KEY`     | *(empty)*             | If set, `POST /v1` requires this key. Empty = open. |
| `POOL_SIZE`   | `1`                   | Number of warm Chrome instances = max concurrent requests. |
| `HEADLESS`    | `false`               | Run Chrome headless. Cloudflare is harder to beat headless — keep `false` unless your target doesn't challenge. |
| `NAV_TIMEOUT` | `60000`               | Navigation + Cloudflare-wait timeout, in ms. |
| `DEFAULT_URL` | `https://nowsecure.nl`| URL used when a request omits `url`. |

Example `.env`:

```ini
PORT=4001
API_KEY=
POOL_SIZE=2
HEADLESS=false
NAV_TIMEOUT=60000
DEFAULT_URL=https://nowsecure.nl
```

> Changes to `.env` require a **server restart** (config is read once at startup).

---

## The secret key (API auth)

`API_KEY` is an optional shared secret that protects the `POST /v1` endpoint.
`GET /health` and `GET /` stay open regardless.

**Enable it:** set a value in `.env` and restart:

```ini
API_KEY=my-super-secret-key
```

The startup log will then show `POST /v1 (API key required)`.

**Send the key** with every `/v1` request — either header works:

```bash
# Header form
curl -X POST http://localhost:4001/v1 \
  -H "Content-Type: application/json" \
  -H "X-API-Key: my-super-secret-key" \
  -d '{"url":"https://nowsecure.nl"}'

# Bearer form
curl -X POST http://localhost:4001/v1 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my-super-secret-key" \
  -d '{"url":"https://nowsecure.nl"}'
```

- **Missing / wrong key →** `401 {"error":"Unauthorized"}`.
- **Disable auth →** set `API_KEY=` (empty) in `.env` and restart.

> The key is a plain shared secret. Always pair it with HTTPS (e.g. behind nginx)
> when exposing the service publicly, so the key isn't sent in the clear.

---

## API reference

Base URL: `http://localhost:4001`

### `GET /health`

Liveness probe + pool stats. Never requires a key.

```bash
curl http://localhost:4001/health
```

```json
{ "status": "ok", "uptimeSeconds": 42, "pool": { "size": 1, "busy": 0 } }
```

### `GET /`

Self-describing usage/help, including the request body schema and whether auth is on.

```bash
curl http://localhost:4001/
```

### `POST /v1`

Scrape a URL. **JSON body**, `Content-Type: application/json`. Requires the API
key only if `API_KEY` is configured.

Minimal:

```bash
curl -X POST http://localhost:4001/v1 \
  -H "Content-Type: application/json" \
  -d '{"url":"https://nowsecure.nl"}'
```

| Method other than POST | `405 Method not allowed` |
|---|---|
| Body isn't valid JSON  | `400 Invalid JSON body` |
| Unknown route          | `404 Not found` |
| Scrape failed          | `500 {"error": "..."}` |

### `POST /binary`

Fetch a **Cloudflare-protected binary** — typically an image — and stream back
the **raw bytes** (not JSON, not HTML). Same auth as `/v1`.

This exists because `/v1` only ever returns text (html / cookies / json), and a
`cf_clearance` is bound to the **solving host's IP**, so a caller on another
machine can't reuse flareburner's cookies for its own direct image fetch. Route
the image through `/binary` instead and flareburner fetches it from its own IP.

**How it resolves (cheap first, browser only if needed):**

1. **Fast-path (no Chrome).** A plain `fetch` from flareburner's host using the
   most-recently-harvested clearance (cookies + UA from the last solve). Most
   images come back this way — concurrently, without touching the size-limited
   browser pool.
2. **Browser fallback.** If the fast-path is challenged, it leases a warm
   browser, navigates to the resource to solve the origin, reads the real bytes
   from the navigation response, and refreshes the cached clearance so
   subsequent images go back to the fast-path.

JSON body:

| Field     | Type   | Default       | Description |
|-----------|--------|---------------|-------------|
| `url`     | string | *(required)*  | The binary/image URL to fetch. |
| `timeout` | number | `NAV_TIMEOUT` | Fetch + challenge timeout, in ms. |

The response is the raw resource with its upstream `Content-Type` and a
`Cache-Control: public, max-age=86400` header.

```bash
# Fetch a protected image and save it
curl -X POST http://localhost:4001/binary \
  -H "Content-Type: application/json" \
  -d '{"url":"https://i.animepahe.pw/uploads/snapshots/xxxx.sm.webp"}' \
  -o image.webp
```

| Method other than POST   | `405 Method not allowed` |
|---|---|
| Body isn't valid JSON    | `400 Invalid JSON body` |
| Missing `url`            | `400 {"error":"url is required"}` |
| Fetch failed / challenged| `502 {"error": "..."}` |

> Best for content-addressed assets (images, fonts) where the bytes matter. For
> HTML/JSON pages use [`POST /v1`](#post-v1).

---

## Request body options

All fields are optional except that you'll usually want `url`.

| Field             | Type      | Default            | Description |
|-------------------|-----------|--------------------|-------------|
| `url`             | string    | `DEFAULT_URL`      | Target URL. |
| `cookies`         | array     | —                  | Cookies to load before navigating. Enables the [fast-path](#cookie-reuse--the-fast-path). Use a `cookies` array from a previous response. |
| `userAgent`       | string    | Chrome's default   | Override the User-Agent. Match the one that produced your cookies for reuse. |
| `headers`         | object    | —                  | Extra HTTP headers, e.g. `{"Accept-Language":"en-US"}`. |
| `returnType`      | string    | `"full"`           | `"full"` \| `"html"` \| `"cookies"` \| `"json"`. |
| `screenshot`      | boolean   | `false`            | Include a base64 PNG (`screenshot` field). Forces the browser path. |
| `waitUntil`       | string    | `"domcontentloaded"` | Puppeteer wait condition: `load`, `domcontentloaded`, `networkidle0`, `networkidle2`. |
| `waitForSelector` | string    | —                  | Wait for this CSS selector after load. |
| `timeout`         | number    | `NAV_TIMEOUT`      | Navigation + challenge timeout, in ms. |
| `fastPath`        | boolean   | `true`             | Set `false` to always use the browser, even with cookies. |

---

## Response shapes

Every browser response includes `via: "browser"`; fast-path responses include
`via: "fetch"`.

**`returnType: "full"`** (default):

```json
{
  "url": "https://nowsecure.nl/",
  "title": "nowSecure",
  "via": "browser",
  "userAgent": "Mozilla/5.0 …",
  "cookies": [ { "name": "cf_clearance", "value": "…", "domain": "nowsecure.nl", … } ],
  "html": "<!DOCTYPE html>…",
  "screenshot": "<base64 png, only if requested>"
}
```

- **`"html"`** → `{ url, title, via, html }`
- **`"cookies"`** → `{ url, title, via, cookies }`
- **`"json"`** → `{ url, title, via, json }` (parses the page body as JSON; falls back to `html` if it isn't JSON)

---

## Cookie reuse & the fast-path

Cloudflare's clearance cookie (`cf_clearance`) lets later requests skip the
challenge. flareburner supports two reuse modes:

1. **Fast-path (no Chrome).** When you send a `cookies` array, the server first
   tries a plain HTTP `fetch` with those cookies. If it isn't challenged, you get
   a near-instant `via: "fetch"` response.
2. **Browser fallback.** If the fast `fetch` is challenged (many sites also
   fingerprint TLS, which a plain fetch can't fake), it automatically falls back
   to the warm browser and still returns the page (`via: "browser"`).

**Easiest reuse (no `jq` needed):** a `/v1` response already contains `url` and
`cookies`, so just send the whole saved response back as the next body:

```bash
# 1) solve once, save the response
curl -s -X POST http://localhost:4001/v1 -H "Content-Type: application/json" \
  -d '{"url":"https://nowsecure.nl"}' -o out.json

# 2) reuse — feed the file straight back
curl -X POST http://localhost:4001/v1 -H "Content-Type: application/json" \
  --data-binary @out.json
```

Check the `via` field to see which path served it.

> **Important:** `cf_clearance` is bound to your **IP address + User-Agent**.
> Reused cookies only work from the same machine/IP and with a matching
> User-Agent. That's why `full` responses echo the `userAgent` — send it back
> alongside the cookies.

---

## curl cookbook

```bash
# Health
curl http://localhost:4001/health

# Basic scrape (full)
curl -X POST http://localhost:4001/v1 -H "Content-Type: application/json" \
  -d '{"url":"https://nowsecure.nl"}'

# HTML only
curl -X POST http://localhost:4001/v1 -H "Content-Type: application/json" \
  -d '{"url":"https://nowsecure.nl","returnType":"html"}'

# Cookies only
curl -X POST http://localhost:4001/v1 -H "Content-Type: application/json" \
  -d '{"url":"https://nowsecure.nl","returnType":"cookies"}'

# JSON endpoint (parses the page body as JSON; falls back to html if it isn't)
curl -X POST http://localhost:4001/v1 -H "Content-Type: application/json" \
  -d '{"url":"https://httpbin.org/json","returnType":"json"}'

# Screenshot -> save PNG (no jq; uses node)
curl -s -X POST http://localhost:4001/v1 -H "Content-Type: application/json" \
  -d '{"url":"https://nowsecure.nl","screenshot":true}' -o shot.json
node -e "require('fs').writeFileSync('shot.png',Buffer.from(require('./shot.json').screenshot,'base64'))"

# Custom UA + headers
curl -X POST http://localhost:4001/v1 -H "Content-Type: application/json" \
  -d '{"url":"https://nowsecure.nl","userAgent":"MyBot/1.0","headers":{"Accept-Language":"en-US"}}'

# Wait for a selector
curl -X POST http://localhost:4001/v1 -H "Content-Type: application/json" \
  -d '{"url":"https://nowsecure.nl","waitForSelector":"h1","timeout":45000}'

# Force browser (skip fast-path)
curl -X POST http://localhost:4001/v1 -H "Content-Type: application/json" \
  -d '{"url":"https://nowsecure.nl","fastPath":false}'

# With API key (if enabled)
curl -X POST http://localhost:4001/v1 \
  -H "Content-Type: application/json" -H "X-API-Key: YOUR_KEY" \
  -d '{"url":"https://nowsecure.nl"}'
```

Handy flags: add `-i` to see status + headers, or
`-s -o out.json -w "HTTP %{http_code}\n"` to save the body and print just the
status code.

---

## CLI (no server)

`index.js` can open a single URL directly, print the title, and dump the cookies
and HTML to a `json/` folder:

```bash
node index.js https://nowsecure.nl
# -> json/cookies.json   (array of cookies)
# -> json/page.json      ({ url, html })
```

A URL argument is required.

---

## Deploying

Two options — pick whichever fits your host:

| Option | Best for | Auto-restart |
|--------|----------|--------------|
| **A. Docker** | Anywhere with Docker (laptop, VPS, PaaS, CI). Most portable. | yes (`restart: unless-stopped`) |
| **B. VPS script** (`setup.sh`) | A bare Ubuntu/Debian box you control. Installs onto the host directly. | yes (systemd) |

### Option A — Docker

Everything (Chrome, Xvfb, fonts, deps) is baked into the image.

```bash
# docker compose (recommended)
docker compose up -d --build
docker compose logs -f
docker compose down

# or plain docker
docker build -t flareburner .
docker run -d --name flareburner -p 4001:4001 --shm-size=1g flareburner
```

Configure via environment variables (see the [config table](#configuration-env)) —
edit `docker-compose.yml`, or pass `-e`:

```bash
docker run -d -p 4001:4001 --shm-size=1g \
  -e POOL_SIZE=2 -e API_KEY=change-me flareburner
```

> **`--shm-size=1g`** matters: Docker's default 64 MB `/dev/shm` can crash Chrome.
> compose sets `shm_size: "1gb"` for you; with plain `docker run`, pass the flag.
> The image also launches Chrome with `--disable-dev-shm-usage` as a safety net.

### Option B — Linux VPS script (`setup.sh`)

`setup.sh` provisions an **Ubuntu/Debian** host end-to-end: installs Node, Google
Chrome, Xvfb and dependencies, seeds `.env`, and runs the API as a `systemd`
service. If systemd isn't available (e.g. a dev container / Codespace) it falls
back to launching with `nohup`.

> It only runs on Linux. On Windows/macOS it exits with a message — for local
> dev just use `node server.js`.

```bash
# On the VPS, from the project directory:
sudo bash setup.sh                 # serves on :4001
PORT=8080 sudo bash setup.sh       # different port
```

Manage the systemd service:

```bash
systemctl status flareburner       # state
journalctl -u flareburner -f       # live logs
systemctl restart flareburner      # after editing .env
systemctl stop flareburner         # stop
```

(no-systemd fallback: logs in `flareburner.log`, stop with `kill $(cat flareburner.pid)`.)

For either option, open the firewall / port if reaching it externally
(e.g. `sudo ufw allow 4001`), and ideally put it behind nginx with TLS —
especially when using `API_KEY`.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `{"error":"Unauthorized"}` | `API_KEY` is set. Send `X-API-Key`/`Bearer`, or clear `API_KEY=` in `.env` and restart. |
| `EADDRINUSE: …:4001` | Another instance is already on that port. Stop it, or use a different `PORT`. |
| Stuck on `"Just a moment…"` | The challenge needs the real browser; ensure `HEADLESS=false`. Increase `timeout` for slow networks. |
| `Attempted to use detached Frame` | Transient Cloudflare re-navigation; the server already retries this automatically. |
| Reused cookies still get challenged | `cf_clearance` is IP+UA bound — reuse from the same IP and send the matching `userAgent`. The server falls back to the browser anyway. |
| `setup.sh` does nothing on Windows | It's a Linux deploy script. Run `node server.js` locally; run `setup.sh` on the VPS. |
| Browser won't launch on the VPS | Chrome needs `--no-sandbox` (already set) and Xvfb (installed by `setup.sh`). Check `journalctl -u flareburner`. |
| Chrome crashes in Docker (`Target closed` / SIGTRAP) | `/dev/shm` too small — run with `--shm-size=1g` (compose already sets it). |

---

## How it works

- **`index.js`** — library: `resolveChromePath`, `connectBrowser` (with launch
  retries), `navigate` (cookies/UA/headers + `waitForCloudflare` + settle),
  `buildResult` (shapes the response), `BrowserPool` (warm, queued slots),
  `fetchFastPath` (cookie-only `fetch`), `fetchBinaryFastPath` (cookie-only
  `fetch` returning raw bytes), and `save` (CLI dump). Also runnable as a CLI.
- **`server.js`** — HTTP layer: `.env`/config loading, `/health`, `/`,
  `POST /v1` with API-key auth (fast-path-then-pool scraping), `POST /binary`
  (clearance-reusing binary/image fetch), and graceful shutdown. Tracks the
  last-harvested clearance so `/binary` can skip the browser.
- **`setup.sh`** — Ubuntu/Debian provisioning + `systemd` service (nohup fallback).
- **`Dockerfile` / `docker-compose.yml`** — containerized deploy (Chrome + Xvfb baked in).
- **`.env.example`** — documented config template.
```
