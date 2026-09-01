import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function cssFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.isFile() && entry.name.endsWith(".css") ? [path] : [];
  });
}

describe("flat visual design contract", () => {
  it("contains no CSS gradient or decorative background image", () => {
    const violations = cssFiles(join(process.cwd(), "src")).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      const matches = source.match(/(?:gradient\s*\(|background-image\s*:)/gi) ?? [];
      return matches.map((match) => ({ path, match }));
    });
    expect(violations).toEqual([]);
  });

  it("keeps the application canvas and borders on the neutral grey palette", () => {
    const theme = readFileSync(join(process.cwd(), "src/light-theme.css"), "utf8");
    expect(theme).toContain("--canvas: #f3f3f1");
    expect(theme).toContain("--border: #deded9");
    expect(theme).toContain("background: var(--canvas)");
  });
});
