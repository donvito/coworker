/**
 * Shared protocol for channel discussions.
 *
 * A coworker signals it has nothing substantive to add to a discussion turn by
 * replying with only the pass marker. The coordinator counts consecutive
 * passes to conclude a discussion early, and the UI renders passes as quiet
 * notes instead of full messages.
 */
export const DISCUSSION_PASS_MARKER = "PASS";

export function isDiscussionPass(text: string | null | undefined): boolean {
  if (!text) return false;
  return /^pass[.!]?$/i.test(text.trim());
}
