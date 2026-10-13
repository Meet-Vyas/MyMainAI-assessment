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
  - **Part size:** 16 MiB, scaled up only if needed to stay under 10,000 parts. A 10 GB file is about 600 parts.
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
- [x] 2. **Backend core.** Prisma `Video` model with status, `uploadId`, keys, duration, renditions, error and attempts, plus a seed admin. jose JWT cookie auth with a guard. Videos CRUD. *(about 1.5h)*
- [x] 3. **Multipart upload API.** Endpoints for init, sign parts (batch), list parts, complete and abort, with zod validation. Enqueue the job on complete. Add the sweeper. Add tests. *(about 2h)*
- [ ] 4. **Admin upload UI.** Login screen. Uploader with chunking, concurrency, pause/resume/cancel, speed and ETA, and resume after refresh. Video list with live status through SSE, plus retry and delete. Apply the UGN theme. *(about 2.5h)*
- [ ] 5. **Worker.** Probe, poster, HLS ladder, upload, progress, retries, idempotency and reconciler. Tests for the state machine. *(about 2.5h)*
- [ ] 6. **Public playback.** List of READY videos. Player page with detection logic, quality menu, accessible controls, resume watching and the graceful states. `GET /videos/:id/playback`. *(about 2h)*
- [ ] 7. **Verification.** Generate 10h and ~10GB test files. Test kill/resume for uploads, kill the worker mid-job, and test on devices. Fill in the test matrix. *(about 1.5h)*
- [ ] 8. **Docs.** README (including AI usage and assumptions), ARCHITECTURE (with a mermaid diagram) and ANSWERS W1–W7. Demo video if time allows. *(about 2h)*

## Decisions log (copy into README / ARCHITECTURE)
- **MinIO image:** the official `minio/minio` and `minio/mc` repos are gone from Docker Hub, and quay.io needs a login. We use Bitnami's frozen archive builds `bitnamilegacy/minio:2025.7.23-debian-12-r5` and `bitnamilegacy/minio-client:2025.7.21-debian-12-r3`, pinned so reviewers run exactly what was tested. Production uses real S3, so this only affects local dev.
- **Bucket layout:** `uploads/` is private (presigned access only); `public/` allows anonymous read for HLS and posters. MinIO's default CORS already allows the frontend origin.
- **Abandoned multipart uploads (local):** MinIO's `MINIO_API_STALE_UPLOADS_EXPIRY=48h` stands in for S3's `AbortIncompleteMultipartUpload` lifecycle rule.
- **Shared `packages/db`:** the Prisma schema, migrations and client live in their own workspace (not `apps/backend`) because the worker also writes video status. Prisma 6 and jose 5 rather than the newest majors: both still ship CommonJS, which NestJS compiles to. Prisma 7 would change client generation and add driver adapters for no benefit here.
- **Auth:** scrypt (built into Node, no native add-on) with a `scrypt$N$r$p$salt$hash` format so parameters can be raised later. JWT is HS256 with issuer/audience checks, 8h expiry, in an httpOnly `SameSite=Lax` cookie (`Secure` via `COOKIE_SECURE`). An unknown email is checked against a dummy hash, so timing doesn't reveal which emails exist. The frontend proxies `/api`, so the cookie is same-origin.
- **Seed:** runs on every backend start and is idempotent. Changing `ADMIN_PASSWORD` and restarting resets the password.
- **Delete order:** abort multipart, then delete `uploads/{id}/`, then `public/videos/{id}/`, then the row. If storage fails, the row survives and the delete is retryable. Deleting while PROCESSING returns 409 until the worker can cancel jobs (milestone 5).
- **Status transitions:** defined once in `@ugn/contracts` (`canTransition`). READY is terminal; FAILED goes back to UPLOADED on retry; PROCESSING goes back to UPLOADED when the reconciler re-queues a crashed job.
- **Known audit findings (accepted):** `deepmerge-ts` via the Prisma CLI and `sprintf-js` via ts-jest. Both are DoS bugs in dev/build tooling that never handles request data. Jest was upgraded to 30 to clear the others.
- **Server-side completion:** on `/complete` the backend lists the parts S3 actually holds, checks every part number and size, and only then assembles the upload. A 409 names the missing/truncated parts so the client re-sends just those. The browser never reads `ETag`, so no CORS `ExposeHeaders` setup is needed (this resolves the earlier milestone 3 note).
- **Two S3 clients:** one for the backend's own calls (`minio:9000` in Docker) and one that only signs URLs for the host the browser uses (`S3_PUBLIC_ENDPOINT`, `localhost:9000`), because SigV4 signatures cover the host. For phone testing on a LAN, set `S3_PUBLIC_ENDPOINT=http://<LAN-IP>:9000`.
- **SDK checksum default off for presigning:** newer AWS SDKs add a CRC32 checksum to presigned UploadPart URLs, computed over an empty body, which breaks real browser uploads. Both clients use `requestChecksumCalculation: 'WHEN_REQUIRED'`.
- **Idempotent complete:** a repeat call after success returns the video. If S3 finished but the row update crashed, the next call sees `NoSuchUpload`, checks that the assembled object exists at the right size, and finishes the transition. The UPLOADING→UPLOADED update is conditional, so concurrent completes can't both win.
- **Job IDs:** `{videoId}-run{n}` (BullMQ forbids `:`). Enqueueing the same run twice is de-duplicated; an admin retry bumps `attempts` to get a new run. Job options: 3 attempts, exponential backoff from 30s, completed jobs kept 7 days and failed jobs 30 days.
- **Expired uploads:** if storage has already dropped the multipart upload (lifecycle rule), status and complete return 410 Gone and delete the video.
- **Abandoned-upload sweeper:** a BullMQ job scheduler (`maintenance` queue, every 15 min, so only one instance sweeps) deletes UPLOADING videos idle for over 24h (`ABANDONED_UPLOAD_TTL_HOURS`). Signing and status calls count as activity. 24h survives a laptop closed overnight and stays under the 48h storage-level backstop.
- **Custom thumbnail:** a presigned POST (not PUT) so storage itself enforces 5 MiB max and the exact content type. It's stored at `public/videos/{id}/custom-thumbnail` and recorded on complete. It's publicly readable as soon as it's uploaded (admin-only upload, so accepted).
- **Size limit:** 50 GiB (a 10-hour set at 8 Mbit/s is about 36 GB). The pre-upload type check is extension plus declared MIME; browsers often send `''` for `.mkv`. The real check is ffprobe in the worker.
- **Cancel** is `DELETE /admin/videos/:id`, which aborts the S3 upload and removes the objects. No separate abort endpoint.
- **To revisit in milestone 5:** let DELETE cancel a PROCESSING job instead of returning 409. The worker must also treat a job whose video no longer exists (deleted after enqueue) as a no-op, not a failure.

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
