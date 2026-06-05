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
import { resolveStore } from './version-store/detect.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(__dirname, 'runtime');
const PAYLOAD_RE = /<script id="devrev-page-payload">[\s\S]*?<\/script>/;

// Replacement FUNCTIONS everywhere so `$` bytes in assets are never read as
// replacement patterns. Escape any tag-terminator that could close the inline
// <script>/<style> early.
const escScript = (s) => s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const escStyle = (s) => s.replace(/<\/(style)/gi, '<\\/$1');

// In-iframe selection-commenting. Injected into the PAGE HTML (so it runs inside
// the sandboxed srcDoc iframe, where text selection happens). On a real text
// selection it (a) paints a Google-Docs-style highlight over the selected range
// and (b) posts a `note` to the host overlay anchored to the SELECTION rect +
// the selected text — reusing the host's existing composer via the verified
// {source:'devrev-host-annot', type:'note', anchor:{...}} contract. It suppresses
// the host shim's element-level click-note for that gesture so they don't double-
// fire. No-op unless annotate mode is on (mirrors the host shim's gate).
const SELECTION_COMMENT_SOURCE = `
(function () {
  if (window.__devrevSelectionCommentInstalled) return;
  window.__devrevSelectionCommentInstalled = true;

  var SOURCE = 'devrev-host-annot';   // same channel the host overlay listens on
  var SNIPPET_MAX = 200, FULLTEXT_MAX = 4096;
  var passthrough = false;
  var marks = [];        // highlight rects currently painted
  var suppressClick = false;   // swallow the synthetic click after a selection
  var pending = false;   // a selection-note is awaiting commit/cancel from host
  var committed = [];     // {rects, text} persisted highlights for posted comments
  var lastRange = null;   // the range of the in-flight selection

  // Messages from the host/outer doc. passthrough disables selection-commenting;
  // annot-commit persists the pending highlight (+ stores comment text for hover);
  // annot-cancel drops it.
  window.addEventListener('message', function (ev) {
    var d = ev.data; if (!d || d.source !== SOURCE) return;
    if (d.type === 'passthrough') passthrough = !!d.active;
    else if (d.type === 'annot-commit') commitPending(d.text || '');
    else if (d.type === 'annot-cancel') cancelPending();
  });

  function post(msg) { msg.source = SOURCE; window.parent.postMessage(msg, '*'); }

  function clearMarks() {
    for (var i = 0; i < marks.length; i++) { if (marks[i].parentNode) marks[i].parentNode.removeChild(marks[i]); }
    marks = [];
  }

  // Persist the pending selection as a committed highlight that carries the
  // comment text (shown on hover). Re-rendered on scroll/resize via repaintCommitted.
  function commitPending(text) {
    pending = false;
    if (lastRange) {
      committed.push({ range: lastRange, text: text });
      lastRange = null;
    }
    clearMarks();           // drop the transient (bright) highlight
    repaintCommitted();     // draw the persistent (softer) one
  }
  function cancelPending() {
    pending = false; lastRange = null; clearMarks();
  }

  var committedEls = [];
  function clearCommittedEls() {
    for (var i = 0; i < committedEls.length; i++) { if (committedEls[i].parentNode) committedEls[i].parentNode.removeChild(committedEls[i]); }
    committedEls = [];
  }
  function repaintCommitted() {
    clearCommittedEls();
    committed.forEach(function (c) {
      var rects;
      try { rects = c.range.getClientRects(); } catch (e) { return; }
      for (var i = 0; i < rects.length; i++) {
        var r = rects[i];
        if (r.width < 1 || r.height < 1) continue;
        var m = document.createElement('div');
        m.setAttribute('data-devrev-injected', '1');
        m.title = c.text || 'Comment';   // native hover tooltip = comment upfront
        m.style.cssText = [
          'position:fixed', 'z-index:2147483639', 'cursor:help',
          'left:' + r.left + 'px', 'top:' + r.top + 'px',
          'width:' + r.width + 'px', 'height:' + r.height + 'px',
          'background:rgba(255,230,0,0.20)',
          'box-shadow:0 1px 0 rgba(214,180,0,0.7) inset, 0 -1px 0 rgba(214,180,0,0.7) inset',
          'border-radius:2px',
        ].join(';');
        document.body.appendChild(m);
        committedEls.push(m);
      }
    });
  }

  // Paint a translucent highlight over each client rect of the selection range
  // (floating overlay divs; never mutates the page's own DOM).
  function paintSelection(range) {
    clearMarks();
    var rects = range.getClientRects();
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      if (r.width < 1 || r.height < 1) continue;
      var m = document.createElement('div');
      m.setAttribute('data-devrev-injected', '1');
      m.style.cssText = [
        'position:fixed', 'pointer-events:none', 'z-index:2147483640',
        'left:' + r.left + 'px', 'top:' + r.top + 'px',
        'width:' + r.width + 'px', 'height:' + r.height + 'px',
        'background:rgba(255,230,0,0.32)',
        'box-shadow:0 1px 0 rgba(214,180,0,0.9) inset, 0 -1px 0 rgba(214,180,0,0.9) inset',
        'border-radius:2px',
      ].join(';');
      document.body.appendChild(m);
      marks.push(m);
    }
  }

  function selectionInfo() {
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    var text = sel.toString().trim();
    if (!text) return null;
    var range = sel.getRangeAt(0);
    var rect = range.getBoundingClientRect();
    if (!rect || (rect.width < 1 && rect.height < 1)) return null;
    return { sel: sel, range: range, text: text, rect: rect };
  }

  function onMouseUp(e) {
    if (passthrough || (e && (e.metaKey || e.ctrlKey))) return;
    // Defer so the browser finalizes the selection after mouseup.
    window.setTimeout(function () {
      var info = selectionInfo();
      if (!info) { clearMarks(); return; }
      // A real text selection exists → this gesture is a selection-comment, not
      // an element click. The compiled host shim also opens a note on click; we
      // can't edit it, so swallow the synthetic click it would act on (capture
      // phase, below) so only the selection-note fires.
      suppressClick = true;
      window.setTimeout(function () { suppressClick = false; }, 500);

      pending = true;
      lastRange = info.range.cloneRange();
      paintSelection(info.range);
      var snippet = info.text.length > SNIPPET_MAX ? info.text.slice(0, SNIPPET_MAX) : info.text;
      var full = info.text.length > FULLTEXT_MAX ? info.text.slice(0, FULLTEXT_MAX) : info.text;
      var r = info.rect;
      var anchorEl = info.range.startContainer.nodeType === 1
        ? info.range.startContainer
        : info.range.startContainer.parentNode;
      var tag = (anchorEl && anchorEl.tagName ? anchorEl.tagName : 'span').toLowerCase();
      post({
        type: 'note',
        anchor: {
          textSnippet: snippet,
          tagName: tag,
          rect: { x: r.left, y: r.top, width: r.width, height: r.height },
          scroll: { x: window.scrollX, y: window.scrollY },
          // Anchor the composer to the END of the selection (Docs-like).
          point: { fx: 1, fy: 1 },
          isSelection: true,
        },
        fullText: full,
        editable: false,
      });
    }, 0);
  }

  // Drop the TRANSIENT highlight when the selection collapses — but NOT while a
  // note is pending (the user clicked into the composer, which collapses the
  // selection; the bright highlight should stay until they commit or cancel).
  document.addEventListener('selectionchange', function () {
    if (pending) return;
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) clearMarks();
  });
  // Keep both transient and committed highlights aligned on scroll/resize.
  function realign() {
    if (pending && lastRange) paintSelection(lastRange);
    else { var info = selectionInfo(); if (info) paintSelection(info.range); else clearMarks(); }
    repaintCommitted();
  }
  window.addEventListener('scroll', realign, true);
  window.addEventListener('resize', realign);

  // Capture-phase click interceptor: if a selection just happened, eat the
  // click so the compiled shim's element-level note never opens.
  document.addEventListener('click', function (e) {
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    }
  }, true);

  document.addEventListener('mouseup', onMouseUp, true);
})();
`;

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

// Fallback title for an auto-commit (the agent rebuilt without an explicit
// commit). We can't know intent from bytes alone, so use a plain, honest label.
// The agent is strongly instructed to commit with a real descriptive title +
// change bullets (see SKILL.md), so this is the exception, not the norm.
function autoTitle() {
  return 'Edited (no description)';
}

// Build the history payload + picker overlay injection. Returns '' if history
// can't be produced, so the page degrades to exactly today's behavior.
function buildVersioningInjection(sourcePath) {
  let history;
  try {
    const createStore = resolveStore();
    const store = createStore(sourcePath, { identityName: null });
    // Guarantee a version per real edit: if the source changed since the last
    // version, auto-commit on rebuild. This does NOT depend on the agent
    // remembering to run the commit CLI — regenerating the page is enough. An
    // explicit `cli.mjs commit "title"` before regenerating still gives a nicer
    // title and lets the agent split a round into multiple commits; this is the
    // safety net for when it doesn't.
    const auto = store.commitIfChanged(autoTitle());
    if (auto) console.error(`[versioning] auto-committed v${auto.n} (source changed)`);
    history = store.readHistory();
  } catch (e) {
    console.error(`[versioning] disabled: ${e.message}`);
    return '';
  }
  if (!history || !history.versions || history.versions.length === 0) return '';

  const payload =
    `<script id="devrev-page-versions">` +
    `window.__DEVREV_PAGE_VERSIONS__=${JSON.stringify(history)};` +
    `</script>`;

  // Inline relative-time source (strip the ESM export keyword) + overlay source.
  const rtSrc = readFileSync(join(__dirname, 'version-store', 'relative-time.mjs'), 'utf8')
    .replace(/export\s+function/g, 'function');
  const overlaySrc = readFileSync(join(__dirname, 'picker', 'picker-overlay.js'), 'utf8');
  const overlay =
    `<script>${escScript(rtSrc)}\n${escScript(overlaySrc)}</script>`;

  return payload + overlay;
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

  let pageHtml = readFileSync(input, 'utf8');
  const pageName = basename(input);
  // Inject the selection-commenting script INTO the page HTML so it runs inside
  // the sandboxed srcDoc iframe (where text selection lives). Before </body> if
  // present, else appended.
  const selScript = `<script>${escScript(SELECTION_COMMENT_SOURCE)}</script>`;
  pageHtml = pageHtml.includes('</body>')
    ? pageHtml.replace('</body>', () => `${selScript}</body>`)
    : pageHtml + selScript;
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

  // Inject before the LAST </body>. The inlined runtime bundle contains the
  // literal text `</body>` inside its own minified JS, so a first-match replace
  // would splice the block into the middle of the bundle and break it.
  const versioning = buildVersioningInjection(input);
  let finalOut = out;
  if (versioning) {
    const idx = out.lastIndexOf('</body>');
    finalOut = idx === -1
      ? out + versioning
      : out.slice(0, idx) + versioning + out.slice(idx);
  }

  writeFileSync(output, finalOut, 'utf8');
  console.log(`✓ Wrote ${output} (${(finalOut.length / 1024).toFixed(0)} KB)`);
}

main();
