package com.leadup.nova

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat

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

        fun hasPostNotificationPermission(context: Context): Boolean {
            return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                ContextCompat.checkSelfPermission(
                    context,
                    Manifest.permission.POST_NOTIFICATIONS
                ) == PackageManager.PERMISSION_GRANTED
            } else {
                true
            }
        }

        fun postNotification(
            context: Context,
            packageName: String,
            title: String,
            text: String
        ) {
            if (!hasPostNotificationPermission(context)) {
                Log.w(TAG, "Cannot post notification on Android 13+: POST_NOTIFICATIONS permission not granted")
                return
            }

            val intent = Intent("nova.notification.POSTED").apply {
                putExtra("package_name", packageName)
                putExtra("title", title)
                putExtra("text", text)
            }
            context.sendBroadcast(intent)
        }
    }
}
