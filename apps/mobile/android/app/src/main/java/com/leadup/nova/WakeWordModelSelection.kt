package com.leadup.nova

/**
 * Which installed wake-word classifier the service listens for.
 *
 * Extracted from [WakeWordService] as a pure function so the rule can be tested
 * on the JVM: a stored choice that is no longer installed must not silence the
 * microphone, and an empty installation must not invent a phrase.
 *
 * The engine is given exactly one model, so this returns a single name. With one
 * classifier installed the answer is always that classifier, which is why the
 * Settings screen has nothing to offer a choice between.
 */
object WakeWordModelSelection {

    /**
     * @param stored the user's persisted choice, or null when they never made one.
     * @param installed the classifier names whose assets are actually present.
     * @return the name to listen for, or null when nothing is installed.
     */
    fun resolve(stored: String?, installed: List<String>): String? {
        if (installed.isEmpty()) return null
        val choice = stored?.takeIf { it.isNotBlank() }
        return if (choice != null && installed.contains(choice)) choice else installed.first()
    }
}
