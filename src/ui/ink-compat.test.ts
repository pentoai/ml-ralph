import { describe, expect, test } from "bun:test";
import { __testing } from "./ink.tsx";

describe("Ink compat layer", () => {
  test("Box defaults to row flexDirection like Ink", () => {
    const mapped = __testing.mapBoxPropsForCompat({});
    expect(mapped.flexDirection).toBe("row");
  });

  test("Text defaults to word wrapping like Ink", () => {
    const mapped = __testing.mapTextPropsForCompat({});
    expect(mapped.wrapMode).toBe("word");
    expect(mapped.truncate).toBe(false);
  });

  test("Text truncate maps to non-wrapping truncation", () => {
    const mapped = __testing.mapTextPropsForCompat({ wrap: "truncate" });
    expect(mapped.wrapMode).toBe("none");
    expect(mapped.truncate).toBe(true);
  });

  test("preserves boundary spaces between styled chunks", () => {
    expect(__testing.preserveEdgeSpacesInString(" icon ")).toBe(
      "\u00A0icon\u00A0\u2060",
    );
  });
});
