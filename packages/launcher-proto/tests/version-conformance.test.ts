import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compareLauncherVersions } from "../src/index.js";

// Shared conformance fixture (also verified by the Go launcher's CmpVersion test):
// both ports must agree on version ordering so they never drift (Q4).
const fixturePath = fileURLToPath(new URL("../../../launcher/testdata/version-conformance.json", import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  cases: Array<{ a: string; b: string; expected: number }>;
};

describe("compareLauncherVersions Go/TS conformance", () => {
  it("has a non-empty shared fixture", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  it.each(fixture.cases)("orders $a vs $b as $expected", ({ a, b, expected }) => {
    expect(Math.sign(compareLauncherVersions(a, b))).toBe(expected);
  });
});
