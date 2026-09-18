# NOVA Mobile - R8 / ProGuard rules (release builds)
#
# Consumed by `isMinifyEnabled = true` + `isShrinkResources = true` in
# android/app/build.gradle.kts.
#
# The previous version of this file was written for the abandoned Expo/React Native
# implementation: it kept com.facebook.react, com.facebook.hermes, expo.modules,
# com.facebook.imagepipeline (Fresco), Yoga, and the React Native ProGuard annotations.
# None of those classes exist in this app any more. Keeping them was misleading and
# silently masked the fact that the real native dependencies were unprotected.
#
# The actual native dependency set is:
#   - Flutter engine (io.flutter)
#   - ONNX Runtime (ai.onnxruntime)          <- used by the wake word engine
#   - xyz.rementia openWakeWord (com.rementia.openwakeword)
#   - Firebase / Crashlytics (optional, activated by a real google-services.json)

############################
# 1. Stack-trace deobfuscation
############################
# Crash reporters symbolicate obfuscated stack traces using these.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
-keepattributes RuntimeVisibleAnnotations,RuntimeInvisibleAnnotations
-keepattributes RuntimeVisibleParameterAnnotations,RuntimeInvisibleParameterAnnotations
-keepattributes AnnotationDefault
-keepattributes Signature,InnerClasses,EnclosingMethod

############################
# 2. Kotlin
############################
-keep class kotlin.Metadata { *; }
-dontwarn kotlin.**
# Coroutines reflectively discover their own internal classes.
-keepclassmembers class kotlinx.coroutines.** { volatile <fields>; }
-dontwarn kotlinx.coroutines.**

############################
# 3. NOVA app components (declared in AndroidManifest.xml)
############################
# Manifest-declared components are instantiated by the framework from a string name.
-keep class com.leadup.nova.MainActivity { *; }
-keep class com.leadup.nova.WakeWordService { *; }
-keep class com.leadup.nova.BootReceiver { *; }
-keep class com.leadup.nova.NotificationListener { *; }

############################
# 4. Flutter engine
############################
-keep class io.flutter.app.** { *; }
-keep class io.flutter.plugin.** { *; }
-keep class io.flutter.util.** { *; }
-keep class io.flutter.view.** { *; }
-keep class io.flutter.embedding.** { *; }
-keep class io.flutter.** { *; }
-dontwarn io.flutter.**

############################
# 5. ONNX Runtime (JNI)
############################
# OrtSession/OrtEnvironment are thin Java wrappers over a native library that calls
# back into these classes by name. Stripping or renaming them breaks inference with
# an UnsatisfiedLinkError / NoSuchMethodError at wake word start-up.
-keep class ai.onnxruntime.** { *; }
-dontwarn ai.onnxruntime.**

############################
# 6. openWakeWord
############################
-keep class com.rementia.openwakeword.** { *; }
-keepclassmembers enum com.rementia.openwakeword.** { *; }
-dontwarn com.rementia.openwakeword.**

############################
# 7. Native methods, generically
############################
-keepclasseswithmembernames class * {
    native <methods>;
}

############################
# 8. Firebase / Crashlytics / FCM
############################
# Present so that R8 does not break the Crashlytics stack-trace pipeline once a real
# google-services.json is generated. -dontwarn covers the case where the SDK is not on
# the classpath yet.
-keepattributes *Annotation*
-keep class com.google.firebase.** { *; }
-keep class com.google.firebase.crashlytics.** { *; }
-keep class com.crashlytics.** { *; }
-keep public class * extends java.lang.Exception
-dontwarn com.google.firebase.**
-dontwarn com.google.android.gms.**

############################
# 9. AndroidX
############################
-keep class androidx.core.app.NotificationCompat { *; }
-dontwarn androidx.core.**
-dontwarn androidx.lifecycle.**

############################
# 10. Serializable / Parcelable (defensive)
############################
-keepclassmembers class * implements java.io.Serializable {
    static final long serialVersionUID;
    private static final java.io.ObjectStreamField[] serialPersistentFields;
    private void writeObject(java.io.ObjectOutputStream);
    private void readObject(java.io.ObjectInputStream);
    java.lang.Object writeReplace();
    private void readObjectNoData();
}
-keepclassmembers class * implements android.os.Parcelable {
    public static final ** CREATOR;
}

############################
# 11. Misc warnings to silence (safe to ignore)
############################
-dontwarn java.lang.invoke.StringConcatFactory
-dontwarn org.codehaus.mojo.animal_sniffer.**
-dontwarn javax.annotation.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
