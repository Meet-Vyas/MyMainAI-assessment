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
