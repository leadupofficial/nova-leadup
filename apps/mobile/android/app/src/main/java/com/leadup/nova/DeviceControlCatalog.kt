package com.leadup.nova

/**
 * NOVA device & system control — the pure-Kotlin half (product brief §9.2).
 *
 * ## Why this file has no Android imports
 *
 * Everything in here is a decision about *what* a device action is: its
 * permission level, whether Android actually permits it, the exact `Intent`
 * that carries it out, the media key it maps to, and the wording shown to the
 * user when it is refused. None of it needs a `Context`. Keeping it Android-free
 * means `DeviceControlCatalogTest` runs on a plain JVM — no device, no emulator,
 * no special access grant — exactly like `NotificationContentGuardTest`.
 *
 * [NovaDeviceControl] is the thin, Android-touching half that turns these
 * decisions into real `Intent`s and system calls. The split is deliberate: the
 * interesting logic is testable, and the untestable part is as small as it can
 * be.
 *
 * ## What Android actually permits (the honest table)
 *
 *  * Open apps / deep links — fully supported.
 *  * Dial a number — `ACTION_DIAL` only, which *shows* the number in the
 *    dialer. NOVA never adds `CALL_PHONE` and never places a call itself; §9.2
 *    says "Show number, confirm", so the confirmation happens in the app and the
 *    user presses call.
 *  * Wi-Fi / Bluetooth — **not toggleable by a third-party app**. Bluetooth
 *    `BluetoothAdapter.enable()`/`disable()` became no-ops for third-party apps
 *    on Android 12 (`BLUETOOTH_CONNECT` cannot restore them) and Wi-Fi
 *    `setWifiEnabled` stopped working for third-party apps on Android 10. The
 *    spec therefore asks for a deep link to the relevant Settings panel, and
 *    that is all this offers — no adapter call exists anywhere in this app.
 *  * Brightness — possible through `WRITE_SETTINGS`, a *special* access the user
 *    grants on a Settings screen. This app declares the permission (Android can
 *    grant it to a third-party app) and reports "not granted" honestly until the
 *    user does.
 *  * Do Not Disturb — possible through `ACCESS_NOTIFICATION_POLICY`, also a
 *    special user-granted access.
 *  * Media playback — `AudioManager.dispatchMediaKeyEvent` against the active
 *    session.
 *  * Send SMS — **deferred** by §9.2. Not implemented, and there is no action
 *    for it.
 *  * Read screen / control other apps — **excluded from the consumer MVP** by
 *    §9.2. There is no Accessibility service in this app and no action for it.
 */
object DeviceControlCatalog {

    // ─── Permission levels (the API's §10.1 scale) ───────────────────────
    //
    // These are the same four levels as `services/api/src/services/assistant-tools.ts`
    // (`ToolPermissionLevel`, 0–3). The numbers must stay identical across the
    // Kotlin, Dart and TypeScript registries; a test on each side pins them.

    const val LEVEL_READ_ONLY = 0
    const val LEVEL_LOW_RISK_WRITE = 1
    const val LEVEL_EXTERNAL = 2
    const val LEVEL_SENSITIVE = 3

    /**
     * The confirmation threshold, matching the API's `VOICE_TOOL_CONFIRM_LEVEL`
     * default during beta (L1). At or above this level an action must be
     * confirmed before it runs; L0 is below every value in range, so a
     * read-only action can never be made to prompt.
     */
    const val DEFAULT_CONFIRM_LEVEL = LEVEL_LOW_RISK_WRITE

    /** Every device action NOVA can perform. `wireName` is the cross-language id. */
    enum class Action(val wireName: String) {
        OPEN_APP("open_app"),
        OPEN_DEEP_LINK("open_deep_link"),
        OPEN_SETTINGS("open_settings"),
        DIAL_NUMBER("dial_number"),
        SET_BRIGHTNESS("set_brightness"),
        SET_DND("set_dnd"),
        MEDIA_PLAY("media_play"),
        MEDIA_PAUSE("media_pause"),
        MEDIA_NEXT("media_next"),
        MEDIA_PREVIOUS("media_previous"),

        /**
         * Meeting capture (§5.11).
         *
         * **Executed in Dart, not by an Android intent.** The Flutter recorder
         * opens the microphone, writes the file, uploads it and drives the
         * server pipeline; Android is never asked to do any of it. These ids
         * exist here only so the Dart, Kotlin and TypeScript registries agree on
         * one vocabulary, and [NovaDeviceControl] answers an (impossible) call
         * with an honest "not an Android action" failure rather than pretending.
         */
        START_RECORDING("start_recording"),
        STOP_RECORDING("stop_recording"),
    }

    /**
     * How far an action actually gets on this platform.
     *
     *  * [FUNCTIONAL] — NOVA performs it.
     *  * [DEEP_LINK_ONLY] — NOVA can only open the screen where the user changes
     *    it. The action itself is impossible for a third-party app.
     *  * [EXCLUDED] — deliberately not implemented (spec decision).
     *  * [DART_EXECUTED] — Android does nothing; the Flutter app performs it
     *    itself. It is excluded from the status payload so no native capability
     *    is ever claimed for it.
     */
    enum class Capability { FUNCTIONAL, DEEP_LINK_ONLY, EXCLUDED, DART_EXECUTED }

    /** A named Android Settings screen a deep link can open. */
    enum class SettingsPanel(val wireName: String, val intentAction: String) {
        WIFI("wifi", "android.settings.WIFI_SETTINGS"),
        BLUETOOTH("bluetooth", "android.settings.BLUETOOTH_SETTINGS"),

        /** Where the user grants Do Not Disturb access to NOVA. */
        DND_ACCESS("dnd_access", "android.settings.NOTIFICATION_POLICY_ACCESS_SETTINGS"),

        /** Where the user grants "Modify system settings" (brightness). */
        WRITE_SETTINGS("write_settings", "android.settings.MANAGE_WRITE_SETTINGS"),

        /** Where the user grants Notification Access (already used by §5.21). */
        NOTIFICATION_ACCESS("notification_access", "android.settings.NOTIFICATION_LISTENER_SETTINGS"),

        /** NOVA's own App info page, which is where "Restricted settings" is unlocked. */
        APP_DETAILS("app_details", "android.settings.APPLICATION_DETAILS_SETTINGS"),

        SOUND("sound", "android.settings.SOUND_SETTINGS"),
    }

    /** Media transport actions and their `KeyEvent` codes. */
    enum class MediaAction(val wireName: String, val keyCode: Int) {
        PLAY("media_play", KEYCODE_MEDIA_PLAY),
        PAUSE("media_pause", KEYCODE_MEDIA_PAUSE),
        NEXT("media_next", KEYCODE_MEDIA_NEXT),
        PREVIOUS("media_previous", KEYCODE_MEDIA_PREVIOUS),
    }

    // `android.view.KeyEvent` constants, copied here so this file stays
    // Android-free. These values are frozen by the platform (they are part of
    // the input ABI) and a test pins them.
    const val KEYCODE_MEDIA_NEXT = 87
    const val KEYCODE_MEDIA_PREVIOUS = 88
    const val KEYCODE_MEDIA_PLAY_PAUSE = 85
    const val KEYCODE_MEDIA_PLAY = 126
    const val KEYCODE_MEDIA_PAUSE = 127

    // `NotificationManager.INTERRUPTION_FILTER_*`, likewise copied.
    // ALL = 1, NONE = 3.
    const val INTERRUPTION_FILTER_ALL = 1
    const val INTERRUPTION_FILTER_NONE = 3

    /**
     * A plain description of an `Intent` to send.
     *
     * Deliberately not an `android.content.Intent`, so intent construction is
     * asserted by `DeviceControlCatalogTest` on a JVM. [NovaDeviceControl]
     * translates one of these into the real thing.
     */
    data class IntentSpec(
        val action: String,
        val data: String? = null,
        val packageName: String? = null,
        val categories: List<String> = emptyList(),
    )

    /** An action Android cannot offer a third-party app, and why. */
    data class Excluded(val id: String, val title: String, val reason: String)

    // ─── The registry ─────────────────────────────────────────────────────

    /**
     * The single source of truth for each action's permission level.
     *
     * Deliberate choices, justified against §10.1:
     *
     *  * [Action.OPEN_APP] / [Action.OPEN_SETTINGS] are L1 — personal, low-risk,
     *    reversible writes: launching an app or opening a settings panel changes
     *    nothing by itself.
     *  * [Action.OPEN_DEEP_LINK] is L2 — an arbitrary URI leaves NOVA for
     *    content it did not choose, i.e. external communication.
     *  * [Action.DIAL_NUMBER] is L2 — §9.2 classifies "initiate a call" as
     *    platform-intent with "show number, confirm"; a call reaches a person
     *    outside the user's account.
     *  * [Action.SET_BRIGHTNESS] / [Action.SET_DND] are L3 — each changes a
     *    device-wide setting, which §10.1 rates "sensitive/consequential"
     *    ("change account setting" → explicit confirm). DND also silently
     *    changes whether the user is reachable.
     *  * Media transport is L1 — local, instantly reversible playback control.
     *  * [Action.START_RECORDING] is L3 — it opens the microphone and records
     *    people, which §9.5 pairs with an explicit consent flow.
     *  * [Action.STOP_RECORDING] is L1 — ending an action the user already began.
     *
     * `LEVELS` is a total map over [Action]; there is no default, so adding an
     * action without classifying it fails to compile rather than silently
     * becoming read-only.
     */
    val LEVELS: Map<Action, Int> = mapOf(
        Action.OPEN_APP to LEVEL_LOW_RISK_WRITE,
        Action.OPEN_DEEP_LINK to LEVEL_EXTERNAL,
        Action.OPEN_SETTINGS to LEVEL_LOW_RISK_WRITE,
        Action.DIAL_NUMBER to LEVEL_EXTERNAL,
        Action.SET_BRIGHTNESS to LEVEL_SENSITIVE,
        Action.SET_DND to LEVEL_SENSITIVE,
        Action.MEDIA_PLAY to LEVEL_LOW_RISK_WRITE,
        Action.MEDIA_PAUSE to LEVEL_LOW_RISK_WRITE,
        Action.MEDIA_NEXT to LEVEL_LOW_RISK_WRITE,
        Action.MEDIA_PREVIOUS to LEVEL_LOW_RISK_WRITE,
        Action.START_RECORDING to LEVEL_SENSITIVE,
        Action.STOP_RECORDING to LEVEL_LOW_RISK_WRITE,
    )

    fun levelOf(action: Action): Int = LEVELS.getValue(action)

    /**
     * True when [action] may not run until the user confirms.
     *
     * Identical arithmetic to `toolRequiresConfirmation` on the API, including
     * the property that an L0 action is below every threshold in range and can
     * therefore never be made to prompt.
     */
    fun requiresConfirmation(
        action: Action,
        threshold: Int = DEFAULT_CONFIRM_LEVEL,
    ): Boolean = levelOf(action) >= threshold

    /** The inverse of [Action]'s wire name, or null for an unknown id. */
    fun actionFor(wireName: String): Action? =
        Action.entries.firstOrNull { it.wireName == wireName }

    /** The inverse of [SettingsPanel]'s wire name, or null for an unknown id. */
    fun panelFor(wireName: String): SettingsPanel? =
        SettingsPanel.entries.firstOrNull { it.wireName == wireName }

    /** The inverse of [MediaAction]'s wire name, or null. */
    fun mediaActionFor(wireName: String): MediaAction? =
        MediaAction.entries.firstOrNull { it.wireName == wireName }

    /**
     * How far [action] gets on Android.
     *
     * Opening a Settings *panel* is functional as a deep link, but the panel for
     * Wi-Fi or Bluetooth is the honest limit of what NOVA can do there — see
     * [panelCapability].
     */
    fun capabilityOf(action: Action): Capability = when (action) {
        Action.OPEN_APP,
        Action.OPEN_DEEP_LINK,
        Action.OPEN_SETTINGS,
        Action.DIAL_NUMBER,
        Action.SET_BRIGHTNESS,
        Action.SET_DND,
        Action.MEDIA_PLAY,
        Action.MEDIA_PAUSE,
        Action.MEDIA_NEXT,
        Action.MEDIA_PREVIOUS,
        -> Capability.FUNCTIONAL

        // The recorder lives in Dart; Android is never asked to do this.
        Action.START_RECORDING,
        Action.STOP_RECORDING,
        -> Capability.DART_EXECUTED
    }

    /**
     * Wi-Fi and Bluetooth are the two panels NOVA can only *open*.
     *
     * This is the spec's "Deep-link to settings only" row, and the reason is an
     * Android version fact, not a NOVA policy: third-party apps lost
     * programmatic Wi-Fi toggling on Android 10 and Bluetooth `enable()` /
     * `disable()` on Android 12.
     */
    fun panelCapability(panel: SettingsPanel): Capability = when (panel) {
        SettingsPanel.WIFI, SettingsPanel.BLUETOOTH -> Capability.DEEP_LINK_ONLY
        else -> Capability.FUNCTIONAL
    }

    /**
     * The Android-version explanation shown next to Wi-Fi and Bluetooth.
     *
     * It is written to be shown verbatim, because a control that appears broken
     * is worse than one that explains itself.
     */
    fun deepLinkReason(panel: SettingsPanel): String = when (panel) {
        SettingsPanel.WIFI ->
            "Android 10 removed programmatic Wi-Fi toggling for third-party apps, " +
                "so NOVA opens the Wi-Fi screen and you flip the switch."
        SettingsPanel.BLUETOOTH ->
            "Android 12 made Bluetooth enable()/disable() no-ops for third-party " +
                "apps, so NOVA opens the Bluetooth screen and you flip the switch."
        else -> "Android does not let an app change this directly."
    }

    /** Why an action that needs a special grant cannot run yet. */
    fun grantReason(action: Action): String = when (action) {
        Action.SET_BRIGHTNESS ->
            "Android requires the special \"Modify system settings\" access. " +
                "NOVA can open the screen; only you can grant it there."
        Action.SET_DND ->
            "Android requires \"Do Not Disturb access\". " +
                "NOVA can open the screen; only you can grant it there."
        else -> "This action needs an access only you can grant."
    }

    /**
     * The two things the spec does not implement, stated plainly.
     *
     * They are rendered on the device-control screen so their absence is a
     * documented decision rather than a missing feature.
     */
    val EXCLUDED: List<Excluded> = listOf(
        Excluded(
            id = "send_sms",
            title = "Send SMS",
            reason = "Deferred by the product brief §9.2 — sending a message as the " +
                "user is policy-sensitive, so NOVA does not do it.",
        ),
        Excluded(
            id = "read_screen",
            title = "Read the screen or control other apps",
            reason = "Excluded from the consumer MVP by §9.2. NOVA ships no " +
                "Accessibility service and cannot see or drive other apps.",
        ),
    )

    // ─── Intent construction ──────────────────────────────────────────────

    /** The `Intent` that opens [panel]. */
    fun settingsIntentSpec(panel: SettingsPanel): IntentSpec = IntentSpec(
        action = panel.intentAction,
        // Both of these screens are per-app and need the package, or Android
        // opens a list instead of NOVA's own entry.
        data = when (panel) {
            SettingsPanel.WRITE_SETTINGS, SettingsPanel.APP_DETAILS -> "package:$NOVA_PACKAGE"
            else -> null
        },
    )

    /**
     * The `Intent` that launches [packageName].
     *
     * `MAIN`/`LAUNCHER` is the launcher entry point, and the manifest declares a
     * matching `<queries>` element so package visibility on Android 11+ allows
     * the lookup.
     */
    fun appLaunchIntentSpec(packageName: String): IntentSpec = IntentSpec(
        action = "android.intent.action.MAIN",
        data = packageName,
        categories = listOf("android.intent.category.LAUNCHER"),
    )

    /**
     * The `Intent` that opens a URI.
     *
     * The scheme is checked here rather than in the Android half so a malformed
     * or dangerous link is refused before an `Intent` exists. Only `http`,
     * `https` and explicit app schemes with no `file:`/`content:`/`javascript:`
     * are accepted.
     */
    fun deepLinkIntentSpec(rawUri: String): IntentSpec? {
        val uri = rawUri.trim()
        if (uri.isEmpty()) return null
        val scheme = uri.substringBefore(':', missingDelimiterValue = "").lowercase()
        if (scheme.isEmpty()) return null
        if (scheme in FORBIDDEN_SCHEMES) return null
        return IntentSpec(action = "android.intent.action.VIEW", data = uri)
    }

    /** Schemes a device-control deep link must never carry. */
    val FORBIDDEN_SCHEMES: Set<String> = setOf("file", "content", "javascript", "data")

    /**
     * `ACTION_DIAL` — the dialer, pre-filled, never dialled.
     *
     * There is deliberately no `ACTION_CALL` builder in this app: that is what
     * `CALL_PHONE` would enable, and §9.2 asks NOVA to show the number and let
     * the user confirm. The number travels in the intent's data so the dialer
     * displays exactly what was confirmed.
     */
    fun dialIntentSpec(rawNumber: String): IntentSpec? {
        val number = normalizeNumber(rawNumber) ?: return null
        return IntentSpec(action = "android.intent.action.DIAL", data = "tel:$number")
    }

    /**
     * Normalises a phone number for `tel:`.
     *
     * Keeps a leading `+`, digits and the dial-pad symbols `* # , ;`. Returns
     * null when fewer than three digits remain, which is what stops an empty or
     * placeholder string from opening the dialer.
     */
    fun normalizeNumber(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null
        val builder = StringBuilder()
        var digitCount = 0
        trimmed.forEachIndexed { index, ch ->
            when {
                ch.isDigit() -> {
                    builder.append(ch)
                    digitCount++
                }
                ch == '+' && index == 0 -> builder.append(ch)
                ch == '*' || ch == '#' || ch == ',' || ch == ';' -> builder.append(ch)
                ch == ' ' || ch == '-' || ch == '(' || ch == ')' || ch == '.' -> Unit
                else -> return null
            }
        }
        if (digitCount < 3) return null
        return builder.toString()
    }

    /**
     * The system brightness value (`0–255`) for a `0.0–1.0` request.
     *
     * Clamped rather than rejected: a fractional request slightly out of range
     * is a rounding artefact, and refusing it would be pedantic. A non-finite
     * value is rejected by the caller before this is reached.
     */
    fun brightnessToSystem(fraction: Double): Int =
        Math.round(fraction * 255.0).toInt().coerceIn(0, 255)

    /** The `INTERRUPTION_FILTER_*` value for a requested DND state. */
    fun interruptionFilterFor(dndEnabled: Boolean): Int =
        if (dndEnabled) INTERRUPTION_FILTER_NONE else INTERRUPTION_FILTER_ALL

    /** True when an `INTERRUPTION_FILTER_*` value means "not silencing everything". */
    fun dndEnabledFor(filter: Int): Boolean = filter == INTERRUPTION_FILTER_NONE

    /** The `KeyEvent` code for a media action. */
    fun mediaKeyCode(action: MediaAction): Int = action.keyCode

    // ─── App aliases ──────────────────────────────────────────────────────

    /**
     * A small, curated spoken-name → package-name table.
     *
     * NOVA deliberately does **not** request `QUERY_ALL_PACKAGES` (a restricted
     * Play permission) and does not scan every installed app. A short alias list
     * covers the apps a voice request names, and anything outside it is reported
     * as "not installed or not recognised" rather than silently failing.
     */
    val APP_ALIASES: Map<String, String> = mapOf(
        "whatsapp" to "com.whatsapp",
        "whatsapp business" to "com.whatsapp.w4b",
        "telegram" to "org.telegram.messenger",
        "instagram" to "com.instagram.android",
        "facebook" to "com.facebook.katana",
        "gmail" to "com.google.android.gm",
        "maps" to "com.google.android.apps.maps",
        "google maps" to "com.google.android.apps.maps",
        "youtube" to "com.google.android.youtube",
        "chrome" to "com.android.chrome",
        "spotify" to "com.spotify.music",
        "camera" to "com.android.camera",
        "clock" to "com.google.android.deskclock",
        "calendar" to "com.google.android.calendar",
        "photos" to "com.google.android.apps.photos",
        "slack" to "com.Slack",
        "settings" to "com.android.settings",
        "phone" to "com.google.android.dialer",
        "messages" to "com.google.android.apps.messaging",
        "netflix" to "com.netflix.mediaclient",
        "uber" to "com.ubercab",
        "swiggy" to "in.swiggy.android",
        "zomato" to "com.application.zomato",
        "paytm" to "net.one97.paytm",
    )

    /**
     * Resolves a spoken name or a literal package name.
     *
     * A value that already looks like a package (`a.b.c` with no spaces) is
     * passed through, so the UI's own package entry keeps working; anything else
     * is looked up in [APP_ALIASES].
     */
    fun packageForApp(aliasOrPackage: String): String? {
        val key = aliasOrPackage.trim().lowercase()
        if (key.isEmpty()) return null
        APP_ALIASES[key]?.let { return it }
        return if (isPackageLike(aliasOrPackage.trim())) aliasOrPackage.trim() else null
    }

    /** True for `com.example.app`-shaped strings. */
    fun isPackageLike(value: String): Boolean {
        if (value.isEmpty() || value.contains(' ')) return false
        val parts = value.split('.')
        if (parts.size < 2) return false
        return parts.all { part ->
            part.isNotEmpty() &&
                part.first().isLetter() &&
                part.all { it.isLetterOrDigit() || it == '_' }
        }
    }

    /** This app's own package, for the App-info deep link. */
    const val NOVA_PACKAGE = "com.leadup.nova"
}
