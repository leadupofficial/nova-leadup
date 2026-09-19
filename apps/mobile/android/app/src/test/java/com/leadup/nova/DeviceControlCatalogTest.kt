package com.leadup.nova

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for the Kotlin half of device & system control (§9.2).
 *
 * `DeviceControlCatalog` is deliberately free of Android dependencies, so this
 * runs on a plain JVM — no device, no emulator, no special access grant. It
 * proves the Kotlin registry's action→level table, its intent construction and
 * its refusal logic. `test/features/device_control_levels_test.dart` pins the
 * same table for Dart, and `test/features/device_control_platform_test.dart`
 * asserts the two sides agree on the wire ids, which is what stops them
 * drifting.
 *
 * Run with:
 *   ./gradlew :app:testDebugUnitTest
 */
class DeviceControlCatalogTest {

    private val catalog = DeviceControlCatalog

    // ─── The permission-level registry ────────────────────────────────────

    @Test
    fun `every action is classified, with no strays`() {
        // A total map over the enum: an action added without a level would fail
        // to compile, but this also catches a level map that lost an entry.
        assertEquals(
            DeviceControlCatalog.Action.entries.toSet(),
            catalog.LEVELS.keys,
        )
    }

    @Test
    fun `levels match the deliberate decisions`() {
        // L1: personal, low-risk, reversible.
        assertEquals(1, catalog.levelOf(DeviceControlCatalog.Action.OPEN_APP))
        assertEquals(1, catalog.levelOf(DeviceControlCatalog.Action.OPEN_SETTINGS))
        assertEquals(1, catalog.levelOf(DeviceControlCatalog.Action.MEDIA_PLAY))
        assertEquals(1, catalog.levelOf(DeviceControlCatalog.Action.MEDIA_PAUSE))
        assertEquals(1, catalog.levelOf(DeviceControlCatalog.Action.MEDIA_NEXT))
        assertEquals(1, catalog.levelOf(DeviceControlCatalog.Action.MEDIA_PREVIOUS))

        // L2: reaches outside the user's own account.
        assertEquals(2, catalog.levelOf(DeviceControlCatalog.Action.OPEN_DEEP_LINK))
        assertEquals(2, catalog.levelOf(DeviceControlCatalog.Action.DIAL_NUMBER))

        // L3: changes a device-wide setting (§10.1 "change account setting").
        assertEquals(3, catalog.levelOf(DeviceControlCatalog.Action.SET_BRIGHTNESS))
        assertEquals(3, catalog.levelOf(DeviceControlCatalog.Action.SET_DND))
    }

    @Test
    fun `media transport is low-risk, not sensitive`() {
        // The owner's brief calls pausing media low-risk; ratings must reflect
        // that rather than over-protecting a reversible playback key.
        for (action in listOf(
            DeviceControlCatalog.Action.MEDIA_PLAY,
            DeviceControlCatalog.Action.MEDIA_PAUSE,
            DeviceControlCatalog.Action.MEDIA_NEXT,
            DeviceControlCatalog.Action.MEDIA_PREVIOUS,
        )) {
            assertTrue(catalog.levelOf(action) < catalog.LEVEL_SENSITIVE)
        }
    }

    @Test
    fun `L0 is never at or above a real threshold`() {
        // The hard rule the API's gate also relies on: a read-only action must
        // not be makeable to prompt. No action is L0 today, so the property is
        // asserted against the constant the level scale starts at.
        assertEquals(0, catalog.LEVEL_READ_ONLY)
        for (threshold in 1..3) {
            assertFalse(catalog.LEVEL_READ_ONLY >= threshold)
        }
    }

    @Test
    fun `L1 and above require confirmation at the default threshold`() {
        for (action in DeviceControlCatalog.Action.entries) {
            assertEquals(
                catalog.levelOf(action) >= catalog.DEFAULT_CONFIRM_LEVEL,
                catalog.requiresConfirmation(action),
            )
        }
        assertTrue(catalog.requiresConfirmation(DeviceControlCatalog.Action.OPEN_APP))
        assertTrue(catalog.requiresConfirmation(DeviceControlCatalog.Action.SET_DND))
        assertTrue(catalog.requiresConfirmation(DeviceControlCatalog.Action.DIAL_NUMBER))
    }

    @Test
    fun `a higher threshold silences lower levels and never the reverse`() {
        assertFalse(catalog.requiresConfirmation(DeviceControlCatalog.Action.OPEN_APP, threshold = 2))
        assertTrue(catalog.requiresConfirmation(DeviceControlCatalog.Action.SET_DND, threshold = 3))
        assertFalse(catalog.requiresConfirmation(DeviceControlCatalog.Action.SET_DND, threshold = 4))
    }

    // ─── Capability honesty ───────────────────────────────────────────────

    @Test
    fun `wifi and bluetooth are deep-link only, and everything else is functional`() {
        assertEquals(
            DeviceControlCatalog.Capability.DEEP_LINK_ONLY,
            catalog.panelCapability(DeviceControlCatalog.SettingsPanel.WIFI),
        )
        assertEquals(
            DeviceControlCatalog.Capability.DEEP_LINK_ONLY,
            catalog.panelCapability(DeviceControlCatalog.SettingsPanel.BLUETOOTH),
        )
        assertEquals(
            DeviceControlCatalog.Capability.FUNCTIONAL,
            catalog.panelCapability(DeviceControlCatalog.SettingsPanel.DND_ACCESS),
        )
        for (action in DeviceControlCatalog.Action.entries) {
            assertEquals(DeviceControlCatalog.Capability.FUNCTIONAL, catalog.capabilityOf(action))
        }
    }

    @Test
    fun `the wifi and bluetooth reasons name the Android version change`() {
        assertTrue(
            catalog.deepLinkReason(DeviceControlCatalog.SettingsPanel.WIFI).contains("Android 10"),
        )
        assertTrue(
            catalog.deepLinkReason(DeviceControlCatalog.SettingsPanel.BLUETOOTH).contains("Android 12"),
        )
    }

    @Test
    fun `the excluded list names SMS and screen reading`() {
        val ids = catalog.EXCLUDED.map { it.id }
        assertTrue(ids.contains("send_sms"))
        assertTrue(ids.contains("read_screen"))
        // Every excluded entry explains itself; there is no bare "not supported".
        for (item in catalog.EXCLUDED) {
            assertTrue(item.reason.isNotBlank())
            assertTrue(item.title.isNotBlank())
        }
    }

    @Test
    fun `special-access actions carry a grant reason`() {
        assertTrue(
            catalog.grantReason(DeviceControlCatalog.Action.SET_BRIGHTNESS).contains("Modify system settings"),
        )
        assertTrue(
            catalog.grantReason(DeviceControlCatalog.Action.SET_DND).contains("Do Not Disturb access"),
        )
    }

    // ─── Intent construction ──────────────────────────────────────────────

    @Test
    fun `settings panels build the platform action strings`() {
        assertEquals(
            "android.settings.WIFI_SETTINGS",
            catalog.settingsIntentSpec(DeviceControlCatalog.SettingsPanel.WIFI).action,
        )
        assertEquals(
            "android.settings.BLUETOOTH_SETTINGS",
            catalog.settingsIntentSpec(DeviceControlCatalog.SettingsPanel.BLUETOOTH).action,
        )
        assertEquals(
            "android.settings.NOTIFICATION_POLICY_ACCESS_SETTINGS",
            catalog.settingsIntentSpec(DeviceControlCatalog.SettingsPanel.DND_ACCESS).action,
        )
        assertEquals(
            "android.settings.MANAGE_WRITE_SETTINGS",
            catalog.settingsIntentSpec(DeviceControlCatalog.SettingsPanel.WRITE_SETTINGS).action,
        )
    }

    @Test
    fun `the per-app settings panels carry this package`() {
        assertEquals(
            "package:${catalog.NOVA_PACKAGE}",
            catalog.settingsIntentSpec(DeviceControlCatalog.SettingsPanel.WRITE_SETTINGS).data,
        )
        assertEquals(
            "package:${catalog.NOVA_PACKAGE}",
            catalog.settingsIntentSpec(DeviceControlCatalog.SettingsPanel.APP_DETAILS).data,
        )
        assertNull(catalog.settingsIntentSpec(DeviceControlCatalog.SettingsPanel.WIFI).data)
    }

    @Test
    fun `the app launch intent is the launcher entry point`() {
        val spec = catalog.appLaunchIntentSpec("com.whatsapp")
        assertEquals("android.intent.action.MAIN", spec.action)
        assertTrue(spec.categories.contains("android.intent.category.LAUNCHER"))
    }

    @Test
    fun `dial uses ACTION_DIAL and never ACTION_CALL`() {
        val spec = catalog.dialIntentSpec("+91 98765 43210")
        assertNotNull(spec)
        assertEquals("android.intent.action.DIAL", spec!!.action)
        assertEquals("tel:+919876543210", spec.data)
        // The one thing NOVA must never do: place the call itself.
        assertFalse(spec.action.contains("CALL"))
    }

    @Test
    fun `a number with too few digits is refused`() {
        assertNull(catalog.dialIntentSpec("12"))
        assertNull(catalog.dialIntentSpec(""))
        assertNull(catalog.dialIntentSpec("not a number"))
    }

    @Test
    fun `number normalisation keeps a leading plus and dial symbols`() {
        assertEquals("+919876543210", catalog.normalizeNumber("+91 (98765) 43210"))
        assertEquals("*123#", catalog.normalizeNumber("*123#"))
        assertEquals("123456", catalog.normalizeNumber("123-456"))
        assertNull(catalog.normalizeNumber("hello"))
    }

    @Test
    fun `deep links refuse the dangerous schemes`() {
        for (scheme in catalog.FORBIDDEN_SCHEMES) {
            assertNull(
                "expected $scheme: to be refused",
                catalog.deepLinkIntentSpec("$scheme://example/thing"),
            )
        }
        val https = catalog.deepLinkIntentSpec("https://nova.leadup.tech")
        assertEquals("android.intent.action.VIEW", https!!.action)
        assertNull(catalog.deepLinkIntentSpec("no-scheme-here"))
    }

    // ─── Values the platform half depends on ──────────────────────────────

    @Test
    fun `media key codes match the frozen platform constants`() {
        assertEquals(catalog.KEYCODE_MEDIA_NEXT, catalog.mediaKeyCode(DeviceControlCatalog.MediaAction.NEXT))
        assertEquals(catalog.KEYCODE_MEDIA_PREVIOUS, catalog.mediaKeyCode(DeviceControlCatalog.MediaAction.PREVIOUS))
        assertEquals(catalog.KEYCODE_MEDIA_PLAY, catalog.mediaKeyCode(DeviceControlCatalog.MediaAction.PLAY))
        assertEquals(catalog.KEYCODE_MEDIA_PAUSE, catalog.mediaKeyCode(DeviceControlCatalog.MediaAction.PAUSE))
        // AOSP values; a rename would break transport on every device.
        assertEquals(87, catalog.KEYCODE_MEDIA_NEXT)
        assertEquals(88, catalog.KEYCODE_MEDIA_PREVIOUS)
        assertEquals(126, catalog.KEYCODE_MEDIA_PLAY)
        assertEquals(127, catalog.KEYCODE_MEDIA_PAUSE)
    }

    @Test
    fun `brightness maps onto the system scale and clamps`() {
        assertEquals(0, catalog.brightnessToSystem(0.0))
        assertEquals(255, catalog.brightnessToSystem(1.0))
        assertEquals(128, catalog.brightnessToSystem(0.5))
        assertEquals(0, catalog.brightnessToSystem(-0.5))
        assertEquals(255, catalog.brightnessToSystem(1.5))
    }

    @Test
    fun `do not disturb maps onto the interruption filter`() {
        assertEquals(
            catalog.INTERRUPTION_FILTER_NONE,
            catalog.interruptionFilterFor(true),
        )
        assertEquals(
            catalog.INTERRUPTION_FILTER_ALL,
            catalog.interruptionFilterFor(false),
        )
        assertTrue(catalog.dndEnabledFor(catalog.INTERRUPTION_FILTER_NONE))
        assertFalse(catalog.dndEnabledFor(catalog.INTERRUPTION_FILTER_ALL))
    }

    // ─── Wire ids ─────────────────────────────────────────────────────────

    @Test
    fun `wire ids round-trip and reject unknown values`() {
        for (action in DeviceControlCatalog.Action.entries) {
            assertEquals(action, catalog.actionFor(action.wireName))
        }
        assertNull(catalog.actionFor("launch_missiles"))
        for (panel in DeviceControlCatalog.SettingsPanel.entries) {
            assertEquals(panel, catalog.panelFor(panel.wireName))
        }
        assertNull(catalog.panelFor("nope"))
        for (media in DeviceControlCatalog.MediaAction.entries) {
            assertEquals(media, catalog.mediaActionFor(media.wireName))
        }
    }

    @Test
    fun `the action wire names are the frozen snake case set`() {
        assertEquals(
            setOf(
                "open_app",
                "open_deep_link",
                "open_settings",
                "dial_number",
                "set_brightness",
                "set_dnd",
                "media_play",
                "media_pause",
                "media_next",
                "media_previous",
            ),
            DeviceControlCatalog.Action.entries.map { it.wireName }.toSet(),
        )
    }

    // ─── App aliases ──────────────────────────────────────────────────────

    @Test
    fun `known app names resolve to packages`() {
        assertEquals("com.whatsapp", catalog.packageForApp("WhatsApp"))
        assertEquals("com.spotify.music", catalog.packageForApp("spotify"))
        assertEquals("com.Slack", catalog.packageForApp("slack"))
    }

    @Test
    fun `a literal package name passes through and rubbish does not`() {
        assertEquals("com.example.notes", catalog.packageForApp("com.example.notes"))
        assertNull(catalog.packageForApp("some app nobody installed"))
        assertNull(catalog.packageForApp(""))
        assertNull(catalog.packageForApp("single"))
    }

    @Test
    fun `package-shaped strings are validated`() {
        assertTrue(catalog.isPackageLike("com.example.app"))
        assertTrue(catalog.isPackageLike("a.b"))
        assertFalse(catalog.isPackageLike("com.example app"))
        assertFalse(catalog.isPackageLike("com"))
        assertFalse(catalog.isPackageLike("1com.example"))
    }
}
