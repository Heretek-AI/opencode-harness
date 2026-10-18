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
  shellNamedFileTargets,
  shellRedirectTargets,
  shellTeeTargets,
  type GuardRequest,
} from "../src/guards/permission-guard";
import {
  classifyShellCommand,
  isDestructiveShellCommand,
  isFileMutatingShellCommand,
} from "../src/guards/shell-parse";
import {
  clearTaintState,
  evaluateTaintGuard,
  recordUntrustedContentTaint,
} from "../src/guards/taint-guard";

function verdict(request: GuardRequest) {
  return evaluateBoardGuard(request, defaultGuardConfig());
}

describe("shell-parse classifier", () => {
  test("flags the six destructive operations", () => {
    expect(isDestructiveShellCommand("rm -rf /")).toBe(true);
    // `sudo` never launders a traversal wipe: `/tmp/../` normalizes to `/`.
    expect(isDestructiveShellCommand("sudo rm -rf /tmp/../")).toBe(true);
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

describe("OH-6.5 P0 parser evasions (xargs, backticks, deep nesting, find-exec)", () => {
  test("xargs preserves payload flags: xargs rm -rf / is destructive (OH-6.5-xargs-rf-strip)", () => {
    for (const command of [
      "xargs rm -rf /",
      "xargs -0 rm -rf /",
      "xargs rm -rf / < /dev/null",
      "echo x | xargs rm -rf /",
      "xargs -r -0 rm -rf /",
      "xargs -I{} rm -rf /",
    ]) {
      expect(isDestructiveShellCommand(command)).toBe(true);
      expect(
        evaluateBoardGuard({ role: "builder", tool: "shell", command }).allowed,
      ).toBe(false);
    }
    // Bare xargs (defaults to echo) stays write-class, never destructive.
    expect(classifyShellCommand("xargs echo hi").class).toBe("write");
  });

  test("backtick substitution is destructive like $() (OH-6.5-backtick-substitution)", () => {
    expect(isDestructiveShellCommand("rm -rf $(echo /)")).toBe(true);
    expect(isDestructiveShellCommand("rm -rf `echo /`")).toBe(true);
    for (const command of ["rm -rf $(echo /)", "rm -rf `echo /`"]) {
      expect(classifyShellCommand(command).class).toBe("destructive");
      expect(
        evaluateBoardGuard({ role: "builder", tool: "shell", command }).allowed,
      ).toBe(false);
    }
  });

  test("5- and 6-deep bash -c nesting of rm -rf / is destructive (OH-6.5-deep-nesting-depth)", () => {
    const nest = (inner: string, depth: number): string => {
      let cmd = inner;
      for (let i = 0; i < depth; i++) {
        cmd = `bash -c ${JSON.stringify(cmd)}`;
      }
      return cmd;
    };
    for (const depth of [4, 5, 6, 9]) {
      const command = nest("rm -rf /", depth);
      expect(classifyShellCommand(command).class).toBe("destructive");
      expect(
        evaluateBoardGuard({ role: "builder", tool: "shell", command }).allowed,
      ).toBe(false);
    }
  });

  test("find -exec payloads unwrap; find / -delete is destructive (OH-6.5-find-exec-unwrapped)", () => {
    expect(isDestructiveShellCommand("find . -exec rm -rf / \\;")).toBe(true);
    expect(isDestructiveShellCommand("find / -delete")).toBe(true);
    expect(
      evaluateBoardGuard({ role: "builder", tool: "shell", command: "find . -exec rm -rf / \\;" })
        .allowed,
    ).toBe(false);
    // Scoped deletes stay write-class, not destructive.
    expect(classifyShellCommand("find /tmp -name x -delete").class).toBe("write");
    expect(isDestructiveShellCommand("find /tmp -name x -delete")).toBe(false);
  });
});

describe("shell redirect/tee target extraction", () => {
  test("shellRedirectTargets finds >, >>, and quoted targets, skipping /dev/null", () => {
    expect(shellRedirectTargets("echo x > out.txt")).toEqual(["out.txt"]);
    expect(shellRedirectTargets("echo x >> logs/a.txt 2> /dev/null")).toEqual(["logs/a.txt"]);
    expect(shellRedirectTargets('echo x > "spaced name.txt"')).toEqual(["spaced name.txt"]);
    expect(shellRedirectTargets("echo x > 'single quoted.txt'")).toEqual(["single quoted.txt"]);
    expect(shellRedirectTargets("git status")).toEqual([]);
  });

  test("shellTeeTargets finds tee and sudo tee targets, skipping flags", () => {
    expect(shellTeeTargets("echo x | tee out.txt")).toEqual(["out.txt"]);
    expect(shellTeeTargets("echo x | tee -a a.txt b.txt")).toEqual(["a.txt", "b.txt"]);
    expect(shellTeeTargets("echo x | sudo tee /etc/hosts")).toEqual(["/etc/hosts"]);
    expect(shellTeeTargets("git status")).toEqual([]);
  });

  test("shellNamedFileTargets unions both", () => {
    expect(shellNamedFileTargets("echo x > a.txt | tee b.txt")).toEqual(["a.txt", "b.txt"]);
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
      expect(result.rule).toBe("rule-3a-qa-src-lock");
      expect(verdict({ role, tool: "patch", path: "src/guards/x.ts" }).allowed).toBe(false);
    }
  });

  test("denies QA edits on allowlisted-under-src paths with the src rule (OH-6.3-src-prefix-untested)", () => {
    for (const role of ["qa-adversary", "agency-qa"]) {
      const result = verdict({ role, tool: "edit", path: "src/a.test.ts" });
      expect(result.allowed).toBe(false);
      expect(result.rule).toBe("rule-3a-qa-src-lock");
    }
  });

  test("denies QA edits outside the writable allow-list with the allowlist rule", () => {
    const result = verdict({ role: "qa-adversary", tool: "edit", path: "package.json" });
    expect(result.allowed).toBe(false);
    expect(result.rule).toBe("rule-3b-qa-allowlist");
  });

  test("denies file-mutating shell for QA roles (OH-6.3-qa-shell-bypass)", () => {
    for (const command of [
      "rm src/index.ts",
      "echo evil > src/evil.ts",
      "sed -i s/a/b/ src/x.ts",
      "git checkout -- src/x.ts",
      "mv src/a.ts src/b.ts",
      "touch src/new.ts",
    ]) {
      for (const role of ["qa-adversary", "agency-qa"]) {
        const result = verdict({ role, tool: "bash", command });
        expect(result.allowed).toBe(false);
        expect(result.rule).toBe("rule-3-qa-source-lock");
      }
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

  test("denies locked contract writes via shell redirect and tee (OH-6.4-contract-shell-bypass)", () => {
    for (const command of [
      "echo evil > api/contracts/v1.json",
      "echo evil >> api/contracts/v1.json",
      'echo evil > "api/contracts/v1.json"',
      "echo evil | tee api/contracts/v1.json",
      "echo evil | tee -a api/contracts/v1.json",
      "echo evil | sudo tee api/contracts/v1.json",
      "echo evil > x/schemas/a.schema.json",
    ]) {
      const result = verdict({ role: "programmer", tool: "bash", command });
      expect(result.allowed).toBe(false);
      expect(result.rule).toBe("rule-4-contract-lock");
    }
    // The architect stays allowed through the shell leg too.
    expect(
      verdict({ role: "architect", tool: "bash", command: "echo evil > api/contracts/v1.json" })
        .allowed,
    ).toBe(true);
    // Non-contract redirect targets stay allowed for ordinary roles.
    expect(
      verdict({ role: "programmer", tool: "bash", command: "echo evil > src/evil.ts" }).allowed,
    ).toBe(true);
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

  test("confines shell redirect targets to owned globs (OH-6.4-task-owned-shell-bypass)", () => {
    const config = { lockedContractGlobs: [] as string[], taskOwnedPaths: { worker: ["src/a/**"] } };
    const outside = evaluateBoardGuard(
      { role: "worker", tool: "bash", command: "echo evil > src/b/evil.ts" },
      config,
    );
    expect(outside.allowed).toBe(false);
    expect(outside.rule).toBe("rule-5-task-owned-paths");
    const outsideTee = evaluateBoardGuard(
      { role: "worker", tool: "bash", command: "echo evil | tee src/b/evil.ts" },
      config,
    );
    expect(outsideTee.allowed).toBe(false);
    expect(outsideTee.rule).toBe("rule-5-task-owned-paths");
    expect(
      evaluateBoardGuard({ role: "worker", tool: "bash", command: "echo ok > src/a/ok.ts" }, config)
        .allowed,
    ).toBe(true);
  });
});

describe("permission-guard staff roles (OH-8.3)", () => {
  test("staff-backend and staff-ui follow the builder policy", () => {
    for (const role of ["staff-backend", "staff-ui"]) {
      expect(verdict({ role, tool: "edit", path: "src/x.ts" }).allowed).toBe(true);
      expect(verdict({ role, tool: "shell", command: "rm -rf /" }).allowed).toBe(false);
      expect(verdict({ role, tool: "edit", path: "api/contracts/v1.json" }).allowed).toBe(false);
      expect(verdict({ role, tool: "edit", path: "src/x.ts" }).rule).toBe(undefined);
    }
  });
});

describe("OH-6.5-root-normalization: slash/dot-dot/tilde wipe-root spellings are destructive (P0)", () => {
  const ATTACK_ROLES = ["builder", "architect", "director", "qa-adversary"];

  test("rm -rf over normalized wipe roots is destructive for every role", () => {
    for (const command of [
      "rm -rf //",
      "rm -rf ///",
      "rm -rf /.",
      "rm -rf /./",
      "rm -rf /../",
      "rm -rf /tmp/../",
      "rm -rf ~root",
      "rm -rf ~root/.ssh",
    ]) {
      expect(classifyShellCommand(command).class).toBe("destructive");
      expect(isDestructiveShellCommand(command)).toBe(true);
      for (const role of ATTACK_ROLES) {
        const result = verdict({ role, tool: "shell", command });
        expect(result.allowed).toBe(false);
        expect(result.rule).toBe("rule-1-destructive");
      }
    }
  });

  test("find -exec placeholder wipe over normalized/escaping roots is destructive for every role", () => {
    for (const command of [
      "find // -exec rm -rf {} \\;",
      "find /./ -exec rm -rf {} \\;",
      "find /tmp/../ -exec rm -rf {} \\;",
      "find .. -exec rm -rf {} \\;",
      "find ~root -exec rm -rf {} \\;",
    ]) {
      expect(classifyShellCommand(command).class).toBe("destructive");
      expect(isDestructiveShellCommand(command)).toBe(true);
      for (const role of ATTACK_ROLES) {
        const result = verdict({ role, tool: "shell", command });
        expect(result.allowed).toBe(false);
        expect(result.rule).toBe("rule-1-destructive");
      }
    }
  });

  test("find -delete over normalized/escaping roots is destructive for every role", () => {
    for (const command of ["find // -delete", "find /tmp/../ -delete", "find .. -delete"]) {
      expect(classifyShellCommand(command).class).toBe("destructive");
      expect(isDestructiveShellCommand(command)).toBe(true);
      for (const role of ATTACK_ROLES) {
        const result = verdict({ role, tool: "shell", command });
        expect(result.allowed).toBe(false);
        expect(result.rule).toBe("rule-1-destructive");
      }
    }
  });

  test("tainted sessions deny every root-normalization probe at the taint layer", () => {
    const session = `oh65-root-norm-taint-${Date.now()}`;
    const commands = [
      "rm -rf //",
      "rm -rf ///",
      "rm -rf /.",
      "rm -rf /./",
      "rm -rf /../",
      "rm -rf /tmp/../",
      "rm -rf ~root",
      "rm -rf ~root/.ssh",
      "find // -exec rm -rf {} \\;",
      "find /./ -exec rm -rf {} \\;",
      "find /tmp/../ -exec rm -rf {} \\;",
      "find .. -exec rm -rf {} \\;",
      "find ~root -exec rm -rf {} \\;",
      "find // -delete",
      "find /tmp/../ -delete",
      "find .. -delete",
    ];
    for (const command of commands) {
      recordUntrustedContentTaint(session, "webfetch");
      const tainted = evaluateTaintGuard(session, command, "shell");
      expect(tainted.action).toBe("deny");
      expect(tainted.ruleId).toBe("TAINT-DESTRUCTIVE-1");
      clearTaintState(session);
    }
  });

  test("scoped controls stay write-class and allowed for builder", () => {
    for (const command of [
      "rm -rf /tmp",
      "rm -rf /tmp/wave1-abcd",
      "rm -rf /var/tmp/app",
      "find /tmp -name x -exec rm -rf {} \\;",
      "find /tmp -name x -exec rm -rf {}/foo \\;",
      "find . -exec rm -rf {} \\;",
      "find . -exec rm -rf {}/foo \\;",
      "find /tmp -name x -delete",
    ]) {
      expect(classifyShellCommand(command).class).toBe("write");
      expect(isDestructiveShellCommand(command)).toBe(false);
      expect(verdict({ role: "builder", tool: "shell", command }).allowed).toBe(true);
    }
  });
});

describe("OH-6.5-embedded-placeholder: suffixed/embedded {} is a placeholder wipe (P1)", () => {
  const ATTACK_ROLES = ["builder", "architect", "director", "qa-adversary"];

  test("embedded {} payloads over / are destructive for every role", () => {
    for (const command of [
      "find / -exec rm -rf {}/foo \\;",
      "find / -exec rm -rf {}foo \\;",
      "find / -exec rm -rf prefix{} \\;",
      "find / -exec rm -rf -- {}/foo \\;",
    ]) {
      expect(classifyShellCommand(command).class).toBe("destructive");
      expect(isDestructiveShellCommand(command)).toBe(true);
      for (const role of ATTACK_ROLES) {
        const result = verdict({ role, tool: "shell", command });
        expect(result.allowed).toBe(false);
        expect(result.rule).toBe("rule-1-destructive");
      }
    }
  });

  test("embedded {} also denies with -ok terminators", () => {
    for (const command of [
      "find / -ok rm -rf {}/foo \\;",
      "find / -ok rm -rf {}foo \\;",
      "find / -ok rm -rf prefix{} \\;",
    ]) {
      expect(isDestructiveShellCommand(command)).toBe(true);
      for (const role of ATTACK_ROLES) {
        const result = verdict({ role, tool: "shell", command });
        expect(result.allowed).toBe(false);
        expect(result.rule).toBe("rule-1-destructive");
      }
    }
  });

  test("tainted sessions deny embedded {} wipes at the taint layer", () => {
    const session = `oh65-embedded-taint-${Date.now()}`;
    for (const command of [
      "find / -exec rm -rf {}/foo \\;",
      "find / -exec rm -rf {}foo \\;",
      "find / -exec rm -rf prefix{} \\;",
      "find / -exec rm -rf -- {}/foo \\;",
    ]) {
      recordUntrustedContentTaint(session, "webfetch");
      const tainted = evaluateTaintGuard(session, command, "shell");
      expect(tainted.action).toBe("deny");
      expect(tainted.ruleId).toBe("TAINT-DESTRUCTIVE-1");
      clearTaintState(session);
    }
  });

  test("scoped embedded-{} controls stay write-class and allowed", () => {
    for (const command of [
      "find /tmp -name x -exec rm -rf {}/foo \\;",
      "find . -name x -exec rm -rf {}/foo \\;",
    ]) {
      expect(classifyShellCommand(command).class).toBe("write");
      expect(isDestructiveShellCommand(command)).toBe(false);
      expect(verdict({ role: "builder", tool: "shell", command }).allowed).toBe(true);
    }
  });
});
