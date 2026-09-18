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
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.rementia.openwakeword.lib.WakeWordEngine
import com.rementia.openwakeword.lib.model.DetectionMode
import com.rementia.openwakeword.lib.model.WakeWordModel
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
import org.json.JSONObject

/**
 * The single wake-word foreground service for NOVA.
 *
 * Detection runs fully on-device using openWakeWord (Apache-2.0) through the
 * `xyz.rementia:openwakeword` runtime. No access key, account, or network call is
 * involved - see `android/app/src/main/assets/wakeword/README.md` for how to swap in
 * a different or custom-trained wake word.
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
         * openWakeWord's two shared front-end models. The library resolves these
         * names relative to the root of the Android assets directory, so they must
         * stay at `android/app/src/main/assets/`.
         */
        private const val MEL_MODEL_ASSET = "melspectrogram.onnx"
        private const val EMBEDDING_MODEL_ASSET = "embedding_model.onnx"

        /** Registry of installed wake-word classifiers. */
        private const val MODEL_MANIFEST_ASSET = "wakeword/models.json"

        /** Minimum interval between two detections. */
        private const val DETECTION_COOLDOWN_MS = 2_000L

        @Volatile
        private var eventSink: EventChannel.EventSink? = null

        @Volatile
        private var isRunningFlag = false

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

        /** True when the shared models and at least one classifier are installed. */
        fun availability(context: Context): Map<String, Any> {
            val assets = context.assets
            if (!assetExists(assets, MEL_MODEL_ASSET) ||
                !assetExists(assets, EMBEDDING_MODEL_ASSET)
            ) {
                return mapOf(
                    "available" to false,
                    "reason" to "missing_shared_models",
                    "detail" to "Expected $MEL_MODEL_ASSET and $EMBEDDING_MODEL_ASSET in Android assets.",
                )
            }

            val models = loadModels(context)
            if (models.isEmpty()) {
                return mapOf(
                    "available" to false,
                    "reason" to "no_wake_word_model",
                    "detail" to "No installed classifier is listed in $MODEL_MANIFEST_ASSET.",
                )
            }

            return mapOf(
                "available" to true,
                "reason" to "ok",
                "models" to models.map { it.name },
            )
        }

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

        private fun emit(payload: Map<String, Any>) {
            eventSink?.success(payload)
        }
    }

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var engine: WakeWordEngine? = null

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
        val models = loadModels(this)
        if (models.isEmpty()) {
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

        // startForegroundCompat runs on every path that keeps this service alive. When a
        // service is started via startForegroundService(), the platform requires a
        // matching startForeground() call shortly after; skipping it raises
        // "did not then call Service.startForeground()". This also covers the
        // redundant-start case where the engine is already running.
        val names = models.joinToString(", ") { it.name }
        startForegroundCompat(buildNotification("Listening for \"$names\""))

        if (isRunningFlag) {
            Log.d(TAG, "Already listening")
            return
        }

        try {
            val created = WakeWordEngine(
                applicationContext,
                models,
                DetectionMode.ALL,
                DETECTION_COOLDOWN_MS,
                serviceScope,
            )
            created.detections
                .onEach { detection -> onWakeWordDetected(detection.model.name, detection.score) }
                .launchIn(serviceScope)
            created.start()
            engine = created
            isRunningFlag = true
            Log.i(TAG, "Wake word engine started (models: $names)")
            emit(mapOf("type" to "listening", "models" to models.map { it.name }))
        } catch (t: Throwable) {
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
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("NOVA")
            .setContentText(contentText)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return

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
}
