# MoveSafe Relocation — video walkthroughs

Browser video calls for MoveSafe staff and their customers. A specialist opens a survey room, sends a link, and the customer joins from a phone or desktop browser. No account and no app install. Staff can record the whole call — every participant’s picture and voice — and play it back from the office library.

The local demo does not need a paid video API. Calls use WebRTC. A small Node server handles staff login, room links, signaling, and the saved recordings.

## What you can do

- Staff sign in, create a survey for a customer, and copy an invite link.
- The customer opens the link, agrees that the visit may be recorded, and joins.
- One-to-one calls, and small groups up to four people.
- Mute, camera off, and a rear-camera switch for walking through rooms.
- Staff start and stop recording. A red banner and REC badge stay on screen for **everyone** while recording is on. They cannot be dismissed.
- The recording composites every participant’s video and mixes their audio, then stores the file.
- Staff play recordings in the browser, download them, or delete them. Each row shows date and time, customer, room, and who recorded it.

## Run it locally

Requires Node.js 22 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000 and sign in:

- Email: `alex@movesaferelocation.com`
- Password: `walkthrough-demo`

Optional: copy `.env.example` to `.env` to change the port, password, or storage. You do not need a `.env` file for the demo. Outside production, the login page shows the demo password.

### Two browsers on one call

1. Sign in and create a video survey. Copy the invite, or use **Join call**.
2. On the customer’s phone, open the link. Or, on the same computer, use **Customer view** (a private-style tab that does not act as staff) or a private window.
3. Enable the camera and microphone. The customer must check the recording notice before joining.
4. When both sides show **Live**, the specialist presses **Record**. Both screens show “This call is being recorded by MoveSafe Relocation”.
5. Press **Stop**. Open **Library** to play or download the file.

Customers on a phone should use **Rear cam** while they walk room to room. The self-view mirrors the front camera only.

`getUserMedia` works on `localhost` without HTTPS. Any other host must be served over HTTPS, or the browser will refuse the camera.

## How recording works

Media is peer-to-peer. The Node server only relays signaling (Socket.IO) and receives the finished recording.

When a specialist presses Record, their browser:

1. Draws every participant’s video into one canvas (customer tiles first, then the specialist).
2. Mixes every microphone with the Web Audio API.
3. Records that mix with `MediaRecorder` and uploads it in short chunks.

The file is saved under `data/` (SQLite plus the media). If `ffmpeg` is on the machine, the server transcodes WebM to H.264/AAC MP4 so the duration is seekable and Safari can play it. Without ffmpeg, the original WebM is kept (Chrome, Edge, Firefox, and Safari 16.4+).

The specialist’s tab has to stay open while recording. Leaving the call stops and saves it. A dropped connection is finalized after a short grace period if any media was uploaded.

This is a good fit for a moving company doing a handful of surveys at a time. It is not a large-scale media server. For strict mobile networks, add a TURN server (below). For lots of disk, put finished files in S3-compatible storage.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PORT` / `HOST` | Listen address. Default `3000` / `0.0.0.0`. |
| `SESSION_SECRET` | Required in production, 16+ characters. |
| `STAFF_EMAIL`, `STAFF_NAME`, `STAFF_PASSWORD` | The staff account. Re-applied from the environment on each startup. Production refuses the demo password. |
| `STAFF_USERS` | Optional extra accounts: `email\|Name\|password`, comma-separated. No commas or pipes inside a password. |
| `SHOW_DEMO_BANNER` | Show the password on the login page. Defaults on outside production. Set `false` if the server is reachable by anyone else. |
| `COOKIE_SECURE` | Set `true` when the site is HTTPS. |
| `TRUST_PROXY` | Set `true` behind nginx or a platform proxy. |
| `DATA_DIR` | SQLite, recordings, and posters. Default `./data`. |
| `STORAGE` | `local` (default) or `s3`. |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE` | Used when `STORAGE=s3`. Credentials come from the standard AWS variables `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (or an instance role). `S3_ENDPOINT` plus `S3_FORCE_PATH_STYLE=true` covers MinIO, Cloudflare R2, and similar. |
| `RECORDING_TTL_DAYS` | Delete finished recordings older than this many days. `0` keeps them until someone deletes them. |
| `TRANSCODE` | `auto` (default, MP4 when ffmpeg exists), `off`, or `mp4`. |
| `TURN_URLS` | Comma-separated TURN/TURNS urls. |
| `TURN_SECRET` | Shared secret for coturn `use-auth-secret`. The server mints 8-hour credentials. |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | Static TURN login, if you are not using a secret. |

No Daily, Twilio, LiveKit, or other video-vendor key is required.

## Deploy

The app is one Node process. Run a single instance: signaling state lives in memory, and recordings for one call are uploaded to that process. A small office does not need a cluster.

### Docker

Create a production `.env` (do not use the demo password):

```bash
SESSION_SECRET=a-long-random-string-here
STAFF_EMAIL=alex@movesaferelocation.com
STAFF_NAME=Alex Rivera
STAFF_PASSWORD=choose-a-real-password
SHOW_DEMO_BANNER=false
COOKIE_SECURE=true
TRUST_PROXY=true
STORAGE=local
```

```bash
docker compose up --build -d
```

The container includes ffmpeg and keeps recordings in the `movesafe-data` volume. Publish the port behind HTTPS.

### A VM with systemd and nginx

1. Install Node.js 22 and ffmpeg.
2. Copy this project to `/opt/movesafe`, run `npm ci --omit=dev`, and create `/opt/movesafe/.env`.
3. Install `deploy/movesafe.service` and `deploy/nginx.conf.sample` (adjust the domain and TLS paths).
4. Set `COOKIE_SECURE=true` and `TRUST_PROXY=true`.

Certbot or your host’s certificate manager can issue the certificate. Browsers will not share a camera on a plain `http://` IP address.

### TURN (when a phone will not connect)

Most home and office networks connect with the public STUN servers alone. Some mobile carriers and office firewalls need a relay. Run coturn with `deploy/coturn.conf.sample`, open UDP/TCP 3478 and the relay range, then:

```bash
TURN_URLS=turn:video.movesaferelocation.com:3478?transport=udp,turn:video.movesaferelocation.com:3478?transport=tcp
TURN_SECRET=the-same-static-auth-secret
```

Restart the app. Clients request fresh ICE settings when they join, so the short-lived TURN username is generated per join.

### Object storage

```bash
STORAGE=s3
S3_BUCKET=movesafe-recordings
S3_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

Chunks are assembled on disk, then the finished file is uploaded and the local copy removed. Playback is authorized through the staff session and streamed from the bucket. Posters stay on local disk; if they are missing, the library shows the customer’s initial.

## Recording consent

This is not legal advice. Moving surveys are often recorded in places with all-party consent rules (including California, Florida, Illinois, Pennsylvania, and others). Build the habit around the customer, not around a hidden toggle.

- Say, in the invite and out loud at the start, that the walkthrough may be recorded to prepare the estimate.
- The join screen requires the customer to acknowledge that before the camera starts the call.
- The product does not let staff hide the recording indicator. The banner is shown to every person in the room for the whole recording.
- Keep recordings only as long as the estimate, the job, or a dispute needs them. Set `RECORDING_TTL_DAYS` (90 is a reasonable office default) and delete sooner when a customer asks. The library has a delete button for that request.
- Limit who can sign in. The recording library is staff-only.
- Mention recording in the customer agreement, and do not use a survey recording for advertising without a separate permission.
- Cameras and microphones stay in the browser. Customers are not asked to install anything, which also means a refreshed page or a denied permission ends their side of the call — say that if a room drops.

## Checks

`npm run verify` boots a temporary server and, with Chrome, joins the same room as staff and as a customer, records a few seconds, and plays the file back. It uses Chrome’s fake camera so it can run unattended. `npm run walkthrough` is that same path in visible windows when a display is available.

## Layout

- `server/` — Express, SQLite sessions and records, Socket.IO signaling, recording uploads, optional S3
- `public/` — the staff desk, the customer lobby, and the call
- `deploy/` — nginx, systemd, and coturn samples
- `data/` — created at runtime and not committed

Fonts: [Fraunces](https://fonts.google.com/specimen/Fraunces) and [Outfit](https://fonts.google.com/specimen/Outfit) under the SIL Open Font License. License texts are in `public/fonts/`.
