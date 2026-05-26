import { describe, expect, it } from 'vitest';

import { isStaleSessionError } from './stale-session.js';

describe('isStaleSessionError', () => {
  describe('existing patterns (regression)', () => {
    it('matches "no conversation found"', () => {
      expect(
        isStaleSessionError('Error: no conversation found for session xyz'),
      ).toBe(true);
    });

    it('matches missing jsonl file (ENOENT)', () => {
      expect(
        isStaleSessionError(
          "ENOENT: no such file or directory, open '/tmp/abc.jsonl'",
        ),
      ).toBe(true);
    });

    it('matches "session not found"', () => {
      expect(isStaleSessionError('session abc-123 not found')).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(isStaleSessionError('NO CONVERSATION FOUND')).toBe(true);
    });
  });

  describe('SDK startup-failure signals (new)', () => {
    it('matches EPIPE write failure (agent process died on resume)', () => {
      // Real error captured 2026-05-26: SDK crashed on resume of an 11MB session
      // jsonl, agent-runner stdout write hit EPIPE.
      const error =
        "Process exited with code 1: loseNT (node:internal/streams/destroy:129:3)\n" +
        '    at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {\n' +
        "  errno: -32,\n  code: 'EPIPE',\n  syscall: 'write'\n}\n";
      expect(isStaleSessionError(error)).toBe(true);
    });

    it('matches SDK error_during_execution result subtype', () => {
      const error =
        'Process exited with code 1: ' +
        '[agent-runner] Result #1: subtype=error_during_execution';
      expect(isStaleSessionError(error)).toBe(true);
    });
  });

  describe('unrelated failures should not trigger session clear', () => {
    it('does not match generic timeout', () => {
      expect(isStaleSessionError('Process timed out after 600000ms')).toBe(
        false,
      );
    });

    it('does not match generic non-zero exit without known signals', () => {
      expect(
        isStaleSessionError('Process exited with code 1: command not found'),
      ).toBe(false);
    });

    it('does not match empty error', () => {
      expect(isStaleSessionError('')).toBe(false);
    });
  });
});
