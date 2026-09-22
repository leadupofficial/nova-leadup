# NOVA — End-to-End Static Gap Analysis

**Method:** static source reading only. No app was run, no device was connected, no build tool
(`flutter`, `gradle`, `pnpm`, `adb`) was invoked. Every claim below is backed by an exact
`path:line`. Where a comment or markdown document disagrees with the code, the code is reported
and the lying comment is named.

**Labels used throughout**

- **(a) Confirmed defect** — the code provably does not do what it says/needs to do.
- **(b) Platform limitation** — the OS genuinely forbids it; no code change fixes it.
- **(c) Suspected** — strongly indicated but not provable from source alone.

**Scope note on stale docs.** This repository has a documented history of prose that does not
match the tree (`CLAUDE.md` records `CURRENT_ARCHITECTURE.md` calling a Flutter app "Expo").
That pattern is alive and well in the wake-word area — eight separate files still describe an
`openWakeWord` + `hey_jarvis` design that no longer exists (findings `W-08`, `W-09`).

---

## 1. Custom wake word while the app is open

The shipped phrase is **`hey_nova`**, not `hey_jarvis`. The registry is
`apps/mobile/android/app/src/main/assets/wakeword/models.json:5-6`, and it points at a sherpa-onnx
**keywords file** (`wakeword/kws/keywords.txt`), not an ONNX classifier. The engine that consumes
it is `SherpaWakeWordEngine.kt`, which builds a `KeywordSpotter` from
`encoder.int8.onnx` / `decoder.int8.onnx` / `joiner.int8.onnx` / `tokens.txt` / `bpe.model`
(`apps/mobile/android/app/src/main/java/com/leadup/nova/SherpaWakeWordEngine.kt:140-161`).

So the headline capability **does** exist. The defects are in the wiring around it.

### W-01 — LIVE (streaming) defect: the `availability` probe gates on files the engine never opens

**(a) Confirmed defect — HIGH**

`WakeWordService.availability()` refuses to report the feature as available unless
`melspectrogram.onnx` **and** `embedding_model.onnx` exist:

```
apps/mobile/android/app/src/main/java/com/leadup/nova/WakeWordService.kt:167-177
    fun availability(context: Context): Map<String, Any> {
        val assets = context.assets
        if (!assetExists(assets, MEL_MODEL_ASSET) ||
            !assetExists(assets, EMBEDDING_MODEL_ASSET)
        ) {
            return mapOf("available" to false, "reason" to "missing_shared_models", ...)
```

Those two constants are declared as *openWakeWord's* front-end models
(`WakeWordService.kt:64-70`). The sherpa KWS engine does not reference either name anywhere:
`grep` over `SherpaWakeWordEngine.kt` finds only `MODEL_DIR = "wakeword/kws"`
(`SherpaWakeWordEngine.kt:323`) and the five KWS files. `melspectrogram.onnx` and
`embedding_model.onnx` are dead assets kept alive only by this check.

Consequence, in two directions:

1. Any asset-cleanup pass that deletes the two unused openWakeWord models (a very natural
   follow-up, since `hey_jarvis_v0.1.onnx` is also dead) silently turns the wake word off for
   every user — `availability` → `missing_shared_models`, and
   `WakeWordController._initialize()` then **persists the toggle off**
   (`apps/mobile/lib/core/voice/wake_word_controller.dart:132-139`). The user's preference is
   destroyed by a build-time asset change.
2. The probe reports the feature as working for reasons that have nothing to do with the feature
   working. It never checks the five files the engine actually opens.

### W-02 — The detection channel is fire-and-forget; a detection with no Dart listener is dropped, not queued

**(a) Confirmed defect — HIGH**

`WakeWordService.emit()` returns immediately when no `EventChannel` sink is attached:

```
apps/mobile/android/app/src/main/java/com/leadup/nova/WakeWordService.kt:349-356
        private fun emit(payload: Map<String, Any>) {
            if (eventSink == null) return
```

`eventSink` is set only from `EventChannel.StreamHandler.onListen`
(`WakeWordService.kt:152-157`) and cleared on `onCancel` (`WakeWordService.kt:159-161`). The
provider that subscribes is `WakeWordController.build()`
(`apps/mobile/lib/core/voice/wake_word_controller.dart:102-108`), and it is **not** `autoDispose`;
a plain `NotifierProvider` (`wake_word_controller.dart:367-369`). Once a Riverpod provider has no
listeners, a non-autoDispose provider is not re-created but *is* removed from the container's
active set; whether `_subscription` stays attached is therefore incidental rather than guaranteed
by anything in this code. There is no queue, no `SharedFlow` replay
(`extraBufferCapacity = 8` but no `replay`, `SherpaWakeWordEngine.kt:111`), and no fallback
notification posted on detection.

Two provable consequences:

- `WakeWordService.kt:44-48` says *"When no model is installed the service reports
  `no_wake_word_model` and stops"* — but on the **detection** path there is no equivalent
  honesty. A detection with no sink is a silent no-op.
- `WakeWordService.onWakeWordDetected` (`WakeWordService.kt:477-487`) posts **no
  notification**. The comment in `apps/mobile/lib/core/voice/wake_word_session.dart:11-13`
  asserts the opposite:

  ```
  apps/mobile/lib/core/voice/wake_word_session.dart:11-13
  /// * [appInForeground] — ... in that case
  ///   the native service has already posted a notification, which is the honest signal.
  ```

  Nothing in `WakeWordService.kt` or `SherpaWakeWordEngine.kt` posts a notification on
  detection. The only `NotificationCompat.Builder` in the file builds the **ongoing foreground
  notification** (`WakeWordService.kt:526-534`, `.setOngoing(true)`). **The comment at
  `wake_word_session.dart:11-13` is false.**

### W-03 — A background detection is discarded by design, with no user-visible signal

**(a) Confirmed defect — HIGH**

```
apps/mobile/lib/core/voice/wake_word_session.dart:27-29
  if (!appInForeground) return false;
  if (turnActive) return false;
```

Combined with W-02 (no native notification on detection), saying "Hey Nova" while the app is
open-but-backgrounded produces: an engine log line (`WakeWordService.kt:478`), a `detected`
event that reaches Dart, and a return at `wake_word_session.dart:27` with no UI, no
notification, no sound. The user gets nothing. The brief's premise — "custom wake word while
the app is open" — is satisfied only in the literal foreground.

### W-04 — `shutdown()` cancels the service scope permanently, but the service instance survives to receive more `start` intents

**(a) Confirmed defect — HIGH**

First, the part that is **correct** and was checked rather than assumed: the sticky-restart branch
is reachable. `beginListening()` returns `START_STICKY` (`WakeWordService.kt:397`), the OS
recreates the service with a null `Intent` after a low-memory kill, and `when (intent?.action)`
(`WakeWordService.kt:368`) matches `null` at the second branch:

```
apps/mobile/android/app/src/main/java/com/leadup/nova/WakeWordService.kt:374-375
            // A null action means the system recreated us after a kill (START_STICKY).
            ACTION_START, null -> {
```

`ACTION_STOP` (`:369`) is a non-null string, so `null` correctly falls through to `:375` rather
than to `else` (`:400`). **W-04 is not a dead-branch bug.** The real defect is in the ordering of
the service-scope lifetime:

```
WakeWordService.kt:498
        serviceScope.cancel()
```
```
WakeWordService.kt:359
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
```

`serviceScope` is an **instance** field created once, and `shutdown()` cancels it permanently —
there is no re-creation anywhere (`grep` for `serviceScope` returns only `:359`, `:454`, `:458`,
`:498`). `shutdown()` is reached from `ACTION_STOP` (`:369-372`) and from `onDestroy` (`:409-412`).
Crucially, **`ACTION_STOP` calls `shutdown()` and returns without calling `stopSelf()`**
(`:369-372`), and `WakeWordService.stop(context)` uses `stopService()` (`:264-270`) — which does
destroy the instance — **but the engine-failure path also calls it without ending the service**:

```
WakeWordService.kt:464-474
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to start wake word engine", t)
            emit(mapOf("type" to "error", "code" to "engine_start_failed", ...))
            shutdown()
        }
```

So after any `engine_start_failed` (or after an `ACTION_STOP` intent delivered by any route other
than Dart's `stop()`), the service is **still alive**, still declared
`android:stopWithTask="false"` (`AndroidManifest.xml:247`), and still accepting `ACTION_START`
intents over the same `MethodChannel` handler (`WakeWordService.kt:105-113`, which calls `start()`
unconditionally). A subsequent `start` reaches `beginListening()`, which constructs
`SherpaWakeWordEngine(applicationContext, models, DETECTION_COOLDOWN_MS, serviceScope)` at
`WakeWordService.kt:450-455` on the **cancelled** scope. `SherpaWakeWordEngine.start()` runs
synchronously up to and including opening the microphone and setting `running = true`
(`SherpaWakeWordEngine.kt:165-204`) — `KeywordSpotter` construction, `AudioRecord` acquisition,
`record.startRecording()` — and only then calls `scope.launch(Dispatchers.Default)`
(`SherpaWakeWordEngine.kt:206`), which on a cancelled scope returns an already-cancelled job. **The
read loop never runs.** Net state: `AudioRecord` open and holding the microphone,
`isRunningFlag = true` (`WakeWordService.kt:461`), `emit({"type":"listening"})`
(`WakeWordService.kt:463`), the notification saying "Listening for …" (`:442`), and **no detection
is ever possible**. The UI reports "Listening now" (`wake_word_controller.dart:329-330`,
`wake_word_settings_page.dart:221-222`) and the user has no way to tell.

`WakeWordController.setModel()` drives exactly this transition — it always goes
`await stop(); await start();` when the service is listening
(`apps/mobile/lib/core/voice/wake_word_controller.dart:212-215`). That particular sequence uses
`stopService()`, so it gets a fresh instance; the exploitability rests on the non-`stopSelf`
`shutdown()` paths above, which is why this is HIGH rather than CRITICAL.

### W-05 — `POST_NOTIFICATIONS` is a hard gate on a microphone feature

**(a) Confirmed defect / (b) partial platform limitation — MEDIUM**

```
WakeWordService.kt:244-254
            if (!hasNotificationPermission(context)) {
                Log.w(TAG, "start() skipped - POST_NOTIFICATIONS not granted")
                emit(mapOf("type" to "error", "code" to "permission_denied", ...))
                return
            }
```

The rationale (the notification is mandatory for a foreground service) is correct for the
*notification*, but the gate is applied to the whole feature. A user who denies the
notification permission on Android 13+ (a single tap on a prompt that has no visible connection
to wake words) loses wake-word detection entirely. On Android 13+, `POST_NOTIFICATIONS` is not
granted by default, so a meaningful share of installs hit this. The manifest declares it
(`apps/mobile/android/app/src/main/AndroidManifest.xml:6`).

### W-06 — The `availability` gate is checked before the permission gate in a different order than the UI reports

**(a) Confirmed defect — MEDIUM**

`availability()` never reports `permission_denied` as a reason. It only ever returns
`ok`, `missing_shared_models` or `no_wake_word_model` (`WakeWordService.kt:167-201`). But
`WakeWordAvailability.userMessage` has a case for it
(`apps/mobile/lib/core/voice/wake_word_service.dart:79-80`) and
`wake_word_controller.dart:346-349` special-cases `permission_denied` for a friendly message.
Because `availability()` never produces that reason, the friendly path is only reachable through
the *event* channel, not through the availability probe — so a user whose flag is on and who
opens the settings screen sees "Wake word is available" (`wake_word_controller.dart:130`,
`setEnabled` passes, `wake_word_controller.dart:229`) and *then* gets the error. The
probe/PRESENT/start sequence disagrees with itself.

### W-07 — The account-side record is write-only

**(a) Confirmed defect — LOW**

`PATCH /api/v1/device/wake-word/config` stores the phrase
(`services/api/src/routes/device.ts:147-158`) and `GET` reads it back
(`device.ts:114-130`), but no device-side code ever reads it. `wakeWordConfigProvider`
(`apps/mobile/lib/core/api/providers.dart:161`) is consumed only by the settings card that
displays it (`apps/mobile/lib/features/settings/wake_word_settings_page.dart:450`), and the only
writer is `updateWakeWordConfig` at `wake_word_settings_page.dart:179`. `WakeWordController`
reads its phrase exclusively from the native probe. So "your choice follows your account across
re-installs" (implied by `device.ts:16-18`) is not true: on a reinstall the device falls back to
`WakeWordModelSelection.resolve(stored, models)` → first installed model
(`WakeWordService.kt:207-210`). The API's own comment at `device.ts:16-20` is honest that this is
"a preference record, not a control", but the consequence — it is never applied anywhere — is
not stated.

### W-08 — Eight files still document the dead `openWakeWord` / `hey_jarvis` design

**(a) Confirmed defect (stale documentation) — MEDIUM**

| File:line | Lying claim | Reality (code) |
|---|---|---|
| `apps/mobile/android/app/src/main/java/com/leadup/nova/WakeWordService.kt:35` | "Detection runs fully on-device using **openWakeWord** (Apache-2.0)" | `SherpaWakeWordEngine.kt` builds a sherpa-onnx `KeywordSpotter` (`SherpaWakeWordEngine.kt:140-161`). openWakeWord is not a dependency of this path at all. |
| `WakeWordService.kt:64-70` | "**openWakeWord's** two shared front-end models" | Nothing in the running engine opens them (W-01). |
| `apps/mobile/android/app/src/main/assets/wakeword/README.md:4` | "NOVA performs wake-word detection entirely on device using **openWakeWord**" | Same as above. |
| `README.md:14,37-40` | "`hey_jarvis_v0.1.onnx` … classifier"; "`hey_jarvis` is bundled so the feature works out of the box" | `models.json:5` registers **`hey_nova`** with `asset: wakeword/kws/keywords.txt`. |
| `apps/mobile/lib/features/settings/wake_word_settings_page.dart:244` | UI string: `'Classifier "$selected" · detected on device by **openWakeWord**'` | User-visible false attribution. |
| `wake_word_settings_page.dart:361` | "adding another **openWakeWord classifier** to the app bundle: an .onnx file" | Adding a wake word means editing `keywords.txt`, not adding an `.onnx`. |
| `apps/mobile/lib/core/voice/wake_word_controller.dart:48,56-58` | "Today's build ships one classifier (`hey_jarvis`)" / "openWakeWord ships no 'hey nova' classifier" | Ships `hey_nova`; sherpa KWS makes the phrase data (`SherpaWakeWordEngine.kt:54-62`). |
| `apps/mobile/lib/core/voice/wake_word_service.dart:25,34,87` | "e.g. `['hey_jarvis']`" | Same. |

### W-09 — Verified non-issue (recorded so it is not re-reported)

`SherpaWakeWordEngine.kt:187-193` opens `AudioRecord` with `MediaRecorder.AudioSource.MIC`, and the
comment at `:179-186` explains that `VOICE_RECOGNITION` was rejected to keep a store-policy
guarantee intact. That is **correct and deliberate** — the code and the comment agree.

---

## 2. Background listening after the app is fully closed

### B-01 — On Android 14+ the documented behaviour is impossible via `BOOT_COMPLETED` (platform), and the guard is correct

**(b) Platform limitation — no defect in the guard itself**

`BootReceiver` skips the start on API ≥ 34 and explains why:

```
apps/mobile/android/app/src/main/java/com/leadup/nova/BootReceiver.kt:43-51
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            Log.i(TAG, "Boot completed on API ${Build.VERSION.SDK_INT}: a microphone foreground service " +
                "cannot be started while the app is in the background. ...")
            return
        }
```

`UPSIDE_DOWN_CAKE` is API 34 (`BootReceiver.kt:43`), matching the comment's own warning at
`BootReceiver.kt:28-30` that gating at 35 (`VANILLA_ICE_CREAM`) left API 34 taking the exception.
This is correct — an Android 14 app in the background cannot start a
`FOREGROUND_SERVICE_TYPE_MICROPHONE` service. **No code change fixes this.** The opt-in read is
also correct: `SHARED_PREFS_NAME = "FlutterSharedPreferences"` and
`WAKE_WORD_ENABLED_KEY = "flutter.nova_wake_word_enabled"`
(`BootReceiver.kt:71-72`) match the Dart key `'nova_wake_word_enabled'`
(`wake_word_controller.dart:91`) plus the `flutter.` prefix.

### B-02 — The only working re-arm is "user opens the app", and the re-arm depends on a provider that must already be listening

**(a) Confirmed defect — HIGH**

The documented recovery for B-01 is re-arming on app resume
(`apps/mobile/lib/app/app.dart:127-134`, `wake_word_controller.dart:298-318`). `WakeWordController.arm()`
is called from `_onResume` (`app.dart:134`), `HomePage` (`home_page.dart:72`),
the wake-word settings page (`wake_word_settings_page.dart:52`) and the overlay
(`wakeword_page.dart:55`). All four require the widget/provider to be mounted.

The provider is created lazily on first `ref.read`/`ref.watch` of `wakeWordStateProvider`. The
first thing a user sees after a cold start is onboarding or the home screen; if the user lands
anywhere that does not read `wakeWordStateProvider`, no listener is attached, `arm()` never runs,
and the service stays dead until they navigate to Home/Settings. There is no `AppLifecycleListener`
registered from `main.dart` itself — the lifecycle hook is inside `app.dart`'s `NovaApp` widget
(`app.dart:132-147`), so it depends on `NovaApp` being built *and* on `wakeWordStateProvider`
being read at least once before `arm()` can do anything, because `arm()` short-circuits on
`if (!state.enabled)` using state the controller has only after `build()`
(`wake_word_controller.dart:303`).

### B-03 — OEM task-killers are a documented, unfixed hole

**(c) Suspected (well-evidenced) — MEDIUM**

`apps/mobile/android/app/src/main/AndroidManifest.xml:236-243` states plainly that on a OnePlus
9R, OxygenOS freezes the whole process when the screen goes off
(`OplusHansManager: freeze uid … scene: LcdOff`), which "stops detection regardless of this flag".
The remedy offered is a settings link for battery-optimisation exemption, explicitly **not**
`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`. So on the primary test device class, "background listening
with the app fully closed" is not delivered, and the codebase knows it. `stopWithTask="false"` is
set (`AndroidManifest.xml:247`), which handles the swipe-away case but not the freeze case.

`START_STICKY` (`WakeWordService.kt:397`) is the only recovery, and a *force-stop* (as opposed to
a low-memory kill) cancels sticky restarts entirely — no code path can recover from that, and
`BootReceiver` is skipped on 14+ (B-01). So the realistic matrix is:

| Scenario | Wake word survives? | Evidence |
|---|---|---|
| App foregrounded | Yes | `wake_word_session.dart:27` |
| App backgrounded, process alive | Engine runs; detection is discarded | W-03 |
| Swipe from Recents | Yes | `AndroidManifest.xml:247` |
| Screen off on OEM ROM | No | `AndroidManifest.xml:236-243` |
| Low-memory kill | `START_STICKY` re-creates the service | `WakeWordService.kt:397` |
| Force-stop | No, until the app is opened | `BootReceiver.kt:43-51`, B-02 |
| Device reboot, API ≤ 33 | Yes | `BootReceiver.kt:53-59` |
| Device reboot, API ≥ 34 | No, until the app is opened | `BootReceiver.kt:43-51` |

---

## 3. Meeting recording over long conversations

The recorder writes **one file**, has **no chunk rotation**, and holds the **entire meeting in
process memory** before it uploads. `apps/mobile/lib/features/recording/meeting_recorder.dart:29-30`
is explicit that there is deliberately no auto-stop cap. That decision, combined with the code
below, is the core of this section.

### R-01 — The whole meeting is loaded into a Dart `Uint8List`, then a second time into a Node `Buffer`

**(a) Confirmed defect — CRITICAL**

```
apps/mobile/lib/features/recording/meeting_recorder.dart:174-187
    final Uint8List bytes;
    try {
      bytes = await File(path).readAsBytes();
    } catch (error) { ... }
    _deleteQuietly(path);
    if (bytes.isEmpty) throw _emptyFailure();
    return MeetingAudioClip(bytes: bytes, mimeType: _mimeType);
```

The comment at `meeting_recorder.dart:33-34` says *"the caller needs the raw bytes for
`POST /recordings/:id/audio`, not base64 for the STT route"* — it presents the full-buffer read as
a design decision without acknowledging that it scales linearly with meeting length. A 32 MB
ceiling on the server (`services/api/src/services/audio-storage.ts:82`,
`MAX_AUDIO_BYTES = 32 * 1024 * 1024`) means the largest permitted meeting is a ~30 MB blob held
in Dart heap, uploaded as one `List<int>`, and then held again server-side:

```
apps/api/src/services/audio-storage.ts:278-284
            const chunks: Buffer[] = [];
            ...
                chunks.push(Buffer.from(chunk));
            return Buffer.concat(chunks);
```

and again inside the pipeline:

```
services/api/src/services/recording-pipeline.ts:330-336
        let audio: Buffer;
        try {
            audio = await getAudio(recording.storageKey);
        } catch (err) {
            return fail(recordingId, userId, 'audio-unreadable', err);
        }
        if (audio.length === 0) return fail(recordingId, userId, 'audio-empty');
```

and again handed whole to the provider:

```
services/api/src/services/ai.ts:1161-1181
export async function transcribeAudioForLanguage(
	audioBuffer: Buffer,
	language: string
): Promise<...> {
	const provider = getSttProviderForLanguage(language as any);
	try {
		if (provider === 'sarvam') { const r = await transcribeAudioSarvam(audioBuffer, language); ...
```

`transcribeAudioForLanguage` receives the **entire recording buffer**. There is no segmentation,
no chunked upload, and no per-chunk transcription anywhere in `recording-pipeline.ts`. A single
STT request carries the whole meeting.

### R-02 — A long recording exists only in process memory between `stop()` and a successful upload

**(a) Confirmed defect — CRITICAL**

`MeetingRecorder.stop()` deletes the temp file the instant it has read the bytes (R-01,
`meeting_recorder.dart:185`). The bytes then live in exactly one place:

```
apps/mobile/lib/features/recording/recording_controller.dart:191
    _pendingClip = clip;
```

`_pendingClip` is a private field on a `Notifier` (`recording_controller.dart:29`) with no
persistence and no `ref.keepAlive`, and `recordingControllerProvider` is a plain
`NotifierProvider`, not `autoDispose` (`recording_controller.dart:464-466`) — so it *does* survive
navigation, but it does not survive process death. The controller's own comment admits the
exposure:

```
recording_controller.dart:299-308
    // This used to send `status: 'completed'` here — before a single byte had been
    // uploaded. ... A kill during the upload — an OOM on a long
    // meeting, the user swiping the app away — therefore lost the recording ...
```

The status bookkeeping was fixed. The **loss itself was not**: if the process dies anywhere between
`recording_controller.dart:186` (`stop()`) and `recording_controller.dart:362` (upload success),
the audio is gone and there is no recovery path. The row is left at `recording` (it was created at
`recording_controller.dart:102-106`) and `_markUploadFailed` (`recording_controller.dart:397-403`)
never runs because the process is dead. On the next launch `retryUpload()` returns `null`
immediately because `_pendingClip` is `null` (`recording_controller.dart:204-207`), and
`prepareNewSession()` nulls it anyway (`recording_controller.dart:52`).

The window is not small: `_serverCeiling` is awaited *before* the upload
(`recording_controller.dart:326`), then the transfer itself
(`recording_controller.dart:344-350`) sends up to 32 MB over a mobile connection, all while the
only copy of the meeting sits in a Dart heap allocation.

### R-03 — No upload retry and no durable upload queue

**(a) Confirmed defect — HIGH**

There is exactly one automatic attempt. `_uploadAndProcess` catches `NovaApiException` and stops:

```
recording_controller.dart:351-362
        } on NovaApiException catch (e) {
            state = state.copyWith(
                phase: RecordingPhase.failed,
                error: _uploadFailureMessage(e, clip.byteLength),
            );
            await _markUploadFailed(api, id);
            return null;
        }
```

The only retry is `retryUpload()` (`recording_controller.dart:204-210`), which requires the user to
be looking at a screen that offers it, in the same process, while `_pendingClip` is still
non-null. No exponential backoff, no background uploader, no `WorkManager`, no resumable upload,
no `multipart` retry. A `retryUpload` after the app is backgrounded and reclaimed is a no-op.

This directly contradicts the user-facing promise built into `_uploadFailureMessage`:

```
recording_controller.dart:430-431
        return 'The audio was not uploaded$status: ${e.message}. '
            'The recording row is saved and the audio can be retried.';
```

The row is saved. The audio **cannot** be retried once the process dies — and the message does not
say so.

### R-04 — A recording in progress cannot survive the process; the temp file is orphaned

**(a) Confirmed defect — CRITICAL**

`MeetingRecorder.start()` writes into the **cache** directory:

```
apps/mobile/lib/features/recording/meeting_recorder.dart:97-103
    final directory = await _temporaryDirectory();
    final path =
        '${directory.path}/nova_meeting_'
        '${DateTime.now().millisecondsSinceEpoch}${format.extension}';

    try {
      await recorder.start(format.config, path: path);
```

`_temporaryDirectory` defaults to `getTemporaryDirectory` (`meeting_recorder.dart:50`), i.e.
`context.getCacheDir()` on Android. Nothing on startup scans that directory, and nothing in
`recording_controller.dart` or `recording_page.dart` reads a partial file. So:

- The OS may delete the cache under storage pressure — while the recording is still running.
- If the process dies mid-meeting, the `.wav`/`.m4a` is stranded in the cache and is **never
  recovered, never offered to the user, and never uploaded**. It is deleted by Android at leisure.

There is no `foregroundServiceType="dataSync"` service for the recorder, no `WakeLock`, and no
`AndroidManifest.xml` declaration for a recording service at all (the only service declarations are
`WakeWordService` at `AndroidManifest.xml:244-248` and `NovaNotificationListenerService` at
`:289-297`). A long meeting with the screen off is therefore subject to Doze
suspension of the Dart isolate, which with `stopWithTask="false"` on *only* the wake-word service
means the recorder has no protection whatsoever.

### R-05 — A killed pipeline leaves the row at `processing` forever, with the audio retained

**(a) Confirmed defect — CRITICAL**

The job runs in-process, with no queue and no reconciliation:

```
services/api/src/services/recording-pipeline.ts:504-509
export function enqueueRecordingProcessing(recordingId: string, userId: string): void {
	setImmediate(() => {
		void runRecordingPipeline(recordingId, userId).catch((err) => { ... });
	});
}
```

`recording-pipeline.ts:27-34` is candid that "a restart mid-job leaves the row at `processing` —
the truth — rather than silently completing it". What it does not say is that **nothing ever
retries it**. The retention sweep only selects by age:

```
services/api/src/jobs/retention.ts:94-99
			.from(audioRecordings)
			.innerJoin(privacyPreferences, ...)
			.where(and(
					isNull(audioRecordings.deletedAt),
					sql`${audioRecordings.createdAt} < now() - (${privacyPreferences.autoDeleteRecordingsDays} * interval '1 day')`,
```

There is no `status = 'processing'` predicate in `retention.ts`, and no "stuck job" reaper anywhere
in `src/jobs/` (the directory contains only `retention.ts`). Confirmed by inspection of
`recording-pipeline.ts:246-257`, which documents a *different* stuck-at-`processing` bug that was
fixed in the route's `WHERE` clause — but that fix only prevents a *downgrade*; it does not rescue
a row whose job never ran. So a deploy, an OOM, or a crash during transcription leaves the user
with a recording that will never produce a transcript and never be deleted.

### R-06 — The upload ceiling is enforced after the whole file has already been read and held

**(a) Confirmed defect — MEDIUM**

```
recording_controller.dart:326-336
    final ceiling = await _serverCeiling(api);
    if (ceiling > 0 && clip.byteLength > ceiling) {
      state = state.copyWith(phase: RecordingPhase.failed, error: 'This recording is ...');
      await _markUploadFailed(api, id);
      return null;
    }
```

The comment at `:321-325` claims this avoids "a 413 at the end of a long upload". It does avoid
that, but it is placed *after* `clip` has been fully materialised (R-01), so the user still pays
the full in-memory cost and the full `readAsBytes` time for a recording that will be thrown away.
There is no duration cap, no live size check during capture, and no warning while recording. The
user learns the meeting was too long only after it has ended.

### R-07 — `GET /recordings/:id` returns every transcript segment with no bound

**(a) Confirmed defect — MEDIUM**

```
services/api/src/routes/recordings.ts:236-240
		const segments = transcript
			? await db.select().from(transcriptSegments)
				.where(eq(transcriptSegments.transcriptId, transcript.id))
				.orderBy(asc(transcriptSegments.startMs))
			: [];
```

No `limit`, no pagination, no cursor. `segmentFromWords` caps a segment at 40 words
(`recording-pipeline.ts:76`, `:122`) and also splits on any pause over 2 s (`:74`, `:121`). A
90-minute meeting with ordinary turn-taking produces on the order of 10³–10⁴ segment rows, all
serialised into one JSON response every time the summary screen polls. The mobile summary screen
is the only consumer (`apps/mobile/lib/features/recording/summary_page.dart`), and the route has no
projection cap.

### R-08 — `express.raw` buffers the entire upload on the request path

**(a) Confirmed defect — MEDIUM**

```
services/api/src/routes/recordings-capture.ts:97-100
	express.raw({
		type: ['audio/*', 'application/octet-stream'],
		limit: MAX_AUDIO_BYTES,
	}),
```

`express.raw` accumulates the body into a single `Buffer` before any handler runs. With
`limit: 32 MB` (`audio-storage.ts:82`), N concurrent meeting uploads from one account = N × 32 MB
of resident heap on the API process, on top of the pipeline's own copy (R-01) and
`Buffer.concat`'s doubling (R-01). There is no streaming path, no `busboy`/multipart, and no
per-user concurrency cap. `getAudio` also buffers the whole object back (R-01), so the peak for one
recording is roughly 3 × its size.

### R-09 — The recording session has no server-side timeout

**(a) Confirmed defect — MEDIUM**

`MAX_AUDIO_BYTES` bounds upload *size* only. Nothing bounds duration: the `POST /` create route
accepts a client-reported `durationSeconds` with no maximum
(`services/api/src/routes/recordings.ts:148-164`), `CreateRecordingSchema` is referenced but no
duration ceiling is enforced in the route body, and the entitlement gate
(`recordings.ts:139`, `requireEntitlement(..., USAGE_METRICS.recordingSeconds)`) asks only whether
*any* allowance remains (`recordings.ts:130-134`). A user can therefore hold a row in `recording`
indefinitely, and there is no sweep that closes stale `recording` rows — `retention.ts:94-99`
selects purely by age.

### R-10 — Phase `processing` never resolves if the client dies after a successful upload

**(a) Confirmed defect — MEDIUM**

After a successful upload, the client calls `processRecording` as a **separate** request
(`recording_controller.dart:373-383`). If the app dies between the two, the row sits at `uploaded`
with the audio safely in object storage and **no `/process` call ever made**. Nothing server-side
picks up `uploaded` rows: the only `processing` transition is the route
(`recordings-capture.ts:258-273`) and the pipeline's own `setStatus`
(`recording-pipeline.ts:327`), both of which require an inbound request. The audio is retained
until the 30-day retention window and then deleted — silently, with no transcript ever produced.

---

## 4. Memory storage persistence

### M-01 — No embeddings are ever generated; `storeEmbedding` writes an empty vector or nothing

**(a) Confirmed defect — CRITICAL**

```
services/api/src/services/ai.ts:497-502
export async function generateEmbedding(text: string): Promise<{ embedding: number[]; dimensions: number }> {
	// Anthropic SDK doesn't expose an embeddings endpoint yet.
	// pgvector in @nova/database handles storage; embeddings generation deferred to OpenAI or local model.
	return { embedding: [], dimensions: 0 };
}
```

This is a **hard-coded stub**. `services/api/src/routes/ai.ts:118-123` documents that it is a
no-op and reports `available: false`, which is honest for that route. But the memory service does
not check:

```
services/api/src/services/memory.ts:141-153
async function storeEmbedding(memoryId: string, content: string) {
 try {
 const { embedding } = await generateEmbeddingVector(content);
 const db = getDb();
 await db.insert(memoryEmbeddings).values({
 memoryId,
 embedding,
 model: 'text-embedding-3-small',
 dimensions: embedding.length,
 });
 } catch {
  // Log but don't fail the memory creation
 }
}
```

Every write attempts `INSERT INTO memory_embeddings (memory_id, embedding, dimensions) VALUES ($1,
'[]', 0)`. `memory_embeddings.embedding` is `jsonb NOT NULL`
(`packages/database/src/schema.ts:315`) — `'[]'` is valid JSON, so the row **succeeds and persists
a zero-dimension vector labelled `text-embedding-3-small`**. The vector store is therefore full of
rows that mean nothing, and there is no way to distinguish them from real ones.

The comment at `memory.ts:152` — *"Log but don't fail"* — is **also** false: the `catch` block is
empty. Nothing is logged. Failures are invisible.

### M-02 — No HTTP path reaches `createMemory`, so the embedding hook is dead code

**(a) Confirmed defect — CRITICAL**

`POST /api/v1/memories` writes the row **itself**:

```
services/api/src/routes/memories.ts:114-128
		const [memory] = await db.insert(memories).values({
			userId,
			content: body.content,
			...
		}).returning();
```

The comment at `memories.ts:103-105` explains that the route duplicates the privacy check "rather
than going through `createMemory`" — and by duplicating the insert it also bypasses the
embedding call. `createMemory` (`services/api/src/services/memory.ts:39-77`) is imported by
**nothing** in `src/routes/`; the only non-test references to it are
`src/__tests__/privacy-gates.test.ts:102` (a comment). Confirmed by grep over `src/`.

The same bypass exists in the assistant path:

```
services/api/src/services/assistant-tool-executor.ts:272-296
				const [memory] = await db
					.insert(memories)
					.values({ userId, content: parsed.data.content, ... })
					.returning();
```

So **both** real write paths — the memory screen and the `save_memory` voice tool — create
memories with zero embeddings. The only function that would have generated one
(`createMemory` → `storeEmbedding`) is unreachable.

### M-03 — `memories.embedding_id` is declared but never written; the relation is permanently null

**(a) Confirmed defect — HIGH**

```
packages/database/src/schema.ts:302
	embeddingId: uuid('embedding_id'),
```
```
packages/database/src/schema.ts:848-857
export const memoriesRelations = relations(memories, ({ one }) => ({
  ...
  embedding: one(memoryEmbeddings, {
    fields: [memories.embeddingId],
    references: [memoryEmbeddings.id],
  }),
}));
```

`storeEmbedding` inserts into `memoryEmbeddings` and **never** updates
`memories.embedding_id` (`services/memory.ts:145-150`), and neither insert path
(`routes/memories.ts:114`, `assistant-tool-executor.ts:276`) sets it. The declared relation is
therefore null for every row in the database, and the back-reference is one-way in the wrong
direction (`memoryEmbeddings.memoryId` → `memories.id`). Any code that later tries to load a
memory's embedding through the Drizzle relation will get `null` for every memory ever created.

### M-04 — Not pgvector: the "vector" column is `jsonb`, with no vector index anywhere

**(a) Confirmed defect — HIGH**

```
packages/database/src/schema.ts:312-319
export const memoryEmbeddings = pgTable('memory_embeddings', {
 id: uuid('id').defaultRandom().primaryKey(),
 memoryId: uuid('memory_id').references(() => memories.id, { onDelete: 'cascade' }).notNull().unique(),
 embedding: jsonb('embedding').notNull(), // pgvector stored as JSON array
 model: varchar('model', { length: 100 }).notNull(),
 dimensions: integer('dimensions').notNull(),
 createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

The inline comment *"pgvector stored as JSON array"* is self-contradictory — a JSON array is not a
pgvector column and supports no vector operator. Confirmed against the applied schema: the only
generated SQL touching `memories` is

```
packages/database/drizzle/0000_regular_colossus.sql:587-588
CREATE INDEX "memories_user_idx" ON "memories" USING btree ("user_id");
CREATE INDEX "memories_status_idx" ON "memories" USING btree ("status");
```

and there is **no** `CREATE INDEX … USING hnsw|ivfflat` for `memory_embeddings` in any migration in
`packages/database/drizzle/` (0000–0003 plus `20260101000000_001`). Despite the repo shipping a
pgvector-enabled Postgres (`CLAUDE.md`, `packages/database/scripts/start-pgvector.sh`), the memory
system stores vectors as JSON text with no ANN index. Exact-nearest-neighbour over `jsonb` is not
possible; any future similarity query would require parsing every row in JS.

### M-05 — Search does not use vectors; it is an unbounded sequential `ILIKE` scan

**(a) Confirmed defect — MEDIUM**

```
services/api/src/services/memory.ts:128-132
  // Simple keyword search fallback (replace with pgvector similarity when available)
  const rows = await db.select().from(memories)
  .where(and(eq(memories.userId, userId), sql`${memories.content} ILIKE ${'%' + query + '%'}`))
  .orderBy(desc(memories.importance))
  .limit(limit);
```

and the route the mobile client actually calls:

```
services/api/src/routes/memories.ts:141-145
		const searchTerm = `%${q.query}%`;
		const whereClauses = [
			eq(memories.userId, userId),
			or(ilike(memories.content, searchTerm)),
		];
```

`or(...)` with a single argument is a no-op wrapper, but the real problem is the pattern:
`ILIKE '%term%'` cannot use a btree index. There is no `pg_trgm` GIN index on
`memories.content` in any migration (confirmed: `drizzle/*.sql` contains no `gin_trgm_ops` and no
index on `content`). Every search is a full scan of the caller's `memories` rows plus a `count(*)`
over the same predicate (`memories.ts:153-155`). At any real scale this is the single slowest
user-facing query in the product.

### M-06 — Silent truncation at 100,000 chars in one path and 4,000 in another

**(a) Confirmed defect — MEDIUM**

```
services/api/src/services/memory.ts:14
const MAX_CONTENT_LENGTH = 100_000;
```
```
services/api/src/services/memory.ts:40
  const trimmedContent = input.content.trim().slice(0, MAX_CONTENT_LENGTH);
```

versus the schema that the HTTP route enforces:

```
services/api/src/schemas/index.ts:139
	content: z.string().min(1).max(4000),
```

So `createMemory` truncates at 100 000 — a limit no caller can reach through HTTP, making the
`slice` dead in practice — while the route caps at 4 000 with a **hard 400 error**, not truncation.
The truncation that *does* matter is invisible to the user: `truncate(m.content, ...)` at
`services/api/src/services/user-context.ts:296` cuts what NOVA is told it remembers, and
`apps/mobile/lib/features/memory/memory_page.dart` displays the stored `content` via the API, so
the UI and the model can disagree about what is remembered. The 100 000 constant at
`memory.ts:14` is unreachable and misleading.

### M-07 — No user-scoping defect found (recorded explicitly, because the brief asked)

**Verified clean.** Every memories route scopes to the caller:

| Route | Scoping | Line |
|---|---|---|
| `GET /` | `eq(memories.userId, userId)` | `services/api/src/routes/memories.ts:42` |
| `POST /` | `userId` written from `req.user!.id` | `memories.ts:100`, `:115` |
| `GET /search` | `eq(memories.userId, userId)` | `memories.ts:143` |
| `GET /:id` | `eq(memories.userId, req.user!.id)` | `memories.ts:190` |
| `PATCH /:id` | scoped read **and** scoped-update guard | `memories.ts:212`, `:230` |
| `DELETE /:id` | scoped read then delete by id | `memories.ts:248`, `:254` |
| `createMemory` service | `input.userId` | `services/memory.ts:55` |
| `getMemory` / `updateMemory` / `deleteMemory` | `and(eq(id), eq(userId))` | `memory.ts:81`, `:113`, `:120` |

`DELETE /:id` deletes by id after a user-scoped existence check (`memories.ts:247-254`) — correct
(TOCTOU-safe in practice because the row's owner cannot change), if slightly less direct than a
single scoped delete.

`memory_embeddings` carries no `user_id`, which is fine while it is only ever reached through a
memory row — but combined with M-03 (the relation is null) there is currently no path from a
memory to its embedding at all.

### M-08 — A client comment claims the list endpoint has a `search` filter that does not exist

**(a) Confirmed defect — MEDIUM**

```
apps/mobile/lib/core/api/nova_api.dart:106-107
      // The server's MemoryListQuerySchema reads `search`; the dedicated
      // /memories/search endpoint reads `query`. Both are correct for their
      // own route — this one is the list.
```

`MemoryListQuerySchema` is:

```
services/api/src/schemas/index.ts:171-178
export const MemoryListQuerySchema = z.object({
	cursor: z.string().base64url().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	direction: z.enum(['forward', 'backward']).default('forward'),
	category: ..., visibility: ..., status: ...,
});
```

There is **no** `search` field. `validate()` is not `.strict()` (verified: it parses and assigns
`validatedQuery`, `services/api/src/middleware/validate.ts:9-40`), so `?search=...` is stripped
silently. `listMemories(query: ...)` (`nova_api.dart:100-114`) therefore returns the unfiltered
first page. Today the only caller that could pass `query` is
`memorySearchResultsProvider`, and it correctly uses `searchMemories`
(`apps/mobile/lib/core/api/providers.dart:96-105`) — so the bug is latent, not live. But
`memory_page.dart:9-10` repeats the claim (*"Search hits the server (`GET /api/v1/memories?search=`)"*),
which is doubly wrong: the URL shape is wrong **and** `novа_api.dart` uses the dedicated route.

### M-09 — Nothing is lost on restart (verified, with one caveat)

**Verified clean, one caveat.** The pipeline inserts transcripts and summaries in a single
sequential flow (`services/api/src/services/recording-pipeline.ts:379-426`) and marks `completed`
only afterwards (`:435`). Transcripts are idempotent by unique index on `recording_id`
(`recording-pipeline.ts:353-356`). The caveat is the ordering fix documented at
`recording-pipeline.ts:370-378`: `recording_summaries.transcript_id` is `NO ACTION`, not `CASCADE`,
so a naive re-process failed with 23503 and flipped a good recording to `failed`. The current code
deletes the summary first (`:379`) then the transcript (`:380`) — correct. There is **no database
transaction** around those two deletes and the subsequent inserts, so a crash between `:380` and
`:419` leaves a recording with no transcript and no summary while the status may still say
`processing`. Combined with R-05 (no reaper) that is unrecoverable.

---

## 5. Extreme stress / performance limits

### P-01 — `rateLimitMiddleware`'s sliding-window store evicts live entries, letting a flood unlock everyone

**(a) Confirmed defect — HIGH**

```
services/api/src/middleware/rateLimit.ts:87-93
	private enforceLimit(): void {
		if (this.store.size > this.maxEntries) {
			// Evict oldest 30% of entries
			const keys = Array.from(this.store.keys()).slice(0, Math.floor(this.maxEntries * 0.3));
			keys.forEach((k) => this.store.delete(k));
		}
	}
```

`enforceLimit()` is called on **every** `check()` (`rateLimit.ts:52`, `:66`, `:79`), including on
the brute-force-protected auth path. The keys are composite `IP:route`
(`rateLimit.ts:153-154`), so an attacker with a large IPv6 allocation — or simply a botnet — can
inflate `store.size` past `maxEntries = 10000` (`rateLimit.ts:41`) and force the eviction of the
oldest 30 %, which at that moment includes *every currently-blocked legitimate key*. The auth
limiter is `AUTH_RATE_LIMIT` (`rateLimit.ts:149-150`); evicting its entries resets the brute-force
counter for the login route. This is a denial-of-protection primitive, not just a memory
concern.

### P-02 — The fixed-window rate limiter's `buckets` map is a genuine unbounded leak

**(a) Confirmed defect — MEDIUM**

```
services/api/src/middleware/rateLimit.ts:219
export const buckets = new Map<string, FixedWindowBucket>();
```

Entries are created on first sight of a key (`rateLimit.ts:232-236`) and only ever *replaced* when
the same key returns after `resetAt`:

```
rateLimit.ts:230-236
		let bucket = buckets.get(key);
		if (!bucket || now >= bucket.resetAt) {
			bucket = { count: 0, resetAt: now + windowMs };
			buckets.set(key, bucket);
		}
```

There is no `setInterval` for this map, no size cap, and no eviction — unlike `SlidingWindowStore`,
which does have a cleanup timer (`rateLimit.ts:95-111`). A key that is seen once is never removed.
Note this limiter (`rateLimit()`) is exported but **not mounted** — `grep` finds only
`rateLimitMiddleware` imported by `src/server.ts:34`, and `rateLimit` appears nowhere outside
`rateLimit.ts`. So this is latent, but it becomes a leak the moment anyone wires it up.

### P-03 — `GET /recordings/:id` returns unbounded segment rows

See **R-07** (`services/api/src/routes/recordings.ts:236-240`). Cross-listed: same code, stress lens.

### P-04 — The realtime gateway accumulates empty transcript entries with no bound

**(a) Confirmed defect — MEDIUM**

`AudioHandlerOptions` declares a bound that is never read:

```
services/realtime-gateway/src/handlers/audio.ts:7-10
export interface AudioHandlerOptions {
 maxTranscriptBufferSize?: number;
 audioLevelUpdateIntervalMs?: number;
}
```

`grep` for `maxTranscriptBufferSize` across `services/realtime-gateway/src/` returns **only that
declaration line**. The buffer appender has no cap:

```
services/realtime-gateway/src/sessions.ts:59-67
export function addTranscript(sessionId: string, transcript: ...): ... {
 const managed = sessions.get(sessionId);
 if (!managed) return undefined;
 const updated = [...managed.session.transcriptBuffer, transcript];
 managed.session = { ...managed.session, transcriptBuffer: updated };
```

and it is called every 5 s whenever the audio level exceeds 0.1
(`services/realtime-gateway/src/handlers/audio.ts:52-68`), appending a **placeholder**
`{ transcript: '', text: '', isFinal: false }` (`audio.ts:58-65`). Note the copy-on-write
`[...buffer, x]` in `sessions.ts:63` — each append is O(n), so this is quadratic in session length,
not merely linear memory. `cleanupStale` removes sessions idle > 5 min
(`sessions.ts:95-107`) but does nothing about a session that is actively receiving audio.

### P-05 — Synchronous end-to-end model calls hold the request connection

**(a) Confirmed defect — MEDIUM**

`POST /conversations/:id/messages` awaits the full assistant tool loop before responding:

```
services/api/src/routes/conversations.ts:367-380
				const completion = await runAssistantToolLoop(req.user!.id, toChatMessages(history), { ... });
```

That is one or more provider round-trips, each with a timeout (see
`services/api/src/routes/ai.ts` chat timeouts). The response cannot be sent until every iteration
finishes. Compare the voice path, which is correctly async — `POST /recordings/:id/process` answers
`202` and defers work (`services/api/src/routes/recordings-capture.ts:280-283`,
`recording-pipeline.ts:504-509`). No such pattern was applied to the chat route.

### P-06 — Every grounded turn runs three extra queries plus a model loop before the first token

**(a) Confirmed defect — LOW/MEDIUM**

```
services/api/src/services/user-context.ts:221-302
	const [taskSection, reminderSection, memorySection] = await Promise.all([ ... three db reads ... ]);
```

They are parallelised (`user-context.ts:217-220` explains why), which is the right call. But this
runs on the **latency path of every spoken turn** and is awaited before the model is called
(`conversations.ts:373-379`). The hard-coded timezone also leaks here:

```
user-context.ts:314-316
	const header =
		`What you know about this user right now (current time: ${formatNow(now)}, ` +
		`today's date is ${isoDateInUserZone(now)} in ${USER_TIMEZONE}):`;
```

`USER_TIMEZONE` is a module constant, so a user outside that zone is told the wrong "today" in
their own grounding block — a correctness bug with a performance cost attached.

### P-07 — No pagination on `GET /briefing`-adjacent context reads, but the limits are bounded

**Verified acceptable.** `user-context.ts:231` (`limit(l.maxTasks)`), `:261`
(`limit(l.maxReminders)`), `:286` (`limit(l.maxMemories)`), and `:329` truncates the assembled text
to `l.maxChars`. The lists that matter in this repo — `/tasks`, `/reminders`, `/memories`,
`/conversations`, `/recordings` — all use `limit(q.limit + 1)` cursor pagination with
`RECORDING_STATUS`/keyset helpers (`services/api/src/routes/recordings.ts:97-103`,
`reminders.ts:82-88`, `memories.ts:70-76`, `tasks.ts`). **The exceptions are the memory *search*
route (`memories.ts:158-162`, offset-based) and the unbounded segment read (R-07).**

### P-08 — No N+1 query pattern found in the main list endpoints

**Verified clean.** `admin.ts` batches its user lookups rather than querying per row
(`services/api/src/routes/admin.ts:805-814`, a single `inArray` for all 100 rows), and the
recording/reminder/memory list routes issue exactly two queries each (a count and a page). The
DB-call-inside-a-loop pattern does not appear in `src/routes/`.

---

## 6. Reminders: spoken aloud and pushed, when app is open / background / closed

### N-01 — The known limitation is real, and precisely as described

**(b) Platform limitation — recorded as verified**

`reminder_sync.dart:39-48` states that `flutter_local_notifications` gives no Dart callback on
delivery:

```
apps/mobile/lib/features/reminders/reminder_sync.dart:40-43
/// itself, so it fires with the app closed. Nothing in `flutter_local_notifications`
/// calls back into Dart when a scheduled notification is *delivered* — the
/// background isolate callback only runs when the user taps it — so "speak at the
/// exact moment, with the app dead" is not achievable from Dart.
```

Verified against the code: the only scheduling primitives used are `zonedSchedule`
(`apps/mobile/lib/features/reminders/reminder_notifications.dart:237-249`, `:277-294`) and
`pendingNotificationRequests` (`:211`), and the plugin is initialized **without** any background
callback (`:139-143` — `InitializationSettings` carries only `android:`, no
`onDidReceiveBackgroundNotificationResponse`). Speech is a plain in-process `Timer`:

```
reminder_sync.dart:122-130
    for (final reminder in upcoming.take(maxSpeechTimers)) {
      final delay = reminder.remindAt!.difference(DateTime.now());
      _timers.add(Timer(delay.isNegative ? Duration.zero : delay, () => unawaited(_speak(reminder))));
    }
```

**Conclusion: speech works only while the Dart isolate is alive and the timers are armed. This is
a genuine platform limitation and the code is honest about it.** The defects are elsewhere.

### N-02 — Only the first 50 reminders are ever fetched, and the reconciler cancels every alarm it did not see

**(a) Confirmed defect — CRITICAL**

```
apps/mobile/lib/features/reminders/reminder_sync.dart:89
      final reminders = await ref.read(novaApiProvider).listReminders();
```

`listReminders` defaults to `limit = 50` and never follows `nextCursor`:

```
apps/mobile/lib/core/api/nova_api.dart:270-279
  Future<List<NovaReminder>> listReminders({int limit = 50}) async {
    final data = await _get(ApiConfig.reminders, query: {'limit': limit});
    ...
  }
```

The server orders by `created_at DESC` and returns one page
(`services/api/src/routes/reminders.ts:81-85`). So a user with more than 50 reminders — trivially
reachable, since nothing prunes them — hands the reconciler a list containing only the **newest**
50. The reconciler then treats everything else as garbage:

```
apps/mobile/lib/features/reminders/reminder_reconciler.dart:96-102
    final held = await notifications.scheduledIds();
    var cancelled = 0;
    for (final id in held) {
      if (wanted.containsKey(id)) continue;
      await notifications.cancel(id);
      cancelled++;
    }
```

Any armed alarm whose reminder is on page 2+ is **cancelled**. This is verbatim the bug the
reconciler's own docstring claims to prevent ("a reinstall or an expired token loses every local
alarm while the rows still exist server-side", `reminder_reconciler.dart:30-34`) — it reproduces
it on every sync for a user with >50 reminders. The `_armSpeaking` bound compounds it: only the
first 8 *upcoming of the same truncated list* get speech timers
(`reminder_sync.dart:122`, `maxSpeechTimers = 8` at `:52`).

### N-03 — `_armSpeaking` re-arms only 8 timers and relies on `sync()` being called again

**(a) Confirmed defect — MEDIUM**

```
reminder_sync.dart:109-131
  void _armSpeaking(List<NovaReminder> reminders) {
    _cancelTimers();
    ...
    for (final reminder in upcoming.take(maxSpeechTimers)) {
```

`sync()` is triggered by `ReminderSyncController.build()` on auth
(`reminder_sync.dart:65-68`) and by `_onResume` (`apps/mobile/lib/app/app.dart:137`). If the app
is opened and left open across more than 8 future reminders, reminders 9+ are never spoken. The
mitigation intended is that each `sync()` re-arms the next batch (`reminder_sync.dart:50-51`), but
`sync()` only runs on resume or on auth change — not on a timer. An app left in the foreground
for a day speaks at most the first 8 reminders it knew about.

### N-04 — Timers that expire while the isolate is suspended fire late, in a burst

**(c) Suspected — MEDIUM**

Dart `Timer`s do not run while the Android process is suspended (Doze / App Standby / OEM freeze —
the same mechanism documented at `apps/mobile/android/app/src/main/AndroidManifest.xml:236-243`).
On resume, every overdue timer callback runs. The result is that a user returning to the app after
a few hours hears a stack of reminders spoken back-to-back by
`FlutterTtsDeviceTts.speak` (`apps/mobile/lib/core/voice/device_tts.dart:73-99`), each awaiting the
previous (`reminder_sync.dart:127`, `_speak` at `:133-153`). Nothing checks whether the reminder
time has long passed before speaking it — `_speak` speaks the title unconditionally
(`reminder_sync.dart:134-136`). The OS notification for those reminders has already been shown, so
the speech is a duplicate that arrives hours late.

### N-05 — No push exists; the "Device notifications" toggle is a local-alarm switch

**(a) Confirmed defect (naming/promise) — HIGH**

The brief asks for reminders "pushed". There is no push transport in the app:
`apps/mobile/lib/core/api/models.dart:472-523` models a `push` preference, and
`apps/mobile/lib/features/settings/me_page.dart:541-546` documents the relabelling:

```
        // Deceptive Behavior policy and App Review 2.3.1(a). `push` is relabelled:
        // there is no `firebase_messaging` and no device-token registration, so what
        // ...
          _Toggle('push', '🔔', 'Device notifications', (p) => p.push),
```

`grep` for `firebase_messaging` / `FirebaseMessaging` across `apps/mobile/lib` and `pubspec.yaml`
returns **nothing**. So "pushed, when app is closed" is delivered by a locally-scheduled
`flutter_local_notifications` alarm, not by a server push. The distinction matters operationally:
if the OS drops the alarm (app force-stopped, or `SCHEDULE_EXACT_ALARM` denied), **the server has
no way to reach the device at all**. The manifest's own note at
`AndroidManifest.xml:185-188` confirms FCM is inert: *"`firebase_messaging` is not a dependency and
nothing registers for push"*.

### N-06 — Exact alarms degrade to inexact silently, and `SCHEDULE_EXACT_ALARM` is not the right permission on Android 13

**(a) Confirmed defect / (b) partial — MEDIUM**

```
apps/mobile/lib/features/reminders/reminder_notifications.dart:179-187
      if (!granted && !interactive) {
        // Background path ... Callers degrade to
        // inexact scheduling instead; the reminders screen offers the prompted path.
        _exactAllowed = false;
        return false;
      }
```

`ensureExactAlarmPermission()` is called by the reconciler with no arguments
(`reminder_reconciler.dart:114`), so the default `interactive: false` applies — correct per the
comment. But note the manifest:

```
apps/mobile/android/app/src/main/AndroidManifest.xml:9
    <uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />
```

There is no `USE_EXACT_ALARM` declaration. `SCHEDULE_EXACT_ALARM` is auto-granted on Android 12
(API 31–32) but **denied by default from Android 13 (API 33)** unless the app is an alarm clock or
calendar app. So on any current device the background path systematically takes the
`_exactAllowed = false` branch, and every reminder is scheduled `inexactAllowWhileIdle`
(`reminder_notifications.dart:246-248`) — which Android may defer by many minutes, or until the
next Doze maintenance window. "Reminder fires at the time you set" is therefore not what the
default install delivers.

### N-07 — `scheduledIds()` includes the daily-briefing alarm, which the reconciler then cancels

**(a) Confirmed defect — HIGH**

`scheduledIds()` returns **every** pending notification id, with no filter:

```
apps/mobile/lib/features/reminders/reminder_notifications.dart:207-217
  Future<Set<int>> scheduledIds() async {
    await initialize();
    final pending = await _plugin.pendingNotificationRequests();
    return pending.map((request) => request.id).toSet();
```

The same plugin and the same seam schedule the daily briefing
(`reminder_notifications.dart:43-58` documents this deliberately: "It lives on this seam rather
than in a second wrapper so the app has exactly one `FlutterLocalNotificationsPlugin`"). The
reconciler cancels every id it does not recognise:

```
reminder_reconciler.dart:96-102
    final held = await notifications.scheduledIds();
    for (final id in held) {
      if (wanted.containsKey(id)) continue;
      await notifications.cancel(id);
```

`wanted` is keyed only by `reminderNotificationId(reminder.id)`
(`reminder_reconciler.dart:78`). The briefing's id is not in `wanted` by construction. **Every
reminder sync therefore cancels the scheduled daily briefing.** The same cancellation happens on
the notifications-off path, which cancels *everything* held
(`reminder_reconciler.dart:84-93`) — arguably intended there, but the
`wanted.containsKey` path is not.

### N-08 — Deriving a notification id from an unseeded hash can collide

**(a) Confirmed defect — LOW**

```
reminder_notifications.dart:72-79
int reminderNotificationId(String reminderId) {
  var hash = 0x811c9dc5;
  for (final unit in reminderId.codeUnits) {
    hash ^= unit;
    hash = (hash * 0x01000193) & 0x7fffffff;
  }
  return hash;
}
```

FNV-1a folded into 31 bits, with no namespace salt and no collision check. The docstring at
`:64-71` acknowledges the collision risk and dismisses it as "vanishingly unlikely". That is true
in isolation, but the value is not compared against the briefing's id — and if a reminder's hash
happens to equal the briefing's id, N-07's bug becomes "the briefing id is in `wanted` and the
briefing notification is replaced by a reminder". Combined with N-07, the id space is shared and
unpartitioned.

### N-09 — `reminders_page.dart` schedules nothing

**(a) Confirmed defect — MEDIUM**

Nothing in the reminders UI calls the reconciler. Creating a reminder goes through
`novaMutationsProvider` → `_api.createReminder` (`apps/mobile/lib/core/api/providers.dart:271-274`),
and the provider's invalidation list (`providers.dart:266-269`) covers `memoriesProvider`,
`memorySearchResultsProvider` and `homeOverviewProvider` — **not** `reminderSyncProvider`. So a
reminder created in the app is not armed until the next app resume or auth change triggers
`sync()` (`reminder_sync.dart:65-68`). A user who creates a reminder for 30 minutes from now, then
keeps the app open, gets no alarm. The reconciler's docstring at
`reminder_reconciler.dart:30-34` says scheduling is "deliberately not a one-shot at creation",
which reads as a justification, but the effect is that creation is not a scheduling trigger at
all.

---

## Summary table

| ID | Severity | Area | File:line | One-line defect |
|---|---|---|---|---|
| M-01 | CRITICAL | 4 Memory | `services/api/src/services/ai.ts:497-502` + `services/api/src/services/memory.ts:141-153` | `generateEmbedding` is a hard-coded `{embedding: [], dimensions: 0}` stub, so every embedding row stores an empty vector labelled `text-embedding-3-small`; the `catch` at `memory.ts:151` is empty despite its "Log but don't fail" comment. |
| M-02 | CRITICAL | 4 Memory | `services/api/src/routes/memories.ts:114-128` | The route inserts directly instead of calling `createMemory`, so the only embedding hook is unreachable; the assistant path at `services/api/src/services/assistant-tool-executor.ts:276` bypasses it too. |
| R-01 | CRITICAL | 3 Recording | `apps/mobile/lib/features/recording/meeting_recorder.dart:174-187` | The entire meeting is read into one `Uint8List`, then server-side into `Buffer.concat` (`services/api/src/services/audio-storage.ts:278-284`), then again in the pipeline (`recording-pipeline.ts:332`) and passed whole to STT (`services/api/src/services/ai.ts:1161`). |
| R-02 | CRITICAL | 3 Recording | `apps/mobile/lib/features/recording/meeting_recorder.dart:185` + `recording_controller.dart:191` | The temp file is deleted before upload and the only copy lives in the private `_pendingClip` field, so a kill during upload loses the meeting with no recovery path. |
| R-04 | CRITICAL | 3 Recording | `apps/mobile/lib/features/recording/meeting_recorder.dart:97-103` | Long recordings are written to `getTemporaryDirectory` (`:50`) with no foreground service, no wakelock and no startup recovery, so a mid-meeting process death orphans the file in the OS cache until Android deletes it. |
| R-05 | CRITICAL | 3 Recording | `services/api/src/services/recording-pipeline.ts:504-509` + `services/api/src/jobs/retention.ts:94-99` | The job is an in-process `setImmediate` with no durable queue and no `status='processing'` reaper, so a restart mid-job leaves the row stuck forever while the audio is retained. |
| N-02 | CRITICAL | 6 Reminders | `apps/mobile/lib/core/api/nova_api.dart:270-279` + `reminder_reconciler.dart:96-102` | `listReminders()` fetches a single 50-item page with no cursor, and the reconciler cancels every arming it did not see, so users with >50 reminders lose alarms on every sync. |
| W-02 | HIGH | 1 Wake word | `apps/mobile/android/app/src/main/java/com/leadup/nova/WakeWordService.kt:349-356` | `emit()` drops a detection when no `EventSink` is attached, and `onWakeWordDetected` (`:477-487`) posts no notification — contradicting `wake_word_session.dart:11-13`. |
| W-03 | HIGH | 1 Wake word | `apps/mobile/lib/core/voice/wake_word_session.dart:27-29` | A background detection is discarded with no UI, sound or notification, so "Hey Nova" while backgrounded does nothing visible. |
| W-04 | HIGH | 1 Wake word | `apps/mobile/android/app/src/main/java/com/leadup/nova/WakeWordService.kt:498` + `:359` + `:464-474` | `shutdown()` permanently cancels the instance `serviceScope`, but a non-`stopSelf` `shutdown()` (e.g. `engine_start_failed`) leaves the service alive to accept another `start`, which then opens the mic and launches the read loop on a dead scope — "Listening now", no detection ever. |
| B-02 | HIGH | 2 Background | `apps/mobile/lib/app/app.dart:132-134` + `wake_word_controller.dart:302-318` | The only re-arm on Android 14+ is opening the app, and it requires `wakeWordStateProvider` to already be read, so a cold start that never touches it leaves the service dead. |
| R-03 | HIGH | 3 Recording | `apps/mobile/lib/features/recording/recording_controller.dart:351-362` and `:204-210` | One upload attempt, no backoff or background queue; the retry only works in the same process, yet the message at `:430-431` promises the audio "can be retried". |
| M-03 | HIGH | 4 Memory | `packages/database/src/schema.ts:302` + `:848-857` vs `services/api/src/services/memory.ts:145-150` | `memories.embedding_id` is declared and related but never written, so the embedding relation is null for every row ever created. |
| M-04 | HIGH | 4 Memory | `packages/database/src/schema.ts:312-319` | The "pgvector" store is a `jsonb` column with no `hnsw`/`ivfflat` index in any migration (`packages/database/drizzle/0000_regular_colossus.sql:587-588` is the only `memories` index). |
| P-01 | HIGH | 5 Stress | `services/api/src/middleware/rateLimit.ts:87-93` | `enforceLimit()` evicts the oldest 30 % of keys — including live brute-force blocks on the auth limiter — on every `check()`, so a key flood resets every active rate limit. |
| N-05 | HIGH | 6 Reminders | `apps/mobile/lib/features/settings/me_page.dart:541-546` + `apps/mobile/android/app/src/main/AndroidManifest.xml:185-188` | There is no push transport at all; "Device notifications" is a local `flutter_local_notifications` alarm, so a dropped alarm cannot be re-delivered by the server. |
| N-07 | HIGH | 6 Reminders | `apps/mobile/lib/features/reminders/reminder_notifications.dart:207-217` + `reminder_reconciler.dart:96-102` | `scheduledIds()` returns every pending id, including the daily-briefing alarm, which the reconciler then cancels on every sync. |
| W-01 | HIGH | 1 Wake word | `apps/mobile/android/app/src/main/java/com/leadup/nova/WakeWordService.kt:167-177` | `availability()` gates on two dead openWakeWord assets (`:69-70`) that the sherpa engine never opens, and a failure persists the user's toggle off at `wake_word_controller.dart:132-139`. |
| W-05 | MEDIUM | 1 Wake word | `apps/mobile/android/app/src/main/java/com/leadup/nova/WakeWordService.kt:244-254` | `POST_NOTIFICATIONS` is a hard gate on the whole wake-word feature; on Android 13+ it is denied by default. |
| W-06 | MEDIUM | 1 Wake word | `WakeWordService.kt:167-201` vs `apps/mobile/lib/core/voice/wake_word_service.dart:79-80` | The availability probe can never return `permission_denied`, so the friendly message path at `wake_word_controller.dart:346-349` is unreachable from the probe. |
| W-08 | MEDIUM | 1 Wake word | `apps/mobile/android/app/src/main/java/com/leadup/nova/WakeWordService.kt:35` (and 7 more, see table) | Eight files still document an `openWakeWord`/`hey_jarvis` design; the app ships `hey_nova` sherpa KWS (`models.json:5`, `SherpaWakeWordEngine.kt:140-161`). |
| B-03 | MEDIUM | 2 Background | `apps/mobile/android/app/src/main/AndroidManifest.xml:236-243` | OEM ROMs (OxygenOS documented) freeze the process on screen-off, which stops detection regardless of `stopWithTask`; the exemption is only offered as a settings link. |
| R-06 | MEDIUM | 3 Recording | `apps/mobile/lib/features/recording/recording_controller.dart:326-336` | The size ceiling is checked after the whole file has been read and held, so an oversized meeting still costs full memory and read time before being discarded. |
| R-07 | MEDIUM | 3 Recording | `services/api/src/routes/recordings.ts:236-240` | `GET /recordings/:id` returns every transcript segment with no limit, pagination or projection cap. |
| R-08 | MEDIUM | 3 Recording | `services/api/src/routes/recordings-capture.ts:97-100` | `express.raw` buffers the full 32 MB body in heap before the handler runs (limit at `services/api/src/services/audio-storage.ts:82`), with no per-user concurrency cap. |
| R-09 | MEDIUM | 3 Recording | `services/api/src/routes/recordings.ts:148-164` | No maximum recording duration is enforced and no sweep closes stale `recording` rows (`services/api/src/jobs/retention.ts:94-99` filters by age only). |
| R-10 | MEDIUM | 3 Recording | `apps/mobile/lib/features/recording/recording_controller.dart:373-383` | If the app dies between upload and `/process`, the row stays `uploaded` with nothing server-side to pick it up, and the audio is deleted at the retention window with no transcript. |
| M-05 | MEDIUM | 4 Memory | `services/api/src/routes/memories.ts:141-145` + `services/api/src/services/memory.ts:128-132` | Search is an unbounded `ILIKE '%term%'` sequential scan with no trigram index in any migration. |
| M-06 | MEDIUM | 4 Memory | `services/api/src/services/memory.ts:14` + `:40` vs `services/api/src/schemas/index.ts:139` | `createMemory` truncates at 100 000 chars — unreachable through a route that rejects >4 000 — while the truncation that does apply (`user-context.ts:296`) is invisible to the user. |
| M-08 | MEDIUM | 4 Memory | `apps/mobile/lib/core/api/nova_api.dart:106-107` | The comment claims `MemoryListQuerySchema` reads `search`; `services/api/src/schemas/index.ts:171-178` has no such field, so `?search=` is silently stripped. |
| P-02 | MEDIUM | 5 Stress | `services/api/src/middleware/rateLimit.ts:219` | The fixed-window `buckets` map has no size cap, eviction or cleanup timer, so one-off keys leak forever (latent — `rateLimit()` is not currently mounted). |
| P-04 | MEDIUM | 5 Stress | `services/realtime-gateway/src/handlers/audio.ts:7-10` + `src/sessions.ts:59-67` | `maxTranscriptBufferSize` is declared but never read, so the placeholder transcript buffer grows unboundedly via a copy-on-write `[...buffer, x]` (quadratic) every 5 s. |
| P-05 | MEDIUM | 5 Stress | `services/api/src/routes/conversations.ts:367-380` | The assistant tool loop is awaited inline on the request path, unlike the recording pipeline which answers 202 and defers (`recordings-capture.ts:280-283`). |
| P-06 | MEDIUM | 5 Stress | `services/api/src/services/user-context.ts:314-316` | Three queries plus a hard-coded `USER_TIMEZONE` are awaited before every first token, so out-of-zone users get a wrong "today" in their grounding block. |
| N-03 | MEDIUM | 6 Reminders | `apps/mobile/lib/features/reminders/reminder_sync.dart:109-131` | At most 8 speech timers are armed per sync and `sync()` only runs on resume or auth change, so an app left open never speaks the 9th reminder. |
| N-04 | MEDIUM | 6 Reminders | `apps/mobile/lib/features/reminders/reminder_sync.dart:122-130` | Dart timers do not fire while the isolate is suspended, so overdue reminders are all spoken late in a burst on resume with no staleness check (`:134-136`). |
| N-06 | MEDIUM | 6 Reminders | `apps/mobile/android/app/src/main/AndroidManifest.xml:9` + `reminder_notifications.dart:179-187` | Only `SCHEDULE_EXACT_ALARM` is declared (denied by default on Android 13+) and the background path returns `false` without prompting, so every reminder silently degrades to `inexactAllowWhileIdle` (`:246-248`). |
| N-09 | MEDIUM | 6 Reminders | `apps/mobile/lib/core/api/providers.dart:266-269` | Creating a reminder does not invalidate `reminderSyncProvider`, so a newly created reminder is not armed until the next resume or auth change. |
| W-07 | LOW | 1 Wake word | `apps/mobile/lib/features/settings/wake_word_settings_page.dart:179` | The account-side wake-word record is write-only: no device code reads `wakeWordConfigProvider` to restore a phrase (`services/api/src/routes/device.ts:114-130`). |
| N-08 | LOW | 6 Reminders | `apps/mobile/lib/features/reminders/reminder_notifications.dart:72-79` | Unseeded 31-bit FNV-1a reminder ids share an id space with the briefing alarm and are never collision-checked. |

**Counts:** CRITICAL 7 · HIGH 11 · MEDIUM 20 · LOW 2 — **40 findings**.
(Verified-clean items recorded rather than counted: W-09, M-07, M-09, P-03 cross-reference,
P-07, P-08, B-01, N-01.)
