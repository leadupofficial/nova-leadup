import java.util.Properties

plugins {
    id("com.android.application")
    id("dev.flutter.flutter-gradle-plugin")
    // Processes android/app/google-services.json into the resources that
    // firebase_core / firebase_analytics / firebase_crashlytics read at startup.
    // Omitting this plugin makes Firebase.initializeApp() fail at runtime with
    // "Failed to load default options".
    id("com.google.gms.google-services")
}

// ---------------------------------------------------------------------------
// Release signing
//
// Resolved from environment variables first (CI), then from keystore.properties.
// `keystore.properties` is git-ignored; see android/keystore.properties.template.
//
// The previous version of this block could never compile: it declared
// `val keyAlias` / `val keyPassword` locally and then assigned to `keyAlias` /
// `keyPassword`, which Kotlin resolves to those local `val`s rather than to the
// SigningConfig properties ("'val' cannot be reassigned"). Local names are now
// deliberately different from the DSL property names.
// ---------------------------------------------------------------------------

val signingPropertiesFile: File? = listOf(
    rootProject.file("keystore.properties"), // android/keystore.properties
    rootProject.file("../keystore.properties"), // apps/mobile/keystore.properties
    file("keystore.properties"), // android/app/keystore.properties
).firstOrNull { it.exists() }

val signingProperties = Properties().apply {
    signingPropertiesFile?.inputStream()?.use { load(it) }
}

fun signingValue(envName: String, propertyName: String): String? =
    System.getenv(envName)?.takeIf { it.isNotBlank() }
        ?: signingProperties.getProperty(propertyName)?.takeIf { it.isNotBlank() }

val releaseKeystorePath = signingValue("ANDROID_KEYSTORE_PATH", "storeFile")
val releaseKeystorePassword = signingValue("ANDROID_KEYSTORE_PASSWORD", "storePassword")
val releaseKeyAliasValue = signingValue("ANDROID_KEY_ALIAS", "keyAlias")
val releaseKeyPasswordValue = signingValue("ANDROID_KEY_PASSWORD", "keyPassword")

val missingSigningValues = buildList {
    if (releaseKeystorePath == null) add("storeFile")
    if (releaseKeystorePassword == null) add("storePassword")
    if (releaseKeyAliasValue == null) add("keyAlias")
    if (releaseKeyPasswordValue == null) add("keyPassword")
}
val isReleaseSigningConfigured = missingSigningValues.isEmpty()

android {
    namespace = "com.leadup.nova"

    compileSdk = 37
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true
    }

    signingConfigs {
        create("release") {
            if (isReleaseSigningConfigured) {
                // Accept an absolute path, a path relative to android/, or one
                // relative to the app module.
                val candidates = listOf(
                    file(releaseKeystorePath!!),
                    rootProject.file(releaseKeystorePath),
                    rootProject.file("../$releaseKeystorePath"),
                )
                storeFile = candidates.firstOrNull { it.exists() }
                    ?: throw GradleException(
                        "Release keystore not found at '$releaseKeystorePath'. " +
                            "Looked in: ${candidates.joinToString { it.path }}",
                    )
                storePassword = releaseKeystorePassword
                keyAlias = releaseKeyAliasValue
                keyPassword = releaseKeyPasswordValue

                // V1-V4 so the artifact satisfies Google Play and Android 13+.
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
                enableV4Signing = true
            }
        }
    }

    defaultConfig {
        applicationId = "com.leadup.nova"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    splits {
        abi {
            isEnable = true
            reset()
            include("armeabi-v7a", "arm64-v8a", "x86_64")
            isUniversalApk = true
        }
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
            excludes += "META-INF/DEPENDENCIES"
            excludes += "META-INF/LICENSE"
            excludes += "META-INF/LICENSE.txt"
            excludes += "META-INF/license.txt"
            excludes += "META-INF/NOTICE"
            excludes += "META-INF/NOTICE.txt"
            excludes += "META-INF/notice.txt"
            excludes += "META-INF/ASL2.0"
        }
    }

    androidResources {
        // openWakeWord loads its ONNX graphs through AssetManager. Shipping them
        // uncompressed keeps them memory-mappable instead of forcing a full copy into
        // the heap on every model load.
        noCompress += "onnx"
    }

    buildTypes {
        release {
            // Only attach the release signing config when it is complete, so a debug
            // build on a machine without a keystore still works; the check below
            // fails loudly when a release artifact is actually requested.
            if (isReleaseSigningConfigured) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                file("proguard-rules.pro"),
            )
        }
        debug {
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

// Fail only when a release artifact is genuinely being built, rather than at
// configuration time for every task (which used to break plain debug builds).
gradle.taskGraph.whenReady {
    val buildingRelease = allTasks.any { it.name.contains("Release") }
    if (buildingRelease && !isReleaseSigningConfigured) {
        throw GradleException(
            "Release signing is not configured - missing: " +
                "${missingSigningValues.joinToString(", ")}. " +
                "Set ANDROID_KEYSTORE_PATH / ANDROID_KEYSTORE_PASSWORD / " +
                "ANDROID_KEY_ALIAS / ANDROID_KEY_PASSWORD, or provide a valid " +
                "keystore.properties (see android/keystore.properties.template).",
        )
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")

    // On-device wake word detection (openWakeWord, Apache-2.0).
    //
    // Chosen over Picovoice Porcupine because it needs no access key, no account, and
    // no per-device licence: the models are bundled in the APK and inference runs
    // locally through ONNX Runtime. This pulls in onnxruntime-android transitively.
    implementation("xyz.rementia:openwakeword:0.1.5")
}

flutter {
    source = "../.."
}
