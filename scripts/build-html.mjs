// Embeds src/app.html into src/html.js (the module the worker imports).
// Run after every change to app.html: npm run build:html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'src/app.html'), 'utf8');

const out = `import { FONTS_CSS } from './fonts_css.js';

const TEMPLATE = ${JSON.stringify(html)};

export const APP_HTML = TEMPLATE.replace('/*{{FONTS_CSS}}*/', FONTS_CSS);
`;

fs.writeFileSync(path.join(ROOT, 'src/html.js'), out);
console.log(`src/html.js updated (${html.length} chars)`);
