package com.leadup.nova

import android.content.ContentResolver
import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Log
import java.io.FileInputStream

/**
 * The file half of requirement 6c: listing the audio in one granted folder and
 * returning the bytes of one file.
 *
 * Split from `NovaCallRecordingFolder.kt` so each file stays readable. This class
 * never records, listens to, or screens a call, and it never walks a directory
 * tree: it queries exactly the tree URI the user granted and reads exactly the
 * file URI the user selected. The decisions about *what counts as audio* live in
 * [CallRecordingFolderPolicy], which is Android-free and unit-tested on a JVM.
 */
object NovaCallRecordingFiles {

    private const val TAG = "NovaCallRecFiles"

    /**
     * The audio files directly inside the granted tree.
     *
     * Non-audio documents are dropped by [CallRecordingFolderPolicy], not by the
     * query, because document providers are inconsistent about selecting every
     * audio type. The answer is always `{code, ok, files}`; an unreadable tree is
     * `ok: false`, which is how the screen tells the user the grant is gone.
     */
    fun list(
        context: Context,
        treeUri: String?,
        directoryMimeType: String,
    ): Map<String, Any?> {
        val resolver = context.contentResolver
        if (treeUri.isNullOrBlank()) {
            return failure(
                NovaCallRecordingFolder.CODE_NO_FOLDER,
                "No folder has been chosen yet.",
            )
        }
        val tree = Uri.parse(treeUri)
        val parentId = try {
            DocumentsContract.getTreeDocumentId(tree)
        } catch (t: Throwable) {
            Log.w(TAG, "not a document tree: $tree", t)
            return failure(
                NovaCallRecordingFolder.CODE_NOT_A_FOLDER,
                "That is not a folder NOVA can read.",
            )
        }
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId)

        val files = mutableListOf<Map<String, Any?>>()
        try {
            resolver.query(
                childrenUri,
                arrayOf(
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                    DocumentsContract.Document.COLUMN_SIZE,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED,
                ),
                null,
                null,
                null,
            )?.use { cursor -> collect(context, cursor, tree, directoryMimeType, files) }
        } catch (t: SecurityException) {
            Log.w(TAG, "the folder grant is no longer usable: $tree", t)
            return failure(
                NovaCallRecordingFolder.CODE_UNREADABLE,
                "Android no longer lets NOVA read that folder. Choose it again to " +
                    "restore access. Nothing was read and nothing was uploaded.",
            )
        } catch (t: Throwable) {
            Log.w(TAG, "listing $tree failed", t)
            return failure(
                NovaCallRecordingFolder.CODE_UNREADABLE,
                "That folder could not be read: ${t.message ?: t::class.java.simpleName}. " +
                    "Nothing was read and nothing was uploaded.",
            )
        }

        files.sortWith(
            compareByDescending<Map<String, Any?>> { it["modifiedMs"] as? Long ?: 0L }
                .thenBy { it["name"] as? String ?: "" },
        )
        return mapOf(
            "code" to NovaCallRecordingFolder.CODE_OK,
            "ok" to true,
            "treeUri" to tree.toString(),
            "files" to files,
        )
    }

    private fun collect(
        context: Context,
        cursor: android.database.Cursor,
        tree: Uri,
        directoryMimeType: String,
        into: MutableList<Map<String, Any?>>,
    ) {
        val idIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
        val nameIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
        val mimeIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
        val sizeIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE)
        val modifiedIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
        if (idIndex < 0 || nameIndex < 0) return

        while (cursor.moveToNext()) {
            val documentId = cursor.getString(idIndex) ?: continue
            val name = cursor.getString(nameIndex) ?: continue
            val mimeType = if (mimeIndex >= 0) cursor.getString(mimeIndex) else null

            // A nested folder is not a recording. NOVA does not walk the tree:
            // the user picks the folder the dialer writes to, and a recursive
            // scan would read more than they pointed at.
            if (mimeType == directoryMimeType) continue
            if (!CallRecordingFolderPolicy.isAudioFile(name, mimeType)) continue

            val fileUri = DocumentsContract.buildDocumentUriUsingTree(tree, documentId)
            val size = if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
                cursor.getLong(sizeIndex)
            } else {
                -1L
            }
            into.add(
                mapOf(
                    "uri" to fileUri.toString(),
                    "documentId" to documentId,
                    "name" to name,
                    "mimeType" to CallRecordingFolderPolicy.uploadMimeType(name, mimeType),
                    "sizeBytes" to size,
                    "modifiedMs" to if (modifiedIndex >= 0 && !cursor.isNull(modifiedIndex)) {
                        cursor.getLong(modifiedIndex)
                    } else {
                        null
                    },
                    // Duration is read from the file's own metadata and is left
                    // null when the container does not carry it. NOVA never
                    // invents a length for a recording it has not read.
                    "durationMs" to durationMs(context, fileUri),
                ),
            )
        }
    }

    /**
     * The bytes of one file, for upload.
     *
     * `maxBytes` lets Dart apply the server's own ceiling (from
     * `GET /recordings/capabilities`) to a local file before anything is read,
     * and [NovaCallRecordingFolder.MAX_READABLE_BYTES] is the backstop when that
     * ceiling is unknown. A refused file is `ok: false` with `too_large` — the
     * screen says the file was not read rather than reporting a truncated upload.
     */
    fun readAudio(
        context: Context,
        uri: String?,
        maxBytes: Long?,
    ): Map<String, Any?> {
        val resolver = context.contentResolver
        if (uri.isNullOrBlank()) {
            return failure(
                NovaCallRecordingFolder.CODE_INVALID_ARGUMENT,
                "No file was named.",
            )
        }
        val documentUri = Uri.parse(uri)
        val ceiling = when {
            maxBytes != null && maxBytes > 0 ->
                minOf(maxBytes, NovaCallRecordingFolder.MAX_READABLE_BYTES)
            else -> NovaCallRecordingFolder.MAX_READABLE_BYTES
        }

        val size = sizeOf(resolver, documentUri)
        if (size > ceiling) {
            return failure(
                NovaCallRecordingFolder.CODE_TOO_LARGE,
                "That file is $size bytes, above the $ceiling-byte limit for one " +
                    "upload. It was not read and was not sent.",
            )
        }

        val bytes = try {
            val descriptor = resolver.openFileDescriptor(documentUri, "r")
            if (descriptor == null) {
                return failure(
                    NovaCallRecordingFolder.CODE_UNREADABLE,
                    "That file could not be opened for reading.",
                )
            }
            // The descriptor stays open for the whole read: `ParcelFileDescriptor`
            // hands out a raw fd owned by the descriptor, so reading through a
            // fresh InputStream built from it (rather than the provider's own
            // stream) avoids depending on that stream being seekable, and `use`
            // closes the descriptor only after the bytes are in hand.
            descriptor.use { open ->
                FileInputStream(open.fileDescriptor).use { it.readBytes() }
            }
        } catch (t: SecurityException) {
            Log.w(TAG, "the file grant is no longer usable: $documentUri", t)
            return failure(
                NovaCallRecordingFolder.CODE_UNREADABLE,
                "Android no longer lets NOVA read that file. Choose the folder " +
                    "again to restore access.",
            )
        } catch (t: Throwable) {
            Log.w(TAG, "reading $documentUri failed", t)
            return failure(
                NovaCallRecordingFolder.CODE_UNREADABLE,
                "That file could not be read: ${t.message ?: t::class.java.simpleName}",
            )
        }

        if (bytes.isEmpty()) {
            return failure(
                NovaCallRecordingFolder.CODE_EMPTY,
                "That file is empty, so there is nothing to transcribe. It was " +
                    "not uploaded.",
            )
        }
        return mapOf(
            "code" to NovaCallRecordingFolder.CODE_OK,
            "ok" to true,
            "uri" to documentUri.toString(),
            "sizeBytes" to bytes.size.toLong(),
            "bytes" to bytes,
        )
    }

    /**
     * The folder's own name, for the settings screen. Never throws: a provider
     * that will not answer simply leaves the last path segment as the name.
     */
    fun displayName(context: Context, treeUri: Uri): String {
        val resolver = context.contentResolver
        try {
            resolver.query(
                treeUri,
                arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
                null,
                null,
                null,
            )?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val index = cursor.getColumnIndex(
                        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    )
                    if (index >= 0) {
                        val name = cursor.getString(index)
                        if (!name.isNullOrBlank()) return name
                    }
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "could not read the folder name for $treeUri", t)
        }
        return treeUri.lastPathSegment ?: treeUri.toString()
    }

    /** The size the provider reports, or the descriptor's stat size, or -1. */
    private fun sizeOf(resolver: ContentResolver, documentUri: Uri): Long {
        try {
            resolver.query(
                documentUri,
                arrayOf(DocumentsContract.Document.COLUMN_SIZE),
                null,
                null,
                null,
            )?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val index = cursor.getColumnIndex(
                        DocumentsContract.Document.COLUMN_SIZE,
                    )
                    if (index >= 0 && !cursor.isNull(index)) return cursor.getLong(index)
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "could not read the size of $documentUri", t)
        }
        try {
            val descriptor = resolver.openFileDescriptor(documentUri, "r")
            descriptor?.use { return it.statSize }
        } catch (t: Throwable) {
            Log.w(TAG, "could not stat $documentUri", t)
        }
        return -1L
    }

    /**
     * The recording's length in milliseconds, when the file carries it.
     *
     * Null is a real answer — the screen renders "duration not available" and
     * omits the hint from the upload rather than showing a length NOVA did not
     * read.
     */
    private fun durationMs(context: Context, uri: Uri): Long? {
        val retriever = MediaMetadataRetriever()
        return try {
            retriever.setDataSource(context, uri)
            retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                ?.toLongOrNull()
                ?.takeIf { it > 0 }
        } catch (t: Throwable) {
            null
        } finally {
            try {
                retriever.release()
            } catch (t: Throwable) {
                Log.w(TAG, "releasing the metadata reader failed", t)
            }
        }
    }

    private fun failure(code: String, message: String): Map<String, Any?> = mapOf(
        "code" to code,
        "ok" to false,
        "supported" to (code != NovaCallRecordingFolder.CODE_UNSUPPORTED),
        "message" to message,
    )
}
