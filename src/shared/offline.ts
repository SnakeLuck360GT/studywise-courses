// Offline mode: nothing calls the AI, and studying only asks questions that
// are made and marked without it. Kept per device (settings don't sync), so a
// phone on the train can be offline while the computer at home isn't.

export const OFFLINE_SETTING = 'offline.enabled'

export const OFFLINE_MESSAGE = 'Offline mode is on, so nothing uses AI. Turn it off (Offline at the top, or Settings → General) to use AI again.'

/** Deck question types offline mode never asks: free answers are marked by AI, and sorting into groups needs AI to make the groups. */
export const OFFLINE_SKIPPED_TYPES = ['free_answer', 'categorize'] as const
