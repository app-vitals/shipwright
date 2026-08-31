#!/usr/bin/env bun
/**
 * Rasterizes assets/logo/shipwright-icon.svg into the six committed PWA icon
 * PNGs consumed by admin/src/pwa.ts (PWA_ICONS) and served from
 * admin/pwa-assets/icons/.
 *
 * Uses the repo's existing headless Chromium (Playwright, already an admin/
 * devDependency for e2e tests) instead of adding a native `sharp` dependency
 * for six static files — loads the SVG in a minimal HTML wrapper sized to
 * each target icon's dimensions and screenshots it.
 *
 * Maskable icons (icon-maskable-192.png, icon-maskable-512.png) confine the
 * glyph to a ~40% safe zone: the source SVG is scaled down and centered
 * within the canvas so Android's masking (circle, squircle, etc.) never
 * clips the logo. The apple-touch-icon is rendered on an OPAQUE background
 * (the SVG's own dark navy, not transparent) — iOS composites transparent
 * icons onto black otherwise.
 *
 * This is a one-time/on-demand dev script, not a build or CI step — its
 * PNG output is committed to the repo, not generated at runtime.
 *
 *   bun scripts/build-pwa-icons.ts
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Resolved via admin's node_modules (Playwright is an admin/ devDependency,
// the repo's existing headless-Chromium tooling for e2e tests) rather than
// adding a root-level Playwright dependency for a one-time script.
import { chromium } from "../admin/node_modules/@playwright/test/index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SVG_PATH = join(REPO_ROOT, "assets", "logo", "shipwright-icon.svg");
const OUTPUT_DIR = join(REPO_ROOT, "admin", "pwa-assets", "icons");

// The source SVG's own dark navy background (see rect fill in
// shipwright-icon.svg) — used as the opaque backdrop for the apple-touch-icon
// so iOS never composites a transparent icon onto black.
const OPAQUE_BG = "#0D1117";

interface IconTarget {
  filename: string;
  size: number;
  /** Fraction of the canvas the glyph occupies (1 = edge-to-edge, 0.4 = maskable safe zone). */
  glyphScale: number;
  /** Render an opaque background behind the SVG instead of transparent. */
  opaqueBackground: boolean;
}

const TARGETS: IconTarget[] = [
  {
    filename: "icon-192.png",
    size: 192,
    glyphScale: 1,
    opaqueBackground: false,
  },
  {
    filename: "icon-512.png",
    size: 512,
    glyphScale: 1,
    opaqueBackground: false,
  },
  {
    filename: "icon-maskable-192.png",
    size: 192,
    glyphScale: 0.4,
    opaqueBackground: true,
  },
  {
    filename: "icon-maskable-512.png",
    size: 512,
    glyphScale: 0.4,
    opaqueBackground: true,
  },
  {
    filename: "apple-touch-icon.png",
    size: 180,
    glyphScale: 1,
    opaqueBackground: true,
  },
  {
    filename: "favicon-32.png",
    size: 32,
    glyphScale: 1,
    opaqueBackground: false,
  },
];

/**
 * Strips the radial-gradient sky background (defs + the rect using it),
 * leaving the flat #0D1117 base rect and the ship-wheel glyph untouched.
 * The gradient's smooth 512x512 color ramp is what pushes losslessly
 * compressed PNG output well past the 60KB icon budget (Chromium's PNG
 * encoder has no palette/quantization step) — flattening the backdrop to a
 * single color is a standard app-icon simplification and keeps the glyph
 * itself pixel-identical to the source asset.
 */
function flattenGradientBackground(svgMarkup: string): string {
  return svgMarkup
    .replace(/<defs>.*?<\/defs>/s, "")
    .replace(/<rect ([^>]*)fill="url\(#sky\)"([^>]*)\/>/, "");
}

function buildHtml(svgMarkup: string, target: IconTarget): string {
  const bg = target.opaqueBackground ? OPAQUE_BG : "transparent";
  const glyphSize = target.size * target.glyphScale;
  return `<!DOCTYPE html>
<html>
<head>
<style>
  html, body { margin: 0; padding: 0; background: ${bg}; }
  body {
    width: ${target.size}px;
    height: ${target.size}px;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  svg { width: ${glyphSize}px; height: ${glyphSize}px; display: block; }
</style>
</head>
<body>
${svgMarkup}
</body>
</html>`;
}

async function main() {
  if (!existsSync(SVG_PATH)) {
    console.error(`[build-pwa-icons] source SVG not found: ${SVG_PATH}`);
    process.exit(1);
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const svgMarkup = flattenGradientBackground(readFileSync(SVG_PATH, "utf8"));

  const browser = await chromium.launch();
  try {
    for (const target of TARGETS) {
      const page = await browser.newPage({
        viewport: { width: target.size, height: target.size },
        deviceScaleFactor: 1,
      });
      try {
        const html = buildHtml(svgMarkup, target);
        await page.setContent(html, { waitUntil: "load" });
        const outPath = join(OUTPUT_DIR, target.filename);
        await page.screenshot({
          path: outPath,
          omitBackground: !target.opaqueBackground,
        });
        console.log(`[build-pwa-icons] wrote ${outPath}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  console.log("[build-pwa-icons] done.");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[build-pwa-icons] fatal error:", err);
    process.exit(1);
  });
}
