# MoveSafe Relocation — video walkthroughs

Browser video calls for MoveSafe staff and their customers. A specialist opens a survey room, sends a link, and the customer joins from a phone or desktop browser. No account is required. Installing MoveSafe is optional — a customer can still join from the browser. Staff can record the whole call — every participant’s picture and voice — and play it back from the office library.

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

`getUserMedia` works on `localhost` without HTTPS. Any other host must be served over HTTPS, or the browser will refuse the camera. Installing the app has the same rule: production needs HTTPS. `localhost` is the exception browsers already allow.

## Install the app

MoveSafe is a progressive web app. Staff and customers can keep it on a phone home screen or install it on a desktop. Joining a survey does not require the install.

- **Desktop Chrome or Edge.** Open the desk and use **Install app** when the browser offers it. You can also use the install icon in the address bar.
- **Android Chrome.** The same **Install app** button, or Chrome’s install prompt, adds MoveSafe to the home screen. It opens in its own window, without the browser toolbar.
- **iPhone and iPad.** Safari does not show an install button. Open the page in Safari, tap **Share**, then **Add to Home Screen**. The icon is labeled MoveSafe.

A video visit still needs a connection. The installed app saves the page shell so it opens quickly, and it shows a short offline page when the network is down. Login, call signaling, uploads, and recordings are not saved for offline use.

Customer links (`/c/…`) stay on that visit. In an installed window, opening a survey link loads that room rather than replacing it with the home screen. On Android, Chrome can open those in-scope links in the installed app. On iPhone, a link from Messages usually opens Safari, which is enough to join. The home-screen icon itself opens the staff desk at `/`. If an older iPhone pins the page that was open when you tapped Add to Home Screen, the survey link in Safari still works.

Installing requires HTTPS in production. Browsers will not offer install, and will not keep a service worker, on a plain `http://` site other than `localhost`.

## Owner account

Henrik Samuelsson is the only owner. Production does not create the shared demo login. On first start, set these in the server environment, not in git:

```bash
OWNER_EMAIL=henrik@example.com
OWNER_NAME=Henrik Samuelsson
OWNER_PASSWORD=a-long-password-you-keep-offline
OWNER_PHONE=+15555550100
```

`+15555550100` is a reserved example. Put Henrik’s real mobile number only in the host’s secret store. The app reads `OWNER_PHONE` at runtime and does not store it in the repo or the database. The password is hashed with bcrypt. Later restarts do not overwrite it unless `OWNER_RESET_PASSWORD=true`.

If `OWNER_EMAIL` is set and `OWNER_PASSWORD` is not, the server prints a one-time setup token in the console. Open `/setup`, enter that token, and choose a password. The token is not shown again.

In production the session cookie is marked Secure unless `COOKIE_SECURE=false`. Leave the site on HTTPS. Login attempts are rate-limited. The owner signs in with the password and then a 6-digit text code. Staff sign in with a password only. There is no public registration page.

Outside production, with no `OWNER_EMAIL`, the app runs in a clearly flagged demo mode (`alex@movesaferelocation.com` / `walkthrough-demo`) so the local desk can be tried. `NODE_ENV=production` turns that off. Set `DEMO_MODE=false` to turn it off in dev too.

Keep the GitHub repository private. Henrik should be the only admin on that repo and the only admin on the hosting account (the server, DNS, and any object-storage keys). Do not commit `.env`.

## Staff invites

Only the owner can invite staff. An invite is an email plus the staff role, never another owner. Creating or resending it texts a 6-digit code to `OWNER_PHONE`. The code expires in 8 minutes, works once, and locks after 5 wrong tries. The server also limits how many codes it will send in a short window. The phone number is not a password.

The invite link itself expires in 72 hours and works once. The new staff member opens it and chooses a name and password. The owner can see pending invites, resend them, or revoke them. Deactivate or remove ends that person’s sessions immediately. Staff cannot invite anyone or change their own role.

Without SMTP, the admin page shows the link so Henrik can copy it into a message. To send mail, set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`.

Text messages use Twilio: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM`. In production, invites and other owner checks are refused until Twilio and `OWNER_PHONE` are set. In dev, without Twilio, the code is printed in the server console and labeled as dev mode. It is not sent. The same text-code step protects owner login, settings changes, removing or deactivating staff, revoking invites, deleting a recording as the owner, and changing the owner password.

## Furniture inventory

During a survey the specialist opens **Inventory**, picks the room (living room, bedroom 1, kitchen, garage, and so on), and builds a list. Each line has a quantity, cubic feet, and a confidence note. The running total is cubic feet for items that are actually moving, an estimated weight, and a suggested truck.

Cubic feet start from a moving-industry reference table (sofa sizes, beds, dressers, appliances, box sizes, and similar). **Scan** grabs one frame from the customer’s camera and asks a vision model to name the pieces and, when it can, estimate dimensions. The server keeps the reference size unless the measured size is in a plausible range for that item, and it shows a lower confidence when the picture and the table disagree. Suggestions are not added until a person presses **Add**. **Sample while recording** repeats that about every 20 seconds. Prefer the button. A long call with sampling on sends a lot of frames.

Staff can change quantity, size, and cubic feet, add from the reference search, remove a line, or mark something as not moving. Not-moving lines stay on the list and drop out of the totals. The same inventory is saved on the survey, linked to the recording, and opens from the room and from the library. Download CSV, or open the printable summary and use the browser’s Print / Save as PDF.

Weight defaults to 7 pounds per cubic foot. The owner can change that, the truck sizes, the reference numbers, and the company name under **Admin**. Those changes also require a text code.

Set `OPENAI_API_KEY` (and optionally `OPENAI_VISION_MODEL`, default `gpt-4o-mini`) to turn scanning on. The key stays on the server. With no key, Scan explains that, and nothing is sent anywhere. Manual entry and the reference list still work. Vision calls are billed by the provider per image. Treat the result as an approximation: measure large, soft, or unusual pieces on site before the quote goes out. The printable summary says the same thing.

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
| `SESSION_SECRET` | Required in production, 16+ characters. Also used to hash text codes. |
| `OWNER_EMAIL`, `OWNER_NAME`, `OWNER_PASSWORD` | The only owner. Created on first start. The password is hashed and is not reset later unless `OWNER_RESET_PASSWORD=true`. |
| `OWNER_PHONE` | Owner mobile number for text codes. Example placeholder `+15555550100`. Never commit a real number. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Send those codes. Required in production before invites and other owner checks. |
| `OPENAI_API_KEY`, `OPENAI_VISION_MODEL` | Optional furniture scan. Unset means manual inventory only. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | Optional invite email. Without them, the owner copies the link. |
| `DEMO_MODE` | Shared demo login. On outside production when `OWNER_EMAIL` is unset. Off in production. Set `false` to disable it in dev. |
| `STAFF_EMAIL`, `STAFF_NAME`, `STAFF_PASSWORD` | Local demo owner when `OWNER_EMAIL` is unset. Defaults to the walkthrough login. Not used once an owner is configured. |
| `SHOW_DEMO_BANNER` | Show the demo password on the login page. Off in production and whenever `OWNER_EMAIL` is set. |
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

No Daily, LiveKit, or other video-vendor key is required. Twilio is only for the owner’s text codes, not for the video call.

## Deploy

The app is one Node process. Run a single instance: signaling state lives in memory, and recordings for one call are uploaded to that process. A small office does not need a cluster.

### Docker

Create a production `.env` (do not use the demo password):

```bash
SESSION_SECRET=a-long-random-string-here
OWNER_EMAIL=henrik@example.com
OWNER_NAME=Henrik Samuelsson
OWNER_PASSWORD=a-long-password-you-keep-offline
OWNER_PHONE=+15555550100
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM=
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
- Cameras and microphones stay in the browser. Customers are not required to install anything. A refreshed page or a denied permission ends their side of the call — say that if a room drops.

## Checks

`npm run verify` boots a temporary server and, with Chrome, joins the same room as staff and as a customer, records a few seconds, and plays the file back. The demo owner signs in with the console text code. It uses Chrome’s fake camera so it can run unattended. `npm run walkthrough` is that same path in visible windows when a display is available.

`npm run verify:office` checks the reference-table math, that a scan does not call out without an API key, customer and staff blocks on admin routes, invite expiry, and that deactivating staff ends their session.

`npm run check:pwa` checks the manifest, icon sizes, the offline page, that `/api` and Socket.IO are left on the network, and that a customer link stays on `/c/…`.

Lighthouse 12 and newer dropped the PWA category. Installability is still scored by Lighthouse 11:

```bash
npx lighthouse@11.7.1 http://localhost:3000/login --only-categories=pwa --chrome-flags="--headless=new --no-sandbox"
```

## Layout

- `server/` — Express, SQLite sessions and records, Socket.IO signaling, recording uploads, optional S3
- `public/` — the staff desk, the customer lobby, the call, `manifest.webmanifest`, `sw.js`, and `offline.html`
- `public/icons/` — home-screen icons, including maskable and Apple touch icons. Regenerate with `python3 scripts/generate-icons.py` (needs Pillow).
- `deploy/` — nginx, systemd, and coturn samples
- `data/` — created at runtime and not committed

Fonts: [Fraunces](https://fonts.google.com/specimen/Fraunces) and [Outfit](https://fonts.google.com/specimen/Outfit) under the SIL Open Font License. License texts are in `public/fonts/`.
