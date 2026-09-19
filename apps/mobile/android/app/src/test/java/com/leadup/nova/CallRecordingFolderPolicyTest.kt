package com.leadup.nova

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM tests for the decisions behind requirement 6c.
 *
 * `CallRecordingFolderPolicy` is deliberately free of Android dependencies, so
 * this runs on a plain JVM — no device, no emulator, no folder grant. It pins
 * the two things that would otherwise be silently wrong:
 *
 *  * a call-recording folder contains non-audio files, and NOVA must offer only
 *    audio — never a `.nomedia` marker, a database or a thumbnail;
 *  * a document provider may report `application/octet-stream`, in which case
 *    the container to declare to the server comes from the extension.
 *
 * Run with:
 *   ./gradlew :app:testDebugUnitTest
 */
class CallRecordingFolderPolicyTest {

    @Test
    fun `audio mime types are accepted`() {
        assertTrue(CallRecordingFolderPolicy.isAudioFile("Call_20260101.m4a", "audio/mp4"))
        assertTrue(CallRecordingFolderPolicy.isAudioFile("call.mp3", "audio/mpeg"))
        // Any `audio/*` subtype is accepted without being enumerated.
        assertTrue(CallRecordingFolderPolicy.isAudioFile("call.x", "audio/amr-wb"))
    }

    @Test
    fun `a vague provider type falls back to the extension`() {
        assertTrue(
            CallRecordingFolderPolicy.isAudioFile("Call_20260101.m4a", "application/octet-stream"),
        )
        assertTrue(CallRecordingFolderPolicy.isAudioFile("call.wav", null))
        assertTrue(CallRecordingFolderPolicy.isAudioFile("call.opus", "*/*"))
    }

    @Test
    fun `non-audio files in the same folder are refused`() {
        assertFalse(CallRecordingFolderPolicy.isAudioFile(".nomedia", null))
        assertFalse(CallRecordingFolderPolicy.isAudioFile("calls.db", "application/x-sqlite3"))
        assertFalse(CallRecordingFolderPolicy.isAudioFile("thumb.jpg", "image/jpeg"))
        assertFalse(CallRecordingFolderPolicy.isAudioFile("notes.pdf", "application/pdf"))
        assertFalse(CallRecordingFolderPolicy.isAudioFile("README", "text/plain"))
    }

    @Test
    fun `a definite non-audio type is never overridden by an audio extension`() {
        // A `.m4a`-named file the provider classified as video is not an audio
        // recording to import.
        assertFalse(CallRecordingFolderPolicy.isAudioFile("clip.m4a", "video/mp4"))
    }

    @Test
    fun `the upload type is a real audio container`() {
        assertEquals(
            "audio/mp4",
            CallRecordingFolderPolicy.uploadMimeType("Call_20260101.m4a", "application/octet-stream"),
        )
        assertEquals(
            "audio/mpeg",
            CallRecordingFolderPolicy.uploadMimeType("call.mp3", null),
        )
        assertEquals(
            "audio/wav",
            CallRecordingFolderPolicy.uploadMimeType("call.WAV", "application/octet-stream"),
        )
        assertEquals(
            "audio/amr-wb",
            CallRecordingFolderPolicy.uploadMimeType("call.awb", null),
        )
        // A definite audio type is passed through untouched.
        assertEquals(
            "audio/ogg",
            CallRecordingFolderPolicy.uploadMimeType("call.ogg", "audio/ogg"),
        )
        // Nothing conclusive: an honest audio container, not `application/octet-stream`.
        assertEquals(
            CallRecordingFolderPolicy.FALLBACK_MIME_TYPE,
            CallRecordingFolderPolicy.uploadMimeType("recording", null),
        )
    }

    @Test
    fun `the title is the file name without its extension`() {
        assertEquals(
            "Call_20260101_143000",
            CallRecordingFolderPolicy.titleFor("Call_20260101_143000.m4a"),
        )
        assertEquals("recording", CallRecordingFolderPolicy.titleFor("recording"))
        assertEquals(
            "two.dots",
            CallRecordingFolderPolicy.titleFor("two.dots.mp3"),
        )
    }

    @Test
    fun `a title never carries a path or a control character`() {
        // Path separators and control characters are dropped, not rendered.
        assertEquals("etcpasswd", CallRecordingFolderPolicy.titleFor("/etc/passwd"))
        assertEquals("abcnested", CallRecordingFolderPolicy.titleFor("a/b\\c\u0000nested.m4a"))
        // A whitespace-only name has nothing left in it.
        assertEquals(CallRecordingFolderPolicy.FALLBACK_TITLE, CallRecordingFolderPolicy.titleFor("   "))
    }

    @Test
    fun `a leading dot is part of the name, not an extension`() {
        // `substringBeforeLast` would turn this into an empty string; a dotfile
        // has no extension to strip, so the name is kept as it stands.
        assertEquals(".m4a", CallRecordingFolderPolicy.titleFor(".m4a"))
    }
}
