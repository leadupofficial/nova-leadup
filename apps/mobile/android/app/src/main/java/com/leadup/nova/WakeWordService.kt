package com.leadup.nova

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.isActive
import org.json.JSONObject

/**
 * The single wake-word foreground service for NOVA.
 *
 * Detection runs fully on-device using `sherpa-onnx` keyword spotting (Apache-2.0).
 * The wake word is a BPE-tokenised **keywords file** listed in `wakeword/models.json`,
 * so the phrase is data rather than a trained classifier. No access key, account, or
 * network call is involved - see `android/app/src/main/assets/wakeword/README.md` for
 * how to swap in a different wake word.
 *
 * This replaces three previously duplicated services (`WakeWordService`,
 * `NovaWakeService`, and `NativeBridge.WakeWordForegroundService`). The old manifest
 * declared `WakeWordForegroundService` while `BootReceiver` started `WakeWordService`.
 *
 * The removed implementations contained an "amplitude detector" that fired a wake word
 * whenever the microphone got loud. That is deliberately not carried over: it produced
 * false activations from speech, music, and door slams, which is worse than having no
 * wake word at all. When no model is installed the service reports
 * `no_wake_word_model` and stops instead of pretending to listen.
 */
class WakeWordService : Service() {

    companion object {
        const val TAG = "WakeWordService"

        const val ACTION_START = "com.leadup.nova.action.START_WAKE_WORD"
        const val ACTION_STOP = "com.leadup.nova.action.STOP_WAKE_WORD"

        const val METHOD_CHANNEL_NAME = "nova/wake_word"
        const val EVENT_CHANNEL_NAME = "nova/wake_word/events"

        private const val CHANNEL_ID = "nova_wake_word"
        private const val NOTIFICATION_ID = 1001

        /**
         * The "NOVA heard you" notification. A second channel, because the foreground
         * channel above is deliberately `IMPORTANCE_LOW` with no sound: a detection the
         * user asked for by speaking is worth an interruption, the ongoing "listening"
         * notice is not.
         */
        private const val DETECTION_CHANNEL_ID = "nova_wake_word_detection"
        private const val DETECTION_NOTIFICATION_ID = 1002

        /** Registry of installed wake words. */
        private const val MODEL_MANIFEST_ASSET = "wakeword/models.json"

        /**
         * The user's chosen wake word, stored in the same
         * `FlutterSharedPreferences` file Flutter's `shared_preferences` writes
         * (hence the `flutter.` prefix), exactly like
         * [BootReceiver.WAKE_WORD_ENABLED_KEY]. Dart reads and writes it through
         * [com.leadup.nova.WakeWordService]'s `selectModel` method; keeping one
         * store means the choice survives a restart and the boot receiver sees
         * the same value the UI showed.
         */
        const val SELECTED_MODEL_PREF_KEY = "flutter.nova_wake_word_model"

        /** Minimum interval between two detections. */
        private const val DETECTION_COOLDOWN_MS = 2_000L

        @Volatile
        private var eventSink: EventChannel.EventSink? = null

        @Volatile
        private var isRunningFlag = false

        /**
         * Whether the Activity is on screen.
         *
         * A detection is delivered to Dart over the event channel either way, but Dart
         * deliberately does not open a conversation while backgrounded, so on that path
         * the only observable signal is the notification [onWakeWordDetected] posts.
         * [MainActivity] keeps this current from `onResume`/`onPause`.
         */
        @Volatile
        private var appInForeground = false

        /**
         * Set from [MainActivity]. Kept on the service rather than asked of Flutter
         * because a background detection has to be surfaced natively.
         */
        fun setAppInForeground(value: Boolean) {
            appInForeground = value
        }

        /** When the last detection notification was posted; see `shouldPostDetectionNotification`. */
        @Volatile
        private var lastDetectionNotificationAt = 0L

        /**
         * Wires the Dart-facing channels. Called from MainActivity.configureFlutterEngine,
         * so the channels live as long as the Flutter engine does.
         */
        fun registerChannels(messenger: BinaryMessenger, context: Context) {
            val appContext = context.applicationContext

            MethodChannel(messenger, METHOD_CHANNEL_NAME)
                .setMethodCallHandler { call: MethodCall, result: MethodChannel.Result ->
                    when (call.method) {
                        "start" -> {
                            try {
                                start(appContext)
                                result.success(true)
                            } catch (t: Throwable) {
                                Log.e(TAG, "start() failed", t)
                                result.error("start_failed", t.message, null)
                            }
                        }

                        "stop" -> {
                            stop(appContext)
                            result.success(true)
                        }

                        "isRunning" -> result.success(isRunningFlag)

                        // Lets Dart disable the wake-word toggle instead of silently
                        // enabling a feature that cannot work.
                        "availability" -> result.success(availability(appContext))

                        // Persists the user's choice among the *installed*
                        // wake words. Validated here, not in Dart: this service is
                        // the only party that can see which entries in
                        // `wakeword/models.json` resolve to an asset that exists,
                        // so a name that is not installed must be refused rather
                        // than stored and later ignored.
                        "selectModel" -> {
                            val name = call.argument<String>("name")
                            if (name.isNullOrBlank()) {
                                result.error("invalid_argument", "name is required", null)
                            } else if (selectModel(appContext, name)) {
                                result.success(true)
                            } else {
                                result.error(
                                    "unknown_model",
                                    "No installed wake word is named '$name'",
                                    null,
                                )
                            }
                        }

                        else -> result.notImplemented()
                    }
                }

            EventChannel(messenger, EVENT_CHANNEL_NAME).setStreamHandler(
                object : EventChannel.StreamHandler {
                    override fun onListen(arguments: Any?, sink: EventChannel.EventSink?) {
                        eventSink = sink
                        // Bring the UI up to date immediately rather than waiting for
                        // the next engine event.
                        sink?.success(mapOf("type" to "state", "running" to isRunningFlag))
                    }

                    override fun onCancel(arguments: Any?) {
                        eventSink = null
                    }
                },
            )
        }

        /**
         * True when the model the engine actually loads and at least one wake word are
         * installed.
         *
         * The gate names exactly what `SherpaWakeWordEngine.start()` opens. It used to
         * require two openWakeWord front-end files (`melspectrogram.onnx`,
         * `embedding_model.onnx`) that this engine never touches, so a build that could
         * have listened reported itself unavailable - and Dart, told the build cannot
         * honour the preference, persisted the user's toggle **off**.
         */
        fun availability(context: Context): Map<String, Any> {
            val assets = context.assets
            val missing = missingKwsAssets { assetExists(assets, it) }
            if (missing.isNotEmpty()) {
                return mapOf(
                    "available" to false,
                    "reason" to "missing_shared_models",
                    "detail" to "This build is missing the wake word model files " +
                        "${missing.joinToString(", ")}.",
                )
            }

            val models = loadModels(context)
            if (models.isEmpty()) {
                return mapOf(
                    "available" to false,
                    "reason" to "no_wake_word_model",
                    "detail" to "No installed wake word is listed in $MODEL_MANIFEST_ASSET.",
                )
            }

            // The phrase that will actually be listened for. Always one of
            // `models`: a stored choice that is no longer installed falls back to
            // the first installed wake word rather than silently listening for nothing.
            val selected = selectedModelName(context, models)
            val payload = mutableMapOf<String, Any>(
                "available" to true,
                "reason" to "ok",
                "models" to models.map { it.name },
            )
            // Added only when there is one, so the map stays `Map<String, Any>`
            // for the channel. Dart treats an absent key as "no wake word".
            if (selected != null) payload["selected"] = selected
            return payload
        }

        /**
         * The effective wake word: the user's stored choice when it is still
         * installed, otherwise the first installed wake word.
         */
        fun selectedModelName(context: Context, models: List<WakeWordModel>): String? {
            val stored = sharedPreferences(context).getString(SELECTED_MODEL_PREF_KEY, null)
            return WakeWordModelSelection.resolve(stored, models.map { it.name })
        }

        /**
         * Persists [name] as the chosen wake word.
         *
         * Returns false — storing nothing — when no installed wake word has
         * that name. Dart is told, so the UI can say the phrase was refused
         * instead of showing a selection the service will ignore on next start.
         */
        fun selectModel(context: Context, name: String): Boolean {
            val match = loadModels(context).firstOrNull { it.name == name } ?: return false
            sharedPreferences(context).edit().putString(SELECTED_MODEL_PREF_KEY, match.name).apply()
            Log.i(TAG, "Selected wake word '${match.name}'")
            return true
        }

        private fun sharedPreferences(context: Context) =
            context.getSharedPreferences(BootReceiver.SHARED_PREFS_NAME, Context.MODE_PRIVATE)

        fun start(context: Context) {
            // Never request a microphone-typed foreground service without the runtime
            // permissions: Android 14+ enforces this, and on Android 16 (SDK 36) it
            // raises SecurityException and kills the process.
            if (!hasMicPermission(context)) {
                Log.w(TAG, "start() skipped - RECORD_AUDIO not granted")
                emit(
                    mapOf(
                        "type" to "error",
                        "code" to "permission_denied",
                        "message" to "RECORD_AUDIO not granted",
                    ),
                )
                return
            }
            if (!hasNotificationPermission(context)) {
                Log.w(TAG, "start() skipped - POST_NOTIFICATIONS not granted")
                emit(
                    mapOf(
                        "type" to "error",
                        "code" to "permission_denied",
                        "message" to "POST_NOTIFICATIONS not granted",
                    ),
                )
                return
            }

            val intent = Intent(context, WakeWordService::class.java).apply { action = ACTION_START }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            // stopService (rather than startService with ACTION_STOP): starting a
            // service with startService() while the app is in the background throws
            // IllegalStateException on Android 8+. stopService() is always allowed and
            // still runs onDestroy() -> shutdown().
            context.stopService(Intent(context, WakeWordService::class.java))
        }

        private fun hasMicPermission(context: Context): Boolean =
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED

        private fun hasNotificationPermission(context: Context): Boolean =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
                    PackageManager.PERMISSION_GRANTED
            } else {
                true
            }

        private fun assetExists(assets: android.content.res.AssetManager, path: String): Boolean =
            try {
                assets.open(path).use { true }
            } catch (_: Exception) {
                false
            }

        /**
         * Reads `wakeword/models.json`. Entries whose asset is missing are skipped
         * with a warning instead of crashing the service.
         */
        private fun loadModels(context: Context): List<WakeWordModel> {
            val assets = context.assets
            val json = try {
                assets.open(MODEL_MANIFEST_ASSET).bufferedReader().use { it.readText() }
            } catch (t: Exception) {
                Log.w(TAG, "Could not read $MODEL_MANIFEST_ASSET", t)
                return emptyList()
            }

            return try {
                val array = JSONObject(json).getJSONArray("models")
                buildList {
                    for (i in 0 until array.length()) {
                        val entry = array.getJSONObject(i)
                        val name = entry.getString("name")
                        val asset = entry.getString("asset")
                        val threshold = entry.optDouble("threshold", 0.5).toFloat()
                        if (assetExists(assets, asset)) {
                            add(WakeWordModel(name, asset, threshold))
                        } else {
                            Log.w(TAG, "Wake word '$name' skipped: asset '$asset' not found")
                        }
                    }
                }
            } catch (t: Exception) {
                Log.e(TAG, "Malformed $MODEL_MANIFEST_ASSET", t)
                emptyList()
            }
        }

        /**
         * Posts to the main thread, because Flutter's `EventChannel` sink requires it.
         *
         * `EventSink.success` is annotated `@UiThread` and `FlutterJNI.dispatchPlatformMessage`
         * enforces that at runtime. The wake-word engine runs on `Dispatchers.Default`, so
         * calling this directly from a detection threw
         *
         *     java.lang.RuntimeException: Methods marked with @UiThread must be executed on
         *     the main thread. Current thread: DefaultDispatcher-worker-1
         *         at io.flutter.embedding.engine.FlutterJNI.ensureRunningOnMainThread
         *         at ...WakeWordService$Companion.emit(WakeWordService.kt)
         *         at ...WakeWordService.onWakeWordDetected(WakeWordService.kt)
         *
         * and took the whole process down — every single time the wake word fired, which is
         * to say the app's headline feature crashed the app on first use. Nothing in the
         * suite could see it: it needs real audio above the 0.5 detection threshold, which
         * is why it was found by playing "Hey Jarvis" at a physical device.
         *
         * Fixed here rather than at the seven call sites so there is one place to be right,
         * and `eventSink` is re-read inside the post in case the sink was torn down in
         * between.
         */
        private val mainHandler = Handler(Looper.getMainLooper())

        private fun emit(payload: Map<String, Any>) {
            val sink = eventSink
            if (sink == null) {
                // No Dart listener, so this event reaches nobody through this channel.
                // Saying so out loud is what makes a dropped detection visible in
                // logcat; a background detection is still surfaced by the notification
                // `onWakeWordDetected` posts.
                Log.d(TAG, "No event sink attached; dropping '${payload["type"]}' event")
                return
            }
            if (Looper.myLooper() == Looper.getMainLooper()) {
                sink.success(payload)
            } else {
                mainHandler.post { eventSink?.success(payload) }
            }
        }
    }

    /**
     * The coroutine scope the engine captures on.
     *
     * Owned by [WakeWordScopeOwner] rather than created here, because [shutdown]
     * cancels it and [shutdown] is reached on paths that leave this service alive to
     * serve a later `start`. See that class for why a live scope is a precondition of
     * listening at all.
     */
    private val serviceScope = WakeWordScopeOwner()
    private var engine: SherpaWakeWordEngine? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                shutdown()
                return START_NOT_STICKY
            }

            // A null action means the system recreated us after a kill (START_STICKY).
            ACTION_START, null -> {
                if (!hasMicPermission(this) || !hasNotificationPermission(this)) {
                    // We must not simply `return` here. When a service is started via
                    // startForegroundService() the platform requires a matching
                    // startForeground() call within a few seconds, and skipping it
                    // raises "did not then call Service.startForeground()". stopSelf()
                    // is the safe choice. Runtime permissions survive process death, so
                    // a sticky restart normally takes the branch below; Flutter also
                    // re-arms the service on launch and on resume.
                    Log.w(TAG, "Cannot run: permissions unavailable - stopping")
                    emit(
                        mapOf(
                            "type" to "error",
                            "code" to "permission_denied",
                            "message" to "Microphone or notification permission missing",
                        ),
                    )
                    stopSelf()
                    return START_NOT_STICKY
                }

                beginListening()
                return START_STICKY
            }

            else -> {
                stopSelf()
                return START_NOT_STICKY
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        shutdown()
        super.onDestroy()
    }

    private fun beginListening() {
        val installed = loadModels(this)
        if (installed.isEmpty()) {
            Log.e(TAG, "No wake word model installed - refusing to start")
            emit(
                mapOf(
                    "type" to "error",
                    "code" to "no_wake_word_model",
                    "message" to "No wake word model is installed in the app bundle.",
                ),
            )
            stopSelf()
            return
        }

        // Honour the user's stored choice. Only the selected wake word is fed
        // to the engine, so with several installed the microphone fires on the
        // phrase the user picked rather than on all of them. `ifEmpty` keeps a
        // stale selection from silencing the service. Which models that is, and the
        // phrase the notification names them by, are decided together by
        // [planWakeWordListening] so that both halves are unit-tested.
        val plan = planWakeWordListening(installed, selectedModelName(this, installed))
        val models = plan.models
        val names = models.joinToString(", ") { it.name }

        // startForegroundCompat runs on every path that keeps this service alive. When a
        // service is started via startForegroundService(), the platform requires a
        // matching startForeground() call shortly after; skipping it raises
        // "did not then call Service.startForeground()". This also covers the
        // redundant-start case where the engine is already running.
        //
        // `plan.notificationText` names the phrase the way every other surface does.
        // Interpolating the raw keys here instead left a permanent
        // `Listening for "hey_nova"` in the shade.
        startForegroundCompat(buildNotification(plan.notificationText))

        if (isRunningFlag) {
            Log.d(TAG, "Already listening")
            return
        }

        // `shutdown()` cancels the capture scope, and `shutdown()` is reached on paths
        // that leave this service alive to serve a later `start` — the failed engine
        // start below is exactly such a path. A cancelled scope accepts `launch` and
        // never runs the block, so without this the second start opened the microphone,
        // reported "Listening now" and could never detect anything again. Asking for a
        // live scope before anything is built is the fix; see [WakeWordScopeOwner].
        val scope = serviceScope.live()

        try {
            val created = SherpaWakeWordEngine(
                applicationContext,
                models,
                DETECTION_COOLDOWN_MS,
                scope,
            )
            // Assigned before `start()` so a throw from a half-built engine is released
            // by `shutdown()` rather than leaking the microphone and the native spotter
            // it may already have opened.
            engine = created
            created.detections
                .onEach { detection -> onWakeWordDetected(detection.name, detection.score) }
                .launchIn(scope)
            created.start()
            isRunningFlag = true
            Log.i(TAG, "Wake word engine started (models: $names)")
            emit(mapOf("type" to "listening", "models" to models.map { it.name }))
        } catch (t: Throwable) {
            // `isRunningFlag` is only ever set after `start()` returned, so this clears
            // it explicitly as well: a failure here must never leave the service claiming
            // to listen while no capture loop exists. `shutdown()` cancels the scope, and
            // the next `start` asks for a live one again.
            isRunningFlag = false
            Log.e(TAG, "Failed to start wake word engine", t)
            emit(
                mapOf(
                    "type" to "error",
                    "code" to "engine_start_failed",
                    "message" to (t.message ?: t.javaClass.simpleName),
                ),
            )
            shutdown()
        }
    }

    /**
     * Makes a detection observable when the app is not on screen.
     *
     * `emit` can only reach a Dart listener, and Dart refuses to open a conversation
     * while the app is backgrounded. Before this, a backgrounded "Hey Nova" therefore
     * did nothing at all: the event was dropped or ignored, and no notification existed
     * to say otherwise - even though `wake_word_session.dart` documented one as the
     * honest signal. The engine already paces detections with `DETECTION_COOLDOWN_MS`,
     * and [shouldPostDetectionNotification] enforces the same interval again so this
     * cannot become a stream of interruptions.
     */
    private fun onWakeWordDetected(name: String, score: Float) {
        Log.i(TAG, "Wake word detected: $name (score=$score)")
        emit(
            mapOf(
                "type" to "detected",
                "name" to name,
                "score" to score,
                "ts" to System.currentTimeMillis(),
            ),
        )

        val now = System.currentTimeMillis()
        if (!shouldPostDetectionNotification(
                appInForeground = appInForeground,
                nowMs = now,
                lastNotificationAtMs = lastDetectionNotificationAt,
                cooldownMs = DETECTION_COOLDOWN_MS,
            )
        ) {
            return
        }
        lastDetectionNotificationAt = now

        try {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.notify(
                DETECTION_NOTIFICATION_ID,
                buildDetectionNotification(
                    "Heard \"${humanizeWakeWordName(name)}\" — tap to talk",
                ),
            )
        } catch (t: Throwable) {
            // A notification that cannot be posted must not take the detection - or the
            // service - down with it.
            Log.w(TAG, "Could not post the wake word notification", t)
        }
    }

    private fun shutdown() {
        isRunningFlag = false
        try {
            engine?.stop()
            engine?.release()
        } catch (t: Throwable) {
            Log.w(TAG, "Error releasing wake word engine", t)
        }
        engine = null
        serviceScope.cancel()
        try {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } catch (t: Throwable) {
            Log.w(TAG, "Error stopping foreground", t)
        }
        emit(mapOf("type" to "stopped"))
    }

    private fun startForegroundCompat(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(contentText: String): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("NOVA")
            .setContentText(contentText)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(launchPendingIntent())
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .build()
    }

    /**
     * The "NOVA heard you" notification: high priority, dismissible, and tapping it opens
     * the app at whatever screen it was last on. It deliberately starts **no** turn — the
     * conversation is opened by the app, on screen, where the user can see it.
     */
    private fun buildDetectionNotification(contentText: String): Notification {
        return NotificationCompat.Builder(this, DETECTION_CHANNEL_ID)
            .setContentTitle("NOVA")
            .setContentText(contentText)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(launchPendingIntent())
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    private fun launchPendingIntent(): PendingIntent? {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Wake word",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Keeps NOVA listening for its wake word in the background"
                setShowBadge(false)
                setSound(null, null)
            }
            manager.createNotificationChannel(channel)
        }

        // Separate, and loud, because this one reports something the user asked for by
        // speaking. The channel above is deliberately silent.
        if (manager.getNotificationChannel(DETECTION_CHANNEL_ID) == null) {
            val detection = NotificationChannel(
                DETECTION_CHANNEL_ID,
                "Wake word heard",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description =
                    "Tells you when NOVA heard its wake word while the app was in the background"
            }
            manager.createNotificationChannel(detection)
        }
    }
}

/**
 * Owns the coroutine scope the wake-word engine captures on.
 *
 * `WakeWordService.shutdown()` cancels the scope, and `shutdown()` is reached on paths
 * that leave the service alive to serve a later `start()` — a failed engine start is the
 * one that actually happens. A cancelled scope accepts `launch` and never runs the block:
 * the next start opened the microphone, reported "Listening now", and could never detect
 * anything again until the process died.
 *
 * [live] is the fix. Every path that is about to listen asks for a live scope, and one is
 * created if a previous shutdown cancelled it. It is a type of its own rather than a
 * `CoroutineScope` field because a `Service` cannot be instantiated in a JVM unit test,
 * and this invariant is exactly what one needs to pin without a device.
 */
internal class WakeWordScopeOwner(
    private val create: () -> CoroutineScope = {
        CoroutineScope(SupervisorJob() + Dispatchers.Default)
    },
) {
    private var owned: CoroutineScope = create()

    /** True while the owned scope can still run a coroutine that is launched on it. */
    val isActive: Boolean get() = owned.isActive

    /**
     * The scope to launch capture on.
     *
     * Returns the same scope while it is alive, so a redundant `start` does not leak
     * scopes, and recreates it after a shutdown so the next start can actually listen.
     */
    fun live(): CoroutineScope {
        if (!owned.isActive) owned = create()
        return owned
    }

    /** Cancels the owned scope. Called from `WakeWordService.shutdown()`. */
    fun cancel() {
        owned.cancel()
    }
}

/**
 * The files [SherpaWakeWordEngine] opens for **every** installed wake word: the zipformer
 * KWS model and its BPE vocabulary. Paths are relative to the Android assets root, exactly
 * as the engine builds them.
 *
 * The per-wake-word file is the keywords file `models.json` points at;
 * `WakeWordService.loadModels` already skips an entry whose asset is missing, so an absent
 * keywords file surfaces as `no_wake_word_model` rather than as a broken engine.
 *
 * Declared at file level, not in the `Service` companion: touching a companion property
 * from a JVM unit test would run its other initializers (`Handler(Looper.getMainLooper())`,
 * an Android stub) and blow up before a single assertion. This list is the one part of the
 * service a test needs.
 */
internal val REQUIRED_KWS_ASSETS: List<String> = listOf(
    "${SherpaWakeWordEngine.MODEL_DIR}/encoder.int8.onnx",
    "${SherpaWakeWordEngine.MODEL_DIR}/decoder.int8.onnx",
    "${SherpaWakeWordEngine.MODEL_DIR}/joiner.int8.onnx",
    "${SherpaWakeWordEngine.MODEL_DIR}/tokens.txt",
    "${SherpaWakeWordEngine.MODEL_DIR}/bpe.model",
)

/**
 * Which of [REQUIRED_KWS_ASSETS] an asset probe cannot find.
 *
 * The availability gate as a pure function: `WakeWordService.availability` passes the real
 * `AssetManager` probe, and a JVM test passes a set, so the list can be pinned to exactly
 * what `SherpaWakeWordEngine.start()` opens without a device or an APK.
 */
internal fun missingKwsAssets(exists: (String) -> Boolean): List<String> =
    REQUIRED_KWS_ASSETS.filterNot(exists)

/**
 * Whether a detection may raise a notification now.
 *
 * The engine already drops detections inside `DETECTION_COOLDOWN_MS`, so this is a second
 * guard on purpose: a notification is a user-visible interruption and must not be raised
 * more often than once per cooldown even if a future engine changes its own pacing. It
 * also stays silent while the app is on screen, where the in-app path handles the
 * detection.
 *
 * Pure, so the pacing rule is unit-tested rather than trusted.
 */
internal fun shouldPostDetectionNotification(
    appInForeground: Boolean,
    nowMs: Long,
    lastNotificationAtMs: Long,
    cooldownMs: Long,
): Boolean = !appInForeground && nowMs - lastNotificationAtMs >= cooldownMs

/**
 * `hey_nova` -> `Hey Nova`.
 *
 * Mirrors `humanizeWakeWordName` in `lib/core/voice/wake_word_service.dart`: the raw
 * identifier is an asset key, not something to show a user, and the notification is a
 * user-facing surface like any other.
 *
 * The two implementations are pinned to the same table of inputs in
 * `WakeWordServiceTest.theTwoHumanisersAgreeOnTheSharedTable` and
 * `test/core/voice/wake_word_name_test.dart`. The separator class below is spelled out
 * because Dart's `RegExp(r'[_\-\s]+')` follows ECMAScript, where `\s` also matches the
 * Unicode `Zs` separators, `\u2028`/`\u2029` and `\ufeff`, while Java's `\s` is
 * ASCII-only (`[ \t\n\x0B\f\r]`). Without the explicit list the two humanisers disagreed
 * on `hey\u00a0nova`: Dart produced `Hey Nova`, Kotlin produced `Hey\u00a0nova`.
 */
private val WAKE_WORD_NAME_SEPARATORS = Regex(
    "[_\\-\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+",
)

internal fun humanizeWakeWordName(raw: String): String =
    raw.split(WAKE_WORD_NAME_SEPARATORS)
        .filter { it.isNotEmpty() }
        .joinToString(" ") { it.replaceFirstChar { c -> c.uppercaseChar() } }

/**
 * The models the service will actually listen for, together with the phrase the
 * persistent notification names them by.
 */
internal class WakeWordListeningPlan(
    val models: List<WakeWordModel>,
    val notificationText: String,
)

/**
 * Resolves the user's stored choice against what is installed and builds the persistent
 * notification's only line, e.g. `["hey_nova"]` -> `Listening for "Hey Nova"` and
 * `["hey_nova", "hey_jarvis"]` -> `Listening for "Hey Nova, Hey Jarvis"`.
 *
 * [WakeWordListeningPlan.models] keeps the raw manifest names — the engine loads its
 * assets by them and Dart resolves the phrase from them — while [notificationText] is the
 * user-facing form. Humanising here rather than at the call site is what keeps an asset
 * key out of the shade: it used to read `Listening for "hey_nova"` for as long as the
 * service was alive. Every name in the list is humanised, not just the first.
 *
 * Pure and top-level so the wording is unit-tested rather than trusted.
 */
internal fun planWakeWordListening(
    installed: List<WakeWordModel>,
    selected: String?,
): WakeWordListeningPlan {
    val models = installed.filter { it.name == selected }.ifEmpty { installed }
    val names = models.joinToString(", ") { humanizeWakeWordName(it.name) }
    return WakeWordListeningPlan(
        models = models,
        notificationText = "Listening for \"$names\"",
    )
}
