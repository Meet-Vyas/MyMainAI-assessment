# CLAUDE.md

Guidance for Claude Code working in this repo.

## Project

Take-home assessment for Underground Nights (Full-Stack TypeScript role): **large-video upload & cross-platform playback**. Full spec: `UGN-Take-Home-Assessment-Video-Feature.pdf`.

- **Deadline:** Thursday, Oct 15, 2026, end of day. Suggested effort 12–16 hours. Time-box: a clear list of what's missing beats rushed code.
- **Evaluated on how we think:** trade-offs, failure modes, proof it works. Small and well-tested beats large and fragile.
- Weighting: Architecture & reasoning 25%, Large-upload reliability 20%, Cross-platform playback 20%, Background processing 15%, Code quality & tests 10%, UX 5%, Docs/DX 5%.

## Required stack (npm-workspaces monorepo)

| Workspace | Tech | Responsibility |
|---|---|---|
| `apps/backend` | NestJS, Prisma, PostgreSQL 16 | REST API, auth, upload orchestration, video metadata |
| `apps/worker` | NestJS, BullMQ, Redis 7 (ioredis), ffmpeg/ffprobe | Probe, transcode, thumbnails |
| `apps/frontend` | React 19, TypeScript, Vite | Admin upload UI + public video page |
| `packages/contracts` | Shared TS types | DTOs, job payloads, enums, zod schemas shared by all apps |
| `packages/db` | Prisma 6 | Schema, migrations and client, shared by backend and worker (our addition) |
| `infra` | Docker Compose | Postgres, Redis, MinIO, all apps; `docker compose up` runs everything |

**Frontend:** Tailwind (primary `#DC2626`, near-black dark palette, Bebas Neue headings, Montserrat body), Framer Motion, lucide-react, react-hot-toast, react-hook-form + zod, hls.js.

**Conventions:**
- Auth: custom JWT in an httpOnly cookie, signed/verified with `jose`. One seeded admin user, no sign-up.
- Storage: S3-compatible. MinIO locally; must work against real AWS S3 + CloudFront by changing env vars only.
- No managed video SaaS (Mux, Cloudflare Stream, api.video, etc.). Build the pipeline ourselves.

## Part A: Upload & processing (A1–A10)

- 10 GB+ / 10 h+ files from a browser on a home connection.
- Bytes go **directly to storage** (presigned S3 multipart). They never pass through API memory or disk, and no credentials go to the client.
- Resumable across network drops, tab close, and refresh: persist upload state, use ListParts to resume. Pause, resume, and cancel; accurate progress, speed, and ETA.
- No orphaned data: abort multipart on cancel, sweep abandoned uploads (and set an S3 lifecycle rule for incomplete multipart uploads).
- Validate on client and server (zod; type, size, metadata). ffprobe the actual media to reject renamed non-video files.
- Async BullMQ processing: HLS ABR output, poster/thumbnail, real duration.
- Lifecycle `UPLOADING → UPLOADED → PROCESSING (n%) → READY | FAILED`, live in the UI without reload.
- Jobs survive worker crash/restart (lock duration, stalled-job handling, no zombie PROCESSING), retry sensibly, and are idempotent.
- Failed videos show a reason and support retry/delete. Delete removes all stored objects.
- Justify part size and concurrency, and bound worker CPU, disk, and memory.

## Part B: Public playback (B1–B9)

- Targets: desktop Chrome/Edge/Firefox/Safari; iOS Safari, Android Chrome, Samsung Internet (inline playback with `playsinline`, rotation/lock); Instagram/FB/TikTok webviews; native AVPlayer/ExoPlayer.
- HLS with ≥3 renditions (1080/720/480), automatic switching. Justify codec, container, and segment choices (H.264/AAC is the safe baseline).
- Fast start and quick seek in 10 h videos (e.g. 07:42:10) without downloading the whole file.
- Native HLS where supported (`canPlayType('application/vnd.apple.mpegurl')`), otherwise hls.js. Document the detection.
- Poster, duration, title, manual quality selector, keyboard- and screen-reader-accessible controls.
- Resume watching (per device is fine).
- Correct CORS, MIME types, and caching (short TTL for playlists, long/immutable for segments).
- `GET /videos/:id/playback` returns manifest URL, poster, duration, renditions, status.
- Graceful states: processing, failed, not found, unsupported browser, network error.
- Stretch goals (only once core is solid): signed URLs/cookies, WebVTT captions, sprite scrubbing, chapters, cost dashboard, chunked/parallel transcode.

## Deliverables

- Public GitHub repo with **meaningful, incremental commits** (not one squashed commit). No secrets or video files committed; provide `.env.example` files.
- `README.md`: prerequisites, `docker compose up`, seeded admin credentials, URLs, how to run tests, assumptions made, and **where/how AI assistants were used**.
- `ARCHITECTURE.md`: upload → process → playback diagram, data model, key decisions, rejected alternatives.
- `ANSWERS.md`: written questions W1–W7 (concise):
  - W1 Wi-Fi drop at 63% of 10 GB; laptop closed overnight
  - W2 Worker crash 9 h into a 10 h transcode; reducing lost work
  - W3 Monthly AWS cost for 200 × 10 GB/10 h videos at 2,000 watch-hours each; self-hosted ffmpeg vs MediaConvert
  - W4 Why video plays in desktop Chrome but not iPhone/Instagram; how the design avoids it
  - W5 Private/paid videos without breaking CDN caching or native playback
  - W6 Porting to Next.js 14 App Router + Prisma + MySQL + S3/CloudFront
  - W7 What was left out; next week's plan
- Test matrix: browsers/devices actually verified, how, and what couldn't be tested.
- Tests for critical paths: upload orchestration, job state machine, playback API.
- Optional 5–10 min demo video.

## Test media

Never commit video files. Generate them with:

```sh
ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440 \
  -t 10:00:00 -c:v libx264 -preset ultrafast -c:a aac -shortest long-10h.mp4
```

Add `-b:v 2500k` or a higher resolution to reach ~10 GB.

## Working rules

- Keep types end-to-end through `packages/contracts`; don't redefine DTOs per app.
- When something is ambiguous, make a reasonable assumption and record it in the README.
- The author must be able to explain every line live, so prefer clear code over clever code.

## How to work here

**Start every session by reading `PLAN.md`.** It has the milestone checklist and a **decisions log** with the reasoning behind each choice and open notes for later milestones. After finishing a milestone, tick it and add its decisions to the log; the README and ARCHITECTURE docs are written from it.

**Working agreements with the author**
- **Never commit unless explicitly asked.** The author reviews each milestone first. Commits are one per milestone, with a descriptive message (they're graded).
- Do one milestone at a time. Don't start the next until asked.
- Ask (AskUserQuestion) when blocked on a real decision; otherwise decide and log it in `PLAN.md`.
- Verify against the running stack, not only unit tests. Report plainly what was and wasn't verified.

**Commands** (from the repo root)

| What | Command |
|---|---|
| Run everything | `docker compose up -d --build` (rebuild one service: `docker compose up -d --build backend`) |
| Unit tests | `npm test`: Jest for contracts and backend, Vitest for frontend |
| E2E tests (stack must be up) | `npm run test:e2e -w @ugn/backend` |
| Typecheck / build | `npm run typecheck` / `npm run build` |
| New migration | edit `packages/db/prisma/schema.prisma`, then in `packages/db`: `DATABASE_URL=postgresql://ugn:ugn@localhost:5432/ugn npx prisma migrate dev --name <name>`. The backend container applies migrations and re-seeds the admin on start. |

After changing `packages/contracts`, run `npm run build -w @ugn/contracts` before typechecking the apps; they import its `dist/`.

**Local URLs and dev credentials** (dev-only defaults from Compose)
- App: http://localhost:5173 (`/admin`, `/login`). API: http://localhost:3000/api (also proxied at `:5173/api`).
- Admin: `admin@ugn.local` / `admin12345`. MinIO console: http://localhost:9001 (`minioadmin` / `minioadmin`).
- Postgres `localhost:5432` (ugn/ugn/ugn), Redis `localhost:6379`.
- Inspect storage: `docker compose exec -T minio mc --config-dir /tmp/.mc alias set local http://localhost:9000 minioadmin minioadmin`, then `... mc --config-dir /tmp/.mc ls -r [--incomplete] local/ugn-videos`.

**Where things are**
- Backend modules: `apps/backend/src/{auth,videos,uploads,playback,storage,queue,events,config,prisma}`. `playback/` is the public, unauthenticated API (`GET /videos`, `GET /videos/:id/playback`). E2E tests are in `apps/backend/test/`.
- Upload engine (core client logic, unit-tested): `apps/frontend/src/upload/UploadEngine.ts`.
- Player: `apps/frontend/src/player/`. `playbackMode.ts` (native vs hls.js detection), `playbackSource.ts` (attaches either engine, quality switching), `playbackErrors.ts` (error decisions), `watchProgress.ts` (resume), `VideoPlayer.tsx` (controls, shortcuts, fullscreen). The pure modules are unit-tested. Pages: `pages/HomePage.tsx` (library), `pages/WatchPage.tsx` (all playback states).
- Worker: `apps/worker/src/processing/video-job.runner.ts` (pipeline + state machine, unit-tested with fakes), `video.processor.ts` (BullMQ glue, shutdown), `reconciler.service.ts`, `media/` (ffprobe, ladder, ffmpeg args).
- Shared rules (state machine, part sizing, storage keys, job ids, events): `packages/contracts/src/`.

**Gotchas already hit (don't rediscover)**
- **MinIO images:** official `minio/minio` and `minio/mc` are gone from Docker Hub, and quay.io needs a login. Use the pinned `bitnamilegacy/minio` and `bitnamilegacy/minio-client`. Their home dir isn't writable, so pass `mc --config-dir /tmp/.mc`.
- **Presigned URLs:** sign with the browser-facing host (`S3_PUBLIC_ENDPOINT`), not `minio:9000`. Keep `requestChecksumCalculation: 'WHEN_REQUIRED'`, because SDK default checksums break browser part uploads.
- **BullMQ:** custom job ids can't contain `:`. Workers need `maxRetriesPerRequest: null`.
- **Tailwind v4:** global element styles must live in `@layer base`, or they override utility classes.
- **Tests in Node:** `navigator.onLine` is undefined, so inject `isOnline` in engine tests.
- **Shell (zsh):** don't store a multi-word command in a variable and call `$VAR`; use a function. `[ a \> b ]` isn't supported either.
- **Worker crash tests:** `docker compose kill worker` counts as a manual stop, so `restart: unless-stopped` won't bring it back; `docker compose start worker` afterwards. A killed job is re-picked after the 120 s lock lapses (~3 min). Use `test-media/iphone-14min-portrait.mov` (~10 min encode); `set-5min.mp4` is done in 40 s.
- **Containers need `init: true`:** Node as PID 1 ignores the SIGTERM NestJS re-sends itself, so stops hang until SIGKILL.
- **ffmpeg must run niced:** at equal priority it starved Node long enough to lose the BullMQ lock.
- **Browser automation (Chrome extension):** `file_upload` only takes files under 10 MB. Build a synthetic `File` in the page and assign it through `DataTransfer`. Coordinate clicks sometimes stop reaching the page; check with an in-page `click()` and ask the author to confirm by hand. Don't trigger native dialogs.
- **Desktop Chrome plays HLS natively now** (`canPlayType` returns `"maybe"`), so it takes the native path. Add `?player=hlsjs` (or `?player=native`) to a watch URL to test the other engine.
- **Player layout follows the player's width, not the screen's** (container queries on the player). A portrait video on a laptop is a narrow player. After changing the control bar, check portrait and landscape videos at laptop and phone sizes with a 10 h timestamp; the Full screen button once got clipped this way.
- **Chrome extension can drop mid-session.** Fall back to headless Chrome over the DevTools protocol (`--headless=new --remote-debugging-port`, Node's global `WebSocket`); `Emulation.setDeviceMetricsOverride` covers phone sizes but not `pointer: coarse`. Safari can only be automated through `safaridriver`, which the author must enable once (`sudo safaridriver --enable` plus Develop → Allow Remote Automation).
