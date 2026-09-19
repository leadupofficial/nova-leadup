package com.leadup.nova

/**
 * The decisions behind requirement 6c — *call screening and communication
 * assistance* — with every Android dependency removed so a plain JVM test can
 * pin them (`CallRecordingFolderPolicyTest`).
 *
 * ## What this feature is, and what it deliberately is not
 *
 * NOVA does **not** screen calls, does **not** listen to a call, and does
 * **not** read the call log. Since Android 10 the `VOICE_CALL` audio source is
 * closed to third-party apps, `READ_CALL_LOG` is restricted on Google Play to
 * default dialers, and recording a call is unlawful in two-party-consent
 * jurisdictions. None of that is attempted anywhere in this app.
 *
 * What happens instead is the owner's own proposal: many OEM dialers (Vivo,
 * Xiaomi, Samsung) already record calls and write them to a folder on the
 * device, having handled consent and the recording announcement themselves. The
 * user points NOVA at that folder through the Storage Access Framework, and NOVA
 * transcribes and summarises recordings **the user already owns**.
 *
 * Consequences this file encodes:
 *
 *  * nothing is discovered until the user has granted a folder;
 *  * only audio is ever offered — a call-recording folder can contain a
 *    `.nomedia` marker, a database, thumbnails or anything else;
 *  * the file name is all NOVA knows about a call. There is no caller identity
 *    to attach, so the title is the file name and nothing else is invented.
 */
object CallRecordingFolderPolicy {

    /**
     * The container types that are audio but are not reported under any audio subtype.
     *
     * Any audio subtype is matched by prefix, so a provider that reports
     * `audio/amr-wb` is accepted without this set having to enumerate it.
     */
    private val EXACT_AUDIO_TYPES = setOf(
        "application/ogg",
        "application/x-ogg",
    )

    /**
     * Extensions accepted when the provider reports no usable MIME type.
     *
     * `application/octet-stream` and the any-type wildcard are what a generic
     * document provider returns for a file it does not classify; in an OEM
     * call-recording folder the extension is the reliable signal.
     */
    private val AUDIO_EXTENSIONS = setOf(
        "aac", "amr", "awb", "flac", "m4a", "m4b", "mp3", "mp4", "oga",
        "ogg", "opus", "wav", "3gp", "3gpp", "caf", "gsm", "qcp",
    )

    /** The container type to declare when an upload's MIME type is unknown. */
    const val FALLBACK_MIME_TYPE = "audio/mp4"

    /**
     * The "any type" MIME wildcard, spelled without the comment terminator so a
     * KDoc block containing it stays a comment.
     */
    private const val ANY_MIME_TYPE = "*" + "/" + "*"

    /** The title used when a file name has nothing usable left in it. */
    const val FALLBACK_TITLE = "Call recording"

    /**
     * Whether [name] with the provider-reported [mimeType] should be offered to
     * the user as something NOVA could transcribe.
     *
     * A file is audio when the provider says so, or — only when the provider has
     * no opinion — when the extension is one of the containers dialers write.
     * A definite non-audio type (`image/jpeg`, `application/pdf`) is never
     * overridden by an extension.
     */
    fun isAudioFile(name: String, mimeType: String?): Boolean {
        val type = mimeType?.trim()?.lowercase().orEmpty()
        if (type.startsWith("audio/")) return true
        val providerHasNoOpinion = type.isEmpty() ||
            type == ANY_MIME_TYPE ||
            type == "application/octet-stream"
        if (providerHasNoOpinion) {
            return extensionOf(name) in AUDIO_EXTENSIONS
        }
        return type in EXACT_AUDIO_TYPES
    }

    /**
     * The MIME type to send with the upload.
     *
     * The server validates the container against its own allow-list, so a
     * provider's vague `application/octet-stream` is translated from the
     * extension where possible. When neither the provider nor the extension is
     * conclusive the answer is [FALLBACK_MIME_TYPE] — a real audio container
     * rather than a lie the server would reject for the wrong reason.
     */
    fun uploadMimeType(name: String, mimeType: String?): String {
        val type = mimeType?.trim()?.lowercase().orEmpty()
        if (type.startsWith("audio/")) return type
        if (type in EXACT_AUDIO_TYPES) return type
        return when (extensionOf(name)) {
            "aac" -> "audio/aac"
            "amr" -> "audio/amr"
            "awb" -> "audio/amr-wb"
            "flac" -> "audio/flac"
            "m4a", "m4b", "mp4" -> "audio/mp4"
            "mp3" -> "audio/mpeg"
            "oga", "ogg", "opus" -> "audio/ogg"
            "wav" -> "audio/wav"
            "3gp", "3gpp" -> "audio/3gpp"
            else -> FALLBACK_MIME_TYPE
        }
    }

    /**
     * The recording title for a file: its name without the extension.
     *
     * The **last** dot splits the name, so `call.2026.01.01.m4a` keeps its date.
     * A name with no dot, or whose only dot is the first character, has no
     * extension to strip and is used as it stands. Control characters and path
     * separators are stripped because the title is sent to the server and
     * rendered in the summary screen. Nothing else is added — NOVA has no caller
     * identity for a file it merely reads.
     */
    fun titleFor(name: String): String {
        val dot = name.lastIndexOf('.')
        val withoutExtension = if (dot > 0) name.substring(0, dot) else name
        val cleaned = withoutExtension
            .filter { !it.isISOControl() && it != '/' && it != '\\' }
            .trim()
        return cleaned.ifEmpty { FALLBACK_TITLE }
    }

    /** The lowercase extension of [name], or an empty string when there is none. */
    fun extensionOf(name: String): String {
        val dot = name.lastIndexOf('.')
        if (dot < 0 || dot == name.length - 1) return ""
        return name.substring(dot + 1).lowercase()
    }
}
