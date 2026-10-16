/**
 * `src/context/context-budget.ts` — KV-cache-safe context packer.
 *
 * Wave 2 module per `docs/prompts/SPEC.md` Section 2.4 A (Report `01b`
 * Section 9.3). Packs dynamic context blocks into a token budget and injects
 * the packed text into a session event WITHOUT disturbing the KV-cache
 * prefix:
 *
 * - `estimateTokens` — deterministic character/4 ceiling estimator.
 * - `packBlocks` — priority-ordered greedy fit within `budgetTokens`.
 * - `buildDynamicContextBlocks` — task / plan / episodic-memory blocks from
 *   caller-supplied artifacts (no disk reads, no network).
 * - `injectContextBudgetIntoMessages` — appends
 *   `<opencode-harness-context>...</opencode-harness-context>` strictly to the
 *   last `role === "user"` message; NEVER touches `event.system`.
 *
 * All invalid inputs fail closed with descriptive errors.
 */

export interface ContextBlock {
  id: string;
  title?: string;
  text: string;
  tokens?: number;
  priority?: number;
}

export interface LessonInput {
  id: string;
  trigger: string;
  lesson: string;
  needsReview?: boolean;
}

/**
 * Canonical stored episodic lesson shape (`{ id, summary }`).
 *
 * `src/context/episodic-memory.ts` imports this type canonically instead of
 * redefining it, so `export *` from `src/index.ts` exposes exactly one
 * `EpisodicLesson` symbol (no `export *` ambiguity).
 */
export interface EpisodicLesson {
  id: string;
  summary: string;
}

export interface DynamicArtifacts {
  taskMd?: string;
  planMd?: string;
  lessons?: LessonInput[];
}

export interface PackedContext {
  text: string;
  usedTokens: number;
}

export interface SessionMessage {
  role: string;
  content: unknown;
}

export interface SessionEvent {
  agent?: string;
  kind?: string;
  system?: Array<{ text: string }>;
  messages?: SessionMessage[];
}

export const CONTEXT_WRAPPER_OPEN = "<opencode-harness-context>";
export const CONTEXT_WRAPPER_CLOSE = "</opencode-harness-context>";

const TASK_BLOCK_PRIORITY = 10;
const PLAN_BLOCK_PRIORITY = 5;
const EPISODIC_BLOCK_PRIORITY = 1;

/** Escape a value interpolated into an XML attribute (id/title). */
export function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Deterministic token estimator: the character/4 ceiling (`Math.ceil` over
 * UTF-16 code units). Empty text costs zero. Non-string input throws
 * (fail-closed) so callers never silently budget the wrong content.
 */
export function estimateTokens(text: string): number {
  if (typeof text !== "string") {
    throw new Error(
      `context-budget: estimateTokens expects a string, got ${typeof text} (fail-closed)`,
    );
  }
  if (text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

function blockTokensOf(block: ContextBlock): number {
  if (block.tokens !== undefined) {
    if (
      typeof block.tokens !== "number" ||
      Number.isNaN(block.tokens) ||
      !Number.isFinite(block.tokens) ||
      block.tokens < 0
    ) {
      throw new Error(
        `context-budget: block ${JSON.stringify(block.id)} has an invalid tokens override (expected a finite number >= 0) (fail-closed)`,
      );
    }
    return Math.floor(block.tokens);
  }
  return estimateTokens(block.text);
}

function validateBlock(block: ContextBlock, index: number): void {
  if (!block || typeof block !== "object") {
    throw new Error(
      `context-budget: block at index ${index} must be an object (fail-closed)`,
    );
  }
  if (typeof block.id !== "string" || block.id.trim() === "") {
    throw new Error(
      `context-budget: block at index ${index} must carry a non-empty string id (fail-closed)`,
    );
  }
  if (typeof block.text !== "string") {
    throw new Error(
      `context-budget: block ${JSON.stringify(block.id)} text must be a string (fail-closed)`,
    );
  }
  if (block.title !== undefined && typeof block.title !== "string") {
    throw new Error(
      `context-budget: block ${JSON.stringify(block.id)} title must be a string when present (fail-closed)`,
    );
  }
  if (block.priority !== undefined) {
    const priorityIsNumber = typeof block.priority === "number";
    const priorityFinite = priorityIsNumber && Number.isFinite(block.priority);
    if (!priorityFinite) {
      throw new Error(
        `context-budget: block ${JSON.stringify(block.id)} priority must be a finite number when present (fail-closed)`,
      );
    }
  }
}

function priorityOf(block: ContextBlock): number {
  return block.priority ?? 0;
}

/** Render one packed block as a deterministic XML fragment. */
export function renderBlock(block: ContextBlock): string {
  validateBlock(block, -1);
  const id = escapeXmlAttr(block.id);
  if (block.title !== undefined && block.title !== "") {
    const title = escapeXmlAttr(block.title);
    return `<context-block id="${id}" title="${title}">\n${block.text}\n</context-block>`;
  }
  return `<context-block id="${id}">\n${block.text}\n</context-block>`;
}

/**
 * Greedily fit blocks into `budgetTokens`, highest `priority` first with
 * `id.localeCompare` breaking ties so repeated runs pack identically.
 * Blocks declaring an explicit `tokens` value are costed at that value
 * (floored); all others are costed with `estimateTokens`. Returns the
 * rendered text plus the summed token cost. Empty input (or a zero budget)
 * yields `{ text: "", usedTokens: 0 }` rather than an error.
 */
export function packBlocks(
  blocks: ContextBlock[],
  budgetTokens: number,
): PackedContext {
  if (!Array.isArray(blocks)) {
    throw new Error(
      "context-budget: packBlocks expects an array of blocks (fail-closed)",
    );
  }
  const budgetIsNumber = typeof budgetTokens === "number";
  const budgetUsable =
    budgetIsNumber && Number.isFinite(budgetTokens) && budgetTokens >= 0;
  if (!budgetUsable) {
    throw new Error(
      `context-budget: budgetTokens must be a finite number >= 0, got ${String(budgetTokens)} (fail-closed)`,
    );
  }
  const ordered = [...blocks];
  ordered.forEach((block, index) => validateBlock(block, index));
  ordered.sort((a, b) => {
    const priorityDelta = priorityOf(b) - priorityOf(a);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return a.id.localeCompare(b.id);
  });
  const budget = Math.floor(budgetTokens);
  const included: ContextBlock[] = [];
  let usedTokens = 0;
  for (const block of ordered) {
    const cost = blockTokensOf(block);
    if (usedTokens + cost <= budget) {
      included.push(block);
      usedTokens += cost;
    }
  }
  return { text: included.map(renderBlock).join("\n"), usedTokens };
}

/**
 * Format one episodic lesson deterministically. The tag carries ONLY the
 * lesson `id` — zero floating-point relevance scores, zero timestamps, zero
 * extra attributes — so serialized context stays byte-stable across runs.
 */
export function formatEpisodicLesson(lesson: LessonInput): string {
  if (!lesson || typeof lesson !== "object") {
    throw new Error(
      "context-budget: each lesson must be an object with id/trigger/lesson (fail-closed)",
    );
  }
  if (typeof lesson.id !== "string" || lesson.id.trim() === "") {
    throw new Error(
      "context-budget: each lesson must carry a non-empty string id (fail-closed)",
    );
  }
  if (typeof lesson.trigger !== "string" || lesson.trigger === "") {
    throw new Error(
      `context-budget: lesson ${JSON.stringify(lesson.id)} must carry a non-empty string trigger (fail-closed)`,
    );
  }
  if (typeof lesson.lesson !== "string" || lesson.lesson === "") {
    throw new Error(
      `context-budget: lesson ${JSON.stringify(lesson.id)} must carry a non-empty string lesson (fail-closed)`,
    );
  }
  const id = escapeXmlAttr(lesson.id);
  return `<episodic-repository-memory id="${id}">\n- (${lesson.trigger}): ${lesson.lesson}\n</episodic-repository-memory>`;
}

/**
 * Build dynamic context blocks from caller-supplied artifacts. `rootDir`
 * names the owning workspace (validated non-empty; no disk is touched).
 * `taskMd`/`planMd` become `task`/`plan` blocks when present and non-blank.
 * `lessons` are sorted by `a.id.localeCompare(b.id)` and rendered into a
 * single `episodic-memory` block via `formatEpisodicLesson`. The returned
 * array is ordered by descending priority (`task`, `plan`, `episodic-memory`).
 */
export function buildDynamicContextBlocks(
  rootDir: string,
  artifacts: DynamicArtifacts,
): ContextBlock[] {
  if (typeof rootDir !== "string" || rootDir.trim() === "") {
    throw new Error(
      "context-budget: rootDir must be a non-empty string (fail-closed)",
    );
  }
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) {
    throw new Error(
      "context-budget: artifacts must be an object with optional taskMd/planMd/lessons (fail-closed)",
    );
  }
  const blocks: ContextBlock[] = [];
  if (artifacts.taskMd !== undefined) {
    if (typeof artifacts.taskMd !== "string") {
      throw new Error(
        "context-budget: taskMd must be a string when present (fail-closed)",
      );
    }
    if (artifacts.taskMd.trim() !== "") {
      blocks.push({
        id: "task",
        title: "Task",
        text: artifacts.taskMd,
        tokens: estimateTokens(artifacts.taskMd),
        priority: TASK_BLOCK_PRIORITY,
      });
    }
  }
  if (artifacts.planMd !== undefined) {
    if (typeof artifacts.planMd !== "string") {
      throw new Error(
        "context-budget: planMd must be a string when present (fail-closed)",
      );
    }
    if (artifacts.planMd.trim() !== "") {
      blocks.push({
        id: "plan",
        title: "Plan",
        text: artifacts.planMd,
        tokens: estimateTokens(artifacts.planMd),
        priority: PLAN_BLOCK_PRIORITY,
      });
    }
  }
  if (artifacts.lessons !== undefined) {
    if (!Array.isArray(artifacts.lessons)) {
      throw new Error(
        "context-budget: lessons must be an array when present (fail-closed)",
      );
    }
    if (artifacts.lessons.length > 0) {
      const sorted = [...artifacts.lessons].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      const text = sorted.map(formatEpisodicLesson).join("\n");
      blocks.push({
        id: "episodic-memory",
        title: "Episodic Repository Memory",
        text,
        tokens: estimateTokens(text),
        priority: EPISODIC_BLOCK_PRIORITY,
      });
    }
  }
  blocks.sort((a, b) => priorityOf(b) - priorityOf(a));
  return blocks;
}

/**
 * Append `packedText` (wrapped in `<opencode-harness-context>`) to the last
 * message with `role === "user"`, preserving the KV-cache prefix:
 *
 * 1. `event.system` is NEVER read-mutated, reordered, or reassigned —
 *    bit-for-bit identical after this call.
 * 2. Only the trailing user message is touched; every earlier message keeps
 *    its reference and content.
 * 3. String content is concatenated (`prior + "\n\n" + wrapped`); array
 *    content (multi-part messages) gains one appended
 *    `{ type: "text", text: wrapped }` part; nullish content is replaced by
 *    the wrapped text.
 *
 * Empty `packedText` is a no-op. Missing `messages`, an empty list, or no
 * user message throws (fail-closed) instead of falling back to `system` or
 * to an assistant message.
 */
export function injectContextBudgetIntoMessages(
  event: SessionEvent,
  packedText: string,
): void {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error(
      "context-budget: event must be an object with an optional messages array (fail-closed)",
    );
  }
  if (typeof packedText !== "string") {
    throw new Error(
      `context-budget: packedText must be a string, got ${typeof packedText} (fail-closed)`,
    );
  }
  if (packedText === "") {
    return;
  }
  if (!Array.isArray(event.messages) || event.messages.length === 0) {
    throw new Error(
      "context-budget: refusing to inject context with no messages present (fail-closed)",
    );
  }
  let targetIndex = -1;
  for (let index = event.messages.length - 1; index >= 0; index--) {
    const candidate = event.messages[index];
    if (candidate && candidate.role === "user") {
      targetIndex = index;
      break;
    }
  }
  if (targetIndex === -1) {
    throw new Error(
      "context-budget: refusing to inject context with no role === \"user\" message (system is never mutated) (fail-closed)",
    );
  }
  const wrapped = `${CONTEXT_WRAPPER_OPEN}\n${packedText}\n${CONTEXT_WRAPPER_CLOSE}`;
  const target = event.messages[targetIndex];
  if (typeof target.content === "string") {
    target.content =
      target.content === "" ? wrapped : `${target.content}\n\n${wrapped}`;
    return;
  }
  if (Array.isArray(target.content)) {
    target.content.push({ type: "text", text: wrapped });
    return;
  }
  const contentMissing =
    target.content === null || target.content === undefined;
  if (contentMissing) {
    (target as { content: unknown }).content = wrapped;
    return;
  }
  throw new Error(
    "context-budget: refusing to inject into a user message with unsupported content shape (expected string, parts array, or nullish) (fail-closed)",
  );
}
