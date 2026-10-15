/**
 * `test/circuit-breaker.test.ts` — Wave 1 doom-loop circuit breaker suite.
 *
 * Covers `src/guards/circuit-breaker.ts`: edit-threshold (>= 2 same path)
 * and shell-threshold (>= 3 same command prefix) critical interventions,
 * strict streak breaking, per-session isolation, and fail-closed inputs.
 */
import { describe, expect, test } from "bun:test";
import {
  clearAllSessionAttempts,
  commandPrefixOf,
  evaluateSession,
  normalizeToolKind,
  recordToolAttempt,
  resetSessionAttempts,
  sessionAttempts,
  type ToolAttemptRecord,
} from "../src/guards/circuit-breaker";

function fail(tool: string, extra: Partial<ToolAttemptRecord> = {}): ToolAttemptRecord {
  return { tool, ok: false, ...extra };
}

describe("normalizeToolKind and commandPrefixOf", () => {
  test("groups edit and shell families", () => {
    expect(normalizeToolKind("edit")).toBe("edit");
    expect(normalizeToolKind("patch")).toBe("edit");
    expect(normalizeToolKind("file_hash_edit")).toBe("edit");
    expect(normalizeToolKind("ast_structural_rewrite")).toBe("edit");
    expect(normalizeToolKind("shell")).toBe("shell");
    expect(normalizeToolKind("bash")).toBe("shell");
    expect(normalizeToolKind("read")).toBe("other");
    expect(normalizeToolKind("file_hash_read")).toBe("other");
  });

  test("derives a two-token prefix with collapsed whitespace", () => {
    expect(commandPrefixOf("git push --force origin main")).toBe("git push");
    expect(commandPrefixOf("  bun   test  ")).toBe("bun test");
    expect(commandPrefixOf("ls")).toBe("ls");
  });
});

describe("edit doom-loop threshold", () => {
  test("triggers critical intervention after 2 consecutive failed edits on one path", () => {
    const session = "edit-threshold";
    resetSessionAttempts(session);
    const first = recordToolAttempt(session, fail("edit", { path: "src/a.ts", error: "anchor mismatch" }));
    expect(first.triggered).toBe(false);
    expect(first.shouldEscalateModel).toBe(false);
    const second = recordToolAttempt(session, fail("edit", { path: "src/a.ts", error: "anchor mismatch" }));
    expect(second.triggered).toBe(true);
    expect(second.shouldEscalateModel).toBe(true);
    expect(second.severity).toBe("critical");
    expect(second.consecutiveFailures).toBe(2);
    expect(second.intervention).toContain('<circuit-breaker-intervention severity="critical">');
    expect(second.intervention).toContain("src/a.ts");
  });

  test("counts patch-family tools toward the same edit streak", () => {
    const session = "edit-family";
    resetSessionAttempts(session);
    recordToolAttempt(session, fail("edit", { path: "src/a.ts" }));
    const verdict = recordToolAttempt(session, fail("patch", { path: "src/a.ts" }));
    expect(verdict.triggered).toBe(true);
    expect(verdict.consecutiveFailures).toBe(2);
  });

  test("a success breaks the edit streak", () => {
    const session = "edit-reset";
    resetSessionAttempts(session);
    recordToolAttempt(session, fail("edit", { path: "src/a.ts" }));
    recordToolAttempt(session, { tool: "edit", ok: true, path: "src/a.ts" });
    const verdict = recordToolAttempt(session, fail("edit", { path: "src/a.ts" }));
    expect(verdict.triggered).toBe(false);
    expect(verdict.consecutiveFailures).toBe(1);
  });

  test("a different path breaks the edit streak", () => {
    const session = "edit-other-path";
    resetSessionAttempts(session);
    recordToolAttempt(session, fail("edit", { path: "src/a.ts" }));
    const verdict = recordToolAttempt(session, fail("edit", { path: "src/b.ts" }));
    expect(verdict.triggered).toBe(false);
    expect(verdict.consecutiveFailures).toBe(1);
  });

  test("an interleaved shell failure breaks the edit streak", () => {
    const session = "edit-interleaved";
    resetSessionAttempts(session);
    recordToolAttempt(session, fail("edit", { path: "src/a.ts" }));
    recordToolAttempt(session, fail("shell", { command: "bun test" }));
    const verdict = recordToolAttempt(session, fail("edit", { path: "src/a.ts" }));
    expect(verdict.triggered).toBe(false);
    expect(verdict.consecutiveFailures).toBe(1);
  });
});

describe("shell doom-loop threshold", () => {
  test("triggers critical intervention after 3 consecutive failed shell runs on one prefix", () => {
    const session = "shell-threshold";
    resetSessionAttempts(session);
    expect(
      recordToolAttempt(session, fail("shell", { command: "bun test --watch" })).triggered,
    ).toBe(false);
    expect(recordToolAttempt(session, fail("bash", { command: "bun test file.ts" })).triggered).toBe(
      false,
    );
    const third = recordToolAttempt(session, fail("shell", { command: "bun test other.ts" }));
    expect(third.triggered).toBe(true);
    expect(third.shouldEscalateModel).toBe(true);
    expect(third.severity).toBe("critical");
    expect(third.consecutiveFailures).toBe(3);
    expect(third.intervention).toContain('<circuit-breaker-intervention severity="critical">');
    expect(third.intervention).toContain("bun test");
  });

  test("groups by explicit commandPrefix when provided", () => {
    const session = "shell-explicit-prefix";
    resetSessionAttempts(session);
    recordToolAttempt(session, fail("shell", { commandPrefix: "bun test" }));
    recordToolAttempt(session, fail("shell", { commandPrefix: "bun test" }));
    const verdict = recordToolAttempt(session, fail("shell", { commandPrefix: "bun test" }));
    expect(verdict.triggered).toBe(true);
  });

  test("a different command prefix breaks the shell streak", () => {
    const session = "shell-other-prefix";
    resetSessionAttempts(session);
    recordToolAttempt(session, fail("shell", { command: "bun test a.ts" }));
    recordToolAttempt(session, fail("shell", { command: "bun test b.ts" }));
    const verdict = recordToolAttempt(session, fail("shell", { command: "make check" }));
    expect(verdict.triggered).toBe(false);
    expect(verdict.consecutiveFailures).toBe(1);
  });

  test("a shell success breaks the streak", () => {
    const session = "shell-success";
    resetSessionAttempts(session);
    recordToolAttempt(session, fail("shell", { command: "bun test a.ts" }));
    recordToolAttempt(session, fail("shell", { command: "bun test b.ts" }));
    recordToolAttempt(session, { tool: "shell", ok: true, command: "bun test c.ts" });
    const verdict = recordToolAttempt(session, fail("shell", { command: "bun test d.ts" }));
    expect(verdict.triggered).toBe(false);
    expect(verdict.consecutiveFailures).toBe(1);
  });
});

describe("session bookkeeping", () => {
  test("evaluateSession is quiet for empty and successful sessions", () => {
    const session = "quiet-session";
    resetSessionAttempts(session);
    expect(evaluateSession(session).triggered).toBe(false);
    recordToolAttempt(session, { tool: "edit", ok: true, path: "src/a.ts" });
    const verdict = evaluateSession(session);
    expect(verdict.triggered).toBe(false);
    expect(verdict.shouldEscalateModel).toBe(false);
  });

  test("ignores other-family tools", () => {
    const session = "other-tools";
    resetSessionAttempts(session);
    recordToolAttempt(session, fail("read", { path: "src/a.ts" }));
    recordToolAttempt(session, fail("read", { path: "src/a.ts" }));
    recordToolAttempt(session, fail("read", { path: "src/a.ts" }));
    expect(evaluateSession(session).triggered).toBe(false);
  });

  test("isolates sessions from each other", () => {
    resetSessionAttempts("iso-a");
    resetSessionAttempts("iso-b");
    recordToolAttempt("iso-a", fail("edit", { path: "src/a.ts" }));
    recordToolAttempt("iso-a", fail("edit", { path: "src/a.ts" }));
    expect(evaluateSession("iso-a").triggered).toBe(true);
    expect(evaluateSession("iso-b").triggered).toBe(false);
  });

  test("exposes the shared sessionAttempts map and reset helpers", () => {
    recordToolAttempt("map-check", fail("edit", { path: "src/a.ts" }));
    expect(sessionAttempts.has("map-check")).toBe(true);
    resetSessionAttempts("map-check");
    expect(sessionAttempts.has("map-check")).toBe(false);
    recordToolAttempt("map-check", fail("edit", { path: "src/a.ts" }));
    clearAllSessionAttempts();
    expect(sessionAttempts.size).toBe(0);
  });

  test("rejects fail-closed inputs", () => {
    let sessionMessage = "";
    try {
      recordToolAttempt("", fail("edit", { path: "src/a.ts" }));
    } catch (error) {
      sessionMessage = (error as Error).message;
    }
    expect(sessionMessage).toContain("fail-closed");
    let attemptMessage = "";
    try {
      recordToolAttempt("bad-attempt", { tool: "", ok: false });
    } catch (error) {
      attemptMessage = (error as Error).message;
    }
    expect(attemptMessage).toContain("fail-closed");
  });
});
