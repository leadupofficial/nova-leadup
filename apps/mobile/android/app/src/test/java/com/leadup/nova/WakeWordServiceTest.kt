package com.leadup.nova

import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the three wake-word service rules that live outside the engine, each of which
 * failed silently on a device and could not be seen by the compiler.
 *
 * ## What this guards
 *
 *  * **A cancelled capture scope must never be reused.** `shutdown()` cancels the scope
 *    and is reached on paths that leave the service alive to serve another `start()` (a
 *    failed engine start). `CoroutineScope.launch` on a cancelled scope returns a
 *    cancelled job and never runs the block, so the second start opened the microphone,
 *    reported "Listening now" and could never detect anything again. `WakeWordScopeOwner`
 *    makes a live scope a precondition of listening.
 *  * **A background detection must be observable.** Detection used to be delivered only
 *    over the event channel, which reaches Dart; Dart does not open a conversation while
 *    backgrounded, so saying the wake word with the app backgrounded did nothing at all.
 *    `shouldPostDetectionNotification` is the pacing rule for the notification that now
 *    makes it real.
 *  * **The availability gate must name what the engine opens.** It used to require two
 *    openWakeWord front-end files the sherpa-onnx engine never opens, so a build that
 *    could listen reported itself unavailable and Dart persisted the toggle off.
 *  * **The persistent notification must name the phrase, not the asset key.** It
 *    interpolated the raw `models.json` key, so the shade read `Listening for
 *    "hey_nova"` for as long as the service was alive while every other surface said
 *    "Hey Nova". `wakeWordListeningNotificationText` and `humanizeWakeWordName` are the
 *    pure functions the notification is now built from.
 *
 * `humanizeWakeWordName` also exists in Dart (`lib/core/voice/wake_word_service.dart`)
 * and the two are pinned to the same table, [SHARED_HUMANISER_TABLE], so a change to
 * one is caught on the other side. They diverged once already: Java's `\s` is
 * ASCII-only, so a non-breaking space separated words on the Dart side and not here.
 *
 * Everything asserted here is a pure function or a plain coroutine type, so it runs as a
 * JVM test with `./gradlew :app:testDebugUnitTest` and needs no device.
 */
class WakeWordServiceTest {

    // ─── D2: the capture scope after a non-stopSelf shutdown ──────────────────────

    @Test
    fun aLiveScopeIsReusedRatherThanLeaked() {
        val scope = WakeWordScopeOwner()

        assertTrue("a fresh owner must start with a live scope", scope.isActive)
        assertSame(
            "a redundant start must reuse the live scope, not create another one",
            scope.live(),
            scope.live(),
        )
    }

    @Test
    fun aCancelledScopeIsRecreatedSoASecondStartCanCapture() {
        val scope = WakeWordScopeOwner()

        val firstRun = scope.live()
        scope.cancel()
        assertFalse("cancel() must actually cancel the scope", scope.isActive)

        val secondRun = scope.live()
        assertNotSame(
            "the scope a shutdown cancelled must never be handed out again",
            firstRun,
            secondRun,
        )
        assertTrue("the second start must be given a live scope", scope.isActive)
    }

    @Test
    fun captureLaunchedOnARecreatedScopeActuallyRuns() = runBlocking {
        val scope = WakeWordScopeOwner()
        scope.cancel()

        // The engine's read loop is exactly this: `scope.launch { ... }`. On the
        // cancelled scope the block never ran, which is why the service could report
        // "Listening now" while detecting nothing for ever.
        var captured = false
        scope.live().launch { captured = true }.join()

        assertTrue("a cancelled scope swallows launch() without running the block", captured)
    }

    // ─── D3: a detection the user can actually observe ────────────────────────────

    @Test
    fun aDetectionWhileForegroundedIsHandledInAppInstead() {
        assertFalse(
            shouldPostDetectionNotification(
                appInForeground = true,
                nowMs = 10_000,
                lastNotificationAtMs = 0,
                cooldownMs = 2_000,
            ),
        )
    }

    @Test
    fun aFirstDetectionWhileBackgroundedNotifies() {
        assertTrue(
            shouldPostDetectionNotification(
                appInForeground = false,
                nowMs = 10_000,
                lastNotificationAtMs = 0,
                cooldownMs = 2_000,
            ),
        )
    }

    @Test
    fun aSecondDetectionInsideTheCooldownDoesNotNotify() {
        assertFalse(
            "a notification is a user-visible interruption; one per cooldown is the cap",
            shouldPostDetectionNotification(
                appInForeground = false,
                nowMs = 11_999,
                lastNotificationAtMs = 10_000,
                cooldownMs = 2_000,
            ),
        )
    }

    @Test
    fun aDetectionAfterTheCooldownNotifiesAgain() {
        assertTrue(
            shouldPostDetectionNotification(
                appInForeground = false,
                nowMs = 12_000,
                lastNotificationAtMs = 10_000,
                cooldownMs = 2_000,
            ),
        )
    }

    @Test
    fun theNotificationNamesTheWakeWordTheWayTheAppDoes() {
        // `models.json` names the phrase `hey_nova`; the raw identifier is an asset key,
        // not something to put in front of a user.
        assertEquals("Hey Nova", humanizeWakeWordName("hey_nova"))
        assertEquals("Hey Nova", humanizeWakeWordName("Hey-Nova"))
        assertEquals("Hey Nova", humanizeWakeWordName("hey nova"))
        assertEquals("Alexa", humanizeWakeWordName("alexa"))
    }

    // ─── D5: the persistent notification must name the phrase ─────────────────────

    @Test
    fun theListeningNotificationNamesTheWakeWordTheWayTheAppDoes() {
        // The raw key is an asset name. Every other surface — the home screen, the
        // settings screen, the overlay and the detection notification — says "Hey Nova".
        val plan = planWakeWordListening(listOf(wakeWord("hey_nova")), "hey_nova")
        assertEquals("Listening for \"Hey Nova\"", plan.notificationText)
    }

    @Test
    fun theListeningNotificationShowsNoAssetKeyAtAll() {
        val text = planWakeWordListening(listOf(wakeWord("hey_nova")), "hey_nova").notificationText
        assertFalse("the raw manifest key leaked into the notification: $text", text.contains("_"))
        assertFalse("the raw manifest key leaked into the notification: $text", text.contains("hey_nova"))
    }

    @Test
    fun severalModelsKeepTheCommaSpaceJoin() {
        val plan =
            planWakeWordListening(
                listOf(wakeWord("hey_nova"), wakeWord("hey_jarvis")),
                selected = null,
            )
        assertEquals("Listening for \"Hey Nova, Hey Jarvis\"", plan.notificationText)
    }

    @Test
    fun everyModelInTheListIsHumanisedNotJustTheFirst() {
        // Joining the raw keys and humanising the result gives `Hey_nova, Hey_jarvis`,
        // and humanising only the first leaves `Hey Nova, hey_jarvis`; both are the bug
        // wearing a different hat.
        val plan =
            planWakeWordListening(
                listOf(wakeWord("hey_nova"), wakeWord("hey_jarvis"), wakeWord("alexa")),
                selected = null,
            )
        assertEquals("Listening for \"Hey Nova, Hey Jarvis, Alexa\"", plan.notificationText)
        assertFalse("an asset key survived in: ${plan.notificationText}", plan.notificationText.contains("_"))
    }

    @Test
    fun thePlanKeepsTheRawNamesTheEngineAndDartNeed() {
        // Humanising is display-only: the engine loads assets by the raw name, and Dart
        // resolves the phrase from the `models` list it is sent.
        val selected =
            planWakeWordListening(
                listOf(wakeWord("hey_nova"), wakeWord("hey_jarvis")),
                selected = "hey_jarvis",
            )
        assertEquals(listOf("hey_jarvis"), selected.models.map { it.name })
        assertEquals("Listening for \"Hey Jarvis\"", selected.notificationText)

        // A stale stored choice must not silence the service: it falls back to every
        // installed model, and the notification names all of them.
        val stale = planWakeWordListening(listOf(wakeWord("hey_nova")), selected = "hey_jarvis")
        assertEquals(listOf("hey_nova"), stale.models.map { it.name })
        assertEquals("Listening for \"Hey Nova\"", stale.notificationText)
    }

    @Test
    fun theTwoHumanisersAgreeOnTheSharedTable() {
        // The Dart twin of this table is in
        // `test/core/voice/wake_word_name_test.dart`. Rows and order must match.
        for (row in SHARED_HUMANISER_TABLE) {
            assertEquals(
                "shared table row '${row.label}' (raw code units ${row.raw.map { it.code }})",
                row.expected,
                humanizeWakeWordName(row.raw),
            )
        }
    }

    private fun wakeWord(name: String) =
        WakeWordModel(name = name, asset = "wakeword/kws/keywords.txt", threshold = 0.25f)

    // ─── D4: the availability gate must match the shipped engine ─────────────────

    @Test
    fun theAvailabilityGateNamesExactlyTheAssetsTheEngineOpens() {
        // These are the paths `SherpaWakeWordEngine.start()` builds from `MODEL_DIR`.
        // Pinned literally so a change to either side fails here rather than on a phone
        // that reports "no wake word installed" for a complete build.
        assertEquals(
            listOf(
                "wakeword/kws/encoder.int8.onnx",
                "wakeword/kws/decoder.int8.onnx",
                "wakeword/kws/joiner.int8.onnx",
                "wakeword/kws/tokens.txt",
                "wakeword/kws/bpe.model",
            ),
            REQUIRED_KWS_ASSETS,
        )
    }

    @Test
    fun theOpenWakeWordFrontEndIsNoLongerRequired() {
        val openWakeWordOnly = listOf(
            "melspectrogram.onnx",
            "embedding_model.onnx",
            "wakeword/hey_jarvis_v0.1.onnx",
        )
        for (asset in openWakeWordOnly) {
            assertFalse(
                "'$asset' is not opened by SherpaWakeWordEngine and must not gate availability",
                REQUIRED_KWS_ASSETS.contains(asset),
            )
        }
    }

    @Test
    fun aMissingAssetIsReportedByPathAndACompleteBuildReportsNothing() {
        val present = REQUIRED_KWS_ASSETS.toSet() - "wakeword/kws/bpe.model"
        assertEquals(
            listOf("wakeword/kws/bpe.model"),
            missingKwsAssets { it in present },
        )

        assertTrue(
            "a build with every KWS asset present must gate nothing",
            missingKwsAssets { it in REQUIRED_KWS_ASSETS }.isEmpty(),
        )
    }
}

/**
 * The contract shared by this file's `humanizeWakeWordName` and its Dart twin in
 * `lib/core/voice/wake_word_service.dart`. Keep the rows, their labels and their order
 * identical to `_sharedTable` in `apps/mobile/test/core/voice/wake_word_name_test.dart`;
 * a change to one humaniser that this table does not describe is a change the other
 * side will not notice.
 *
 * A code point that is not a separator keeps the raw character inside the token, so
 * only the token's first character is upper-cased. The last two rows pin that: neither
 * a zero-width space (U+200B) nor NEL (U+0085) splits a name.
 *
 * One divergence is deliberately not represented here because it cannot be reconciled
 * without shipping a case table: Java's first-character upper-casing follows a newer
 * Unicode version than Dart's. The two agree on every ASCII, Latin-1 and
 * Greek/Cyrillic letter and differ on 199 BMP code points added in later Unicode
 * versions (Georgian Mtavruli U+10D0-U+10FF, Abkhaz U+AB70-U+ABBF, Cherokee small
 * U+13F8-U+13FD and a scattering of extended Latin/Cyrillic letters). None of them can
 * appear in a wake word asset key.
 */
private data class HumaniserRow(val label: String, val raw: String, val expected: String)

private val SHARED_HUMANISER_TABLE = listOf(
    HumaniserRow("the shipped asset key", "hey_nova", "Hey Nova"),
    HumaniserRow("separators already spaced", "hey nova", "Hey Nova"),
    HumaniserRow("hyphen with a capitalised word", "Hey-Nova", "Hey Nova"),
    HumaniserRow("a run of separators collapses", "hey__nova", "Hey Nova"),
    HumaniserRow("leading and trailing separators are dropped", "_hey_nova_", "Hey Nova"),
    HumaniserRow("a mixed separator run collapses", "hey- nova", "Hey Nova"),
    HumaniserRow("surrounding spaces are dropped", "  hey_nova  ", "Hey Nova"),
    HumaniserRow("already upper case is preserved", "HEY_NOVA", "HEY NOVA"),
    HumaniserRow("mixed case", "Hey_Nova", "Hey Nova"),
    HumaniserRow("a single word", "alexa", "Alexa"),
    HumaniserRow("a second typical key", "hey_jarvis", "Hey Jarvis"),
    HumaniserRow("a trailing digit", "nova_2", "Nova 2"),
    HumaniserRow("a digit inside a word is not a separator", "hey2nova", "Hey2nova"),
    HumaniserRow("a leading digit has no upper case", "2hey_nova", "2hey Nova"),
    HumaniserRow("a single character", "h", "H"),
    HumaniserRow("the empty string", "", ""),
    HumaniserRow("separators only", "___", ""),
    HumaniserRow("a tab", "hey\tnova", "Hey Nova"),
    HumaniserRow("a newline", "hey\nnova", "Hey Nova"),
    HumaniserRow("a non-breaking space is a separator in both", "hey\u00a0nova", "Hey Nova"),
    HumaniserRow("an ideographic space is a separator in both", "hey\u3000nova", "Hey Nova"),
    HumaniserRow("an em space is a separator in both", "hey\u2003nova", "Hey Nova"),
    HumaniserRow("a line separator is a separator in both", "hey\u2028nova", "Hey Nova"),
    HumaniserRow("a narrow no-break space is a separator in both", "hey\u202fnova", "Hey Nova"),
    HumaniserRow("a zero-width no-break space is a separator in both", "hey\ufeffnova", "Hey Nova"),
    HumaniserRow("a repeated non-breaking space collapses", "wake\u00a0\u00a0word", "Wake Word"),
    HumaniserRow("a zero-width space is not a separator", "hey\u200bnova", "Hey\u200bnova"),
    HumaniserRow("NEL is not a separator", "hey\u0085nova", "Hey\u0085nova"),
)
