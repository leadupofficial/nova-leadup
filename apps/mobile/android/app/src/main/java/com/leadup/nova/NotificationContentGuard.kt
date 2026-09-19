package com.leadup.nova

/**
 * The Kotlin half of NOVA's notification content guard.
 *
 * This mirrors `lib/features/notifications/notification_content_guard.dart`
 * rule-for-rule. The Dart copy is the specification and the one covered by
 * unit tests; this copy exists because it has to run on the path a notification
 * actually takes — inside `onNotificationPosted`, before any text is put on the
 * Flutter event channel, and even when the Flutter engine is not alive at all.
 *
 * The two layers are independent, and a notification is dropped if *either*
 * rejects it, so the effective rule set is the union of the two. That is the
 * intended design: a bug or an omission on one side cannot let an OTP through.
 *
 * Deliberately no logging of the inspected text anywhere in this file. Only
 * package names are ever logged.
 */
internal object NotificationContentGuard {

    /** What kind of never-touch content a notification looks like. */
    enum class Kind {
        ONE_TIME_CODE,
        PASSWORD,
        BANKING,
        AUTH,
    }

    // ── patterns ─────────────────────────────────────────────────────────────

    /** 3-8 digits, optionally grouped by a space or a dash ("123 456"). */
    private val DIGIT_CODE = Regex("""(?<!\d)\d(?:[\s\-]?\d){2,7}(?!\d)""")

    /** `otp` / `o.t.p` / `o t p` / `one time` / `2fa` / `passcode`. */
    private val UNAMBIGUOUS_CODE = Regex(
        """\botp\b|\bo[\s._\-*]?t[\s._\-*]?p\b|\bone[\s\-_]?time\b|\b2fa\b|""" +
            """\btwo[\s\-_]?factor\b|\bmfa\b|\bpasscode\b|\bpass[\s\-]?code\b""",
        RegexOption.IGNORE_CASE,
    )

    /** A code named by what it verifies: "verification code", "login pin". */
    private val QUALIFIED_CODE = Regex(
        """\b(?:verification|confirm(?:ation)?|security|authentication|auth|login|""" +
            """log[\s\-]?in|sign[\s\-]?in|access|activation|invitation|backup|""" +
            """recovery|restore)\s+(?:code|pin|number|token)\b""",
        RegexOption.IGNORE_CASE,
    )

    /** Bare `code` / `pin`, which only counts with a co-signal. */
    private val BARE_CODE = Regex("""\b(?:code|pin)\b""", RegexOption.IGNORE_CASE)

    private val CODE_CO_SIGNAL = Regex(
        """\bdo\s+not\s+(?:share|disclose|reveal)\b|\bnever\s+share\b|""" +
            """\bdon'?t\s+share\b|\bexpires?\s+in\b|\bvalid\s+for\b|""" +
            """\buse\s+(?:this|it|the)\s+code\b|\bcode\s+is\b|\bcode:\s|\bis\s+your\b""",
        RegexOption.IGNORE_CASE,
    )

    private val DO_NOT_SHARE = Regex(
        """\bdo\s+not\s+(?:share|disclose|reveal)\b|\bnever\s+share\b|""" +
            """\bdon'?t\s+share\b""",
        RegexOption.IGNORE_CASE,
    )

    private val PASSWORD = Regex(
        """\bpassword\b|\bpassphrase\b|\bpass\s?phrase\b|\bpasscode\b|""" +
            """\bcredentials?\b|\bmagic\s+link\b|\bpassword\s+reset\b|""" +
            """\breset\s+(?:your\s+)?password\b|\btemporary\s+password\b|""" +
            """\bsign[\s\-]?in\s+link\b|\blogin\s+link\b|""" +
            """\bone[\s\-]?time\s+password\b|\bchange\s+your\s+password\b|""" +
            """\bnew\s+password\b""",
        RegexOption.IGNORE_CASE,
    )

    private val BANKING = Regex(
        """\ba/?c\b|\bacct\b|\bbank\s+account\b|""" +
            """\baccount\s+(?:balance|number|statement|details)\b|\bnet\s?banking\b|""" +
            """\bupi\b|\bneft\b|\bimps\b|\brtgs\b|\bifsc\b|\bmicr\b|\bcvv\b|""" +
            """\bdebit\s+card\b|\bcredit\s+card\b|\bcard\s+ending\b|""" +
            """\bdebited\b|\bcredited\b|\bwithdrawn\b|\bwithdrawal\b|""" +
            """\bdeposited\b|\btransaction\s+(?:of|id|failed|successful|alert)\b|""" +
            """\bemi\s+(?:due|of|amount)\b|\bbalance\s+is\b|\bbank\s+alert\b|""" +
            """\bstatement\s+is\s+(?:ready|generated)\b|\bspent\s+(?:on|of|at)\b|""" +
            """\bpaid\s+to\b|\breceived\s+from\b|\bupi\s+(?:id|ref|transaction)\b""",
        RegexOption.IGNORE_CASE,
    )

    /** An escaped normal string: `$` and `\d` cannot go in a raw Kotlin string. */
    private val CURRENCY = Regex(
        "(?:₹|rs\\.?\\s?|inr\\s?|usd\\s?|\\$|€|eur\\s?|£|gbp\\s?|aed\\s?|sgd\\s?)\\d" +
            "|\\d+(?:[.,]\\d+)?\\s?(?:inr|usd|eur|gbp|aed|sgd|rupees|dollars|euros)\\b",
        RegexOption.IGNORE_CASE,
    )

    private val MONEY_CONTEXT = Regex(
        """\bpaid\b|\bpay(?:ment)?\b|\bspent\b|\bcharged\b|\bdebit(?:ed)?\b|""" +
            """\bcredit(?:ed)?\b|\btransferred\b|\brefund\b|\bbalance\b|\binvoice\b|""" +
            """\bemi\b|\btransaction\b|\bwithdraw(?:al|n)?\b|\bdeposit(?:ed)?\b""",
        RegexOption.IGNORE_CASE,
    )

    private val AUTH = Regex(
        """\bverify\s+your\b|\bconfirm\s+your\s+(?:email|account|identity)\b|""" +
            """\bverification\s+(?:email|link|request)\b|\bsign[\s\-]?in\s+attempt\b|""" +
            """\bsign[\s\-]?in\s+request\b|\bnew\s+(?:device|login|sign[\s\-]?in)\b|""" +
            """\b(?:approve|deny|confirm)\s+(?:the\s+|this\s+)?""" +
            """(?:sign[\s\-]?in|login|log[\s\-]?in|authentication|access)\b|""" +
            """\bsecurity\s+alert\b|\bunusual\s+(?:sign[\s\-]?in|activity|login)\b|""" +
            """\bsuspicious\s+(?:login|activity|sign[\s\-]?in)\b|""" +
            """\bauthentication\s+(?:code|request|prompt)\b|\baccess\s+code\b|""" +
            """\bone[\s\-]?time\s+(?:code|pin|password)\b""",
        RegexOption.IGNORE_CASE,
    )

    /**
     * Package-name fragments that mark an app as financial or
     * credential-bearing.
     *
     * Mirrors the Dart hint table minus the entries covered by the explicit
     * catalogue there. Deliberately conservative: a false positive makes an app
     * un-selectable, so broad tokens such as `pay` (Payroll, Paycom) are left
     * out.
     */
    private val TREASURY_PACKAGE_HINTS = mapOf(
        "bank" to Kind.BANKING,
        "wallet" to Kind.BANKING,
        "paypal" to Kind.BANKING,
        "paytm" to Kind.BANKING,
        "phonepe" to Kind.BANKING,
        "paisa" to Kind.BANKING,
        "upi" to Kind.BANKING,
        "authenticator" to Kind.ONE_TIME_CODE,
        "authy" to Kind.ONE_TIME_CODE,
        "freeotp" to Kind.ONE_TIME_CODE,
        "aegis" to Kind.ONE_TIME_CODE,
        "password" to Kind.PASSWORD,
        "passcode" to Kind.PASSWORD,
        "bitwarden" to Kind.PASSWORD,
        "lastpass" to Kind.PASSWORD,
        "dashlane" to Kind.PASSWORD,
        "onepassword" to Kind.PASSWORD,
    )

    /** Whole words that mark an installed app's label as financial or secret. */
    private val TREASURY_LABEL_HINTS = mapOf(
        "bank" to Kind.BANKING,
        "banks" to Kind.BANKING,
        "banking" to Kind.BANKING,
        "netbanking" to Kind.BANKING,
        "passbook" to Kind.BANKING,
        "wallet" to Kind.BANKING,
        "authenticator" to Kind.ONE_TIME_CODE,
        "otp" to Kind.ONE_TIME_CODE,
        "password" to Kind.PASSWORD,
        "passcode" to Kind.PASSWORD,
    )

    private val TREASURY_LABEL_HINT = Regex(
        "\\b(?:" +
            TREASURY_LABEL_HINTS.keys
                .sortedByDescending { it.length }
                .joinToString("|") +
            ")\\b",
        RegexOption.IGNORE_CASE,
    )

    // ── rules ────────────────────────────────────────────────────────────────

    /**
     * The §9.5 non-negotiable: does this text look like an OTP, a password, a
     * bank alert or an authentication message?
     *
     * Returns null when the text is not recognisably sensitive. The caller
     * treats any non-null answer as "drop, store nothing, say nothing".
     */
    fun detect(title: String, body: String): Kind? {
        val raw = "$title\n$body".lowercase()
        if (raw.isBlank()) return null

        // Leet-normalised copy used only for keyword matching; the digit-based
        // patterns run against the untouched text so this cannot invent a code.
        val words = deLeet(raw)

        if (BANKING.containsMatchIn(raw) || BANKING.containsMatchIn(words)) {
            return Kind.BANKING
        }
        if (CURRENCY.containsMatchIn(raw) && MONEY_CONTEXT.containsMatchIn(words)) {
            return Kind.BANKING
        }
        if (PASSWORD.containsMatchIn(words)) return Kind.PASSWORD
        if (oneTimeCode(raw, words)) return Kind.ONE_TIME_CODE
        if (AUTH.containsMatchIn(words)) return Kind.AUTH
        return null
    }

    /**
     * The permanent block, mirroring `blockedCategoryFor` in
     * `notification_app_catalogue.dart`.
     *
     * [label] is the installed app's label from `PackageManager`, never a string
     * the notification supplied, so it cannot be spoofed by the notification
     * payload.
     */
    fun blockedCategoryFor(packageName: String, label: String?): Kind? {
        val lower = packageName.lowercase()
        for ((hint, kind) in TREASURY_PACKAGE_HINTS) {
            if (lower.contains(hint)) return kind
        }
        val text = label?.trim().orEmpty()
        if (text.isEmpty()) return null
        val match = TREASURY_LABEL_HINT.find(text) ?: return null
        return TREASURY_LABEL_HINTS[match.value.lowercase()]
    }

    private fun oneTimeCode(raw: String, words: String): Boolean {
        if (DIGIT_CODE.containsMatchIn(raw)) {
            if (UNAMBIGUOUS_CODE.containsMatchIn(words)) return true
            if (QUALIFIED_CODE.containsMatchIn(words)) return true
            if (BARE_CODE.containsMatchIn(raw) && CODE_CO_SIGNAL.containsMatchIn(raw)) {
                return true
            }
        }
        return DO_NOT_SHARE.containsMatchIn(raw) &&
            (BARE_CODE.containsMatchIn(raw) || UNAMBIGUOUS_CODE.containsMatchIn(words))
    }

    /** `O.T.P` → `otp`, `0tp` → `otp`, `pa55word` → `password`. */
    private fun deLeet(input: String): String {
        val substitutions = mapOf(
            '0' to 'o',
            '1' to 'l',
            '3' to 'e',
            '4' to 'a',
            '5' to 's',
            '7' to 't',
            '@' to 'a',
            '$' to 's',
        )
        val builder = StringBuilder(input.length)
        for (char in input) {
            builder.append(substitutions[char] ?: char)
        }
        return builder.toString()
    }
}
