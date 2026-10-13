# Plan: UGN Video Feature take-home

## Context
The repo is empty apart from the spec PDF and CLAUDE.md. Today is Tue Oct 13 and the deadline is Thu Oct 15 EOD, which leaves about 2.5 days for 12–16 hours of work. Grading weights reasoning and reliability over polish, so we build a thin vertical slice that works from start to finish first, then harden it, then write the docs. The first action is to copy this plan into the repo as `PLAN.md`, with checkboxes we tick as we go. Each milestone becomes one or more meaningful commits, since the grader wants a real commit history.

## How we work
- Work in milestones. After each one: it runs under `docker compose up`, tests pass, we commit, and we tick the box in PLAN.md.
- Record decisions and assumptions in `ARCHITECTURE.md` and `README.md` while we make them, not at the end.
- `packages/contracts` is the single source of truth for types and zod schemas.
- If time runs short, cut the stretch goals and frontend polish first. Never cut resumability, crash recovery or the docs.

## Key design decisions (to justify in ARCHITECTURE.md)
- **Upload:** S3 multipart with presigned part URLs issued by the backend. The browser PUTs parts straight to MinIO/S3, so file bytes never touch the API.
  - **Part size:** 16 MiB, scaled up only if needed to stay under 10,000 parts. A 10 GB file is about 640 parts.
  - **Concurrency:** 4 parts in flight, with per-part retry and backoff.
  - **Resume:** the backend stores the `uploadId` and key in Postgres; the browser keeps a fingerprint (name, size, lastModified) mapped to the videoId in localStorage. On reload, the UI asks the user to re-select the file, the backend calls ListParts, and only the missing parts are sent.
  - **Cleanup:** cancel calls AbortMultipartUpload. A BullMQ repeatable sweeper aborts uploads with no activity for 24h. An S3 lifecycle rule (`AbortIncompleteMultipartUpload` after 2 days) is the backstop.
- **Processing:** a BullMQ `process-video` job with a long `lockDuration` that is renewed automatically, `maxStalledCount` set, 3 attempts with exponential backoff, and worker concurrency of 1 per container.
  - **Pipeline:** download the source to a temp directory, ffprobe it (reject non-video files), poster, HLS ladder, upload outputs, mark READY.
  - **Idempotency:** output goes to `videos/{id}/hls/v{attempt}/`, and the DB pointer is flipped atomically at the end. Old prefixes are cleaned up.
  - **Resource bounds:** docker cpu/mem limits, `ffmpeg -threads`, a disk check before starting, and temp directories always removed.
  - **Progress:** parsed from ffmpeg `-progress`, sent via `job.updateProgress`, and written through to the DB (throttled).
  - **Zombie recovery:** stalled jobs get re-queued, plus a reconciler that resets PROCESSING rows with no live job.
- **HLS:** H.264 High profile with AAC-LC, fMP4 or TS segments of 6s with keyframes aligned (`-g` = 2× fps, no scene-cut), and VOD playlists. The ladder is 1080p/720p/480p (360p optional). One encode pass produces all renditions with `-var_stream_map` and a master playlist. This gives fast start and quick seeks.
- **Playback:** if `video.canPlayType('application/vnd.apple.mpegurl')`, use native playback (Safari, iOS, most webviews). Otherwise, if `Hls.isSupported()`, use hls.js. Otherwise, show the unsupported state.
  - Use `playsinline` and `muted`-free autoplay avoidance, plus a custom accessible control bar and a quality selector.
  - Resume position is saved per video in localStorage.
- **Storage headers:** CORS on the bucket. `.m3u8` gets `application/vnd.apple.mpegurl` with `max-age=10`. Segments get `max-age=31536000, immutable`.
- **Live status:** SSE endpoint `GET /admin/videos/events`, fed by the worker over Redis pub/sub. Polling is the fallback.

## Milestones
- [x] 1. **Scaffold.** Set up the npm workspaces, contracts package and tsconfig base. Docker Compose with postgres, redis, minio plus a bucket and CORS init job, backend, worker and frontend. Write `.env.example` files. Make `docker compose up` boot. *(about 2h)*
- [ ] 2. **Backend core.** Prisma `Video` model with status, `uploadId`, keys, duration, renditions, error and attempts, plus a seed admin. jose JWT cookie auth with a guard. Videos CRUD. *(about 1.5h)*
- [ ] 3. **Multipart upload API.** Endpoints for init, sign parts (batch), list parts, complete and abort, with zod validation. Enqueue the job on complete. Add the sweeper. Add tests. *(about 2h)*
- [ ] 4. **Admin upload UI.** Login screen. Uploader with chunking, concurrency, pause/resume/cancel, speed and ETA, and resume after refresh. Video list with live status through SSE, plus retry and delete. Apply the UGN theme. *(about 2.5h)*
- [ ] 5. **Worker.** Probe, poster, HLS ladder, upload, progress, retries, idempotency and reconciler. Tests for the state machine. *(about 2.5h)*
- [ ] 6. **Public playback.** List of READY videos. Player page with detection logic, quality menu, accessible controls, resume watching and the graceful states. `GET /videos/:id/playback`. *(about 2h)*
- [ ] 7. **Verification.** Generate 10h and ~10GB test files. Test kill/resume for uploads, kill the worker mid-job, and test on devices. Fill in the test matrix. *(about 1.5h)*
- [ ] 8. **Docs.** README (including AI usage and assumptions), ARCHITECTURE (with a mermaid diagram) and ANSWERS W1–W7. Demo video if time allows. *(about 2h)*

## Decisions log (copy into README / ARCHITECTURE)
- **MinIO image:** the official `minio/minio` and `minio/mc` repos are gone from Docker Hub, and quay.io needs a login. We use Bitnami's frozen archive builds `bitnamilegacy/minio:2025.7.23-debian-12-r5` and `bitnamilegacy/minio-client:2025.7.21-debian-12-r3`, pinned so reviewers run exactly what was tested. Production uses real S3, so this only affects local dev.
- **Bucket layout:** `uploads/` is private (presigned access only); `public/` allows anonymous read for HLS and posters. MinIO's default CORS already allows the frontend origin.
- **Abandoned multipart uploads (local):** MinIO's `MINIO_API_STALE_UPLOADS_EXPIRY=48h` stands in for S3's `AbortIncompleteMultipartUpload` lifecycle rule.
- **To check in milestone 3:** the browser must be able to read the `ETag` header on part PUT responses (CORS `ExposeHeaders`).

## Critical files (to be created)
- `package.json` (workspaces)
- `infra/docker-compose.yml`
- `packages/contracts/src/*`
- `apps/backend/prisma/schema.prisma`
- `apps/backend/src/{auth,uploads,videos,playback,events}/`
- `apps/worker/src/{processor,ffmpeg,reconciler}/`
- `apps/frontend/src/{pages,components/Uploader,components/Player}/`
- `PLAN.md`, `README.md`, `ARCHITECTURE.md`, `ANSWERS.md`

## Verification
- `npm test` runs unit and integration tests for upload orchestration, the job state machine and the playback API. Testcontainers or the compose services are acceptable.
- Manual checks:
  - Upload ~10GB, kill the network partway, then refresh and resume.
  - Cancel an upload and confirm MinIO has no leftover parts.
  - `docker kill` the worker mid-transcode and confirm it recovers.
  - Seek to 07:42:10.
  - Play in Chrome, Firefox and Safari.
  - Play on an iPhone over the LAN IP or an ngrok tunnel, and inside an Instagram webview via a link.
  - Play the master URL in VLC.
