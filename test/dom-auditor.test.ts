import { describe, expect, test } from "bun:test";
import {
  evaluateDomGeometryInPage,
  type DomElementInput,
} from "../src/ui-auditor/dom-auditor";

function element(overrides: Partial<DomElementInput>): DomElementInput {
  return {
    tag: "div",
    rect: { x: 0, y: 0, width: 100, height: 40 },
    ...overrides,
  };
}

describe("element-overflow-x", () => {
  test("flags scrollWidth beyond clientWidth plus tolerance", () => {
    const defects = evaluateDomGeometryInPage([
      element({ id: "wide", scrollWidth: 120, clientWidth: 100 }),
    ]);
    expect(defects.map((defect) => defect.kind)).toContain(
      "element-overflow-x",
    );
    expect(defects[0].elementId).toBe("wide");
    expect(defects[0].message).toContain("wide");
  });

  test("ignores overflow within the 2px tolerance and missing widths", () => {
    const defects = evaluateDomGeometryInPage([
      element({ id: "edge", scrollWidth: 102, clientWidth: 100 }),
      element({ id: "fit", scrollWidth: 90, clientWidth: 100 }),
      element({ id: "unknown" }),
    ]);
    expect(
      defects.filter((defect) => defect.kind === "element-overflow-x"),
    ).toHaveLength(0);
  });
});

describe("tiny-interactive-target", () => {
  test("flags interactive elements below 24px on either axis", () => {
    const defects = evaluateDomGeometryInPage([
      element({
        id: "tiny-btn",
        tag: "button",
        interactive: true,
        rect: { x: 0, y: 0, width: 20, height: 20 },
      }),
      element({
        id: "thin-link",
        tag: "a",
        interactive: true,
        rect: { x: 30, y: 0, width: 60, height: 10 },
      }),
    ]);
    const tiny = defects.filter(
      (defect) => defect.kind === "tiny-interactive-target",
    );
    expect(tiny.map((defect) => defect.elementId)).toEqual(
      expect.arrayContaining(["tiny-btn", "thin-link"]),
    );
  });

  test("passes 24x24 targets and ignores non-interactive boxes", () => {
    const defects = evaluateDomGeometryInPage([
      element({
        id: "exact",
        tag: "button",
        interactive: true,
        rect: { x: 0, y: 0, width: 24, height: 24 },
      }),
      element({
        id: "decor",
        interactive: false,
        rect: { x: 0, y: 0, width: 8, height: 8 },
      }),
    ]);
    expect(
      defects.filter((defect) => defect.kind === "tiny-interactive-target"),
    ).toHaveLength(0);
  });
});

describe("descender-clip-risk", () => {
  test("flags tight line-height with hidden overflow", () => {
    const defects = evaluateDomGeometryInPage([
      element({
        id: "tight",
        fontSize: 16,
        lineHeight: 16,
        overflow: "hidden",
      }),
    ]);
    expect(defects.map((defect) => defect.kind)).toContain(
      "descender-clip-risk",
    );
  });

  test("passes roomy ratios, visible overflow, and missing metrics", () => {
    const defects = evaluateDomGeometryInPage([
      element({
        id: "roomy",
        fontSize: 16,
        lineHeight: 18.4,
        overflow: "hidden",
      }),
      element({
        id: "visible",
        fontSize: 16,
        lineHeight: 14,
        overflow: "visible",
      }),
      element({ id: "unstyled", overflow: "hidden" }),
    ]);
    expect(
      defects.filter((defect) => defect.kind === "descender-clip-risk"),
    ).toHaveLength(0);
  });
});

describe("sibling-collision", () => {
  test("flags same-parent siblings overlapping on both axes", () => {
    const defects = evaluateDomGeometryInPage([
      element({
        id: "card-a",
        parentId: "row",
        rect: { x: 0, y: 0, width: 100, height: 50 },
      }),
      element({
        id: "card-b",
        parentId: "row",
        rect: { x: 50, y: 10, width: 100, height: 50 },
      }),
    ]);
    const collisions = defects.filter(
      (defect) => defect.kind === "sibling-collision",
    );
    expect(collisions).toHaveLength(1);
    expect(collisions[0].elementId).toBe("card-b");
    expect(collisions[0].message).toContain("card-a");
  });

  test("ignores different parents, edge touches, and single-axis overlap", () => {
    const defects = evaluateDomGeometryInPage([
      element({
        id: "a",
        parentId: "p1",
        rect: { x: 0, y: 0, width: 50, height: 50 },
      }),
      element({
        id: "b",
        parentId: "p2",
        rect: { x: 10, y: 10, width: 50, height: 50 },
      }),
      element({
        id: "c",
        parentId: "p3",
        rect: { x: 0, y: 100, width: 50, height: 50 },
      }),
      element({
        id: "d",
        parentId: "p3",
        rect: { x: 48, y: 100, width: 50, height: 50 },
      }),
      element({
        id: "e",
        parentId: "p4",
        rect: { x: 0, y: 200, width: 50, height: 50 },
      }),
      element({
        id: "f",
        parentId: "p4",
        rect: { x: 10, y: 300, width: 50, height: 50 },
      }),
    ]);
    expect(
      defects.filter((defect) => defect.kind === "sibling-collision"),
    ).toHaveLength(0);
  });
});

describe("row-baseline-jitter", () => {
  test("flags same-row siblings whose y differs within 0.5–3.5px", () => {
    const defects = evaluateDomGeometryInPage([
      element({
        id: "left",
        parentId: "toolbar",
        rect: { x: 0, y: 100, width: 80, height: 30 },
      }),
      element({
        id: "right",
        parentId: "toolbar",
        rect: { x: 90, y: 102, width: 80, height: 30 },
      }),
    ]);
    const jitter = defects.filter(
      (defect) => defect.kind === "row-baseline-jitter",
    );
    expect(jitter).toHaveLength(1);
    expect(jitter[0].elementId).toBe("right");
  });

  test("passes aligned rows, sub-pixel noise, and large offsets", () => {
    const defects = evaluateDomGeometryInPage([
      element({
        id: "aligned-a",
        parentId: "row-a",
        rect: { x: 0, y: 50, width: 40, height: 20 },
      }),
      element({
        id: "aligned-b",
        parentId: "row-a",
        rect: { x: 50, y: 50, width: 40, height: 20 },
      }),
      element({
        id: "noisy-a",
        parentId: "row-b",
        rect: { x: 0, y: 80, width: 40, height: 20 },
      }),
      element({
        id: "noisy-b",
        parentId: "row-b",
        rect: { x: 50, y: 80.3, width: 40, height: 20 },
      }),
      element({
        id: "spaced-a",
        parentId: "row-c",
        rect: { x: 0, y: 120, width: 40, height: 20 },
      }),
      element({
        id: "spaced-b",
        parentId: "row-c",
        rect: { x: 50, y: 124, width: 40, height: 20 },
      }),
    ]);
    expect(
      defects.filter((defect) => defect.kind === "row-baseline-jitter"),
    ).toHaveLength(0);
  });

  test("treats the 0.5px and 3.5px boundaries as jitter", () => {
    const defects = evaluateDomGeometryInPage([
      element({
        id: "min-a",
        parentId: "row-min",
        rect: { x: 0, y: 10, width: 40, height: 20 },
      }),
      element({
        id: "min-b",
        parentId: "row-min",
        rect: { x: 50, y: 10.5, width: 40, height: 20 },
      }),
      element({
        id: "max-a",
        parentId: "row-max",
        rect: { x: 0, y: 40, width: 40, height: 20 },
      }),
      element({
        id: "max-b",
        parentId: "row-max",
        rect: { x: 50, y: 43.5, width: 40, height: 20 },
      }),
    ]);
    expect(
      defects.filter((defect) => defect.kind === "row-baseline-jitter"),
    ).toHaveLength(2);
  });
});

describe("dom-auditor fail-closed input validation", () => {
  test("rejects non-array input and malformed elements", () => {
    expect(() =>
      evaluateDomGeometryInPage("nope" as unknown as DomElementInput[]),
    ).toThrow(/fail-closed/);
    expect(() =>
      evaluateDomGeometryInPage([
        { tag: "", rect: { x: 0, y: 0, width: 1, height: 1 } },
      ]),
    ).toThrow(/fail-closed/);
    expect(() =>
      evaluateDomGeometryInPage([
        element({ rect: undefined as unknown as DomElementInput["rect"] }),
      ]),
    ).toThrow(/fail-closed/);
    expect(() =>
      evaluateDomGeometryInPage([
        element({
          id: "bad-rect",
          rect: { x: Number.NaN, y: 0, width: 10, height: 10 },
        }),
      ]),
    ).toThrow(/fail-closed/);
  });

  test("returns an empty defect list for clean layouts", () => {
    expect(
      evaluateDomGeometryInPage([
        element({
          id: "hero",
          scrollWidth: 100,
          clientWidth: 100,
          fontSize: 16,
          lineHeight: 24,
          overflow: "visible",
        }),
        element({
          id: "cta",
          tag: "button",
          interactive: true,
          rect: { x: 0, y: 200, width: 120, height: 44 },
        }),
      ]),
    ).toEqual([]);
  });
});
