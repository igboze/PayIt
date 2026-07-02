const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const assetsDir = path.join(__dirname, '..', 'assets');

async function convert(svgPath, outPath) {
  try {
    await sharp(svgPath)
      .png({ quality: 90 })
      .toFile(outPath);
    console.log(`Converted ${path.basename(svgPath)} -> ${path.basename(outPath)}`);
  } catch (err) {
    console.error(`Failed to convert ${svgPath}:`, err.message);
    process.exitCode = 1;
  }
}

async function main() {
  const files = fs.readdirSync(assetsDir).filter(f => f.endsWith('.svg'));
  if (files.length === 0) {
    console.log('No SVG files found in assets/.');
    return;
  }

  for (const f of files) {
    const svgPath = path.join(assetsDir, f);
    const outName = f.replace(/\.svg$/i, '.png');
    const outPath = path.join(assetsDir, outName);
    await convert(svgPath, outPath);
  }
}

main();
