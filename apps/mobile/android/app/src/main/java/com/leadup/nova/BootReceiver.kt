package com.leadup.nova

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class BootReceiver : BroadcastReceiver() {

 override fun onReceive(context: Context?, intent: Intent?) {
 if (context == null) return

 if (intent?.action == Intent.ACTION_BOOT_COMPLETED ||
 intent?.action == Intent.ACTION_LOCKED_BOOT_COMPLETED) {
 Log.d(TAG, "Boot completed, starting wake word service")

 // Start the wake word foreground service after boot
 try {
 WakeWordService.start(context)
 } catch (e: Exception) {
 Log.e(TAG, "Failed to start wake word service on boot", e)
 }
 }
 }

 companion object {
 const val TAG = "BootReceiver"
 }
}
