// Patterns matching errors that indicate the prior session can't be resumed:
// - "no conversation found" / "session not found": SDK side reports stale id
// - missing .jsonl: session file was deleted/moved (e.g. disk full mid-write)
// - EPIPE: agent-runner's stdio pipe to the SDK subprocess died — observed
//   when SDK aborts immediately on resume of a large/corrupted session jsonl
// - error_during_execution: SDK's first-message result type when the
//   resumed conversation fails before any turn runs
const STALE_SESSION_PATTERNS =
  /no conversation found|ENOENT.*\.jsonl|session.*not found|EPIPE|error_during_execution/i;

export function isStaleSessionError(error: string): boolean {
  if (!error) return false;
  return STALE_SESSION_PATTERNS.test(error);
}
