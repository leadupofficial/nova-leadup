/// What kind of never-touch content a notification looks like.
enum SensitiveContentKind {
  /// A one-time passcode, verification code or authenticator prompt.
  oneTimeCode,

  /// A password, passphrase, magic link or credential.
  passwordOrCredential,

  /// A bank, card, UPI or transaction alert.
  bankingAlert,

  /// A sign-in / account-verification message with no code in it.
  authenticationMessage,
}

/// The §9.5 non-negotiable: recognise notification content that must never be
/// stored, relayed or spoken.
///
/// This is deliberately one named function over one set of named patterns
/// rather than conditionals scattered through the filter, the controller and
/// the UI. `NotificationFilter` calls it, the read-aloud path calls it again
/// immediately before speaking, and `NotificationContentGuard.kt` mirrors it on
/// the Kotlin side so the check also runs when the Flutter engine is not alive.
///
/// ## Why it errs toward dropping
///
/// Any app can post a notification with any text, so the input is hostile. The
/// cost of a false positive is a work summary the user does not see; the cost
/// of a false negative is an OTP in a log, a database or a speaker. Every
/// ambiguity therefore resolves to "sensitive".
///
/// ## What it does and does not claim
///
/// It is a heuristic, not a classifier. It will not catch a code with no
/// keyword anywhere near it ("482913"). That case is covered by the app-level
/// blocklist for OTP/authenticator packages, and it is exactly why §5.21 makes
/// "Do not store raw notification text" a rule rather than relying on
/// detection alone.
abstract final class NotificationContentGuard {
  /// Lower-cased text with separator-obfuscated keywords normalised, so `O.T.P`
  /// and `0TP` are recognised as `otp`.
  static SensitiveContentKind? detect({required String title, required String body}) {
    final raw = '$title\n$body'.toLowerCase();
    if (raw.trim().isEmpty) return null;

    // Leet-normalised copy used only for *keyword* matching. The digit-based
    // code patterns below run against the untouched text, so normalisation
    // cannot turn a code into a keyword.
    final words = _deLeet(raw);

    if (_bankingKeyword.hasMatch(raw) || _bankingKeyword.hasMatch(words)) {
      return SensitiveContentKind.bankingAlert;
    }
    if (_currencyAmount.hasMatch(raw) && _moneyContext.hasMatch(words)) {
      return SensitiveContentKind.bankingAlert;
    }
    if (_passwordKeyword.hasMatch(words)) {
      return SensitiveContentKind.passwordOrCredential;
    }
    if (_oneTimeCode(raw, words)) {
      return SensitiveContentKind.oneTimeCode;
    }
    if (_authenticationKeyword.hasMatch(words)) {
      return SensitiveContentKind.authenticationMessage;
    }
    return null;
  }

  /// Convenience wrapper for the read-aloud path, where only the already
  /// sanitised body is available.
  static SensitiveContentKind? detectText(String text) =>
      detect(title: '', body: text);

  // ── patterns ─────────────────────────────────────────────────────────────

  /// A run of 3-8 digits, optionally grouped by a single space or dash so
  /// "123 456" and "123-456" are seen as one code.
  static final RegExp _digitCode = RegExp(r'(?<!\d)\d(?:[\s\-]?\d){2,7}(?!\d)');

  /// `otp` / `o.t.p` / `o t p` / `one time` / `one-time` / `2fa` / `two factor`
  /// / `mfa` / `passcode` — an authentication code named unambiguously.
  static final RegExp _unambiguousCodeKeyword = RegExp(
    r'\botp\b|\bo[\s._\-*]?t[\s._\-*]?p\b|\bone[\s\-_]?time\b|\b2fa\b|'
    r'\btwo[\s\-_]?factor\b|\bmfa\b|\bpasscode\b|\bpass[\s\-]?code\b',
  );

  /// A code named by the thing it verifies: "verification code", "security
  /// pin", "login code", "access code", "activation code".
  static final RegExp _qualifiedCodeKeyword = RegExp(
    r'\b(?:verification|confirm(?:ation)?|security|authentication|auth|login|'
    r'log[\s\-]?in|sign[\s\-]?in|access|activation|invitation|backup|recovery|'
    r'restore)\s+(?:code|pin|number|token)\b',
  );

  /// Bare `code` / `pin` / `number`, which only counts with a co-signal.
  static final RegExp _bareCodeKeyword = RegExp(r'\b(?:code|pin)\b');

  /// The co-signals that make a bare `code` an authentication code rather than
  /// an order reference. `don't share` is written with `\u0027` so the pattern
  /// stays a single-quoted Dart string.
  static final RegExp _codeCoSignal = RegExp(
    r'\bdo\s+not\s+(?:share|disclose|reveal)\b|\bnever\s+share\b|'
    r'\bdon\u0027?t\s+share\b|\bexpires?\s+in\b|\bvalid\s+for\b|'
    r'\buse\s+(?:this|it|the)\s+code\b|\bcode\s+is\b|\bcode:\s|\bis\s+your\b',
  );

  static final RegExp _doNotShare = RegExp(
    r'\bdo\s+not\s+(?:share|disclose|reveal)\b|\bnever\s+share\b|'
    r'\bdon\u0027?t\s+share\b',
  );

  /// Passwords and credentials, in the shapes they actually arrive in.
  static final RegExp _passwordKeyword = RegExp(
    r'\bpassword\b|\bpassphrase\b|\bpass\s?phrase\b|\bpasscode\b|'
    r'\bcredentials?\b|\bmagic\s+link\b|\bpassword\s+reset\b|'
    r'\breset\s+(?:your\s+)?password\b|\btemporary\s+password\b|'
    r'\bsign[\s\-]?in\s+link\b|\blogin\s+link\b|\bone[\s\-]?time\s+password\b|'
    r'\bchange\s+your\s+password\b|\bnew\s+password\b',
  );

  /// Bank, card and transaction language. Every entry is unambiguous enough to
  /// stand alone; generic finance words that also describe ordinary work
  /// ("invoice", "payment", "amount") are handled by the currency rule below.
  ///
  /// `credit` and `debit` appear on their own only in their inflected forms:
  /// the bare nouns are common in ordinary work prose ("credit the team") and
  /// would drop legitimate messages.
  static final RegExp _bankingKeyword = RegExp(
    r'\ba/?c\b|\bacct\b|\bbank\s+account\b|'
    r'\baccount\s+(?:balance|number|statement|details)\b|\bnet\s?banking\b|'
    r'\bupi\b|\bneft\b|\bimps\b|\brtgs\b|\bifsc\b|\bmicr\b|\bcvv\b|'
    r'\bdebit\s+card\b|\bcredit\s+card\b|\bcard\s+ending\b|'
    r'\bdebited\b|\bcredited\b|\bwithdrawn\b|\bwithdrawal\b|'
    r'\bdeposited\b|\btransaction\s+(?:of|id|failed|successful|alert)\b|'
    r'\bemi\s+(?:due|of|amount)\b|\bbalance\s+is\b|\bbank\s+alert\b|'
    r'\bstatement\s+is\s+(?:ready|generated)\b|\bspent\s+(?:on|of|at)\b|'
    r'\bpaid\s+to\b|\breceived\s+from\b|\bupi\s+(?:id|ref|transaction)\b',
  );

  static final RegExp _currencyAmount = RegExp(
    r'(?:₹|rs\.?\s?|inr\s?|usd\s?|\$|€|eur\s?|£|gbp\s?|aed\s?|sgd\s?)\d'
    r'|\d+(?:[.,]\d+)?\s?(?:inr|usd|eur|gbp|aed|sgd|rupees|dollars|euros)\b',
  );

  static final RegExp _moneyContext = RegExp(
    r'\bpaid\b|\bpay(?:ment)?\b|\bspent\b|\bcharged\b|\bdebit(?:ed)?\b|'
    r'\bcredit(?:ed)?\b|\btransferred\b|\brefund\b|\bbalance\b|\binvoice\b|'
    r'\bemi\b|\btransaction\b|\bwithdraw(?:al|n)?\b|\bdeposit(?:ed)?\b',
  );

  /// Sign-in and account-security messages that carry no code.
  ///
  /// `approve`/`deny` only count next to an authentication noun, so an ordinary
  /// "approve the design doc" is not swallowed by this rule.
  static final RegExp _authenticationKeyword = RegExp(
    r'\bverify\s+your\b|\bconfirm\s+your\s+(?:email|account|identity)\b|'
    r'\bverification\s+(?:email|link|request)\b|\bsign[\s\-]?in\s+attempt\b|'
    r'\bsign[\s\-]?in\s+request\b|\bnew\s+(?:device|login|sign[\s\-]?in)\b|'
    r'\b(?:approve|deny|confirm)\s+(?:the\s+|this\s+)?'
    r'(?:sign[\s\-]?in|login|log[\s\-]?in|authentication|access)\b|'
    r'\bsecurity\s+alert\b|\bunusual\s+(?:sign[\s\-]?in|activity|login)\b|'
    r'\bsuspicious\s+(?:login|activity|sign[\s\-]?in)\b|'
    r'\bauthentication\s+(?:code|request|prompt)\b|\baccess\s+code\b|'
    r'\bone[\s\-]?time\s+(?:code|pin|password)\b',
  );

  // ── rules ────────────────────────────────────────────────────────────────

  /// Whether the text carries a one-time code.
  ///
  /// Three independent signals, any of which is enough:
  ///  1. a code named unambiguously (`otp`, `one-time`, `2fa`, `passcode`) plus
  ///     any digit run;
  ///  2. a code named by what it verifies (`verification code`, `login pin`)
  ///     plus any digit run;
  ///  3. a bare `code`/`pin` plus a co-signal ("do not share", "expires in",
  ///     "code is") plus a digit run;
  ///  4. a "do not share" instruction plus a code word, even with no digits —
  ///     the sentence itself is an OTP warning.
  static bool _oneTimeCode(String raw, String words) {
    final hasDigits = _digitCode.hasMatch(raw);
    if (hasDigits) {
      if (_unambiguousCodeKeyword.hasMatch(words)) return true;
      if (_qualifiedCodeKeyword.hasMatch(words)) return true;
      if (_bareCodeKeyword.hasMatch(raw) && _codeCoSignal.hasMatch(raw)) {
        return true;
      }
    }
    return _doNotShare.hasMatch(raw) &&
        (_bareCodeKeyword.hasMatch(raw) ||
            _unambiguousCodeKeyword.hasMatch(words));
  }

  /// `O.T.P` → `otp`, `0tp` → `otp`, `c0de` → `code`, `pa55word` → `password`.
  ///
  /// Only applied to the *keyword* copy. Deliberate obfuscation of an OTP
  /// keyword is a real pattern in bulk SMS and in apps that try to slip past
  /// on-device filters, and normalising is cheap. Because the digit-based
  /// patterns above run against the untouched text, this cannot invent a code.
  static String _deLeet(String input) {
    const substitutions = <String, String>{
      '0': 'o',
      '1': 'l',
      '3': 'e',
      '4': 'a',
      '5': 's',
      '7': 't',
      '@': 'a',
      r'$': 's',
    };
    final buffer = StringBuffer();
    for (final rune in input.runes) {
      final char = String.fromCharCode(rune);
      buffer.write(substitutions[char] ?? char);
    }
    return buffer.toString();
  }
}
