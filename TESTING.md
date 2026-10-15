# Test matrix

What was verified, how, and what wasn't. As of Oct 14, 2026.

**Status: verification is still in progress.**
- **Done:** upload resume and cancel, worker crash and stop recovery, desktop Chrome playback.
- **Partly done:** a real 10 h video (encode stopped at 30%), macOS Safari.
- **Not done yet:** a 10 GB upload, mobile devices, in-app webviews, Firefox, Edge, VLC, screen readers.

**Legend**
- ✅ **Verified:** run against the full Docker Compose stack, by hand or by an automated test.
- 🟡 **Partly verified:** run, but not to the end.
- 📐 **Extrapolated:** not run end to end. Worked out from measured runs, with the arithmetic shown in [10 GB / 10 h](#10-gb--10-h).
- ⏳ **Not verified yet**.

## How things were tested

| Layer | Where | What it covers |
|---|---|---|
| Unit (Jest) | `packages/contracts`, `apps/backend`, `apps/worker` | Part sizing, upload orchestration, state machine, worker pipeline with fake ffmpeg/S3/DB (48 worker tests), reconciler decisions, playback API (12 tests) |
| Unit (Vitest) | `apps/frontend` | Upload engine (network injected), engine detection, playback error decisions, resume watching, timecode parsing |
| E2E (Jest, stack up) | `apps/backend/test/` | Real multipart upload, a real transcode of a 14 s clip to READY with 3 renditions, content types, cache headers, CORS, delete, playback API |
| Manual | Running stack | The upload, crash and playback checks below |

Test media:
- `iphone-14min-portrait.mov`: 1080×1920, 14.0 min, 1.6 GB, H.264.
- `set-5min.mp4`: 5 min, 153 MB.
- A 1 GiB file for upload tests.
- `videoplayback.mp4`: 640×360, 5 h, 1.3 GB.
- A real 10 h recording: 10:03:46, 1280×720 H.264 Main, 25 fps, AAC, 1.97 GB.

## Upload (Part A)

| Check | Result | How |
|---|---|---|
| 1 GiB upload, 64 × 16 MiB parts | ✅ | Desktop Chrome |
| Pause, page reload, re-select file, resume from 31.3% | ✅ | Desktop Chrome; SHA-256 of the stored object matched the source |
| Different file with the same name/size refused on resume | ✅ | Desktop Chrome |
| Cancel leaves no object and no unfinished multipart upload | ✅ | `mc ls -r --incomplete` |
| Renamed `.exe` rejected on the client | ✅ | Desktop Chrome |
| Random bytes named `.mp4` rejected by ffprobe, FAILED with no retries | ✅ | E2E |
| Server-side completion check (missing/truncated parts → 409) | ✅ | Unit + E2E |
| Network drop mid-upload (retry, "reconnecting", stall detection) | ✅ unit / ⏳ browser | Engine unit tests cover retries; the 45 s stall timer in `xhrPutPart.ts` has no unit test. Not yet pulled in a real browser |
| Part URL expiry and re-sign | ✅ unit / ⏳ browser | Engine unit tests |
| Session (8 h JWT) expiring mid-upload | ⏳ | Not tested; see open items |
| 1.97 GB (10 h video) upload | ✅ | Desktop Chrome, localhost: done in under 15 s |
| 10 GB upload | 📐 | See below |

## Processing (Part A)

| Check | Result | How |
|---|---|---|
| 14 s clip → READY, 3 renditions | ✅ | E2E |
| 1.6 GB iPhone portrait → 1080×1920 / 720×1280 / 480×854 | ✅ | Manual |
| Worker SIGKILL at 25% → re-picked, scratch wiped, READY, one output prefix | ✅ | `docker compose kill worker` |
| Worker SIGTERM at 10% → re-queued at once, no attempt used, no partial output | ✅ | `docker compose stop worker` |
| Delete during encode → worker stops in ~3 s, nothing left in storage | ✅ | Manual |
| Reconciler re-enqueues a lost job | ✅ | Job removed from Redis by hand |
| Live status and progress in the admin UI without reload | ✅ | Desktop Chrome (SSE) |
| Real 10 h video accepted: probed, 720/480/360 ladder planned, encode started | ✅ | Admin UI upload |
| Real 10 h video encoded to READY | 🟡 | Stopped twice by the author (at 20% and 30%) to save time; see below |
| Clean stop on a 10 h job (×2): re-queued, 0 attempts used, no partial output, source kept | ✅ | `docker compose stop worker` |
| Restart after the stop: same upload re-picked at once | ✅ | `docker compose start worker` |
| Encode time, memory and output size | ✅ 14 min / 🟡 10 h | See below |
| Real OOM kill, Redis restart mid-job, `--scale worker=2` | ⏳ | |

## Playback (Part B)

| Platform | Engine | Result | How |
|---|---|---|---|
| Chrome (macOS) | native and hls.js (`?player=`) | ✅ | Real Chrome (extension) and headless Chrome over DevTools |
| Safari (macOS) | native | ✅ partial | By hand by the author: resume, layout. Found the clipped Full screen bug (fixed) |
| Phone-sized viewports | | ✅ layout only | Emulated in Chrome (390×844, 320×568, 844×390, 667×375) |
| Firefox, Edge | hls.js / native | ⏳ | |
| iOS Safari, Android Chrome, Samsung Internet | native | ⏳ | |
| Instagram / Facebook / TikTok webviews | native | ⏳ | |
| VLC (stands in for AVPlayer/ExoPlayer) | | ⏳ | |
| VoiceOver / NVDA | | ⏳ | |

Verified on desktop Chrome:
- ABR climbed from 360p to 720p.
- Manual quality switch in both engines.
- Keyboard shortcuts.
- Resume after reload.
- Seeking fetches only the target segment.
- Drag-seek fires one seek on release.
- Fullscreen keeps our controls.
- Offline: playback continues from the buffer, then recovers on reconnect.
- Blocked segments show an error, and "Try again" resumes playback.
- All graceful states: not found, malformed id, uploading, processing, failed, deleted while viewing, unsupported.

## 10 GB / 10 h

**Neither was run end to end.** No 10 GB upload was done. A real 10 h video was uploaded and its encode ran to 30% (about the first 3 h of the video), but it was stopped before READY. The figures below are marked as measured or extrapolated. Only two things grow with file size or length: the number of parts and segments, and wall time. Every other step works per part or per segment, and has been verified at the smaller sizes.

### Upload: 10 GB

| | Measured (1 GiB) | Extrapolated (10 GB) |
|---|---|---|
| Parts (16 MiB) | 64 | 597 (part size grows only past ~156 GB) |
| Sign requests (100 URLs each) | 1 | 6 |
| ListParts pages (1,000 parts each) | 1 | 1 |
| Data lost on a drop | ≤ 64 MiB (4 parts in flight) | ≤ 64 MiB |
| API memory | Bytes go browser → storage; the API only sees JSON | Same |
| Wall time | Minutes (localhost) | 67 min at 20 Mbit/s · 2.2 h at 10 · 4.4 h at 5 |

What only a long upload hits:
- Part URLs (1 h TTL) are re-signed 5 min before they expire, so any upload over ~55 min re-signs. This is unit-tested.
- The 8 h session expires mid-upload on uplinks slower than ~2.8 Mbit/s. This is untested (see open items).

### Processing: 10 h

Measured on the iPhone `.mov` (1080p portrait ladder, 4 CPUs, `veryfast`):
- 14.0 min of video encoded in 9.5 min, about 1.5× realtime.
- Worker RSS about 650 MiB.
- 920 MiB of output (9.1 Mbit/s across the three renditions) in 428 objects.
- No lock-renewal errors, and the longest gap between progress updates was 12 s.

| | Extrapolated for 10 h (1080p ladder) | Derivation |
|---|---|---|
| Encode time | ~6.8 h | 36,000 s ÷ 1.47 (840 s in 570 s) |
| Output | ~41 GB | 9.1 Mbit/s × 36,000 s |
| Objects | 18,005 | 6,000 segments × 3 + 4 playlists + poster |
| Worker memory | Grows slowly | Measured on the real 10 h run (below): ffmpeg grows ~4 MiB per progress point. It isn't flat. |
| Lock renewals | ~400 | One per 60 s over 6.8 h; same mechanism as the measured run |
| Free scratch the pre-flight check requires | ~60 GB | 10 GB source + rendition caps × 10 h × 1.1 + 1 GiB |

**Measured on the real 10 h video** (720p source, so a 720/480/360 ladder; 4 CPUs, `veryfast`). Progress runs 5–90% for the encode and 90–99% for the upload to storage.

| | Run 1 | Run 2 |
|---|---|---|
| Reached | 20% | 30% (~3 h of the video encoded) |
| Encode pace | 5 → 20% in 13.7 min | 5 → 30% in 22.1 min |
| Full encode, projected | ~78 min | ~75 min (~8× realtime) |
| ffmpeg RSS | n/a | 381 → 402 → 414 → 448 → 463 → 474 MiB at 5/10/15/20/25/30% |
| Node RSS | n/a | ~135 MiB, flat |
| Container memory (cgroup, includes file cache) | 800 → 857 MiB (10–20%) | 676 → 798 MiB (5–30%) |
| CPU | ~390–400% (the 4-CPU limit) | same |
| Lock, stall or error lines in the worker log | none | none |

What this shows:
- **Encode time:** this run was about 5× faster than the iPhone clip's 1.5× realtime. The 720p ladder, 25 fps and slow-moving footage explain it. Encode time depends heavily on content, so the 1080p row above (~6.8 h, from handheld phone footage) is still the conservative figure.
- **Memory:** ffmpeg grows by about 4 MiB per point, so ~730 MiB is projected at the end of the encode, well under the 4 GiB limit. The likely cause is the HLS muxer keeping each playlist's segment list in memory, though that hasn't been confirmed. The 14-min clip was too short to show the growth.
- **Not measured, because the run never reached 90%:** output size, the time to upload ~18,000 objects, and anything after READY.

### Playback: 10 h

| | Measured (14 min) | Extrapolated (10 h) |
|---|---|---|
| Segments fetched by a seek | Only the target: 4:00 → `seg_00040`, `seg_00041` | Only the target: 07:42:10 → `seg_04621` (27,730 s ÷ 6 s) |
| Variant playlist | ~140 entries | 6,000 entries, ~180 KB, fetched once at start (~0.5 s at 3 Mbit/s) |
| Player memory | hls.js buffer capped at 30 s behind, ≤ 60 s ahead | Same; doesn't grow with length |
| Control bar | Checked with an injected 10 h timestamp at 8 viewport sizes | Same |

## Open items and known gaps

- **The 10 h video has never reached READY,** so the 07:42:10 seek and resume on a 10 h video are still extrapolated. Finishing needs about 80 min of uninterrupted worker time: `docker compose start worker`, with the Mac kept awake.

- **Session expiry during a long upload:** what the engine does when sign/status returns 401 hasn't been tested.
- **Disk on Docker Desktop:** inside a container, `statfs` reports the VM's sparse 1 TB disk, not the host's free space. The worker's disk check can therefore pass on a Mac that then fills up. On a Linux host it sees the real volume. A 10 h 1080p video needs ~100 GB at peak: source in MinIO, scratch copy, output on scratch, output in MinIO.
- **A crash re-encodes from 0:** a crash at hour 9 of 10 loses about 9 h of work (W2 in the written answers).
- **Not run:** the platforms marked ⏳ above, real touch behaviour (tap, drag-seek, orientation lock), and the screen readers.
