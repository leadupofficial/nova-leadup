package com.leadup.nova

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * JVM unit tests for which wake word the service listens for.
 *
 * `WakeWordModelSelection` is deliberately free of Android dependencies, so this
 * runs on a plain JVM — no device, no emulator, no microphone. It pins the
 * fallback rules that keep a stale stored choice from silencing the service and
 * keep an empty installation from inventing a phrase.
 *
 * Run with:
 *   ./gradlew :app:testDebugUnitTest
 */
class WakeWordModelSelectionTest {

    @Test
    fun `no installed classifier resolves to nothing`() {
        assertNull(WakeWordModelSelection.resolve(null, emptyList()))
        assertNull(WakeWordModelSelection.resolve("hey_jarvis", emptyList()))
    }

    @Test
    fun `a single installed classifier is always the one selected`() {
        // The single-entry case, which is the shape of any build with one installed
        // wake word. No stored choice, a stale one, or a blank one all resolve to
        // it — the service never listens for a phrase whose asset is absent.
        assertEquals("hey_jarvis", WakeWordModelSelection.resolve(null, listOf("hey_jarvis")))
        assertEquals("hey_jarvis", WakeWordModelSelection.resolve("hey_nova", listOf("hey_jarvis")))
        assertEquals("hey_jarvis", WakeWordModelSelection.resolve("", listOf("hey_jarvis")))
    }

    @Test
    fun `a stored choice wins when it is installed`() {
        assertEquals(
            "hey_mycroft",
            WakeWordModelSelection.resolve("hey_mycroft", listOf("hey_jarvis", "hey_mycroft")),
        )
    }

    @Test
    fun `an uninstalled choice falls back to the first classifier`() {
        assertEquals(
            "hey_jarvis",
            WakeWordModelSelection.resolve("hey_nova", listOf("hey_jarvis", "hey_mycroft")),
        )
    }
}
