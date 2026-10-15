# Written answers (W1–W7)

Numbers marked *measured* come from runs on this stack (see [TESTING.md](TESTING.md)). Everything else is arithmetic or an estimate, and says so.

## W1. Wi-Fi drops at 63% of a 10 GB upload, back 20 minutes later. Laptop closed overnight?

A 10 GB file is 597 parts of 16 MiB. At 63%, ~376 parts are complete in S3 and up to 4 are in flight.

**Wi-Fi drops for 20 minutes:**
1. The 4 in-flight PUTs fail. If the link hangs instead of erroring, the engine aborts any part with no progress for 45 s. Completed parts are safe in S3: a multipart upload keeps its parts until it's completed or aborted.
2. The engine switches to **"Reconnecting"**. Network errors never fail an upload: it retries with jittered backoff capped at 30 s, waits for the browser's `online` event, and probes every 30 s anyway in case `navigator.onLine` is wrong. Progress steps back by at most the in-flight bytes (≤ 64 MiB, 0.6%).
3. Nothing on the server changes. The row stays UPLOADING. 20 minutes is far below the 24 h abandoned-upload sweep. The 8 h session is still valid.
4. Wi-Fi returns, and the next retry succeeds. Any part URL expiring within 5 min is re-signed first (URLs last 1 h), and a 403 from storage re-signs too. Only the ≤ 4 interrupted parts are re-sent, then the upload continues from ~63%.
5. At the end, `/complete` lists the parts S3 actually holds and checks every number and size before assembling. Anything missing or short comes back as a 409 listing those parts, and the client re-sends just them.

**Laptop closed overnight:** the OS suspends the tab, and every TCP connection dies.
- **Tab still open on wake:** the same path as above. The URLs have expired, so they're re-signed. If the admin logged in more than 8 h ago, signing returns 401. The engine stops with "Your session expired. Log in again, then resume", and the parts already uploaded stay in S3. After logging in, Resume asks the server for the stored parts (ListParts) and sends the rest.
- **Tab or browser closed (or discarded by the OS):** the admin page shows a resume card from localStorage (`videoId`, name, size, `lastModified`, SHA-256 of the first and last MiB). Browsers can't reopen a file by themselves, so the admin re-selects it. A different file with the same name and size is refused. Then ListParts, and the upload continues from 63%.
- **Gone longer than 24 h** (a weekend): the sweeper aborts the multipart upload and deletes the video. Resuming then says "This upload no longer exists" (or "This upload expired" with a 410 if storage dropped the upload before the sweeper ran), and the admin starts again. S3's lifecycle rule (abort incomplete uploads after 48 h) is the backstop, so a 10 GB half-upload never sits in storage costing money forever.

Verified: pause, reload, re-select and resume of a 1 GiB file in Chrome (SHA-256 of the stored object matched). The retry logic is unit-tested with the network injected (the 45 s stall timer isn't), but no network was pulled in a real browser yet. The 401 message is unit-tested; logging in again and resuming hasn't been tried in a browser.

## W2. A worker crashes 9 hours into a 10-hour video. What's lost, and how to lose less?

**What happens:**
1. ffmpeg dies with the container. Docker restarts the worker (`restart: unless-stopped`), and the new process wipes its scratch directory.
2. The job's BullMQ lock (120 s, renewed every 60 s) lapses. The stalled-job check (every 60 s) moves the job back to waiting. This doesn't use up one of the 3 attempts. The job is picked up again within ~3 min, by this worker or any other.
3. The new run claims the same row with the same run number, downloads the source again and **re-encodes from 0**. The admin UI shows progress dropping back to the start.
4. If no worker comes back, the reconciler finds the stale PROCESSING row after 5 min and sets it back to UPLOADED (shown as Queued), so it doesn't stay PROCESSING forever.
5. If the crash happened while uploading output (90–99%), the partial prefix is never published, because READY and the new prefix are set in one conditional UPDATE at the end. The next successful run deletes it.
6. A job that crashes its worker 3 times becomes FAILED ("stalled more than allowable limit") instead of looping. The admin sees the reason and can retry.

**Lost:** all 9 hours. Output is only uploaded once the whole encode finishes, so nothing survives the crash. That's about 9 h × 4 vCPU (~$1.60 on-demand), plus 9 hours of delay, which matters more. *Measured:* a SIGKILL at 25% on a 14-min video was re-picked and went READY. Two clean stops of a real 10 h job (at 20% and 30%) re-queued instantly without using an attempt, and each restart began again from 0.

**Reducing the loss**, in the order I'd build it:
1. **Chunked, parallel transcode** (the biggest win). Split the source into ~10-minute chunks at keyframes, and encode each as a BullMQ child job (a `FlowProducer` with a parent job that assembles the result).
   - Each chunk writes its segments to a deterministic key (`{run}/{rendition}/chunk_{i}/`), using `-ss`/`-t`, `-output_ts_offset` and a segment start number, so the pieces line up.
   - Audio is encoded once in its own child job (it's cheap) and served as a separate audio rendition, which avoids AAC priming gaps at chunk boundaries.
   - The parent stitches the variant playlists and writes the master.
   - A crash then loses at most one chunk (minutes of CPU). Only the failed chunk retries. 10 workers turn a ~7 h encode into well under an hour, and spot instances become safe to use.
2. **Segment checkpointing** (if chunking isn't worth it yet). Upload each segment as soon as ffmpeg finishes it, and record the last completed segment number. On restart, input-seek to that segment's start (keyframes every 2 s, 6 s segments) and continue numbering from there. A crash then loses one segment plus restart time. It also cuts scratch disk to roughly the source size, since segments no longer pile up locally.
3. **Smaller fixes:** read the source by range requests (ffprobe already does this) instead of re-downloading 10 GB per retry. Alert when a job's encode speed falls below realtime.

## W3. Monthly AWS cost for 200 × 10 GB / 10 h videos, each watched 2,000 hours

**Assumptions:**
- 200 new videos in the month, each with a 1080p source and a 1080/720/480 ladder. "Watched 2,000 hours" means 2,000 viewer-hours per video per month: **400,000 viewer-hours** in total.
- Output size is *measured* at 9.1 Mbit/s summed across the 3 renditions on handheld phone footage (close to the caps, so a worst case). That's **41 GB per video**, 8.2 TB for 200.
- The average delivered bitrate is **3 Mbit/s** (the 720p cap). Most viewers are on phones or laptops, where `capLevelToPlayerSize` keeps them at 720p or below. That's **1.35 GB per viewer-hour, ~527 TB of egress**.
- us-east-1 on-demand list prices with no commitments. Rates come from third-party price trackers, because I couldn't open AWS's own pricing pages; check them there before relying on these totals: S3 Standard $0.023/GB-month; CloudFront (North America/Europe) $0.085 → $0.080 → $0.060 → $0.040 → $0.030/GB in tiers; HTTPS requests $0.01 per 10,000; EC2 c7i.xlarge (4 vCPU) $0.18/h.

| Item | Calculation | Per month |
|---|---|---|
| **Storage** | 2 TB sources + 8.2 TB HLS = 10.2 TB × $0.023 | **~$235** (grows by this much each month if 200 new videos keep arriving) |
| **Processing, self-hosted** | *Measured* ~1.5x realtime on 4 vCPU → ~6.8 h per video × 200 × $0.18 | **~$245** on-demand, ~$95 on spot |
| **Processing, MediaConvert** | 600 min × (2 HD renditions × 2 + 1 SD × 1) = 3,000 normalized min per video × 200 = 600,000 min × ~$0.0085 (Basic) or ~$0.0136 (Professional), before volume discounts | **~$5,100–8,200** |
| **CDN egress** | 527 TB through the CloudFront tiers | **~$25,500** |
| **CDN requests** | 400,000 h × 600 segments/h = 240 M × $0.01/10k | **~$240** |
| **Total (self-hosted)** | | **~$26,000** |

**What this shows:**
- **Egress is ~97% of the bill.** At 1.5 Mbit/s average it would be ~$15k, and at 4.5 Mbit/s ~$34k. The levers that matter are the bitrate ladder and CDN pricing, not processing:
  - Negotiate CloudFront private pricing; at 500 TB/month the rate is well below list.
  - Add an HEVC ladder for devices that support it (30–40% fewer bytes).
  - Keep `capLevelToPlayerSize` on, so phones never pull 1080p.
- Sources could move to S3 Glacier Instant Retrieval after processing, saving ~$40/month on 2 TB. Small, but it adds up as the library grows.
- Worker scratch volumes (~60 GB of gp3, ~$5 each) and S3 request costs for uploads (600 PUTs per video) are negligible.

**Self-hosted ffmpeg vs MediaConvert:**
- **Self-hosted** (what this repo does) is ~20x cheaper per video, and it's the right call at a steady volume like this one, with a team that can run a queue and a few instances. Processing cost is a rounding error next to egress either way.
- **MediaConvert** makes sense when:
  - load is bursty and turnaround matters (it parallelizes a 10 h job internally, so it finishes in roughly an hour, with no instances sitting idle);
  - nobody wants to own ffmpeg upgrades, instance sizing or crash recovery;
  - you need features that are hard to build, such as DRM packaging, HDR tone-mapping, broadcast captions or QVBR;
  - volume is low enough that engineering hours outweigh the per-minute fee.
- A sensible path: stay self-hosted, keep the job payload and output layout engine-neutral, and fall back to MediaConvert for overflow or special formats.

## W4. Why does a video play in desktop Chrome but not on an iPhone or in Instagram?

| Common cause | How this design avoids it |
|---|---|
| **Codec or pixel format.** Chrome plays VP9/AV1 WebM and some 10-bit H.264. iPhones can't play WebM VP9 in older iOS, and many phones can't decode H.264 High 10 or 4:2:2 camera files. | Never serve the original. Always transcode to **H.264 High 8-bit `yuv420p` + AAC-LC**. |
| **Container or progressive MP4.** An MKV or WebM source, or an MP4 with its `moov` atom at the end, means no playback or a full download before the first frame. | **HLS with MPEG-TS** segments, the format Apple's players are built around. |
| **An MSE-only player.** hls.js and dash.js need Media Source Extensions. iPhone Safari had none before iOS 17.1, and many in-app webviews (WKWebView) still have none. | **Native HLS first** (`canPlayType('application/vnd.apple.mpegurl')`), and hls.js only where there's no native HLS. Neither available → a clear "unsupported" state with the stream URL. |
| **Inline playback and autoplay.** iOS forces fullscreen without `playsinline`. Older webviews (Instagram, Facebook) need `webkit-playsinline`. Autoplay with sound is blocked, so the video just sits there. | `playsinline` + `webkit-playsinline`, no autoplay, and `play()` called only from a tap. |
| **The Fullscreen API is missing.** iPhone and some webviews have no element fullscreen, so a "fullscreen" button does nothing or throws. | Falls back to `webkitEnterFullscreen()` on the `<video>` (iOS's own player, which handles rotation). Refusals are ignored. |
| **MIME types and CORS.** `.m3u8` served as `application/octet-stream` or `text/plain` is refused by some players. Missing CORS breaks hls.js (it fetches with XHR) but not Safari, which looks like "works on one browser". | Every object gets its `Content-Type` (`application/vnd.apple.mpegurl`, `video/mp2t`) and `Cache-Control` set at upload. The bucket has CORS. E2E tests check both. |
| **Mixed content or plain HTTP.** An HTTPS page loading HTTP media is blocked, and native apps (iOS ATS) refuse HTTP. | Media is always served from `PUBLIC_MEDIA_BASE_URL`, the HTTPS CloudFront domain in production. |
| **Rotation, odd dimensions, profile/level.** Phone video relies on rotation metadata that some players ignore. Odd widths break 4:2:0 encoders. 4K60 exceeds older phones' decoder level. | Rotation and pixel aspect are applied before encoding, dimensions are rounded to even numbers, the ladder tops out at 1080p, and portrait stays portrait. |
| **Bitrate too high for cellular.** A single 15 Mbit/s file stalls on 4G. | 3-rung ABR (e.g. 5 / 3 / 1.5 Mbit/s caps), capped to the player size. |
| **Cookies or auth.** Webviews have their own cookie jar and block third-party cookies, so cookie-gated media fails only in Instagram. | Playback needs no cookie: public URLs for now. For private videos, signed URLs rather than cookies (W5). |

**Honest status:** this is designed for, but so far only verified in desktop Chrome (both engines) and partly in macOS Safari. iPhone, Android, Samsung Internet and in-app webviews are still open items in [TESTING.md](TESTING.md).

## W5. Private or paid videos without breaking CDN caching or native playback

The goal is that every viewer fetches **the same cached bytes**, and authorization happens at the CDN edge instead of at the origin.

1. **Keep outputs private.** Move private videos' output out of the anonymous `public/` prefix. The bucket is only readable by CloudFront (Origin Access Control).
2. **Check entitlement in the playback API.** `GET /videos/:id/playback` checks the viewer's session (a cookie on the web, a bearer token in the apps) and their purchase or subscription. If allowed, it returns a `manifestUrl` that carries a CloudFront **signed-URL custom policy** scoped to a wildcard: `https://cdn/…/videos/{id}/hls/{run}/*`, expiring in roughly duration + 2 h, so a 10 h set doesn't expire mid-watch.
3. **Sign once per viewer, not per segment.** Relative segment URLs in HLS don't inherit the playlist's query string, so the playlists themselves must carry the signature. The API (or a CloudFront Function or Lambda@Edge) serves the master and variant playlists with the same `Policy`, `Signature` and `Key-Pair-Id` query appended to every line. Playlists are small and `private, no-store`; segments are the 99% of bytes.
4. **Keep the cache shared.** The CloudFront cache policy **excludes the query string from the cache key** for `.ts` files. CloudFront validates the signature, then serves the one shared cached copy. Segments stay `immutable`, and caching efficiency is unchanged.

**Why signed URLs and not signed cookies:**
- They work in AVPlayer and ExoPlayer with no extra setup: it's just a URL.
- They work in Instagram and TikTok webviews (separate cookie jars, third-party cookies blocked), and on AirPlay and Chromecast, where the receiving device fetches the stream itself and never had the cookie.
- Signed cookies are simpler on the web, but only when the CDN is a first-party subdomain (`media.undergroundnights.com`). Apps then have to inject cookies too (`AVURLAssetHTTPCookiesKey`, ExoPlayer request headers).

**Trade-offs:**
- A signed URL can be shared until it expires. Keep expiry tied to the video's duration and rate-limit how often one account can get new URLs. Avoid IP binding, which breaks when a phone switches from Wi-Fi to cellular.
- If the business needs protection against downloading, not just link-sharing, that means DRM (FairPlay plus Widevine over CMAF `cbcs`). That changes packaging and needs a license server, so it's a separate project.

## W6. Porting to Next.js 14 (App Router) + Prisma + MySQL + S3/CloudFront

**Stays the same** (most of it, by design):
- **The worker**, unchanged: BullMQ, Redis, ffmpeg, the state machine, the reconciler. It can't live inside Next.js anyway, since hours-long ffmpeg jobs need a long-running process (ECS or EC2), not serverless functions.
- **`packages/contracts`**: zod schemas, DTOs, job payload, status transitions, part sizing, storage key layout. Shared between Next.js and the worker exactly as now.
- **The upload protocol and engine:** presigned S3 multipart, ListParts resume, server-side completion check. `UploadEngine.ts` is framework-free TypeScript; it moves into a `'use client'` component as is.
- **The player modules** (`playbackMode`, `playbackSource`, `playbackErrors`, `watchProgress`) and the HLS output layout. S3/CloudFront config: set `PUBLIC_MEDIA_BASE_URL` to the CloudFront domain and unset the MinIO endpoint.

**Changes:**
- **NestJS controllers → Route Handlers** (`app/api/admin/uploads/[id]/parts/route.ts`, …). The services are mostly plain classes, so they become modules the handlers call.
  - Admin mutations like retry and delete could be Server Actions.
  - Pin the Node runtime (`export const runtime = 'nodejs'`), because the AWS SDK and Prisma need it.
  - **Next 14 caches `GET` Route Handlers by default.** The playback route needs `dynamic = 'force-dynamic'` (or `revalidate: 60`, to match our `s-maxage`), or viewers would get a stale "processing" response.
- **Auth:** reuse production's existing session instead of our seeded admin. The jose JWT check can run in `middleware.ts` (jose works on the Edge runtime), but each handler checks again, because middleware matchers are easy to get wrong.
- **SSE:** a Route Handler returning a `ReadableStream` works on a long-running Node server. On Vercel-style serverless, functions have a maximum duration, so either reconnect (the client already refetches on every reconnect) or rely on the existing 10 s polling fallback.
- **Prisma on MySQL:** change the provider and regenerate migrations. `@db.Uuid` → `@db.Char(36)`; enums, `BigInt` and `Json` all work on MySQL 8. The conditional `updateMany` calls behind the ownership rule work the same. Check the case-sensitivity of string comparisons (MySQL's default collation is case-insensitive), e.g. for admin email lookup.
- **Public pages become Server Components.** The watch page loads playback data on the server (no loading flash), and `generateMetadata` adds Open Graph tags. That fixes a current gap: links shared in Instagram or Facebook show no preview card. The player stays a client component, with hls.js still dynamically imported.
- **React 19 → 18:** no React 19-only APIs are used (no `use()`, actions hooks or ref-as-prop), so this should be a dependency change. Tailwind, Framer Motion, react-hook-form and hls.js all support React 18.

## W7. What was left out or simplified, and next week's plan

**Deliberately left out or simplified:**
- **Every stretch goal:** signed URLs, captions, sprite scrubbing, chapters, a cost dashboard, chunked transcoding.
- **Mid-encode resume:** a crash restarts the encode from 0 (W2), and each retry downloads the source again.
- **Scratch disk:** a 10 h 1080p video needs ~60 GB of free scratch. On Docker Desktop the disk check sees the VM's sparse disk, not the Mac's real free space.
- **Long uploads and sessions:** the 8 h session can expire during a 10 GB upload on an uplink slower than ~2.8 Mbit/s. The upload stops and resumes after login (no data lost), but a long upload should get an upload-scoped token or a sliding session.
- **One admin:** no roles, no login rate limiting, no audit log. Videos are public as soon as they're READY; there's no draft or unlisted flag.
- **Media edge cases:** HDR is converted to 8-bit without tone-mapping (colours look washed out), and high frame rates aren't capped.
- **Player:** a manual quality switch on native players reloads the stream. Volume isn't remembered. There are no Open Graph tags. The library isn't paginated (capped at 200).
- **No infrastructure as code:** the AWS bucket policy, CORS, lifecycle rule and CloudFront policies are documented in ARCHITECTURE.md but not provisioned. There's also no metrics or alerting.

**Not verified** (see [TESTING.md](TESTING.md)):
- A full 10 GB upload.
- The 10 h video reaching READY, then the 07:42:10 seek on it.
- iPhone, Android, Samsung Internet, in-app webviews, Firefox, Edge, VLC.
- Screen readers.

**Next week, in order:**
1. **Close the verification gaps first:** real devices over a LAN or tunnel, including an Instagram link; a 10 GB upload over a throttled connection with a Wi-Fi drop and an overnight pause; the 10 h encode to READY with the seek and resume; Firefox and Edge; VLC plus a tiny Expo `expo-video` snippet for the native-app claim; VoiceOver.
2. **Chunked parallel transcode** with BullMQ flows (W2). It cuts both the work lost to a crash and the ~7 h wall time, and makes spot instances viable.
3. **Production infrastructure as Terraform or CDK:** private bucket + OAC, CORS, lifecycle rule, CloudFront cache policies (playlists vs segments, gzip), worker autoscaling on queue depth.
4. **Signed playback** for private videos (W5), plus an upload-scoped token so long uploads survive session expiry.
5. **Observability:** queue depth, encode speed relative to realtime, failure reasons, job age, an alert on any job past its expected duration, structured logs with the video id.
6. **Viewer features:** sprite thumbnails for scrubbing (one more ffmpeg output), WebVTT captions (switch to the full hls.js build), Open Graph tags via server rendering, and HDR tone-mapping.
