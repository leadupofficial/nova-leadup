package com.leadup.nova

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class NotificationListener : BroadcastReceiver() {

 override fun onReceive(context: Context?, intent: Intent?) {
 if (context == null) return

 if (intent?.action == "nova.notification.POSTED") {
 val packageName = intent.getStringExtra("package_name") ?: "unknown"
 val title = intent.getStringExtra("title") ?: ""
 val text = intent.getStringExtra("text") ?: ""

 Log.d(TAG, "Notification received from $packageName: $title - $text")

 // Forward notification to the wake word / agent system
 // This can trigger the voice assistant or update the UI
 }
 }

 companion object {
 const val TAG = "NotificationListener"

 fun postNotification(
 context: Context,
 packageName: String,
 title: String,
 text: String
 ) {
 val intent = Intent("nova.notification.POSTED").apply {
 putExtra("package_name", packageName)
 putExtra("title", title)
 putExtra("text", text)
 }
 context.sendBroadcast(intent)
 }
 }
}
