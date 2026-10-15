# UGN Video: large uploads and cross-platform playback

Take-home for Underground Nights. An admin uploads 10 GB+ / 10 h+ videos straight from the browser to S3-compatible storage (resumable, pause/resume/cancel). A BullMQ worker turns them into adaptive HLS with ffmpeg. A public page plays them with native HLS where the platform has it, and hls.js where it doesn't.

| Doc | What's in it |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Diagrams of the upload → process → playback flow, data model, lifecycle, key decisions, failure modes, rejected alternatives, running on real AWS |
| [ANSWERS.md](ANSWERS.md) | Written questions W1–W7 |
| [TESTING.md](TESTING.md) | Test matrix: what was verified, how, and what wasn't |
| [PLAN.md](PLAN.md) | Milestones and the decisions log written while building |

## Prerequisites

- **Docker** with Compose v2.20+ (for `include`). On Docker Desktop, give it **at least 4 CPUs and 8 GB of memory**: the worker is limited to 4 CPUs and 4 GB, and Compose refuses a CPU limit larger than the VM.
- **Disk:** a few GB for images. Large videos need room for the source in MinIO, plus worker scratch space for a copy of the source and the encoded output. A 10 h 1080p video needs ~60 GB of free scratch on top of the stored source. On Docker Desktop that's the VM's disk image, and the worker's free-space check can't see the Mac's real free space (see [TESTING.md](TESTING.md#open-items-and-known-gaps)).
- **Node 22+ and npm:** only needed to run the tests on the host. The stack itself runs entirely in Docker, ffmpeg included.

## Run it

```sh
docker compose up -d --build
```

The first build takes a few minutes. The backend applies migrations and seeds the admin on every start. Stop with `docker compose down`; add `-v` to also delete the database, queue and stored videos.

| What | URL | Credentials |
|---|---|---|
| Public library and player | http://localhost:5173 | none |
| Admin (upload, status, retry, delete) | http://localhost:5173/admin | `admin@ugn.local` / `admin12345` |
| API | http://localhost:3000/api (also proxied at `:5173/api`) | session cookie |
| Playback API | `GET http://localhost:3000/api/videos/:id/playback` | none |
| MinIO console | http://localhost:9001 | `minioadmin` / `minioadmin` |
| Postgres / Redis | `localhost:5432` (ugn / ugn / ugn) / `localhost:6379` | |

These are dev-only defaults. Override them in a root `.env` (see [.env.example](.env.example)); each app also has its own `.env.example` listing every variable it reads.

### Try it

1. Sign in at `/admin` and upload a video. Watch progress, speed and ETA, then try **Pause**, a page reload (re-select the same file to resume), or **Cancel**.
2. The video moves through `UPLOADING → UPLOADED → PROCESSING n% → READY` live, without a reload.
3. Open it from the library at `/`, or with **Watch** in the admin list. Useful URL parameters:
   - `?t=7:42:10` starts at a time.
   - `?player=hlsjs` or `?player=native` forces a playback engine. Recent desktop Chrome plays HLS natively, so it uses the native path unless you force hls.js.
4. Native players: open the `manifestUrl` from the playback API in VLC, AVPlayer or ExoPlayer.

**Test media.** No video files are committed. Generate a long one with:

```sh
ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440 \
  -t 10:00:00 -c:v libx264 -preset ultrafast -c:a aac -shortest long-10h.mp4
```

Add `-b:v 2500k` or a higher resolution to reach ~10 GB. A short clip is enough to see the whole flow; a 14-minute 1080p video takes ~10 min to process on 4 CPUs.

### On a phone (same Wi-Fi)

Presigned URLs and media URLs must use an address the phone can reach. Put your machine's LAN IP in `.env`:

```sh
S3_PUBLIC_ENDPOINT=http://192.168.1.20:9000
PUBLIC_MEDIA_BASE_URL=http://192.168.1.20:9000/ugn-videos
```

Then run `docker compose up -d backend` and open `http://192.168.1.20:5173` on the phone.

- `PUBLIC_MEDIA_BASE_URL` is read when the playback API answers, so existing videos pick up the new address; no re-processing is needed.
- Over plain HTTP on a LAN IP, the upload resume check falls back to name and size, because WebCrypto needs a secure context.
- To test in an Instagram or TikTok webview, send yourself the link in a DM and open it there.

## Tests

```sh
npm ci
npm test                              # unit tests: contracts, backend, worker (Jest), frontend (Vitest)
npm run typecheck
npm run test:e2e -w @ugn/backend      # end to end, against the running stack (docker compose up first)
```

- **Unit (144 tests).**
  - Upload orchestration: part sizing, init/sign/status/complete, the server-side part check, idempotent complete, the sweeper.
  - The upload engine, with the network injected: resume, concurrency, retries through network errors, re-signing on 403, 409 gaps, pause, cancel, session expiry.
  - The worker pipeline and state machine, with fake ffmpeg, S3 and DB: success, crash recovery, superseded and deleted videos, invalid media, retries, shutdown, delete mid-encode.
  - The reconciler's decisions, the ffmpeg arguments and ladder, probe validation, output headers.
  - The playback API.
  - Player engine detection, error handling, resume watching and timecode parsing.
- **E2E.** A real multipart upload through presigned URLs, and a real transcode of a 14 s clip to READY with 3 renditions. It checks content types, cache headers, CORS, the playback API, and that delete removes every object. Random bytes named `.mp4` must fail with no retries. The test clip is generated inside the worker container, so the host needs no ffmpeg.
- **Manual verification** (crash and stop tests, browsers, measurements on the 10 h video): see [TESTING.md](TESTING.md).

## Repository layout

```
apps/backend       NestJS API: auth, uploads, videos, playback, SSE events, sweeper
apps/worker        NestJS + BullMQ worker: probe, poster, HLS ladder, reconciler
apps/frontend      React 19 + Vite: admin uploader, public library and player
packages/contracts Shared zod schemas and types (DTOs, job payloads, state machine, storage keys)
packages/db        Prisma 6 schema, migrations and client (shared by backend and worker)
infra              docker-compose.yml, Dockerfile, MinIO bucket init
```

## Assumptions

Where the brief left room, these are the calls I made:

- **Ladder:** the top three of 1080p / 720p / 480p / 360p **at or below the source**, never upscaled. A 1080p source gets 1080/720/480, as in the brief; a 720p source gets 720/480/360. Portrait video stays portrait.
- **Visibility:** a video is public as soon as it's READY. There's no draft or unlisted state. Private and paid videos are discussed in W5.
- **Resume after a reload** requires re-selecting the file, because browsers can't reopen a file by themselves. The file is identified by name, size, `lastModified` and a SHA-256 of its first and last MiB.
- **Limits:** uploads up to 50 GiB (a 10 h set at 8 Mbit/s is ~36 GB). Accepted containers: mp4, m4v, mov, mkv, webm, avi. The real check is ffprobe in the worker.
- **Abandoned uploads** are deleted after 24 h without activity, with a 48 h storage-level abort as the backstop.
- **Resume watching** is per device (localStorage), as the brief allows.
- **One admin**, seeded from env. No sign-up, roles or password reset.
- **Locally**, MinIO with an anonymously readable `public/` prefix stands in for S3 + CloudFront. In production the bucket is private behind CloudFront OAC; the env changes and AWS setup are in [ARCHITECTURE.md](ARCHITECTURE.md#running-against-real-aws).
- **Native app support** is shown through the playback API, and by the stream being plain HLS (H.264/AAC, MPEG-TS) that AVPlayer and ExoPlayer play directly. No app was built.

## What's missing

The full list, and next week's plan, are in [ANSWERS.md, W7](ANSWERS.md#w7-what-was-left-out-or-simplified-and-next-weeks-plan). The biggest gaps:

- **Not verified yet:** a full 10 GB upload, the 10 h video reaching READY (its encode was run to 30%), and real iPhone, Android and in-app webview playback. [TESTING.md](TESTING.md) marks exactly what was run, extrapolated or not done.
- **A worker crash restarts the encode from 0.** No chunked transcoding or segment checkpointing yet (W2).
- **No stretch goals:** no signed URLs, captions, sprite scrubbing, chapters or cost dashboard.

## How AI assistants were used

I used **Claude Code** (Anthropic) throughout, as a pair programmer under my direction:

- **Planning:** we wrote the milestone plan together. Every decision went into the decisions log in [PLAN.md](PLAN.md) with its reasoning, and these docs are built from it. [CLAUDE.md](CLAUDE.md) holds the repo conventions and the gotchas we hit, so each session started from the same context.
- **Code and tests:** Claude wrote most of the first drafts of the code and tests, one milestone at a time. I reviewed each milestone, asked for changes, and committed it myself (one commit per milestone).
- **Verification:** Claude drove Chrome through the Claude-in-Chrome extension, and headless Chrome over the DevTools protocol, for the browser checks. It ran the crash and stop tests against the running stack and recorded the measurements. I ran the Safari checks and the 10 h runs by hand. The Safari check found a real bug: the Full screen button was clipped on a portrait video.
- **Docs:** Claude drafted README, ARCHITECTURE, ANSWERS and TESTING from the decisions log. I edited them.

I can explain and change any part of the code.
