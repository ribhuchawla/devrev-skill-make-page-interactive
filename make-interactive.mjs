#!/usr/bin/env node
/**
 * make-interactive: turn a static HTML page into an interactive, editable +
 * annotatable page by wrapping it in the prebuilt DevRev annotation runtime.
 *
 *   node make-interactive.mjs <input.html> [output.html]
 *
 * Reads the runtime assets shipped beside this script (runtime/index.html +
 * runtime/a.js + runtime/a.css), inlines them into one self-contained .html,
 * and injects the user's page as base64 (injection-safe for arbitrary markup,
 * including embedded <script>/</script> and quotes). The page's own DevRevHost
 * bridge is preserved, so a Send button still talks to Computer directly when
 * the page is opened there; the in-app Send popup is the offline fallback.
 *
 * No dependencies, no build step — just Node.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(__dirname, 'runtime');
const PAYLOAD_RE = /<script id="devrev-page-payload">[\s\S]*?<\/script>/;

// Replacement FUNCTIONS everywhere so `$` bytes in assets are never read as
// replacement patterns. Escape any tag-terminator that could close the inline
// <script>/<style> early.
const escScript = (s) => s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const escStyle = (s) => s.replace(/<\/(style)/gi, '<\\/$1');

function buildTemplate() {
  const htmlPath = join(RUNTIME, 'index.html');
  if (!existsSync(htmlPath)) {
    console.error(`Runtime not found at ${RUNTIME}. The skill is missing its runtime/ assets.`);
    process.exit(1);
  }
  let html = readFileSync(htmlPath, 'utf8');

  const cssPath = join(RUNTIME, 'a.css');
  if (existsSync(cssPath)) {
    const css = readFileSync(cssPath, 'utf8');
    html = html.replace(/<link[^>]+href="[^"]*a\.css"[^>]*>/g, () => '');
    html = html.replace('</head>', () => `<style>${escStyle(css)}</style></head>`);
  }
  const jsPath = join(RUNTIME, 'a.js');
  if (existsSync(jsPath)) {
    const js = readFileSync(jsPath, 'utf8');
    html = html.replace(/<script[^>]+src="[^"]*a\.js"[^>]*><\/script>/g, () => '');
    html = html.replace('</body>', () => `<script type="module">${escScript(js)}</script></body>`);
  }
  return html;
}

function main() {
  const [, , inputArg, outputArg] = process.argv;
  if (!inputArg) {
    console.error('Usage: node make-interactive.mjs <input.html> [output.html]');
    process.exit(1);
  }
  const input = resolve(process.cwd(), inputArg);
  if (!existsSync(input)) {
    console.error(`Input not found: ${input}`);
    process.exit(1);
  }

  const template = buildTemplate();
  if (!PAYLOAD_RE.test(template)) {
    console.error('Runtime template is missing the devrev-page-payload block.');
    process.exit(1);
  }

  const pageHtml = readFileSync(input, 'utf8');
  const pageName = basename(input);
  const b64 = Buffer.from(pageHtml, 'utf8').toString('base64');
  const payload =
    `<script id="devrev-page-payload">` +
    `window.__DEVREV_PAGE_HTML__=decodeURIComponent(escape(atob(${JSON.stringify(b64)})));` +
    `window.__DEVREV_PAGE_NAME__=${JSON.stringify(pageName)};` +
    `</script>`;

  const out = template.replace(PAYLOAD_RE, () => payload);
  const output = outputArg
    ? resolve(process.cwd(), outputArg)
    : join(dirname(input), pageName.replace(/\.html?$/i, '') + '.interactive.html');
  writeFileSync(output, out, 'utf8');
  console.log(`✓ Wrote ${output} (${(out.length / 1024).toFixed(0)} KB)`);
}

main();
