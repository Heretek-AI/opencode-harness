/**
 * `src/ui-auditor/dom-auditor.ts` — Deterministic DOM geometry verifier plus
 * live headless audit.
 *
 * Wave 2 module per `docs/prompts/SPEC.md` Section 2.4 B:
 *
 * - `evaluateDomGeometryInPage` — pure deterministic geometry verifier over
 *   caller-supplied element rects (no browser, no network), checking the five
 *   SPEC defect families: `element-overflow-x`, `tiny-interactive-target`,
 *   `descender-clip-risk`, `sibling-collision`, `row-baseline-jitter`.
 * - `auditLivePageWithPlaywright` — launches headless Chromium via
 *   `playwright`, runs `@axe-core/playwright` with the WCAG 2.2 tag set
 *   (`wcag2a`, `wcag2aa`, `wcag22aa`) plus the same in-page geometry
 *   collector, and returns a structured `DOMAuditReport`. Invalid URLs fail
 *   closed with a descriptive domain error; the function never returns a
 *   permissive empty report for a bad input.
 */

export interface DomRectInput {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DomElementInput {
  tag: string;
  id?: string;
  rect: DomRectInput;
  scrollWidth?: number;
  clientWidth?: number;
  fontSize?: number;
  lineHeight?: number;
  overflow?: string;
  interactive?: boolean;
  parentId?: string;
}

export interface GeometryDefect {
  kind: string;
  elementId?: string;
  message: string;
  details?: unknown;
}

export interface ViewportInput {
  name: string;
  width: number;
  height: number;
}

export interface ViewportAuditResult extends ViewportInput {
  geometryDefects: GeometryDefect[];
  axeViolationCount: number;
}

export interface DOMAuditReport {
  url: string;
  defects: GeometryDefect[];
  axeViolations?: unknown[];
  viewports?: ViewportAuditResult[];
}

/** Opt-in policy for live URL audits (server-side only; never model-controlled). */
export interface AuditUrlPolicy {
  /** Exact hostnames (case-insensitive) permitted to resolve to non-public IPs. */
  allowedHosts?: string[];
}

export const MIN_INTERACTIVE_SIZE_PX = 24;
export const OVERFLOW_TOLERANCE_PX = 2;
export const SIBLING_OVERLAP_TOLERANCE_PX = 2;
export const ROW_JITTER_MIN_PX = 0.5;
export const ROW_JITTER_MAX_PX = 3.5;
export const MIN_DESCENDER_LINE_HEIGHT_RATIO = 1.15;
/** Upper bound on viewports per live audit (bounds browser work). */
export const MAX_AUDIT_VIEWPORTS = 8;

const DEFAULT_VIEWPORTS: ViewportInput[] = [
  { name: "desktop", width: 1280, height: 800 },
];

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag22aa"];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateElement(element: DomElementInput, index: number): void {
  if (!element || typeof element !== "object") {
    throw new Error(
      `dom-auditor: element at index ${index} must be an object (fail-closed)`,
    );
  }
  if (typeof element.tag !== "string" || element.tag.trim() === "") {
    throw new Error(
      `dom-auditor: element at index ${index} must carry a non-empty string tag (fail-closed)`,
    );
  }
  const rect = element.rect;
  if (!rect || typeof rect !== "object") {
    throw new Error(
      `dom-auditor: element ${JSON.stringify(element.id ?? index)} must carry a rect object (fail-closed)`,
    );
  }
  const coordsValid =
    isFiniteNumber(rect.x) &&
    isFiniteNumber(rect.y) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height);
  if (!coordsValid) {
    throw new Error(
      `dom-auditor: element ${JSON.stringify(element.id ?? index)} rect must hold finite x/y/width/height numbers (fail-closed)`,
    );
  }
}

function elementLabel(element: DomElementInput, index: number): string {
  if (typeof element.id === "string" && element.id !== "") {
    return element.id;
  }
  return `${element.tag}[${index}]`;
}

/**
 * Pure deterministic geometry verifier. Every defect family from SPEC
 * Section 2.4 B is evaluated with the exact thresholds quoted there:
 *
 * - `element-overflow-x`: `scrollWidth > clientWidth + 2`.
 * - `tiny-interactive-target`: `interactive` with width or height below 24px.
 * - `descender-clip-risk`: `lineHeight / fontSize < 1.15` with
 *   `overflow === "hidden"`.
 * - `sibling-collision`: same-`parentId` siblings whose boxes intersect with
 *   `overlapX > 2` and `overlapY > 2`.
 * - `row-baseline-jitter`: same-`parentId` siblings whose `rect.y` differs by
 *   `0.5 <= |dy| <= 3.5`.
 *
 * Pairs are visited in index order (`i < j`) so output is deterministic.
 * Non-array input or malformed elements throw (fail-closed).
 */
export function evaluateDomGeometryInPage(
  elements: DomElementInput[],
): GeometryDefect[] {
  if (!Array.isArray(elements)) {
    throw new Error(
      "dom-auditor: elements must be an array of element descriptors (fail-closed)",
    );
  }
  elements.forEach(validateElement);
  const defects: GeometryDefect[] = [];

  elements.forEach((element, index) => {
    const label = elementLabel(element, index);
    const widthsKnown =
      isFiniteNumber(element.scrollWidth) &&
      isFiniteNumber(element.clientWidth);
    if (widthsKnown) {
      const scrollWidth = element.scrollWidth as number;
      const clientWidth = element.clientWidth as number;
      const overflows =
        scrollWidth > clientWidth + OVERFLOW_TOLERANCE_PX;
      if (overflows) {
        defects.push({
          kind: "element-overflow-x",
          elementId: label,
          message:
            `dom-auditor: element ${JSON.stringify(label)} overflows horizontally ` +
            `(scrollWidth ${scrollWidth} > clientWidth ${clientWidth} + ${OVERFLOW_TOLERANCE_PX})`,
          details: { scrollWidth, clientWidth },
        });
      }
    }

    const markedInteractive = element.interactive === true;
    if (markedInteractive) {
      const narrow = element.rect.width < MIN_INTERACTIVE_SIZE_PX;
      const short = element.rect.height < MIN_INTERACTIVE_SIZE_PX;
      const tooSmall = narrow || short;
      if (tooSmall) {
        defects.push({
          kind: "tiny-interactive-target",
          elementId: label,
          message:
            `dom-auditor: interactive element ${JSON.stringify(label)} is smaller than ` +
            `${MIN_INTERACTIVE_SIZE_PX}x${MIN_INTERACTIVE_SIZE_PX}px ` +
            `(got ${element.rect.width}x${element.rect.height})`,
          details: {
            width: element.rect.width,
            height: element.rect.height,
          },
        });
      }
    }

    const metricsKnown =
      isFiniteNumber(element.fontSize) && isFiniteNumber(element.lineHeight);
    if (metricsKnown) {
      const fontSize = element.fontSize as number;
      const lineHeight = element.lineHeight as number;
      const hidden = element.overflow === "hidden";
      const positive = fontSize > 0;
      if (hidden && positive) {
        const tight = lineHeight / fontSize < MIN_DESCENDER_LINE_HEIGHT_RATIO;
        if (tight) {
          defects.push({
            kind: "descender-clip-risk",
            elementId: label,
            message:
              `dom-auditor: element ${JSON.stringify(label)} risks descender clipping ` +
              `(lineHeight/fontSize ${(lineHeight / fontSize).toFixed(3)} < ${MIN_DESCENDER_LINE_HEIGHT_RATIO} with overflow hidden)`,
            details: { fontSize, lineHeight, overflow: element.overflow },
          });
        }
      }
    }
  });

  const groups = new Map<string, number[]>();
  elements.forEach((element, index) => {
    if (typeof element.parentId === "string" && element.parentId !== "") {
      const group = groups.get(element.parentId) ?? [];
      group.push(index);
      groups.set(element.parentId, group);
    }
  });

  for (const [parentId, members] of groups) {
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        const first = elements[members[a]];
        const second = elements[members[b]];
        const firstLabel = elementLabel(first, members[a]);
        const secondLabel = elementLabel(second, members[b]);

        const rightA = first.rect.x + first.rect.width;
        const bottomA = first.rect.y + first.rect.height;
        const rightB = second.rect.x + second.rect.width;
        const bottomB = second.rect.y + second.rect.height;
        const overlapX =
          Math.min(rightA, rightB) - Math.max(first.rect.x, second.rect.x);
        const overlapY =
          Math.min(bottomA, bottomB) - Math.max(first.rect.y, second.rect.y);
        const collides =
          overlapX > SIBLING_OVERLAP_TOLERANCE_PX &&
          overlapY > SIBLING_OVERLAP_TOLERANCE_PX;
        if (collides) {
          defects.push({
            kind: "sibling-collision",
            elementId: secondLabel,
            message:
              `dom-auditor: siblings ${JSON.stringify(firstLabel)} and ${JSON.stringify(secondLabel)} ` +
              `under parent ${JSON.stringify(parentId)} overlap by ${overlapX.toFixed(1)}x${overlapY.toFixed(1)}px`,
            details: {
              parentId,
              first: firstLabel,
              second: secondLabel,
              overlapX,
              overlapY,
            },
          });
        }

        const dy = Math.abs(first.rect.y - second.rect.y);
        const jittered =
          dy >= ROW_JITTER_MIN_PX && dy <= ROW_JITTER_MAX_PX;
        if (jittered) {
          defects.push({
            kind: "row-baseline-jitter",
            elementId: secondLabel,
            message:
              `dom-auditor: row siblings ${JSON.stringify(firstLabel)} and ${JSON.stringify(secondLabel)} ` +
              `under parent ${JSON.stringify(parentId)} show baseline jitter (dy ${dy.toFixed(2)}px)`,
            details: { parentId, first: firstLabel, second: secondLabel, dy },
          });
        }
      }
    }
  }

  return defects;
}

function parseAuditUrl(url: string): URL {
  if (typeof url !== "string" || url.trim() === "") {
    throw new Error(
      "dom-auditor: url must be a non-empty string (fail-closed)",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (urlError) {
    throw new Error(
      `dom-auditor: refusing to audit unparsable URL ${JSON.stringify(url)}: ${(urlError as Error).message} (fail-closed)`,
    );
  }
  const http = parsed.protocol === "http:";
  const https = parsed.protocol === "https:";
  if (!http && !https) {
    throw new Error(
      `dom-auditor: refusing non-http(s) audit URL ${JSON.stringify(url)} (protocol ${JSON.stringify(parsed.protocol)}) (fail-closed)`,
    );
  }
  return parsed;
}

function validateViewports(viewports: ViewportInput[] | undefined): ViewportInput[] {
  if (viewports === undefined) {
    return [...DEFAULT_VIEWPORTS];
  }
  if (!Array.isArray(viewports) || viewports.length === 0) {
    throw new Error(
      "dom-auditor: viewports must be a non-empty array when provided (fail-closed)",
    );
  }
  if (viewports.length > MAX_AUDIT_VIEWPORTS) {
    throw new Error(
      `dom-auditor: refusing audit of ${viewports.length} viewports (maximum ${MAX_AUDIT_VIEWPORTS}, fail-closed)`,
    );
  }
  viewports.forEach((viewport, index) => {
    const shapeOk =
      viewport !== null &&
      typeof viewport === "object" &&
      typeof viewport.name === "string" &&
      viewport.name !== "";
    const sizeOk =
      shapeOk &&
      isFiniteNumber(viewport.width) &&
      isFiniteNumber(viewport.height) &&
      viewport.width > 0 &&
      viewport.height > 0;
    if (!sizeOk) {
      throw new Error(
        `dom-auditor: viewport at index ${index} must hold a non-empty name and positive finite width/height (fail-closed)`,
      );
    }
  });
  return [...viewports];
}

/** Cloud metadata endpoints: never fetchable, even via the allowlist. */
const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.compute.internal",
]);

function envAuditAllowlist(): string[] {
  const raw = process.env.OPENCODE_HARNESS_AUDIT_URL_ALLOWLIST ?? "";
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function ipv4Blocked(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return false;
    }
    const num = Number(part);
    if (!Number.isInteger(num) || num < 0 || num > 255) {
      return false;
    }
    octets.push(num);
  }
  const [a, b] = octets as [number, number];
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // private 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
  if (a === 192 && b === 168) return true; // private 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 0) return true; // "this network"
  return false;
}

/** True for loopback, private, link-local, or otherwise non-public IPs. */
export function isNonPublicIpAddress(address: string): boolean {
  const normalized = address
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .split("%")[0] as string;
  if (normalized === "::" || normalized === "::ffff:0.0.0.0") {
    return true;
  }
  if (normalized === "localhost") {
    return true;
  }
  if (normalized.includes(":")) {
    if (normalized === "::1") {
      return true;
    }
    if (normalized.startsWith("::ffff:")) {
      return ipv4Blocked(normalized.slice("::ffff:".length));
    }
    const head = (normalized.split(":")[0] ?? "").toLowerCase();
    if (head === "fe80") {
      return true; // IPv6 link-local fe80::/10
    }
    if (head.startsWith("fc") || head.startsWith("fd")) {
      return true; // IPv6 unique-local fc00::/7
    }
    return false;
  }
  return ipv4Blocked(normalized);
}

/**
 * Resolve the audit target and enforce the SSRF policy (fail-closed):
 * non-http(s) URLs, unresolvable hosts, cloud metadata endpoints, and hosts
 * resolving to non-public IPs are refused unless the exact hostname is
 * opted in via `policy.allowedHosts` or the
 * `OPENCODE_HARNESS_AUDIT_URL_ALLOWLIST` environment variable.
 */
export async function resolveAuditTarget(
  url: string,
  policy?: AuditUrlPolicy,
): Promise<URL> {
  const target = parseAuditUrl(url);
  const host = target.hostname.toLowerCase();
  const allowlist = new Set<string>([
    ...(policy?.allowedHosts ?? []).map((entry) => entry.toLowerCase()),
    ...envAuditAllowlist(),
  ]);
  if (METADATA_HOSTS.has(host)) {
    throw new Error(
      `dom-auditor: refusing cloud metadata audit URL ${JSON.stringify(url)} (fail-closed)`,
    );
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    if (!allowlist.has(host)) {
      throw new Error(
        `dom-auditor: refusing loopback audit URL ${JSON.stringify(url)} (fail-closed; opt in with allowedHosts for ${JSON.stringify(host)})`,
      );
    }
    return target;
  }
  let resolved: string[];
  try {
    const { lookup } = await import("node:dns/promises");
    const records = await lookup(host, { all: true });
    resolved = records.map((record) => record.address);
  } catch (dnsError) {
    throw new Error(
      `dom-auditor: refusing audit URL with unresolvable host ${JSON.stringify(host)}: ${(dnsError as Error).message} (fail-closed)`,
    );
  }
  const blocked = resolved.filter((address) => isNonPublicIpAddress(address));
  if (blocked.length > 0 && !allowlist.has(host)) {
    throw new Error(
      `dom-auditor: refusing non-public audit target ${JSON.stringify(url)} (host ${JSON.stringify(host)} resolves to ${blocked.join(",")}) (fail-closed; opt in with allowedHosts)`,
    );
  }
  return target;
}

/**
 * Audit a live page with headless Chromium: for every requested viewport the
 * page is loaded, `@axe-core/playwright` runs with the WCAG 2.2 tag set,
 * and the in-page geometry collector feeds `evaluateDomGeometryInPage`.
 *
 * Returns `{ url, defects, axeViolations, viewports }` where `defects` holds
 * the geometry defects followed by one `axe:<rule>` defect per axe
 * violation (so a single list drives the `ui_geometry_audit` tool), while
 * `axeViolations` preserves the raw axe detail and `viewports` records the
 * per-viewport breakdown. Any navigation, axe, or browser failure is
 * rethrown as a descriptive domain error (fail-closed); the browser is
 * always closed before returning or throwing.
 */
export async function auditLivePageWithPlaywright(
  url: string,
  viewports?: ViewportInput[],
  policy?: AuditUrlPolicy,
): Promise<DOMAuditReport> {
  const target = await resolveAuditTarget(url, policy);
  const viewportList = validateViewports(viewports);
  let chromium: typeof import("playwright").chromium;
  // Structural type for the `@axe-core/playwright` default export (kept
  // local so live audits degrade to a clear fail-closed error when the
  // optional peer dependency is absent).
  let AxeBuilder: new (args: {
    page: unknown;
  }) => {
    withTags: (tags: string[]) => { analyze: () => Promise<unknown> };
  };
  try {
    const [playwrightMod, axeMod] = await Promise.all([
      import("playwright"),
      import("@axe-core/playwright"),
    ]);
    chromium = playwrightMod.chromium;
    AxeBuilder = axeMod.default as unknown as typeof AxeBuilder;
  } catch (dependencyError) {
    throw new Error(
      `dom-auditor: live audit unavailable: install the optional peer dependencies "playwright" and "@axe-core/playwright" to enable browser mode (${(dependencyError as Error).message}) (fail-closed)`,
    );
  }
  const browser = await chromium.launch({ headless: true });
  const defects: GeometryDefect[] = [];
  const axeViolations: unknown[] = [];
  const viewportResults: ViewportAuditResult[] = [];
  // Cache per-host SSRF decisions so every redirect hop is re-checked
  // without repeating DNS lookups.
  const hostDecisions = new Map<string, boolean>();
  const isRequestUrlAllowed = async (rawUrl: string): Promise<boolean> => {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return false;
    }
    if (parsed.protocol === "data:" || parsed.protocol === "blob:") {
      return true;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    const cached = hostDecisions.get(host);
    if (cached !== undefined) {
      return cached;
    }
    try {
      await resolveAuditTarget(parsed.toString(), policy);
      hostDecisions.set(host, true);
      return true;
    } catch {
      hostDecisions.set(host, false);
      return false;
    }
  };
  try {
    for (const viewport of viewportList) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
      });
      // Block redirects (and subresources) escaping to non-public targets.
      await context.route("**/*", async (route) => {
        try {
          if (await isRequestUrlAllowed(route.request().url())) {
            await route.continue();
          } else {
            await route.abort("blockedbyclient");
          }
        } catch {
          try {
            await route.abort("blockedbyclient");
          } catch {
            // Aborting is best-effort; the navigation timeout still bounds us.
          }
        }
      });
      const page = await context.newPage();
      try {
        await page.goto(target.toString(), {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        const axeResults = (await new AxeBuilder({ page })
          .withTags(AXE_TAGS)
          .analyze()) as {
          violations?: Array<{
            id?: unknown;
            help?: unknown;
            description?: unknown;
            impact?: unknown;
            nodes?: unknown;
          }>;
        };
        const violations = Array.isArray(axeResults.violations)
          ? axeResults.violations
          : [];
        for (const violation of violations) {
          axeViolations.push(violation);
          const ruleId =
            typeof violation?.id === "string" ? violation.id : "unknown-rule";
          const nodes = Array.isArray(violation?.nodes)
            ? violation.nodes.length
            : 0;
          defects.push({
            kind: `axe:${ruleId}`,
            message:
              `dom-auditor: axe flags rule ${JSON.stringify(ruleId)} on ${target.toString()} ` +
              `at ${viewport.width}x${viewport.height} (${nodes} node(s)): ${String(violation?.help ?? violation?.description ?? "no description")}`,
            details: {
              rule: ruleId,
              impact: violation?.impact ?? null,
              nodes,
              viewport: viewport.name,
            },
          });
        }
        const collected = await page.evaluate(() => {
          const INTERACTIVE_TAGS = new Set([
            "BUTTON",
            "A",
            "INPUT",
            "SELECT",
            "TEXTAREA",
            "SUMMARY",
          ]);
          const INTERACTIVE_ROLES = new Set([
            "button",
            "link",
            "checkbox",
            "radio",
            "switch",
            "tab",
            "menuitem",
            "option",
          ]);
          const nodes = Array.from(document.querySelectorAll("*")).slice(
            0,
            5000,
          );
          const ids = new Map<Element, string>();
          nodes.forEach((node, index) => {
            const existing = node.getAttribute("id");
            const assigned =
              existing !== null && existing !== ""
                ? existing
                : `${node.tagName.toLowerCase()}#${index}`;
            ids.set(node, assigned);
          });
          return nodes.map((node) => {
            const rect = node.getBoundingClientRect();
            const style = window.getComputedStyle(node);
            const role = node.getAttribute("role") ?? "";
            const tag = node.tagName;
            const interactiveByTag = INTERACTIVE_TAGS.has(tag);
            const interactiveByRole = INTERACTIVE_ROLES.has(role);
            const interactiveByTabindex = node.hasAttribute("tabindex");
            const parent = node.parentElement;
            return {
              tag: tag.toLowerCase(),
              id: ids.get(node),
              rect: {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
              },
              scrollWidth: (node as Element).scrollWidth,
              clientWidth: (node as Element).clientWidth,
              fontSize: Number.parseFloat(style.fontSize),
              lineHeight: Number.parseFloat(style.lineHeight),
              overflow: style.overflowX === "hidden" ? "hidden" : style.overflow,
              interactive:
                interactiveByTag || interactiveByRole || interactiveByTabindex,
              parentId:
                parent !== null ? ids.get(parent) : undefined,
            };
          });
        });
        const elements = (collected as DomElementInput[]).map((entry) => ({
          ...entry,
          lineHeight: Number.isFinite(entry.lineHeight)
            ? entry.lineHeight
            : undefined,
          fontSize: Number.isFinite(entry.fontSize)
            ? entry.fontSize
            : undefined,
        }));
        const geometryDefects = evaluateDomGeometryInPage(elements);
        const tagged = geometryDefects.map((defect) => ({
          ...defect,
          details: {
            ...(typeof defect.details === "object" && defect.details !== null
              ? (defect.details as Record<string, unknown>)
              : {}),
            viewport: viewport.name,
          },
        }));
        for (const defect of tagged) {
          defects.push(defect);
        }
        viewportResults.push({
          ...viewport,
          geometryDefects: tagged,
          axeViolationCount: violations.length,
        });
        await context.close();
      } catch (viewportError) {
        await context.close();
        throw new Error(
          `dom-auditor: live audit failed for ${target.toString()} at viewport ${JSON.stringify(viewport.name)}: ${(viewportError as Error).message} (fail-closed)`,
        );
      }
    }
  } finally {
    await browser.close();
  }
  return {
    url: target.toString(),
    defects,
    axeViolations,
    viewports: viewportResults,
  };
}
