package com.leadup.nova

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.util.Log
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {

 override fun onCreate(savedInstanceState: Bundle?) {
 super.onCreate(savedInstanceState)
 }

 override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
 super.configureFlutterEngine(flutterEngine)

 // Set up the MethodChannel for wake word communication with NovaWakeService
 MethodChannel(
 flutterEngine.dartExecutor.binaryMessenger,
 NovaWakeService.METHOD_CHANNEL_NAME
 ).setMethodCallHandler { call, result ->
 when (call.method) {
 NovaWakeService.METHOD_START_LISTENING -> {
 NovaWakeService.start(applicationContext)
 result.success(true)
 }
 NovaWakeService.METHOD_STOP_LISTENING -> {
 NovaWakeService.stop(applicationContext)
 result.success(true)
 }
 else -> result.notImplemented()
 }
 }

 // Bind to NovaWakeService if running
 bindToWakeService()
 }

 private fun bindToWakeService() {
 val intent = Intent(this, NovaWakeService::class.java)
 startService(intent)
 bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
 }

 private val serviceConnection = object : android.content.ServiceConnection {
 override fun onServiceConnected(name: android.content.ComponentName?, service: android.os.IBinder?) {
 Log.d(TAG, "Connected to NovaWakeService")
 }

 override fun onServiceDisconnected(name: android.content.ComponentName?) {
 Log.d(TAG, "Disconnected from NovaWakeService")
 }
 }

 companion object {
 const val TAG = "MainActivity"
 }
}
