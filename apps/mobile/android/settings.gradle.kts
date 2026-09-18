pluginManagement {
  val flutterSdkPath = run {
    val properties = java.util.Properties()
    file("local.properties").inputStream().use { properties.load(it) }
    val flutterSdkPath = properties.getProperty("flutter.sdk")
    require(flutterSdkPath != null) { "flutter.sdk not set in local.properties" }
    flutterSdkPath
  }

  includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")

  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}

plugins {
  id("dev.flutter.flutter-plugin-loader") version "1.0.0"
  id("com.android.application") version "9.1.0" apply false
  id("org.jetbrains.kotlin.android") version "2.3.20" apply false
  // Firebase (project nova-leadup-stagging). Reads android/app/google-services.json.
  // `apply false` here and applied in :app so the plugin is on the classpath once.
  id("com.google.gms.google-services") version "4.5.0" apply false
}

include(":app")
