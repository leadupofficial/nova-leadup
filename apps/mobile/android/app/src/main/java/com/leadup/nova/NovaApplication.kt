package com.leadup.nova

import android.app.Application
import android.util.Log

class NovaApplication : Application() {

 override fun onCreate() {
 super.onCreate()
 Log.d(TAG, "NOVA Application initialized")
 }

 companion object {
 const val TAG = "NovaApplication"
 }
}
