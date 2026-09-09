package com.leadup.nova

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import android.util.Log

class WakeWordService : Service() {

 companion object {
 const val TAG = "WakeWordService"
 const val CHANNEL_ID = "wake_word_channel"
 const val NOTIFICATION_ID = 1001
 const val ACTION_START = "com.leadup.nova.ACTION_START_WAKE_WORD"
 const val ACTION_STOP = "com.leadup.nova.ACTION_STOP_WAKE_WORD"

 fun start(context: Context) {
 val intent = Intent(context, WakeWordService::class.java).apply {
 action = ACTION_START
 }
 if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
 context.startForegroundService(intent)
 } else {
 context.startService(intent)
 }
 }

 fun stop(context: Context) {
 val intent = Intent(context, WakeWordService::class.java).apply {
 action = ACTION_STOP
 }
 context.stopService(intent)
 }
 }

 private var isListening = false
 private var porcupineHandle: Any? = null

 override fun onCreate() {
 super.onCreate()
 Log.d(TAG, "WakeWordService created")
 createNotificationChannel()
 }

 override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
 val action = intent?.action

 when (action) {
 ACTION_START -> startWakeWordDetection()
 ACTION_STOP -> stopWakeWordDetection()
 else -> startWakeWordDetection()
 }

 return START_STICKY
 }

 override fun onBind(intent: Intent?): IBinder? = null

 override fun onDestroy() {
 super.onDestroy()
 stopWakeWordDetection()
 Log.d(TAG, "WakeWordService destroyed")
 }

 private fun startWakeWordDetection() {
 if (isListening) {
 Log.d(TAG, "Already listening for wake word")
 return
 }

 Log.d(TAG, "Starting wake word detection")

 val notification = buildNotification("Listening for wake word...")
 startForeground(NOTIFICATION_ID, notification)

 // Initialize Porcupine wake word engine (placeholder for SDK integration)
 initializePorcupine()

 isListening = true
 }

 private fun stopWakeWordDetection() {
 if (!isListening) return

 Log.d(TAG, "Stopping wake word detection")

 // Release Porcupine resources
 releasePorcupine()

 stopForeground(STOP_FOREGROUND_REMOVE)
 stopSelf()
 isListening = false
 }

 private fun initializePorcupine() {
 // Placeholder: integrate Picovoice Porcupine SDK here
 // See https://picovoice.ai/docs/porcupine/
 //
 // Example integration (requires adding the Porcupine dependency):
 //
 // val accessKey = BuildConfig.PORCUPINE_ACCESS_KEY
 // porcupineHandle = PorcupineManager.Builder()
 // .setAccessKey(accessKey)
 // .setKeywordPath("porcupine_keyword.ppn")
 // .setWakeWordCallback { keywordIndex ->
 // Log.d(TAG, "Wake word detected! keywordIndex=$keywordIndex")
 // onWakeWordDetected()
 // }
 // .build(applicationContext)
 // .also { it.start() }

 Log.d(TAG, "Porcupine initialization placeholder")
 }

 private fun releasePorcupine() {
 // Release Porcupine resources if initialized
 porcupineHandle = null
 }

 private fun onWakeWordDetected() {
 // Broadcast wake word detection to Flutter via MethodChannel
 val intent = Intent("com.leadup.nova.WAKE_WORD_DETECTED")
 sendBroadcast(intent)
 }

 private fun buildNotification(contentText: String): Notification {
 val pendingIntent = PendingIntent.getActivity(
 this,
 0,
 packageManager.getLaunchIntentForPackage(packageName)?.apply {
 flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
 },
 PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
 )

 return NotificationCompat.Builder(this, CHANNEL_ID)
 .setContentTitle("NOVA Wake Word")
 .setContentText(contentText)
 .setSmallIcon(android.R.drawable.ic_btn_speak_now)
 .setContentIntent(pendingIntent)
 .setPriority(NotificationCompat.PRIORITY_LOW)
 .setCategory(NotificationCompat.CATEGORY_SERVICE)
 .build()
 }

 private fun createNotificationChannel() {
 if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
 val channel = NotificationChannel(
 CHANNEL_ID,
 "Wake Word Detection",
 NotificationManager.IMPORTANCE_LOW
 ).apply {
 description = "Channel for NOVA wake word foreground service"
 setShowBadge(false)
 }

 val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
 manager.createNotificationChannel(channel)
 }
 }
}
