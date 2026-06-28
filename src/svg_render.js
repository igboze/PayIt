// src/svg_render.js
// Renders SVG → PNG using @resvg/resvg-js with bundled DejaVu fonts.
// Replaces sharp's librsvg pipeline, which drops text on Railway/Linux.

const fs   = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");

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
  const resvg    = new Resvg(svg, RESVG_OPTS);
  const rendered = resvg.render();
  fs.writeFileSync(outPath, rendered.asPng());
}

module.exports = { renderSvgToPngFile };
