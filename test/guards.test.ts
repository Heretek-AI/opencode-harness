/**
 * `test/guards.test.ts` — Wave 1 guard suite.
 *
 * Covers `src/guards/shell-parse.ts` (read-only vs write vs destructive
 * classification) and `src/guards/permission-guard.ts` (Rules 0–4 plus
 * per-role task-owned paths).
 */
import { describe, expect, test } from "bun:test";
import {
  defaultGuardConfig,
  evaluateBoardGuard,
  matchesAnyGlob,
  type GuardRequest,
} from "../src/guards/permission-guard";
import {
  classifyShellCommand,
  isDestructiveShellCommand,
  isFileMutatingShellCommand,
} from "../src/guards/shell-parse";

function verdict(request: GuardRequest) {
  return evaluateBoardGuard(request, defaultGuardConfig());
}

describe("shell-parse classifier", () => {
  test("flags the six destructive operations", () => {
    expect(isDestructiveShellCommand("rm -rf /")).toBe(true);
    expect(isDestructiveShellCommand("sudo rm -rf /tmp/../")).toBe(false);
    expect(isDestructiveShellCommand("rm -rf *")).toBe(true);
    expect(isDestructiveShellCommand("rm -fr /")).toBe(true);
    expect(isDestructiveShellCommand("git reset --hard")).toBe(true);
    expect(isDestructiveShellCommand("git push --force origin main")).toBe(true);
    expect(isDestructiveShellCommand("mkfs.ext4 /dev/sda1")).toBe(true);
    expect(isDestructiveShellCommand("dd if=/dev/zero of=/dev/sda")).toBe(true);
  });

  test("treats scoped recursive deletes as write-class, not destructive", () => {
    expect(classifyShellCommand("rm -rf /tmp/wave1-abcd").class).toBe("write");
    expect(isDestructiveShellCommand("rm -rf /tmp/wave1-abcd")).toBe(false);
  });

  test("detects destructive commands inside chains", () => {
    expect(classifyShellCommand("bun test && rm -rf /").class).toBe("destructive");
    expect(classifyShellCommand("echo hi; git reset --hard").class).toBe("destructive");
  });

  test("classifies mutating operations as write", () => {
    expect(isFileMutatingShellCommand("echo data > out.txt")).toBe(true);
    expect(isFileMutatingShellCommand("git commit -m msg")).toBe(true);
    expect(isFileMutatingShellCommand("git checkout main")).toBe(true);
    expect(isFileMutatingShellCommand("bun install")).toBe(true);
    expect(isFileMutatingShellCommand("mkdir -p build/out")).toBe(true);
    expect(isFileMutatingShellCommand("sed -i s/a/b/ file.txt")).toBe(true);
  });

  test("classifies inspection and verification commands as read-only", () => {
    expect(classifyShellCommand("git status").class).toBe("read-only");
    expect(classifyShellCommand("git log --oneline").class).toBe("read-only");
    expect(classifyShellCommand("git diff HEAD").class).toBe("read-only");
    expect(classifyShellCommand("bun test").class).toBe("read-only");
    expect(classifyShellCommand("bun run check").class).toBe("read-only");
    expect(classifyShellCommand("make check").class).toBe("read-only");
    expect(classifyShellCommand("bash scripts/accept/wave-1.sh").class).toBe("read-only");
    expect(classifyShellCommand("ls -la src").class).toBe("read-only");
    expect(classifyShellCommand("").class).toBe("read-only");
  });
});

describe("matchesAnyGlob", () => {
  test("supports **, *, and ? wildcards", () => {
    expect(matchesAnyGlob("src/index.ts", ["src/**"])).toBe(true);
    expect(matchesAnyGlob("a/contracts/b.json", ["**/contracts/**"])).toBe(true);
    expect(matchesAnyGlob("x/schemas/a.schema.json", ["**/schemas/*.schema.json"])).toBe(true);
    expect(matchesAnyGlob("x/schemas/a.json", ["**/schemas/*.schema.json"])).toBe(false);
    expect(matchesAnyGlob("test/a.test.ts", ["**/*.test.*"])).toBe(true);
    expect(matchesAnyGlob("src/a.test.ts", ["test/**"])).toBe(false);
  });
});

describe("permission-guard Rule 0 (fail-closed safety)", () => {
  test("denies unknown tools, empty roles, and escaping paths", () => {
    expect(verdict({ role: "programmer", tool: "teleport", path: "src/a.ts" }).allowed).toBe(false);
    expect(verdict({ role: "", tool: "read", path: "src/a.ts" }).allowed).toBe(false);
    expect(verdict({ role: "programmer", tool: "edit", path: "../outside.ts" }).allowed).toBe(false);
    expect(verdict({ role: "programmer", tool: "edit", path: "/etc/passwd" }).allowed).toBe(false);
    expect(verdict({ role: "programmer", tool: "edit" }).allowed).toBe(false);
    expect(verdict({ role: "programmer", tool: "shell", command: "   " }).allowed).toBe(false);
  });
});

describe("permission-guard Rule 1 (destructive block)", () => {
  test("denies destructive shell for every role including architect", () => {
    for (const role of ["architect", "programmer", "director", "qa-adversary", "agency-qa"]) {
      const result = verdict({ role, tool: "shell", command: "rm -rf /" });
      expect(result.allowed).toBe(false);
      expect(result.rule).toBe("rule-1-destructive");
    }
    expect(verdict({ role: "architect", tool: "bash", command: "git reset --hard" }).allowed).toBe(
      false,
    );
    expect(verdict({ role: "root", tool: "shell", command: "dd if=/dev/zero of=/dev/sda" }).allowed).toBe(
      false,
    );
  });
});

describe("permission-guard Rule 2 (leadership read-only)", () => {
  test("denies edits, writes, patches, and mutating shell for leadership", () => {
    for (const role of ["director", "manager", "agency-coordinator", "agency-drift-guard"]) {
      expect(verdict({ role, tool: "edit", path: "docs/plan.md" }).allowed).toBe(false);
      expect(verdict({ role, tool: "write", path: "docs/plan.md" }).allowed).toBe(false);
      expect(verdict({ role, tool: "patch", path: "docs/plan.md" }).allowed).toBe(false);
      expect(verdict({ role, tool: "file_hash_edit", path: "docs/plan.md" }).allowed).toBe(false);
      expect(verdict({ role, tool: "shell", command: "echo x > docs/plan.md" }).allowed).toBe(false);
    }
  });

  test("permits read tools and read-only shell for leadership", () => {
    expect(verdict({ role: "director", tool: "read", path: "src/index.ts" }).allowed).toBe(true);
    expect(verdict({ role: "manager", tool: "shell", command: "git status" }).allowed).toBe(true);
    expect(verdict({ role: "agency-drift-guard", tool: "shell", command: "bun test" }).allowed).toBe(
      true,
    );
  });
});

describe("permission-guard Rule 3 (QA red-team source lock)", () => {
  test("denies qa-adversary and agency-qa edits on src/**", () => {
    for (const role of ["qa-adversary", "agency-qa"]) {
      const result = verdict({ role, tool: "edit", path: "src/index.ts" });
      expect(result.allowed).toBe(false);
      expect(result.rule).toBe("rule-3-qa-source-lock");
      expect(verdict({ role, tool: "patch", path: "src/guards/x.ts" }).allowed).toBe(false);
    }
  });

  test("permits QA edits on test, spec, accept-script, and docs paths", () => {
    expect(verdict({ role: "qa-adversary", tool: "edit", path: "test/guards.test.ts" }).allowed).toBe(
      true,
    );
    expect(verdict({ role: "agency-qa", tool: "write", path: "tests/e2e.spec.ts" }).allowed).toBe(
      true,
    );
    expect(verdict({ role: "qa-adversary", tool: "edit", path: "scripts/accept/wave-1.sh" }).allowed).toBe(
      true,
    );
    expect(verdict({ role: "agency-qa", tool: "edit", path: "docs/evidence/note.md" }).allowed).toBe(
      true,
    );
  });

  test("denies QA edits outside the writable allow-list", () => {
    expect(verdict({ role: "qa-adversary", tool: "edit", path: "package.json" }).allowed).toBe(false);
    expect(verdict({ role: "agency-qa", tool: "edit", path: "Makefile" }).allowed).toBe(false);
  });

  test("permits QA reads and verification shell anywhere non-destructive", () => {
    expect(verdict({ role: "qa-adversary", tool: "read", path: "src/index.ts" }).allowed).toBe(true);
    expect(verdict({ role: "agency-qa", tool: "shell", command: "bun test" }).allowed).toBe(true);
  });
});

describe("permission-guard Rule 4 (architect contract lock)", () => {
  test("denies non-architect modifications of locked contract globs", () => {
    const result = verdict({ role: "programmer", tool: "edit", path: "api/contracts/v1.json" });
    expect(result.allowed).toBe(false);
    expect(result.rule).toBe("rule-4-contract-lock");
    expect(verdict({ role: "qa-adversary", tool: "edit", path: "docs/contracts/plan.md" }).allowed).toBe(
      false,
    );
    expect(
      verdict({ role: "director", tool: "shell", command: "rm api/contracts/v1.json" }).allowed,
    ).toBe(false);
  });

  test("permits the architect role on contract paths", () => {
    expect(verdict({ role: "architect", tool: "edit", path: "api/contracts/v1.json" }).allowed).toBe(
      true,
    );
  });

  test("permits non-contract edits for ordinary roles", () => {
    expect(verdict({ role: "programmer", tool: "edit", path: "src/index.ts" }).allowed).toBe(true);
  });

  test("honors custom lockedContractGlobs", () => {
    const custom = evaluateBoardGuard(
      { role: "programmer", tool: "edit", path: "locked/secret.md" },
      { lockedContractGlobs: ["locked/**"] },
    );
    expect(custom.allowed).toBe(false);
    expect(custom.rule).toBe("rule-4-contract-lock");
  });
});

describe("permission-guard taskOwnedPaths", () => {
  test("confines listed roles to their owned globs", () => {
    const config = { lockedContractGlobs: [] as string[], taskOwnedPaths: { worker: ["src/a/**"] } };
    expect(
      evaluateBoardGuard({ role: "worker", tool: "edit", path: "src/a/file.ts" }, config).allowed,
    ).toBe(true);
    const denied = evaluateBoardGuard(
      { role: "worker", tool: "edit", path: "src/b/file.ts" },
      config,
    );
    expect(denied.allowed).toBe(false);
    expect(denied.rule).toBe("rule-5-task-owned-paths");
  });
});
