// src/svg_fonts.js
// Shared font-family constants for SVG generators (fonts loaded by svg_render.js).

const FONT      = "'DejaVu Sans', sans-serif";
const FONT_MONO = "'DejaVu Sans Mono', monospace";

/** Minimal CSS — actual fonts are loaded from disk by svg_render.js. */
function getFontCss() {
  return `text, tspan { font-family: 'DejaVu Sans', sans-serif; }`;
}

module.exports = { FONT, FONT_MONO, getFontCss };
