import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { metadata } from "@/app/layout";
import { REPOSTORY_ICON_PATH, REPOSTORY_MARK_PATH } from "@/components/RepoStoryBrand";

const root = process.cwd();

function pngDimensions(filePath: string): { width: number; height: number } {
  const bytes = readFileSync(filePath);
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("RepoStory brand assets", () => {
  it("ships the supplied transparent source and a compact mark derived from it", () => {
    const sourcePath = path.join(root, "public", REPOSTORY_ICON_PATH.slice(1));
    const markPath = path.join(root, "public", REPOSTORY_MARK_PATH.slice(1));

    expect(existsSync(sourcePath)).toBe(true);
    expect(existsSync(markPath)).toBe(true);
    expect(pngDimensions(sourcePath)).toEqual({ width: 669, height: 373 });
    expect(pngDimensions(markPath)).toEqual({ width: 512, height: 512 });
    expect(readFileSync(sourcePath)[25]).toBe(6);
    expect(readFileSync(markPath)[25]).toBe(6);
  });

  it("references the official icon in root metadata for app and social surfaces", () => {
    const serializedMetadata = JSON.stringify(metadata);

    expect(serializedMetadata).toContain(REPOSTORY_ICON_PATH);
    expect(serializedMetadata).toContain(REPOSTORY_MARK_PATH);
    expect(serializedMetadata).toContain("summary_large_image");
  });

  it("does not retain starter asset references or the old text-only mark", () => {
    const source = [
      readFileSync(path.join(root, "src", "app", "page.tsx"), "utf8"),
      readFileSync(path.join(root, "src", "components", "RepoAnalysis.tsx"), "utf8"),
      readFileSync(path.join(root, "src", "app", "layout.tsx"), "utf8"),
    ].join("\n");

    expect(source).not.toContain('className="brand-mark">R');
    expect(source).not.toMatch(/(?:file|globe|next|vercel|window)\.svg/);
    for (const placeholder of ["file.svg", "globe.svg", "next.svg", "vercel.svg", "window.svg"]) {
      expect(existsSync(path.join(root, "public", placeholder))).toBe(false);
    }
  });
});
