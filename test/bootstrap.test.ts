// Step 0 bootstrap smoke test: verifies the placeholder plugin entrypoint
// exports its identity constants. Wave suites (editors, guards,
// circuit-breaker, context-budget, dom-auditor) replace/extend this file.
import { describe, expect, test } from "bun:test";
import { HARNESS_NAME, HARNESS_VERSION } from "../src/index";

describe("bootstrap entrypoint", () => {
  test("exposes the published package identity", () => {
    expect(HARNESS_NAME).toBe("@heretek-ai/opencode-harness");
    expect(HARNESS_VERSION).toBe("1.0.0");
  });
});
