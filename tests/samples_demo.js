// tests/samples_demo.js
// Generates a minimal PPTX (zip) with one slide using JSZip, then runs parsePptx
process.env.USE_MOCK_AI = '1';

const JSZip = require('jszip');
const { parsePptx } = require('../agent/file_parser');
const fs = require('fs');

async function makePptxBuffer(text) {
  const zip = new JSZip();
  // Minimal structure: [Content_Types].xml, ppt/slides/slide1.xml
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n  <Default Extension="xml" ContentType="application/xml"/>\n</Types>`);
  zip.folder('ppt').folder('slides').file('slide1.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">\n  <p:cSld>\n    <p:spTree>\n      <p:sp>\n        <p:txBody>\n          <a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">\n            <a:t>${text}</a:t>\n          </a:p>\n        </p:txBody>\n      </p:sp>\n    </p:spTree>\n  </p:cSld>\n</p:sld>`);
  return await zip.generateAsync({ type: 'nodebuffer' });
}

async function run() {
  const buffer = await makePptxBuffer('Invoice\nClient: Acme Ltd\nAmount: $500');
  const parsed = await parsePptx(buffer);
  console.log('PPTX parsed result:', JSON.stringify(parsed, null, 2));
  // CSV sample
  const csv = 'Name,Amount,Account\nJohn,100,0123456789\nJane,200,0987654321\n';
  fs.writeFileSync('tests/samples/sample.csv', csv);
  console.log('Wrote tests/samples/sample.csv');
}

run().catch(err => { console.error(err); process.exit(1); });
