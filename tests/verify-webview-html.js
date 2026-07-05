// Validate that the inline <script> blocks in the emitted webview HTML
// parse as syntactically valid JavaScript. Catches the class of bug that
// broke v1.10.26 (unescaped apostrophe in a title attribute — `doesn\'t`
// inside an outer template literal evaluates to `doesn't` at runtime and
// terminates a single-quoted JS string in the webview).
//
// CRITICAL: we must EVALUATE the outer template literal first to reproduce
// what the webview actually sees. Reading the raw source misses this class
// of bug because `\'` looks fine in the source but becomes `'` at runtime.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'out', 'dashboardPanel.js'), 'utf8');

// The compiled TS emits: return `<!DOCTYPE html>...`;
// Find the largest template literal, evaluate it, then inspect the result.
const matches = [];
let start = -1;
for (let i = 0; i < src.length; i++) {
  if (src[i] === '`' && src[i - 1] !== '\\') {
    if (start === -1) { start = i + 1; }
    else { matches.push(src.slice(start, i)); start = -1; }
  }
}
if (matches.length === 0) { console.log('NO TEMPLATE LITERALS FOUND'); process.exit(1); }
const rawTemplate = matches.reduce((a, b) => b.length > a.length ? b : a);
console.log('Largest template literal (raw source):', rawTemplate.length, 'chars');

// Evaluate the template literal to get the runtime HTML string.
// Substitute ${jsonData} with a placeholder object literal first.
let html;
try {
  const stubbed = rawTemplate.replace(/\$\{jsonData\}/g, '{}');
  // eslint-disable-next-line no-new-func
  html = new Function('return `' + stubbed + '`')();
} catch (e) {
  console.log('FAIL: outer template literal is not valid JS —', e.message);
  process.exit(1);
}
console.log('Runtime HTML length:', html.length, 'chars');

const scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
let m;
let count = 0;
let failed = 0;
while ((m = scriptRe.exec(html)) !== null) {
  count++;
  const body = m[1];
  try {
    // eslint-disable-next-line no-new-func
    new Function(body);
    console.log('  Inline script #' + count + ': PARSE OK (' + body.length + ' chars)');
  } catch (e) {
    failed++;
    console.log('  Inline script #' + count + ': PARSE FAIL — ' + e.message);
    // Show a snippet around the error position if the message includes line:col
    const pos = e.message.match(/\((\d+):(\d+)\)/);
    if (pos) {
      const lineNum = parseInt(pos[1], 10);
      const lines = body.split('\n');
      const from = Math.max(0, lineNum - 2);
      const to = Math.min(lines.length, lineNum + 1);
      for (let i = from; i < to; i++) {
        console.log('    ' + (i + 1) + ': ' + lines[i].slice(0, 200));
      }
    }
  }
}
console.log('\n' + count + ' inline scripts checked, ' + failed + ' failed.');
process.exit(failed > 0 ? 1 : 0);

