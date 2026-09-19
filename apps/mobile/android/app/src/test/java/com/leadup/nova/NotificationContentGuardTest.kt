package com.leadup.nova

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * JVM unit tests for the Kotlin half of the §9.5 notification filter.
 *
 * `NotificationContentGuard` is deliberately free of Android dependencies so
 * this runs on a plain JVM — no device, no emulator, no Notification Access
 * grant. It proves the Kotlin layer drops the same sample set that
 * `test/features/notification_filter_test.dart` proves for the Dart layer, which
 * is what stops the two from drifting apart.
 *
 * Run with:
 *   ./gradlew :app:testDebugUnitTest
 */
class NotificationContentGuardTest {

    private fun sensitive(title: String = "", body: String = "") =
        NotificationContentGuard.detect(title, body)

    @Test
    fun `a bare OTP is one-time code`() {
        assertEquals(
            NotificationContentGuard.Kind.ONE_TIME_CODE,
            sensitive(body = "Your OTP is 482913"),
        )
    }

    @Test
    fun `a verification code is one-time code`() {
        assertEquals(
            NotificationContentGuard.Kind.ONE_TIME_CODE,
            sensitive(body = "123456 is your verification code"),
        )
    }

    @Test
    fun `an obfuscated OTP keyword is still recognised`() {
        assertEquals(
            NotificationContentGuard.Kind.ONE_TIME_CODE,
            sensitive(body = "Your 0TP is 123456"),
        )
    }

    @Test
    fun `a separated OTP keyword is still recognised`() {
        assertEquals(
            NotificationContentGuard.Kind.ONE_TIME_CODE,
            sensitive(body = "O.T.P: 991122"),
        )
    }

    @Test
    fun `a do-not-share warning is one-time code`() {
        assertEquals(
            NotificationContentGuard.Kind.ONE_TIME_CODE,
            sensitive(body = "Never share this code with anyone."),
        )
    }

    @Test
    fun `a password reset is a credential`() {
        assertEquals(
            NotificationContentGuard.Kind.PASSWORD,
            sensitive(body = "Reset your password using the link below."),
        )
    }

    @Test
    fun `a bank debit alert is banking`() {
        assertEquals(
            NotificationContentGuard.Kind.BANKING,
            sensitive(body = "HDFC Bank: Rs.500 debited from your a/c 1234."),
        )
    }

    @Test
    fun `a UPI alert is banking`() {
        assertEquals(
            NotificationContentGuard.Kind.BANKING,
            sensitive(body = "Your UPI payment of ₹250 to Swiggy was successful."),
        )
    }

    @Test
    fun `a sign-in approval prompt is an auth message`() {
        assertEquals(
            NotificationContentGuard.Kind.AUTH,
            sensitive(body = "Approve the sign-in request for your account."),
        )
    }

    @Test
    fun `ordinary work prose is not sensitive`() {
        val samples = listOf(
            "Can you review the PR when you get a chance?",
            "Calendar: Design review moved to Room 4 at 15:00.",
            "Ticket 12345 was closed by Priya.",
            "Do not share this document outside the team.",
            "Approve the design doc when you have a minute.",
        )
        for (sample in samples) {
            assertNull(
                "expected \"$sample\" to pass the guard",
                sensitive(body = sample),
            )
        }
    }

    @Test
    fun `an empty notification is not sensitive`() {
        assertNull(sensitive())
    }

    @Test
    fun `banking and OTP packages are blocked by package name`() {
        assertEquals(
            NotificationContentGuard.Kind.BANKING,
            NotificationContentGuard.blockedCategoryFor("com.example.mybank", null),
        )
        assertEquals(
            NotificationContentGuard.Kind.ONE_TIME_CODE,
            NotificationContentGuard.blockedCategoryFor(
                "com.google.android.apps.authenticator2",
                "Google Authenticator",
            ),
        )
        assertEquals(
            NotificationContentGuard.Kind.PASSWORD,
            NotificationContentGuard.blockedCategoryFor("com.x8bit.bitwarden", null),
        )
    }

    @Test
    fun `a banking app is blocked by its installed label`() {
        assertEquals(
            NotificationContentGuard.Kind.BANKING,
            NotificationContentGuard.blockedCategoryFor("com.vendor.thing", "Acme Bank"),
        )
        // Work apps must not be caught by the label heuristic.
        assertNull(NotificationContentGuard.blockedCategoryFor("com.Slack", "Slack"))
        assertNull(
            NotificationContentGuard.blockedCategoryFor(
                "com.whatsapp.w4b",
                "WhatsApp Business",
            ),
        )
    }
}
