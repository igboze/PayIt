// src/svg_fonts.js
// Embeds DejaVu fonts as base64 @font-face rules inside SVG <style> blocks.
// Works on every platform (Windows, Railway/Nix) without relying on system fontconfig.

const fs   = require("fs");
const path = require("path");

const FONT_DIR = path.join(__dirname, "..", "node_modules", "dejavu-fonts-ttf", "ttf");

let _css = null;

function fontB64(filename) {
  return fs.readFileSync(path.join(FONT_DIR, filename)).toString("base64");
}

/** Returns CSS @font-face rules to embed inside an SVG <style> block. */
function getEmbeddedFontCss() {
  if (_css) return _css;

  const regular = fontB64("DejaVuSans.ttf");
  const bold    = fontB64("DejaVuSans-Bold.ttf");
  const mono    = fontB64("DejaVuSansMono.ttf");
  const monoB   = fontB64("DejaVuSansMono-Bold.ttf");

  _css = `
    @font-face {
      font-family: 'DejaVu Sans';
      src: url('data:font/truetype;base64,${regular}') format('truetype');
      font-weight: normal;
      font-style: normal;
    }
    @font-face {
      font-family: 'DejaVu Sans';
      src: url('data:font/truetype;base64,${bold}') format('truetype');
      font-weight: bold;
      font-style: normal;
    }
    @font-face {
      font-family: 'DejaVu Sans Mono';
      src: url('data:font/truetype;base64,${mono}') format('truetype');
      font-weight: normal;
      font-style: normal;
    }
    @font-face {
      font-family: 'DejaVu Sans Mono';
      src: url('data:font/truetype;base64,${monoB}') format('truetype');
      font-weight: bold;
      font-style: normal;
    }
    text, tspan { font-family: 'DejaVu Sans', sans-serif; }
  `;

  return _css;
}

module.exports = { getEmbeddedFontCss };
