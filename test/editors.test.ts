/**
 * `test/editors.test.ts` — Wave 1 editor suite.
 *
 * Covers `src/editors/hashline-tools.ts` (FNV-1a line hashes, hash-anchored
 * reads, shifted-anchor edits with fail-closed mismatch handling) and
 * `src/editors/ast-codemod.ts` (structural search + rewrite with
 * metavariable substitution).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  astRewriteFile,
  astSearch,
  structuralFallbackSearch,
  substituteRewrite,
} from "../src/editors/ast-codemod";
import {
  computeLineHash,
  hashEditFile,
  hashReadFile,
} from "../src/editors/hashline-tools";

let roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wave1-editors-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots = [];
});

describe("computeLineHash", () => {
  test("produces lowercase 4-hex hashes", () => {
    expect(computeLineHash("hello world")).toMatch(/^[0-9a-f]{4}$/);
  });

  test("is deterministic across calls", () => {
    expect(computeLineHash("const x = 1;")).toBe(computeLineHash("const x = 1;"));
  });

  test("hashes trimmed content so padding whitespace does not move anchors", () => {
    expect(computeLineHash("  hello  ")).toBe(computeLineHash("hello"));
    expect(computeLineHash("\thello\n")).toBe(computeLineHash("hello"));
  });

  test("empty and whitespace-only lines hash the FNV offset basis low 16 bits", () => {
    expect(computeLineHash("")).toBe("9dc5");
    expect(computeLineHash("   ")).toBe("9dc5");
  });

  test("distinct lines usually hash distinctly", () => {
    const hashes = new Set(
      ["alpha", "beta", "gamma", "delta", "epsilon"].map((line) => computeLineHash(line)),
    );
    expect(hashes.size).toBe(5);
  });
});

describe("hashReadFile", () => {
  test("formats each line as <lineNo>#<hash>| <content>", async () => {
    const root = await makeRoot();
    await Bun.write(join(root, "sample.ts"), "const a = 1;\nconst b = 2;\n");
    const result = await hashReadFile(root, "sample.ts");
    expect(result.path).toBe("sample.ts");
    expect(result.totalLines).toBe(2);
    const expected =
      `1#${computeLineHash("const a = 1;")}| const a = 1;\n` +
      `2#${computeLineHash("const b = 2;")}| const b = 2;`;
    expect(result.content).toBe(expected);
  });

  test("supports 1-based offset and limit slices", async () => {
    const root = await makeRoot();
    await Bun.write(join(root, "nums.txt"), "one\ntwo\nthree\nfour\n");
    const result = await hashReadFile(root, "nums.txt", 2, 2);
    expect(result.totalLines).toBe(4);
    expect(result.content).toBe(
      `2#${computeLineHash("two")}| two\n3#${computeLineHash("three")}| three`,
    );
  });

  test("reads an empty file as zero lines with empty content", async () => {
    const root = await makeRoot();
    await Bun.write(join(root, "empty.txt"), "");
    const result = await hashReadFile(root, "empty.txt");
    expect(result.totalLines).toBe(0);
    expect(result.content).toBe("");
  });

  test("rejects unreadable files without partial output", async () => {
    const root = await makeRoot();
    let message = "";
    try {
      await hashReadFile(root, "missing.txt");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("fail-closed");
  });

  test("rejects escaping paths and invalid paging", async () => {
    const root = await makeRoot();
    await expect(hashReadFile(root, "../escape.txt")).rejects.toThrow("fail-closed");
    await expect(hashReadFile(root, "/abs.txt")).rejects.toThrow("fail-closed");
    await expect(hashReadFile(root, "x.txt", 0)).rejects.toThrow("fail-closed");
    await expect(hashReadFile(root, "x.txt", 1, 0)).rejects.toThrow("fail-closed");
  });
});

describe("hashEditFile", () => {
  test("applies a single-line replacement when anchors match", async () => {
    const root = await makeRoot();
    await Bun.write(join(root, "code.ts"), "const a = 1;\nconst b = 2;\n");
    const result = await hashEditFile(root, "code.ts", [
      {
        startLine: 2,
        startHash: computeLineHash("const b = 2;"),
        endLine: 2,
        endHash: computeLineHash("const b = 2;"),
        replacement: "const b = 3;",
      },
    ]);
    expect(result.applied).toBe(true);
    expect(result.shiftedLines).toBe(0);
    expect(await Bun.file(join(root, "code.ts")).text()).toBe("const a = 1;\nconst b = 3;\n");
  });

  test("replaces a multi-line range and reports the net line delta", async () => {
    const root = await makeRoot();
    await Bun.write(join(root, "code.ts"), "a\nb\nc\nd\n");
    const result = await hashEditFile(root, "code.ts", [
      {
        startLine: 2,
        startHash: computeLineHash("b"),
        endLine: 3,
        endHash: computeLineHash("c"),
        replacement: "B1\nB2\nB3",
      },
    ]);
    expect(result.applied).toBe(true);
    expect(result.shiftedLines).toBe(1);
    expect(await Bun.file(join(root, "code.ts")).text()).toBe("a\nB1\nB2\nB3\nd\n");
  });

  test("deletes a range when replacement is empty", async () => {
    const root = await makeRoot();
    await Bun.write(join(root, "code.ts"), "keep\nbye\nbye2\nkeep2\n");
    const result = await hashEditFile(root, "code.ts", [
      {
        startLine: 2,
        startHash: computeLineHash("bye"),
        endLine: 3,
        endHash: computeLineHash("bye2"),
        replacement: "",
      },
    ]);
    expect(result.applied).toBe(true);
    expect(result.shiftedLines).toBe(-2);
    expect(await Bun.file(join(root, "code.ts")).text()).toBe("keep\nkeep2\n");
  });

  test("resolves shifted anchors after an earlier hunk inserts lines", async () => {
    const root = await makeRoot();
    const body = ["line1", "line2", "line3", "line4", "line5", "line6"].join("\n") + "\n";
    await Bun.write(join(root, "shift.txt"), body);
    const result = await hashEditFile(root, "shift.txt", [
      {
        startLine: 2,
        startHash: computeLineHash("line2"),
        endLine: 2,
        endHash: computeLineHash("line2"),
        replacement: "line2\ninserted-a\ninserted-b",
      },
      {
        startLine: 5,
        startHash: computeLineHash("line5"),
        endLine: 5,
        endHash: computeLineHash("line5"),
        replacement: "LINE5",
      },
    ]);
    expect(result.applied).toBe(true);
    expect(result.shiftedLines).toBe(2);
    expect(await Bun.file(join(root, "shift.txt")).text()).toBe(
      "line1\nline2\ninserted-a\ninserted-b\nline3\nline4\nLINE5\nline6\n",
    );
  });

  test("fails closed without writing when an anchor hash mismatches", async () => {
    const root = await makeRoot();
    const before = "alpha\nbeta\ngamma\n";
    await Bun.write(join(root, "guard.txt"), before);
    const result = await hashEditFile(root, "guard.txt", [
      {
        startLine: 2,
        startHash: "dead",
        endLine: 2,
        endHash: "beef",
        replacement: "HACKED",
      },
    ]);
    expect(result.applied).toBe(false);
    expect(result.error).toContain("fail-closed");
    expect(await Bun.file(join(root, "guard.txt")).text()).toBe(before);
  });

  test("fails closed when the anchor drifted beyond the 25-line window", async () => {
    const root = await makeRoot();
    const lines = Array.from({ length: 60 }, (_, i) => `row-${i + 1}`);
    await Bun.write(join(root, "far.txt"), lines.join("\n") + "\n");
    const result = await hashEditFile(root, "far.txt", [
      {
        startLine: 1,
        startHash: computeLineHash("row-60"),
        endLine: 1,
        endHash: computeLineHash("row-60"),
        replacement: "MOVED",
      },
    ]);
    expect(result.applied).toBe(false);
    expect(result.error).toContain("fail-closed");
  });

  test("rejects malformed hunks without touching the file", async () => {
    const root = await makeRoot();
    const before = "one\ntwo\n";
    await Bun.write(join(root, "bad.txt"), before);
    const flipped = await hashEditFile(root, "bad.txt", [
      {
        startLine: 2,
        startHash: computeLineHash("two"),
        endLine: 1,
        endHash: computeLineHash("one"),
        replacement: "x",
      },
    ]);
    expect(flipped.applied).toBe(false);
    const malformed = await hashEditFile(root, "bad.txt", [
      {
        startLine: 1,
        startHash: "NOTAHASH",
        endLine: 1,
        endHash: computeLineHash("one"),
        replacement: "x",
      },
    ]);
    expect(malformed.applied).toBe(false);
    const empty = await hashEditFile(root, "bad.txt", []);
    expect(empty.applied).toBe(false);
    expect(await Bun.file(join(root, "bad.txt")).text()).toBe(before);
  });
});

describe("astSearch", () => {
  test("finds structural call matches with 1-based lines", () => {
    const code = 'const a = 1;\nconsole.log(a);\nconsole.log("hi");\n';
    const matches = astSearch(code, "console.log($VAR)", "typescript");
    expect(matches.length).toBe(2);
    expect(matches[0].startLine).toBe(2);
    expect(matches[0].text).toContain("console.log");
    expect(matches[1].startLine).toBe(3);
  });

  test("returns an empty array when nothing matches", () => {
    expect(astSearch("const a = 1;\n", "console.log($VAR)", "typescript")).toEqual([]);
  });

  test("supports tsx, javascript, python, rust, and go language aliases", () => {
    const code = "console.log(x);\n";
    for (const language of ["tsx", "javascript", "python", "rust", "go"] as const) {
      const matches = astSearch(code, "console.log($VAR)", language);
      expect(matches.length).toBeGreaterThan(0);
    }
  });

  test("structural fallback matches $VAR and $$$ARGS metavariables", () => {
    const code = "foo(1, 2);\nfoo(3);\nbar(1);\n";
    const matches = structuralFallbackSearch(code, "foo($$$ARGS)");
    expect(matches).toHaveLength(2);
    expect(matches[0].text).toBe("foo(1, 2)");
    expect(matches[1].startLine).toBe(2);
  });

  test("rejects empty patterns fail-closed", () => {
    let message = "";
    try {
      astSearch("const a = 1;", "", "typescript");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("fail-closed");
  });
});

describe("substituteRewrite", () => {
  test("flows captured metavariables into the rewrite template", () => {
    expect(substituteRewrite("console.log($MSG)", "logger.info($MSG)", 'console.log("hi")')).toBe(
      'logger.info("hi")',
    );
  });
});

describe("astRewriteFile", () => {
  test("rewrites matches and persists the output", async () => {
    const root = await makeRoot();
    await Bun.write(join(root, "app.ts"), 'console.log("a");\nconst x = 1;\nconsole.log("b");\n');
    const result = await astRewriteFile(root, "app.ts", "console.log($MSG)", "logger.info($MSG)");
    expect(result.modified).toBe(true);
    expect(result.matchCount).toBe(2);
    expect(result.output).toBe('logger.info("a");\nconst x = 1;\nlogger.info("b");\n');
    expect(await Bun.file(join(root, "app.ts")).text()).toBe(result.output);
  });

  test("leaves the file untouched when nothing matches", async () => {
    const root = await makeRoot();
    const before = "const x = 1;\n";
    await Bun.write(join(root, "plain.ts"), before);
    const result = await astRewriteFile(root, "plain.ts", "console.log($MSG)", "logger.info($MSG)");
    expect(result.modified).toBe(false);
    expect(result.matchCount).toBe(0);
    expect(result.output).toBe(before);
    expect(await Bun.file(join(root, "plain.ts")).text()).toBe(before);
  });

  test("throws fail-closed on missing files and escaping paths", async () => {
    const root = await makeRoot();
    await expect(astRewriteFile(root, "missing.ts", "f($A)", "g($A)")).rejects.toThrow(
      "fail-closed",
    );
    await expect(astRewriteFile(root, "../escape.ts", "f($A)", "g($A)")).rejects.toThrow(
      "fail-closed",
    );
  });
});
