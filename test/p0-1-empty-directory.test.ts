/**
 * `test/p0-1-empty-directory.test.ts` — P0-1 regression: empty-string host
 * roots must fall back to `process.cwd()` instead of throwing fail-closed.
 *
 * Exercises the REAL `setupOpenCodeV2Harness` from `src/index.ts` with a
 * minimal fake host (same pattern as `test/host-contract.test.ts`).
 */
import { describe, expect, test } from "bun:test";
import {
  resolveHarnessOptions,
  setupOpenCodeV2Harness,
  type OpenCodeV2PromiseContext,
} from "../src/index";

function fakeHost(
  overrides: Partial<OpenCodeV2PromiseContext> = {},
): OpenCodeV2PromiseContext {
  const registration = () =>
    Promise.resolve({ dispose: async () => {} });
  return {
    tool: {
      transform: (fn) => {
        fn({ namespace: () => {}, add: () => {} });
        return registration() as never;
      },
      hook: () => registration() as never,
    },
    permission: { hook: () => registration() as never },
    session: { hook: () => registration() as never },
    shell: { hook: () => registration() as never },
    ...overrides,
  };
}

describe("P0-1 empty-directory guard", () => {
  test("setup({ directory: '' }) does not throw; workspaceRoot equals process.cwd()", () => {
    const ctx = fakeHost({ directory: "" });
    let result: ReturnType<typeof setupOpenCodeV2Harness> | undefined;
    expect(() => {
      result = setupOpenCodeV2Harness(ctx);
    }).not.toThrow();
    expect(result!.report.workspaceRoot).toBe(process.cwd());
  });

  test("setup({ directory: '   ' }) does not throw; falls back to process.cwd()", () => {
    const ctx = fakeHost({ directory: "   " });
    let result: ReturnType<typeof setupOpenCodeV2Harness> | undefined;
    expect(() => {
      result = setupOpenCodeV2Harness(ctx);
    }).not.toThrow();
    expect(result!.report.workspaceRoot).toBe(process.cwd());
  });

  test("setup({ worktree: '' }) does not throw", () => {
    const ctx = fakeHost({
      directory: undefined,
      worktree: "",
    });
    let result: ReturnType<typeof setupOpenCodeV2Harness> | undefined;
    expect(() => {
      result = setupOpenCodeV2Harness(ctx);
    }).not.toThrow();
    expect(result!.report.workspaceRoot).toBe(process.cwd());
  });

  test("setup({ location: { directory: '' } }) does not throw", () => {
    const ctx = fakeHost({
      directory: undefined,
      worktree: undefined,
      location: { directory: "" },
    });
    let result: ReturnType<typeof setupOpenCodeV2Harness> | undefined;
    expect(() => {
      result = setupOpenCodeV2Harness(ctx);
    }).not.toThrow();
    expect(result!.report.workspaceRoot).toBe(process.cwd());
  });

  test("setup({ location: { worktree: '   ' } }) does not throw", () => {
    const ctx = fakeHost({
      directory: undefined,
      worktree: undefined,
      location: { worktree: "   " },
    });
    let result: ReturnType<typeof setupOpenCodeV2Harness> | undefined;
    expect(() => {
      result = setupOpenCodeV2Harness(ctx);
    }).not.toThrow();
    expect(result!.report.workspaceRoot).toBe(process.cwd());
  });

  test("setup({ directory: '', worktree: '/tmp' }) resolves to '/tmp' (first non-empty wins)", () => {
    const ctx = fakeHost({ directory: "", worktree: "/tmp" });
    let result: ReturnType<typeof setupOpenCodeV2Harness> | undefined;
    expect(() => {
      result = setupOpenCodeV2Harness(ctx);
    }).not.toThrow();
    expect(result!.report.workspaceRoot).toBe("/tmp");
  });

  test("setup({ directory: '\\t\\n ' }) whitespace-only falls back to process.cwd()", () => {
    const ctx = fakeHost({ directory: "\t\n " });
    let result: ReturnType<typeof setupOpenCodeV2Harness> | undefined;
    expect(() => {
      result = setupOpenCodeV2Harness(ctx);
    }).not.toThrow();
    expect(result!.report.workspaceRoot).toBe(process.cwd());
  });

  test("resolveHarnessOptions({ rootDir: '' }) still throws fail-closed", () => {
    expect(() => resolveHarnessOptions({ rootDir: "" })).toThrow(
      "fail-closed",
    );
  });

  test("resolveHarnessOptions({ rootDir: '   ' }) still throws fail-closed", () => {
    expect(() => resolveHarnessOptions({ rootDir: "   " })).toThrow(
      "fail-closed",
    );
  });
});
