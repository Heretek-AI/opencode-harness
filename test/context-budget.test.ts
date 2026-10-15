import { describe, expect, test } from "bun:test";
import {
  buildDynamicContextBlocks,
  estimateTokens,
  injectContextBudgetIntoMessages,
  packBlocks,
  type SessionEvent,
} from "../src/context/context-budget";

function userMessage(content: unknown) {
  return { role: "user", content };
}

function assistantMessage(content: unknown) {
  return { role: "assistant", content };
}

describe("estimateTokens", () => {
  test("empty text costs zero tokens", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("uses the character/4 ceiling deterministically", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a".repeat(100))).toBe(25);
    expect(estimateTokens("hello world")).toBe(3);
  });

  test("repeats return identical values", () => {
    const text = "deterministic budgeting input 12345";
    expect(estimateTokens(text)).toBe(estimateTokens(text));
  });

  test("rejects non-string input fail-closed", () => {
    expect(() => estimateTokens(42 as unknown as string)).toThrow(
      /fail-closed/,
    );
    expect(() => estimateTokens(undefined as unknown as string)).toThrow(
      /fail-closed/,
    );
  });
});

describe("packBlocks", () => {
  test("fits highest-priority blocks first within budget", () => {
    const packed = packBlocks(
      [
        { id: "low", text: "low priority body here!!", priority: 1 },
        { id: "high", text: "high priority body here!", priority: 9 },
      ],
      10,
    );
    expect(packed.text).toContain('id="high"');
    expect(packed.usedTokens).toBeLessThanOrEqual(10);
  });

  test("breaks priority ties by id localeCompare for determinism", () => {
    const first = packBlocks(
      [
        { id: "b-block", text: "1234", priority: 0 },
        { id: "a-block", text: "1234", priority: 0 },
      ],
      2,
    );
    const second = packBlocks(
      [
        { id: "a-block", text: "1234", priority: 0 },
        { id: "b-block", text: "1234", priority: 0 },
      ],
      2,
    );
    expect(first.text).toBe(second.text);
    expect(first.text.indexOf('id="a-block"')).toBeLessThan(
      first.text.indexOf('id="b-block"'),
    );
  });

  test("honors explicit token overrides and floors fractional values", () => {
    const packed = packBlocks([{ id: "fixed", text: "x", tokens: 7.9 }], 7);
    expect(packed.usedTokens).toBe(7);
    expect(packed.text).toContain('id="fixed"');
  });

  test("skips blocks that exceed the remaining budget", () => {
    const packed = packBlocks(
      [
        { id: "small", text: "ab", priority: 5 },
        { id: "huge", text: "z".repeat(400), priority: 1 },
      ],
      4,
    );
    expect(packed.text).toContain('id="small"');
    expect(packed.text).not.toContain('id="huge"');
    expect(packed.usedTokens).toBeLessThanOrEqual(4);
  });

  test("empty input and zero budget yield empty packing", () => {
    expect(packBlocks([], 100)).toEqual({ text: "", usedTokens: 0 });
    expect(packBlocks([{ id: "a", text: "hello" }], 0)).toEqual({
      text: "",
      usedTokens: 0,
    });
  });

  test("rejects invalid budgets and malformed blocks fail-closed", () => {
    expect(() => packBlocks([{ id: "a", text: "x" }], -1)).toThrow(
      /fail-closed/,
    );
    expect(() => packBlocks([{ id: "a", text: "x" }], Number.NaN)).toThrow(
      /fail-closed/,
    );
    expect(
      () => packBlocks("nope" as unknown as [], 10),
    ).toThrow(/fail-closed/);
    expect(() => packBlocks([{ id: "", text: "x" }], 10)).toThrow(
      /fail-closed/,
    );
    expect(
      () =>
        packBlocks([{ id: "bad", text: 9 as unknown as string }], 10),
    ).toThrow(/fail-closed/);
  });
});

describe("buildDynamicContextBlocks", () => {
  test("builds task, plan, and episodic blocks in priority order", () => {
    const blocks = buildDynamicContextBlocks("workspace-root", {
      taskMd: "# Task\nDo the thing.",
      planMd: "# Plan\nStep one.",
      lessons: [
        { id: "zeta", trigger: "tardy test", lesson: "run checks first" },
        { id: "alpha", trigger: "early test", lesson: "read the spec" },
      ],
    });
    expect(blocks.map((block) => block.id)).toEqual([
      "task",
      "plan",
      "episodic-memory",
    ]);
    expect(blocks[0].tokens).toBe(estimateTokens("# Task\nDo the thing."));
  });

  test("sorts lessons by id and formats the exact episodic tag shape", () => {
    const blocks = buildDynamicContextBlocks("root", {
      lessons: [
        { id: "m-2", trigger: "second", lesson: "second lesson" },
        { id: "m-10", trigger: "tenth", lesson: "tenth lesson" },
        { id: "m-1", trigger: "first", lesson: "first lesson" },
      ],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toBe("episodic-memory");
    const text = blocks[0].text;
    const ids = [...text.matchAll(/<episodic-repository-memory id="([^"]+)">/g)].map(
      (match) => match[1],
    );
    expect(ids).toEqual(["m-1", "m-10", "m-2"]);
    expect(text).toContain(
      '<episodic-repository-memory id="m-1">\n- (first): first lesson\n</episodic-repository-memory>',
    );
  });

  test("episodic tags carry zero float scores or timestamps", () => {
    const blocks = buildDynamicContextBlocks("root", {
      lessons: [
        {
          id: "lesson-a",
          trigger: "trigger-a",
          lesson: "lesson body with decimal 1.5 inside prose",
          needsReview: true,
        },
      ],
    });
    const openings = [
      ...blocks[0].text.matchAll(/<episodic-repository-memory[^>]*>/g),
    ].map((match) => match[0]);
    expect(openings).toHaveLength(1);
    expect(openings[0]).toBe(
      '<episodic-repository-memory id="lesson-a">',
    );
    expect(openings[0]).not.toContain("relevance");
    expect(openings[0]).not.toContain("timestamp");
    expect(openings[0]).not.toMatch(/\d+\.\d+/);
  });

  test("omits blank artifacts and empty lesson lists", () => {
    expect(buildDynamicContextBlocks("root", {})).toEqual([]);
    expect(
      buildDynamicContextBlocks("root", {
        taskMd: "   ",
        planMd: "",
        lessons: [],
      }),
    ).toEqual([]);
  });

  test("rejects bad rootDir and malformed artifacts fail-closed", () => {
    expect(() => buildDynamicContextBlocks("", { taskMd: "x" })).toThrow(
      /fail-closed/,
    );
    expect(
      () =>
        buildDynamicContextBlocks("root", undefined as unknown as {
          taskMd?: string;
        }),
    ).toThrow(/fail-closed/);
    expect(
      () =>
        buildDynamicContextBlocks("root", {
          lessons: [{ id: "", trigger: "t", lesson: "l" }],
        }),
    ).toThrow(/fail-closed/);
  });
});

describe("injectContextBudgetIntoMessages", () => {
  // KV-cache contract: dynamic context lands strictly on the last message
  // with role === "user"; event.system stays bit-for-bit identical.
  test("leaves event.system bit-for-bit identical", () => {
    const event: SessionEvent = {
      system: [{ text: "system prompt v1" }, { text: "second block" }],
      messages: [userMessage("hello")],
    };
    const before = JSON.stringify(event.system);
    injectContextBudgetIntoMessages(event, "packed context");
    expect(JSON.stringify(event.system)).toBe(before);
    expect(event.system).toEqual([
      { text: "system prompt v1" },
      { text: "second block" },
    ]);
  });

  test("appends wrapped context strictly to the last user message", () => {
    const event: SessionEvent = {
      system: [{ text: "sys" }],
      messages: [
        userMessage("first question"),
        assistantMessage("first answer"),
        userMessage("follow-up"),
      ],
    };
    injectContextBudgetIntoMessages(event, "packed context");
    expect(event.messages?.[0].content).toBe("first question");
    expect(event.messages?.[1].content).toBe("first answer");
    expect(event.messages?.[2].content).toBe(
      "follow-up\n\n<opencode-harness-context>\npacked context\n</opencode-harness-context>",
    );
  });

  test("prefers the trailing user message when an assistant message is last", () => {
    const event: SessionEvent = {
      messages: [
        userMessage("question"),
        assistantMessage(" trailing answer "),
      ],
    };
    injectContextBudgetIntoMessages(event, "ctx");
    expect(event.messages?.[0].content).toBe(
      'question\n\n<opencode-harness-context>\nctx\n</opencode-harness-context>',
    );
    expect(event.messages?.[1].content).toBe(" trailing answer ");
  });

  test("appends a text part for array (multi-part) user content", () => {
    const parts: unknown[] = [{ type: "text", text: "prior part" }];
    const event: SessionEvent = { messages: [{ role: "user", content: parts }] };
    injectContextBudgetIntoMessages(event, "ctx");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "prior part" });
    expect(parts[1]).toEqual({
      type: "text",
      text: "<opencode-harness-context>\nctx\n</opencode-harness-context>",
    });
  });

  test("replaces nullish user content with the wrapped text", () => {
    const event: SessionEvent = {
      messages: [{ role: "user", content: undefined }],
    };
    injectContextBudgetIntoMessages(event, "ctx");
    expect(event.messages?.[0].content).toBe(
      "<opencode-harness-context>\nctx\n</opencode-harness-context>",
    );
  });

  test("empty packed text is a strict no-op", () => {
    const event: SessionEvent = {
      system: [{ text: "sys" }],
      messages: [userMessage("q")],
    };
    const before = JSON.stringify(event);
    injectContextBudgetIntoMessages(event, "");
    expect(JSON.stringify(event)).toBe(before);
  });

  test("fails closed without mutating system when no user message exists", () => {
    const systemOnly: SessionEvent = {
      system: [{ text: "sys" }],
      messages: [assistantMessage("answer")],
    };
    const systemBefore = JSON.stringify(systemOnly.system);
    expect(() =>
      injectContextBudgetIntoMessages(systemOnly, "ctx"),
    ).toThrow(/fail-closed/);
    expect(JSON.stringify(systemOnly.system)).toBe(systemBefore);
    expect(() =>
      injectContextBudgetIntoMessages({ messages: [] }, "ctx"),
    ).toThrow(/fail-closed/);
    expect(() =>
      injectContextBudgetIntoMessages({}, "ctx"),
    ).toThrow(/fail-closed/);
  });

  test("fails closed on unsupported user content shapes", () => {
    const event: SessionEvent = {
      messages: [{ role: "user", content: 42 }],
    };
    expect(() => injectContextBudgetIntoMessages(event, "ctx")).toThrow(
      /fail-closed/,
    );
  });
});
