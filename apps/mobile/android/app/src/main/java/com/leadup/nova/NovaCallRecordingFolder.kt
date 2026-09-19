package com.leadup.nova

import android.app.Activity
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Log
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * The Android half of requirement 6c: reading a call-recording folder the user
 * chose with the Storage Access Framework.
 *
 * ## Nothing here records, listens to, or screens a call
 *
 * There is no `VOICE_CALL` capture, no call-log access, no telephony callback
 * and no Accessibility service — see [CallRecordingFolderPolicy] for why those
 * are not implementable or lawful. This class only does three things, all of
 * them on files the user already owns and explicitly pointed NOVA at:
 *
 *  1. `pickFolder` — opens `ACTION_OPEN_DOCUMENT_TREE` and, on a positive
 *     result, calls `takePersistableUriPermission` with read access so the grant
 *     survives a reboot and a process restart. `ACTION_OPEN_DOCUMENT_TREE` needs
 *     **no** manifest permission: the user's tap in the system picker *is* the
 *     grant. `MANAGE_EXTERNAL_STORAGE` and `READ_MEDIA_AUDIO` are deliberately
 *     absent from the manifest.
 *  2. `listFiles` — queries that tree and answers audio files only.
 *  3. `readAudio` — returns the bytes of one file the user selected.
 *
 * ## The folder picker needs the Activity, so registration takes one
 *
 * `ACTION_OPEN_DOCUMENT_TREE` is a system picker, and only an Activity can
 * launch-and-receive it. The channel is still wired from
 * `MainActivity.configureFlutterEngine` like every other NOVA channel; the
 * Activity forwards its result to [onActivityResult]. A call answered while the
 * engine was gone is reported as `not_attempted` rather than left hanging.
 */
class NovaCallRecordingFolder private constructor(
    private val activity: Activity,
    private val context: Context,
) {

    companion object {
        const val TAG = "NovaCallRecFolder"
        const val METHOD_CHANNEL_NAME = "nova/call_recording_folder"

        /**
         * Request code for `ACTION_OPEN_DOCUMENT_TREE`.
         *
         * High and app-specific: plugin registrars use low sequential codes, so
         * this cannot collide with them the way a small number could.
         */
        const val PICK_FOLDER_REQUEST = 0x4E0A

        /**
         * Result codes. Frozen: `call_recording_platform.dart` maps these to a
         * Dart enum and `call_recording_contract_test.dart` pins both lists.
         */
        const val CODE_OK = "ok"
        const val CODE_SUPPORTED = "supported"
        const val CODE_UNSUPPORTED = "unsupported"
        const val CODE_CANCELLED = "cancelled"
        const val CODE_NEEDS_PICKER = "needs_picker"
        const val CODE_NO_FOLDER = "no_folder"
        const val CODE_NOT_A_FOLDER = "not_a_folder"
        const val CODE_UNREADABLE = "unreadable"
        const val CODE_EMPTY = "empty"
        const val CODE_TOO_LARGE = "too_large"
        const val CODE_INVALID_ARGUMENT = "invalid_argument"
        const val CODE_FAILED = "failed"

        /** Refuses an import larger than this instead of pinning it in memory. */
        const val MAX_READABLE_BYTES = 64L * 1024 * 1024

        /**
         * Wires the channel and returns the instance, because the Activity must
         * keep it: `ACTION_OPEN_DOCUMENT_TREE` answers through
         * `Activity.onActivityResult`, so `MainActivity` forwards the result to
         * the object registered here.
         */
        fun registerChannels(
            messenger: BinaryMessenger,
            activity: Activity,
            context: Context,
        ): NovaCallRecordingFolder {
            val folder = NovaCallRecordingFolder(activity, context.applicationContext)
            MethodChannel(messenger, METHOD_CHANNEL_NAME)
                .setMethodCallHandler(folder::onMethodCall)
            return folder
        }
    }

    private val resolver: ContentResolver get() = context.contentResolver

    /**
     * The provider's own MIME type for a directory, resolved once so the file
     * listing can skip nested folders rather than descending into them.
     */
    private val directoryMimeType: String
        get() = DocumentsContract.Document.MIME_TYPE_DIR

    private var pendingPick: MethodChannel.Result? = null

    // ─── Channel ─────────────────────────────────────────────────────────────

    private fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
                "status" -> result.success(status())
                "pickFolder" -> pickFolder(stringArg(call, "suggestedName"), result)
                "clearFolder" -> {
                    pendingPick = null
                    result.success(success())
                }
                "listFiles" -> result.success(
                    NovaCallRecordingFiles.list(
                        context,
                        stringArg(call, "treeUri"),
                        directoryMimeType,
                    ),
                )
                "readAudio" -> result.success(
                    NovaCallRecordingFiles.readAudio(
                        context,
                        stringArg(call, "uri"),
                        longArg(call, "maxBytes"),
                    ),
                )
                else -> result.notImplemented()
            }
        } catch (t: Throwable) {
            // A crash here would take the channel down with it. Any unexpected
            // failure is reported as a failure, never as a silent success.
            Log.w(TAG, "call-recording folder call ${call.method} failed", t)
            result.success(
                failure(
                    CODE_FAILED,
                    "Android refused ${call.method}: ${t.message ?: t::class.java.simpleName}",
                ),
            )
        }
    }

    // ─── Methods ─────────────────────────────────────────────────────────────

    /**
     * Always `supported: true` on Android.
     *
     * `ACTION_OPEN_DOCUMENT_TREE` exists on every Android this app ships to
     * (API 21+), so there is no capability to probe. Whether a folder has been
     * *granted* is a separate, persisted fact that Dart owns.
     */
    private fun status(): Map<String, Any?> = mapOf(
        "code" to CODE_SUPPORTED,
        "supported" to true,
        "message" to
            "NOVA can read a call-recording folder you choose. It never " +
            "records, listens to, or screens a call.",
    )

    /**
     * Opens the system folder picker and answers once the user has chosen or
     * dismissed it.
     *
     * The Dart future stays open until [onActivityResult] fires, which is what
     * makes "the user must pick the folder" unavoidable rather than defaulting
     * to a folder NOVA guessed.
     */
    private fun pickFolder(suggestedName: String?, result: MethodChannel.Result) {
        if (pendingPick != null) {
            result.success(
                failure(CODE_NEEDS_PICKER, "A folder picker is already open."),
            )
            return
        }

        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
            )
            // Re-opens on the folder the OEM dialer writes to (usually
            // `Recordings/Call` or `Music/Recordings`). Purely a convenience:
            // the user may pick anywhere, and NOVA reads only what they pick.
            if (!suggestedName.isNullOrBlank()) {
                putExtra(DocumentsContract.EXTRA_INITIAL_URI, Uri.parse(suggestedName))
            }
        }

        try {
            pendingPick = result
            activity.startActivityForResult(intent, PICK_FOLDER_REQUEST)
        } catch (t: Throwable) {
            pendingPick = null
            Log.w(TAG, "the folder picker could not be opened", t)
            result.success(
                failure(
                    CODE_UNSUPPORTED,
                    "This device has no system folder picker, so NOVA cannot be " +
                        "pointed at a call-recording folder. Nothing was read: " +
                        (t.message ?: t::class.java.simpleName),
                ),
            )
        }
    }

    /**
     * Receives the picker's outcome. Returns true when this class consumed it.
     *
     * `takePersistableUriPermission` is the whole point: without it the grant
     * dies with the process and the folder would have to be re-chosen after
     * every restart. It can legitimately fail (a provider that does not offer
     * persistable grants), and that is reported as `ok: false` with the reason —
     * never swallowed, because the user would otherwise believe the folder is
     * remembered when it is not.
     */
    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != PICK_FOLDER_REQUEST) return false
        val result = pendingPick
        pendingPick = null

        if (result == null) {
            // The engine was rebuilt while the picker was open; there is no
            // future left to answer. Nothing was read either way.
            Log.w(TAG, "folder picker returned with no pending call")
            return true
        }

        if (resultCode != Activity.RESULT_OK) {
            result.success(
                failure(
                    CODE_CANCELLED,
                    "No folder was chosen, so NOVA still has nothing to read.",
                ),
            )
            return true
        }

        val treeUri = data?.data
        if (treeUri == null) {
            result.success(
                failure(CODE_NO_FOLDER, "The picker returned no folder."),
            )
            return true
        }
        if (treeUri.scheme != ContentResolver.SCHEME_CONTENT) {
            result.success(
                failure(
                    CODE_NOT_A_FOLDER,
                    "That is not a folder NOVA can read ($treeUri).",
                ),
            )
            return true
        }

        val takeFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        try {
            resolver.takePersistableUriPermission(treeUri, takeFlags)
        } catch (t: SecurityException) {
            result.success(
                failure(
                    CODE_NEEDS_PICKER,
                    "Android did not let NOVA keep access to that folder, so it " +
                        "would have been forgotten on the next restart. Choose a " +
                        "folder from a provider that supports lasting access " +
                        "(the system Files app does).",
                ),
            )
            return true
        }

        result.success(
            mapOf(
                "code" to CODE_OK,
                "ok" to true,
                "supported" to true,
                "treeUri" to treeUri.toString(),
                "displayName" to NovaCallRecordingFiles.displayName(context, treeUri),
                "message" to
                    "Folder access granted. NOVA can read audio files in the " +
                    "folder you chose, and nothing outside it.",
            ),
        )
        return true
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    private fun stringArg(call: MethodCall, name: String): String? =
        call.argument<String>(name)

    private fun longArg(call: MethodCall, name: String): Long? =
        call.argument<Number>(name)?.toLong()

    private fun success(): Map<String, Any?> = mapOf("code" to CODE_OK, "ok" to true)

    private fun failure(code: String, message: String): Map<String, Any?> = mapOf(
        "code" to code,
        "ok" to false,
        "supported" to (code != CODE_UNSUPPORTED),
        "message" to message,
    )
}
