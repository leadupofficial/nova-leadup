package com.leadup.nova

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the wake-word engine's response to a failed `AudioRecord.read`.
 *
 * ## What this guards
 *
 * The capture loop originally did `if (read <= 0) continue` with no delay.
 * `AudioRecord.read` returns `0` or a negative error code
 * (`ERROR_INVALID_OPERATION`, `ERROR_BAD_VALUE`, `ERROR_DEAD_OBJECT`) *immediately*, so that
 * line became a busy-spin: a full core at 96-121% CPU, the UI starved, for as long as the
 * condition held — and 0% the moment the engine was stopped, which is how it was found. A
 * Kotlin compiler cannot see this, and no existing test ran the engine, so it only ever
 * showed on the device.
 *
 * The response is now a pure function, `SherpaWakeWordEngine.decideRead`, so the two
 * invariants that prevent the spin are testable here:
 *
 *   * a failed read **must** back off rather than retry immediately;
 *   * a run of failures **must** terminate rather than retry for ever.
 */
class SherpaWakeWordEngineTest {

    @Test
    fun aPositiveReadProceedsImmediately() {
        val decision = decideRead(read = 1600, consecutiveFailures = 0)
        assertEquals(ReadDecision.Proceed, decision)
    }

    @Test
    fun aFailedReadBacksOffInsteadOfSpinning() {
        val decision = decideRead(read = 0, consecutiveFailures = 0)
        assertTrue(
            "a failed read must return a Retry with a positive back-off, got $decision",
            decision is ReadDecision.Retry &&
                (decision as ReadDecision.Retry).backoffMs > 0,
        )
    }

    @Test
    fun aNegativeErrorCodeAlsoBacksOff() {
        // ERROR_DEAD_OBJECT = -32, ERROR_INVALID_OPERATION = -38, ERROR_BAD_VALUE = -2.
        val decision = decideRead(read = -32, consecutiveFailures = 0)
        assertTrue(decision is ReadDecision.Retry)
    }

    @Test
    fun enoughConsecutiveFailuresGiveUp() {
        // One short of the cap still retries; at the cap it stops. This is what turns an
        // unbounded spin into a bounded one.
        val justUnder = decideRead(
            read = 0,
            consecutiveFailures = SherpaWakeWordEngine.MAX_READ_FAILURES - 2,
        )
        assertTrue(justUnder is ReadDecision.Retry)

        val atCap = decideRead(
            read = 0,
            consecutiveFailures = SherpaWakeWordEngine.MAX_READ_FAILURES - 1,
        )
        assertEquals(ReadDecision.GiveUp, atCap)
    }

    @Test
    fun aRecoveryAfterFailuresResets() {
        // `Proceed` is the signal the loop uses to reset the failure counter; the counter
        // itself lives in the loop, but the decision must not *itself* require a low count
        // to succeed — a successful read is always a success.
        val decision = decideRead(read = 800, consecutiveFailures = 100)
        assertEquals(ReadDecision.Proceed, decision)
    }
}
