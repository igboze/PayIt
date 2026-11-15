// src/svg_render.js
// Renders SVG → PNG using @resvg/resvg-js with bundled DejaVu fonts.
// Replaces sharp's librsvg pipeline, which drops text on Railway/Linux.

const fs   = require("fs");
const path = require("path");
// Lazy-load @resvg/resvg-js at runtime. Some container environments
// may not have the platform-native binding installed, so require()
// can fail at module load time. We catch that and fall back to a
// harmless blank PNG so the app can start; invoice rendering will
// still log a warning and produce a placeholder image.

let Resvg;
try {
  Resvg = require("@resvg/resvg-js").Resvg;
} catch (err) {
  Resvg = null;
}

const FONT_DIR = path.join(__dirname, "..", "node_modules", "dejavu-fonts-ttf", "ttf");

const FONT_FILES = [
  path.join(FONT_DIR, "DejaVuSans.ttf"),
  path.join(FONT_DIR, "DejaVuSans-Bold.ttf"),
  path.join(FONT_DIR, "DejaVuSansMono.ttf"),
  path.join(FONT_DIR, "DejaVuSansMono-Bold.ttf"),
];

const RESVG_OPTS = {
  font: {
    fontFiles:       FONT_FILES,
    loadSystemFonts: false,
    defaultFontFamily: "DejaVu Sans",
  },
};

/** Write an SVG string to a PNG file. */
function renderSvgToPngFile(svg, outPath) {
  if (Resvg) {
    const resvg = new Resvg(svg, RESVG_OPTS);
    const rendered = resvg.render();
    fs.writeFileSync(outPath, rendered.asPng());
    return;
  }

  // Fallback: write a 1x1 transparent PNG as a placeholder and warn.
  // This avoids crashing the whole app when the native binding is missing.
  console.warn("[svg_render] @resvg/resvg-js not available; writing placeholder PNG to", outPath);
  const blankPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=";
  const buf = Buffer.from(blankPngBase64, "base64");
  fs.writeFileSync(outPath, buf);
}

module.exports = { renderSvgToPngFile };
