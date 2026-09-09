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
import io.flutter.plugin.common.MethodChannel

class NovaWakeService : Service() {

 companion object {
 const val TAG = "NovaWakeService"
 const val CHANNEL_ID = "nova_wake_service_channel"
 const val NOTIFICATION_ID = 1002
 const val ACTION_START = "com.leadup.nova.ACTION_START_NOVA_WAKE"
 const val ACTION_STOP = "com.leadup.nova.ACTION_STOP_NOVA_WAKE"
 const val METHOD_CHANNEL_NAME = "nova/wake_word"

 const val METHOD_ON_WAKE_WORD = "onWakeWordDetected"
 const val METHOD_START_LISTENING = "startWakeWordListening"
 const val METHOD_STOP_LISTENING = "stopWakeWordListening"

 fun start(context: Context) {
 val intent = Intent(context, NovaWakeService::class.java).apply {
 action = ACTION_START
 }
 if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
 context.startForegroundService(intent)
 } else {
 context.startService(intent)
 }
 }

 fun stop(context: Context) {
 val intent = Intent(context, NovaWakeService::class.java).apply {
 action = ACTION_STOP
 }
 context.stopService(intent)
 }
 }

 private var isRunning = false
 private var wakeWordChannel: MethodChannel? = null

 override fun onCreate() {
 super.onCreate()
 Log.d(TAG, "NovaWakeService created")
 createNotificationChannel()
 }

 override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
 val action = intent?.action

 when (action) {
 ACTION_START -> startService()
 ACTION_STOP -> stopService()
 else -> startService()
 }

 return START_STICKY
 }

 override fun onBind(intent: Intent?): IBinder? = null

 override fun onDestroy() {
 super.onDestroy()
 stopService()
 Log.d(TAG, "NovaWakeService destroyed")
 }

 private fun startService() {
 if (isRunning) {
 Log.d(TAG, "NovaWakeService already running")
 return
 }

 Log.d(TAG, "Starting NovaWakeService")

 val notification = buildNotification("NOVA is listening...")
 startForeground(NOTIFICATION_ID, notification)

 isRunning = true
 }

 private fun stopService() {
 if (!isRunning) return

 Log.d(TAG, "Stopping NovaWakeService")
 stopForeground(STOP_FOREGROUND_REMOVE)
 stopSelf()
 isRunning = false
 }

 fun setMethodChannel(channel: MethodChannel) {
 this.wakeWordChannel = channel
 Log.d(TAG, "MethodChannel set: $METHOD_CHANNEL_NAME")
 }

 fun notifyWakeWordDetected(keyword: String) {
 Log.d(TAG, "Wake word detected: $keyword")

 // Notify Flutter via MethodChannel
 wakeWordChannel?.invokeMethod(METHOD_ON_WAKE_WORD, keyword)
 ?: Log.w(TAG, "MethodChannel not set; dropping wake word event")
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
 .setContentTitle("NOVA Assistant")
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
 "NOVA Wake Service",
 NotificationManager.IMPORTANCE_LOW
 ).apply {
 description = "Channel for NOVA wake word bridge service"
 setShowBadge(false)
 }

 val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
 manager.createNotificationChannel(channel)
 }
 }
}
