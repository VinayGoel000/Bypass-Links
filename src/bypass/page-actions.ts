/**
 * Pure helpers for detecting "continue / get link" style action buttons
 * on shortener pages. The regex sources are exported so the browser
 * engine can pass them into `page.evaluate` (which cannot import
 * Node modules) while unit tests exercise the same patterns here.
 */

/** Regex sources (no flags) matched against a button's visible text. */
export const ACTION_TEXT_PATTERNS: string[] = [
  String.raw`^get\s*(your\s*)?links?$`, // Get Link / Get Your Link
  String.raw`^click\s+here\s+to\s+continue$`, // Click here to continue
  String.raw`^continue(\s+to(\s+(the\s+)?links?)?)?$`, // Continue / Continue to Link
  String.raw`^proceed(\s+to(\s+link)?)?$`, // Proceed
  String.raw`^unlock(\s+(my|the))?\s*links?$`, // Unlock Link / Unlock My Link
  String.raw`^download(\s+link)?s?$`, // Download / Download Link
  String.raw`^visit(\s+(the\s+)?links?)?$`, // Visit Link
  String.raw`^generate(\s+link)?s?$`, // Generate Link
  String.raw`^verify\s*&\s*continue$`, // Verify & Continue
  String.raw`^i'?m\s+not\s+a\s+robot$`, // custom human checkbox (best effort)
];

/** Returns true if the given visible text looks like a bypass action button. */
export function matchesActionText(text: string): boolean {
  const t = (text || "").trim().replace(/\s+/g, " ");
  if (!t) return false;
  return ACTION_TEXT_PATTERNS.some((p) => new RegExp(p, "i").test(t));
}

/** Id / class fragments that usually mark the main action button. */
export const ACTION_SELECTOR_HINTS: string[] = [
  "getlink",
  "get-link",
  "get_link",
  "getLink",
  "continue-btn",
  "continue_btn",
  "btn-continue",
  "proceed",
  "unlock-link",
  "download-link",
];

/** Phrases meaning "the timer finished, the link should be ready". */
const TIMER_DONE_PHRASES: string[] = [
  "timer complete",
  "timer is complete",
  "timer ended",
  "timer done",
  "timer finished",
  "link is ready",
  "links are ready",
  "your link is ready",
  "get link button has been enabled",
  "click to get link",
  "you can now continue",
];

/** Returns true if page body text indicates the wait/timer is over. */
export function isTimerDoneText(bodyText: string): boolean {
  const t = (bodyText || "").toLowerCase();
  return TIMER_DONE_PHRASES.some((p) => t.includes(p));
}

/** Returns true if a timer element's text looks finished (0 / done / ready). */
export function isTimerElementDone(timerText: string): boolean {
  const t = (timerText || "").trim().toLowerCase();
  if (!t) return false;
  if (/\b(complete|completed|done|finished|ready|expired)\b/.test(t)) return true;
  // A lone zero, or "0 seconds" style countdown at zero
  if (/^0+(\D|$)/.test(t)) return true;
  if (/\b0\s*(sec(ond)?s?|s)\b/.test(t)) return true;
  return false;
}
