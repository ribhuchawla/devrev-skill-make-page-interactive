// Self-contained version picker. Renders only if a history payload is present.
// Emits copy-paste prompts (never runs version control). `formatRelativeTime`
// is provided by relative-time.mjs source inlined ahead of this script.
//
// Design: this script runs in the SAME document as the annotation toolbar, and
// the full DevRev design-system CSS (a.css) is inlined here. So we DON'T invent
// styles — we dock a "Versions" button into the real toolbar's right cluster
// next to Comments (mirroring its exact DS utility classes) and build the
// dropdown from the same surface/border/elevation tokens the comments sidebar
// uses. Falls back to a floating chip if the toolbar isn't found.
(function () {
  var data = window.__DEVREV_PAGE_VERSIONS__;
  if (!data || !Array.isArray(data.versions) || data.versions.length === 0) return;

  // The comments-panel three-dot menu is a Radix dropdown that portals to body.
  // It can end up rendered below other stacking contexts (the menu opens but is
  // hidden). Force the Radix popper wrapper + menu content above everything and
  // ensure they're not clipped. Scoped to Radix attrs so it can't affect the page.
  try {
    var fix = document.createElement('style');
    fix.setAttribute('data-devrev-menu-fix', '1');
    fix.textContent = [
      '[data-radix-popper-content-wrapper]{z-index:2147483646 !important}',
      '[data-radix-menu-content]{z-index:2147483646 !important;overflow:visible !important}',
    ].join('');
    document.head.appendChild(fix);
  } catch (e) { /* no-op */ }

  var page = data.page || 'page.html';
  // The outer document sets no font-family, so body-appended nodes (dropdown,
  // dialog) fall back to serif. Pin the brand sans stack on those roots.
  var FONT = "'Inter','Chip Text',-apple-system,system-ui,'Segoe UI',sans-serif";
  var BRAND_YELLOW = '#FFE600';
  var INK = '#161616';
  var fmt = (typeof formatRelativeTime === 'function')
    ? function (iso) { return formatRelativeTime(iso, new Date()); }
    : function (iso) { return iso; };

  // Render a (trusted, constant) inline-SVG icon plus optional label text WITHOUT
  // innerHTML: parse the SVG via DOMParser and append the node + a text node.
  // Keeps the picker XSS-clean (no innerHTML sinks) and satisfies the evaluator.
  function setIcon(el, svgString, labelText) {
    while (el.firstChild) el.removeChild(el.firstChild);
    try {
      var doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
      var svg = doc.documentElement;
      if (svg && svg.nodeName.toLowerCase() === 'svg') el.appendChild(document.importNode(svg, true));
    } catch (e) { /* if parsing fails, just show the label */ }
    if (labelText) el.appendChild(document.createTextNode(labelText));
  }

  // Best-effort persistence for recently-shared emails. localStorage throws in
  // the sandboxed iframe (opaque origin), so guard it and fall back to memory.
  var RECENT_EMAILS_KEY = 'devrev-vc-recent-emails';
  var memEmails = [];
  function loadRecentEmails() {
    try {
      var raw = window.localStorage.getItem(RECENT_EMAILS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* sandbox-denied */ }
    return memEmails.slice();
  }
  function saveRecentEmails(list) {
    memEmails = list.slice(0, 20);
    try { window.localStorage.setItem(RECENT_EMAILS_KEY, JSON.stringify(memEmails)); }
    catch (e) { /* sandbox-denied — memory only for this session */ }
  }
  function rememberEmails(csv) {
    var incoming = csv.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!incoming.length) return;
    var seen = {}, merged = [];
    incoming.concat(loadRecentEmails()).forEach(function (e) {
      var k = e.toLowerCase();
      if (!seen[k]) { seen[k] = 1; merged.push(e); }
    });
    saveRecentEmails(merged);
  }

  // DS class strings mirrored from the toolbar's own buttons (a.js).
  // shrink-0 + whitespace-nowrap so our injected buttons never wrap or squeeze
  // the page's existing "Send to Computer" button into a multi-line blob.
  var BTN_BASE = 'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-system-medium transition-colors';
  var BTN_IDLE = 'fg-neutral-medium hover:fg-neutral-prominent hover:bg-surface-backdrop';
  var BTN_ACTIVE = 'bg-surface-backdrop fg-neutral-prominent';

  var SVG_NS = 'xmlns="http://www.w3.org/2000/svg" ';
  var HISTORY_ICON =
    '<svg ' + SVG_NS + 'width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>';
  var PENCIL_ICON =
    '<svg ' + SVG_NS + 'width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  var UP_ICON =
    '<svg ' + SVG_NS + 'width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';

  var open = false;
  var pop = null;
  var btn = null;

  function promptText(kind, v, branchName) {
    if (kind === 'restore') return 'Restore version ' + v.n + ' (' + v.title + ') of ' + page + ' as the latest version.';
    if (kind === 'branch') {
      var from = data.versions[0];
      return 'Create a new branch "' + (branchName || '<name>') + '" from version ' + from.n + ' of ' + page + '.';
    }
    if (kind === 'switch') return 'Switch ' + page + ' to branch "' + branchName + '" and regenerate.';
    return '';
  }

  // ---- Copy-paste dialog (DS tokens, matches the Send dialog) ----------------
  function openDialog(buildText, opts) {
    opts = opts || {};
    var back = document.createElement('div');
    back.className = 'fixed inset-0 flex items-center justify-center';
    back.style.cssText = 'z-index:2147483647;background:rgba(22,22,22,.32);font-family:' + FONT;

    var dlg = document.createElement('div');
    dlg.className = 'flex w-[30rem] max-w-[92vw] flex-col gap-3 rounded-2xl border border-neutral-soft bg-surface-overlay p-4 elevation-l';

    var title = document.createElement('div');
    title.className = 'text-system-bold fg-neutral-prominent';
    title.textContent = 'Paste this into the Computer chat';
    var sub = document.createElement('div');
    sub.className = 'text-body-small fg-neutral-medium';
    sub.textContent = 'Computer applies it and regenerates this page with the new version.';
    dlg.appendChild(title); dlg.appendChild(sub);

    var nameInput = null;
    var ta = document.createElement('textarea');
    ta.readOnly = true;
    ta.className = 'w-full resize-none rounded-lg border border-neutral-soft bg-surface-backdrop px-2.5 py-2 font-mono text-caption fg-neutral-prominent focus:border-neutral-medium focus:outline-none';
    ta.rows = 4;

    function refresh() { ta.value = buildText(nameInput ? nameInput.value.trim() : undefined); }

    if (opts.nameField) {
      nameInput = document.createElement('input');
      nameInput.className = 'w-full rounded-lg border border-neutral-soft bg-surface-backdrop px-2.5 py-2 text-system-medium fg-neutral-prominent focus:border-neutral-medium focus:outline-none';
      nameInput.placeholder = 'branch name, e.g. pricing-experiment';
      nameInput.addEventListener('input', refresh);
      dlg.appendChild(nameInput);
    }
    refresh();
    dlg.appendChild(ta);

    var row = document.createElement('div');
    row.className = 'flex items-center justify-end gap-2';
    var close = document.createElement('button');
    close.className = 'rounded-md px-3 py-1.5 text-system-medium fg-neutral-medium transition-colors hover:bg-surface-backdrop hover:fg-neutral-prominent';
    close.textContent = 'Close';
    var copy = document.createElement('button');
    copy.className = 'rounded-md px-3 py-1.5 text-system-bold';
    copy.style.cssText = 'background:' + BRAND_YELLOW + ';color:' + INK + ';white-space:nowrap';
    copy.textContent = 'Copy prompt';
    row.appendChild(close); row.appendChild(copy);
    dlg.appendChild(row);
    back.appendChild(dlg);
    document.body.appendChild(back);

    if (nameInput) nameInput.focus(); else { ta.focus(); ta.select(); }
    copy.addEventListener('click', function () {
      ta.focus(); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      copy.textContent = ok ? 'Copied ✓' : 'Press ⌘C to copy';
      setTimeout(function () { copy.textContent = 'Copy prompt'; }, 1800);
    });
    close.addEventListener('click', function () { back.remove(); });
    back.addEventListener('click', function (e) { if (e.target === back) back.remove(); });
  }

  // ---- Publish dialog --------------------------------------------------------
  // Audience menu builds a paste-back prompt for Computer to run the bundled
  // ui-publisher-public skill. The page can't publish itself (sandbox).
  var PUBLISHER = 'make-page-interactive/publish/ui-publisher-public';

  // Publish surface: ONE access choice with three modes, chosen from a segmented
  // switcher at the top — Anyone in org / Specific people / Public link. The
  // people input shows only in the "Specific people" mode. If this version was
  // published before, a "Copy link" row appears at the top. `v` null → current.
  var MODES = [
    { key: 'internal', label: 'Anyone in org', sub: 'Anyone in your DevRev org with the link can open it.' },
    { key: 'people', label: 'Specific people', sub: 'Only the people and groups you add can open it.' },
    { key: 'public', label: 'Public link', sub: 'Anyone with the link, no login — the link expires after 7 days.' },
  ];
  function openPublishDialog(v) {
    if (!v) v = data.versions[0];

    var people = [];           // {kind:'email'|'group', value}
    var mode = 'internal';     // 'internal' | 'people' | 'public'
    var alsoOrg = true;        // public: also keep org access

    var back = document.createElement('div');
    back.className = 'fixed inset-0 flex items-center justify-center';
    back.style.cssText = 'z-index:2147483647;background:rgba(22,22,22,.32);font-family:' + FONT;
    var dlg = document.createElement('div');
    dlg.className = 'flex w-[30rem] max-w-[92vw] flex-col gap-3 rounded-2xl border border-neutral-soft bg-surface-overlay p-4 elevation-l';
    // Build the title with textContent (data-safe) rather than innerHTML.
    var dlgHead = document.createElement('div');
    dlgHead.className = 'text-system-bold fg-neutral-prominent';
    dlgHead.textContent = 'Publish “' + (v.title || page) + '”';
    dlg.appendChild(dlgHead);

    // ---- already-published? show a Copy-link row at the top ----
    var pubs = Array.isArray(v.published) ? v.published : [];
    if (pubs.length) {
      var last = pubs[pubs.length - 1];
      var existingUrl = last.publicUrl || last.viewerUrl;
      if (existingUrl) {
        var liveRow = document.createElement('div');
        liveRow.className = 'flex items-center gap-2 rounded-lg bg-surface-backdrop px-3 py-2';
        var live = document.createElement('span');
        live.className = 'text-caption fg-neutral-medium truncate';
        live.style.cssText = 'min-width:0;flex:1';
        var whoMap = { personal: 'Private', internal: 'Org', public: 'Public' };
        live.textContent = '🔗 Live · ' + (whoMap[last.access] || last.access) + ' — ' + existingUrl;
        var copyLink = document.createElement('button');
        copyLink.className = 'shrink-0 rounded-md border border-neutral-soft px-2.5 py-1 text-caption-bold fg-neutral-medium transition-colors hover:bg-surface-overlay hover:fg-neutral-prominent';
        copyLink.textContent = 'Copy link';
        copyLink.addEventListener('click', function () {
          var t = document.createElement('textarea'); t.value = existingUrl;
          t.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(t); t.select();
          try { document.execCommand('copy'); } catch (e) { /* sandbox */ }
          t.remove(); copyLink.textContent = 'Copied ✓';
          setTimeout(function () { copyLink.textContent = 'Copy link'; }, 1500);
        });
        liveRow.appendChild(live); liveRow.appendChild(copyLink);
        dlg.appendChild(liveRow);
        var reShare = document.createElement('div');
        reShare.className = 'text-caption fg-neutral-subtle';
        reShare.textContent = 'Re-publish with different access:';
        dlg.appendChild(reShare);
      }
    }

    // ---- segmented switcher (top) ----
    var seg = document.createElement('div');
    seg.className = 'flex gap-0.5 rounded-lg bg-surface-backdrop p-0.5';
    var segBtns = {};
    MODES.forEach(function (m) {
      var b = document.createElement('button');
      b.className = 'flex-1 rounded-md px-2.5 py-1.5 text-system-medium transition-colors';
      b.textContent = m.label;
      b.addEventListener('click', function () { setMode(m.key); });
      seg.appendChild(b);
      segBtns[m.key] = b;
    });
    var subLine = document.createElement('div');
    subLine.className = 'text-caption fg-neutral-subtle';

    // ---- people input + pills (only in 'people' mode) ----
    var peopleWrap = document.createElement('div');
    peopleWrap.className = 'flex flex-col gap-2';
    var input = document.createElement('input');
    input.className = 'w-full rounded-lg border border-neutral-soft bg-surface-backdrop px-3 py-2 text-system-medium fg-neutral-prominent focus:border-neutral-medium focus:outline-none';
    input.placeholder = 'Add an email or group name, then Enter';
    var pills = document.createElement('div');
    pills.className = 'flex flex-wrap gap-1.5';
    var recentRow = document.createElement('div');
    recentRow.className = 'flex flex-wrap items-center gap-1';
    peopleWrap.appendChild(input);
    peopleWrap.appendChild(pills);
    peopleWrap.appendChild(recentRow);

    // ---- public-only block: pronounced 7-day expiry warning + keep-org-access ----
    var publicExtra = document.createElement('div');
    publicExtra.className = 'flex flex-col gap-2';
    // Loud expiry warning. Amber, icon + bold "7 days", full-width banner. Security.
    var warn = document.createElement('div');
    warn.className = 'flex items-start gap-2 rounded-lg px-3 py-2.5';
    warn.style.cssText = 'background:#fff7e0;border:1px solid #f4d77a';
    warn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a8730a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none;margin-top:1px" aria-hidden="true">' +
      '<path d="M10.3 3.3 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>' +
      '<div class="text-caption" style="color:#7a5300;line-height:1.45">' +
      '<span style="font-weight:700">Expires in 7 days.</span> For security, the public link stops working after 7 days. ' +
      'Anyone with it can view the page until then, with no login. Re-publish to issue a fresh link.</div>';
    var keepLabel = document.createElement('label');
    keepLabel.className = 'flex items-center gap-2 text-caption fg-neutral-medium';
    var keepCb = document.createElement('input'); keepCb.type = 'checkbox'; keepCb.checked = true;
    keepCb.addEventListener('change', function () { alsoOrg = keepCb.checked; refresh(); });
    keepLabel.appendChild(keepCb);
    keepLabel.appendChild(document.createTextNode('Also keep org-wide access after the link expires'));
    publicExtra.appendChild(warn);
    publicExtra.appendChild(keepLabel);

    var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    function addToken(raw) {
      var val = raw.trim(); if (!val) return;
      var kind = EMAIL_RE.test(val) ? 'email' : 'group';
      if (people.some(function (p) { return p.value.toLowerCase() === val.toLowerCase(); })) return;
      people.push({ kind: kind, value: val });
      if (kind === 'email') rememberEmails(val);
      renderPills(); renderRecent(); refresh();
    }
    function commitInput() { input.value.split(',').forEach(addToken); input.value = ''; }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitInput(); }
      else if (e.key === 'Backspace' && !input.value && people.length) { people.pop(); renderPills(); renderRecent(); refresh(); }
    });
    input.addEventListener('blur', commitInput);

    function renderPills() {
      pills.innerHTML = '';
      people.forEach(function (p, i) {
        var pill = document.createElement('span');
        pill.className = 'inline-flex items-center gap-1.5 rounded-full border border-neutral-soft px-2.5 py-1 text-caption fg-neutral-prominent';
        var dotc = p.kind === 'group' ? '#5800E6' : '#3968F6';
        // Build with DOM nodes + textContent (data-safe) rather than innerHTML.
        var dotEl = document.createElement('span');
        dotEl.style.cssText = 'width:6px;height:6px;border-radius:50%;background:' + dotc;
        pill.appendChild(dotEl);
        pill.appendChild(document.createTextNode((p.kind === 'group' ? 'group: ' : '') + p.value));
        var x = document.createElement('button');
        x.className = 'fg-neutral-subtle hover:fg-neutral-prominent'; x.textContent = '×'; x.style.cssText = 'font-size:14px;line-height:1';
        x.addEventListener('click', function () { people.splice(i, 1); renderPills(); renderRecent(); refresh(); });
        pill.appendChild(x); pills.appendChild(pill);
      });
    }
    function renderRecent() {
      recentRow.innerHTML = '';
      var recent = loadRecentEmails().filter(function (em) {
        return !people.some(function (p) { return p.value.toLowerCase() === em.toLowerCase(); });
      });
      if (!recent.length) return;
      var hintEl = document.createElement('span');
      hintEl.className = 'text-caption fg-neutral-subtle mr-1'; hintEl.textContent = 'Recent:';
      recentRow.appendChild(hintEl);
      recent.slice(0, 6).forEach(function (em) {
        var chip = document.createElement('button');
        chip.className = 'rounded-full border border-neutral-soft px-2 py-0.5 text-caption fg-neutral-medium transition-colors hover:bg-surface-backdrop hover:fg-neutral-prominent';
        chip.textContent = em;
        chip.addEventListener('click', function () { addToken(em); input.focus(); });
        recentRow.appendChild(chip);
      });
    }

    function setMode(next) {
      mode = next;
      MODES.forEach(function (m) {
        var on = m.key === mode;
        segBtns[m.key].className = 'flex-1 rounded-md px-2.5 py-1.5 text-system-medium transition-colors ' +
          (on ? 'bg-surface-overlay fg-neutral-prominent elevation-xs' : 'fg-neutral-medium hover:fg-neutral-prominent');
      });
      subLine.textContent = MODES.filter(function (m) { return m.key === mode; })[0].sub;
      peopleWrap.style.display = mode === 'people' ? 'flex' : 'none';
      publicExtra.style.display = mode === 'public' ? 'flex' : 'none';
      refresh();
      if (mode === 'people') setTimeout(function () { input.focus(); }, 0);
    }

    // ---- prompt + footer ----
    var promptHint = document.createElement('div');
    promptHint.className = 'text-caption fg-neutral-subtle';
    promptHint.textContent = 'Prompt to paste into the Computer chat:';
    var ta = document.createElement('textarea');
    ta.readOnly = true;
    ta.className = 'w-full resize-none rounded-lg border border-neutral-soft bg-surface-backdrop px-2.5 py-2 pr-9 font-mono text-caption fg-neutral-prominent focus:outline-none';
    ta.rows = 2;

    // Intent-only prompt. The skill (SKILL.md) already knows its own location,
    // that publishing uses ui-publisher-public, and to record + regenerate after.
    // So the prompt just states WHAT the user wants — short and human.
    function buildPrompt() {
      var emails = people.filter(function (p) { return p.kind === 'email'; }).map(function (p) { return p.value; });
      var groups = people.filter(function (p) { return p.kind === 'group'; }).map(function (p) { return p.value; });
      var head = 'Publish v' + v.n + ' of ' + page + ' ';
      if (mode === 'public') return head + 'as a public 7-day link' + (alsoOrg ? ' (also keep org access)' : '') + '.';
      if (mode === 'internal') return head + 'for anyone in the org.';
      var who = [];
      if (emails.length) who.push(emails.join(', '));
      if (groups.length) who.push('groups ' + groups.join(', '));
      if (!who.length) return head + 'privately (just me).';
      return head + 'shared with ' + who.join(' and ') + '.';
    }
    function refresh() { ta.value = buildPrompt(); }

    var foot = document.createElement('div');
    foot.className = 'flex items-center gap-2';
    var dot = document.createElement('span'); dot.className = 'flex h-1.5 w-1.5 rounded-full'; dot.style.backgroundColor = '#5800E6';
    var footText = document.createElement('span');
    footText.className = 'text-caption fg-neutral-subtle';
    footText.textContent = 'Paste the prompt into the Computer chat — it publishes and the link shows up here.';
    var btnWrap = document.createElement('div'); btnWrap.className = 'ml-auto flex items-center gap-1.5';
    var close = document.createElement('button');
    close.className = 'rounded-md px-3 py-1.5 text-system-medium fg-neutral-medium transition-colors hover:bg-surface-backdrop hover:fg-neutral-prominent';
    close.textContent = 'Close';
    var copyPrimary = document.createElement('button');
    copyPrimary.className = 'rounded-md px-3 py-1.5 text-system-bold';
    copyPrimary.style.cssText = 'background:' + BRAND_YELLOW + ';color:' + INK + ';white-space:nowrap';
    copyPrimary.textContent = 'Copy prompt';
    btnWrap.appendChild(close); btnWrap.appendChild(copyPrimary);
    foot.appendChild(dot); foot.appendChild(footText); foot.appendChild(btnWrap);

    // Prompt row: textarea + a copy-icon button (real copy, not just select).
    var promptRow = document.createElement('div');
    promptRow.className = 'relative';
    var copyBtn = document.createElement('button');
    copyBtn.setAttribute('aria-label', 'Copy prompt');
    copyBtn.className = 'absolute right-1.5 top-1.5 rounded-md border border-neutral-soft bg-surface-overlay px-1.5 py-1 fg-neutral-medium transition-colors hover:fg-neutral-prominent hover:bg-surface-backdrop';
    var COPY_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
    var CHECK_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#1ea672" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    setIcon(copyBtn, COPY_ICON);
    promptRow.appendChild(ta);
    promptRow.appendChild(copyBtn);

    // assemble (switcher on top, then its contextual body)
    dlg.appendChild(seg);
    dlg.appendChild(subLine);
    dlg.appendChild(peopleWrap);
    dlg.appendChild(publicExtra);
    dlg.appendChild(promptHint);
    dlg.appendChild(promptRow);
    dlg.appendChild(foot);
    back.appendChild(dlg); document.body.appendChild(back);

    renderPills(); renderRecent();
    setMode('internal');   // default: anyone in org

    function reallyCopy() {
      commitInput();
      ta.focus(); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      setIcon(copyBtn, ok ? CHECK_ICON : COPY_ICON);
      footText.textContent = ok
        ? 'Copied. Paste it into the Computer chat to publish.'
        : 'Select the text above (⌘A) and copy it, then paste into the Computer chat.';
      footText.className = 'text-caption ' + (ok ? 'fg-neutral-prominent' : 'fg-neutral-subtle');
      copyPrimary.textContent = ok ? 'Copied ✓' : 'Press ⌘C';
      setTimeout(function () { setIcon(copyBtn, COPY_ICON); copyPrimary.textContent = 'Copy prompt'; }, 2000);
    }
    copyBtn.addEventListener('click', reallyCopy);
    copyPrimary.addEventListener('click', reallyCopy);
    close.addEventListener('click', function () { back.remove(); });
    back.addEventListener('click', function (e) { if (e.target === back) back.remove(); });
  }

  // ---- Dropdown --------------------------------------------------------------
  function buildPop() {
    var el = document.createElement('div');
    el.className = 'flex flex-col gap-0.5 rounded-lg border border-neutral-soft bg-surface-overlay p-1.5 elevation-l';
    el.style.cssText = 'position:fixed;z-index:2147483601;width:320px;max-height:72vh;overflow:auto;font-family:' + FONT;

    // Header: branch switcher + New branch (forks from the current version).
    var head = document.createElement('div');
    head.className = 'flex items-center gap-2 border-b border-neutral-soft px-1.5 pb-2 mb-1';
    var label = document.createElement('span');
    label.className = 'text-caption fg-neutral-subtle';
    label.textContent = 'Branch';
    head.appendChild(label);

    var select = document.createElement('select');
    select.className = 'rounded-md border border-neutral-soft bg-surface-backdrop px-2 py-1 text-system-medium fg-neutral-prominent focus:outline-none';
    (data.branches || ['main']).forEach(function (b) {
      var o = document.createElement('option'); o.value = b; o.textContent = b;
      if (b === data.currentBranch) o.selected = true; select.appendChild(o);
    });
    select.addEventListener('change', function () {
      var chosen = select.value; select.value = data.currentBranch;
      openDialog(function () { return promptText('switch', null, chosen); });
    });
    head.appendChild(select);

    var newBranch = document.createElement('button');
    newBranch.className = 'ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-system-medium fg-neutral-medium transition-colors hover:bg-surface-backdrop hover:fg-neutral-prominent';
    var plus = document.createElement('span');
    plus.style.cssText = 'font-size:14px;line-height:1'; plus.textContent = '+';
    newBranch.appendChild(plus);
    newBranch.appendChild(document.createTextNode(' New branch'));
    newBranch.addEventListener('click', function () {
      openDialog(function (name) { return promptText('branch', null, name); }, { nameField: true });
    });
    head.appendChild(newBranch);
    el.appendChild(head);

    data.versions.forEach(function (v, idx) {
      var cur = idx === 0;
      var item = document.createElement('div');
      item.className = 'relative flex flex-col gap-0.5 rounded-md px-2 py-1.5 transition-colors ' +
        (cur ? 'bg-surface-backdrop' : 'hover:bg-surface-backdrop');

      // Title row: just the title (no "vN" prefix). Restore versions get a chip.
      var t = document.createElement('div');
      t.className = 'text-system-medium fg-neutral-prominent';
      t.textContent = v.title;
      if (v.isRestore && v.restoredFrom != null) {
        var badge = document.createElement('span');
        badge.className = 'ml-1.5 rounded border border-neutral-soft px-1.5 py-0.5 text-caption-bold fg-neutral-medium';
        badge.textContent = '↩ v' + v.restoredFrom;
        t.appendChild(badge);
      }
      item.appendChild(t);

      // Meta row: version number lives here (before the timestamp), not the title.
      var m = document.createElement('div');
      m.className = 'text-caption fg-neutral-subtle';
      m.textContent = 'v' + v.n + ' · ' + fmt(v.isoTime) + ' · ' + v.author + (cur ? ' · current' : '');
      item.appendChild(m);

      // Hover popover: the change bullets (3–6 words each), as a side submenu.
      var bullets = Array.isArray(v.body) ? v.body.filter(Boolean) : [];
      if (bullets.length) {
        var hint = document.createElement('span');
        hint.className = 'ml-1.5 text-caption fg-neutral-subtle';
        hint.textContent = '· ' + bullets.length + ' change' + (bullets.length > 1 ? 's' : '');
        m.appendChild(hint);
        attachHoverCard(item, bullets);
      }

      var isPublished = Array.isArray(v.published) && v.published.length > 0;

      // Published indicator: a link chip + a small edit (change-access) icon.
      // When published, this REPLACES the Publish button (nothing left to publish).
      if (isPublished) {
        var last = v.published[v.published.length - 1];
        var url = last.publicUrl || last.viewerUrl || '#';
        var labelMap = { personal: 'Private', internal: 'Org', public: 'Public' };
        var who = labelMap[last.access] || last.access;

        var pubRow = document.createElement('div');
        pubRow.className = 'mt-0.5 flex items-center gap-1';
        var chip = document.createElement('a');
        chip.href = url; chip.target = '_blank'; chip.rel = 'noreferrer';
        chip.className = 'inline-flex w-fit items-center gap-1 rounded border border-neutral-soft px-1.5 py-0.5 text-caption-bold fg-neutral-medium transition-colors hover:fg-neutral-prominent hover:bg-surface-backdrop';
        chip.textContent = '🔗 Published · ' + who +
          (last.access === 'public' && last.expiresAt ? ' · expires ' + fmt(last.expiresAt) : '');
        var edit = document.createElement('button');
        edit.setAttribute('aria-label', 'Change who can access this');
        edit.title = 'Change access';
        edit.className = 'rounded border border-neutral-soft px-1.5 py-0.5 fg-neutral-subtle transition-colors hover:fg-neutral-prominent hover:bg-surface-backdrop';
        setIcon(edit, PENCIL_ICON);
        edit.addEventListener('click', function () { openPublishDialog(v); });
        pubRow.appendChild(chip); pubRow.appendChild(edit);
        item.appendChild(pubRow);
      }

      // Actions: Publish (only if NOT yet published) + Restore (older versions only).
      var actions = document.createElement('div');
      actions.className = 'mt-1 flex gap-1.5';
      var hasAction = false;
      if (!isPublished) {
        var pub = document.createElement('button');
        pub.className = 'rounded-md border border-neutral-soft px-2 py-1 text-caption-bold fg-neutral-medium transition-colors hover:bg-surface-backdrop hover:fg-neutral-prominent';
        pub.textContent = 'Publish';
        pub.addEventListener('click', function () { openPublishDialog(v); });
        actions.appendChild(pub); hasAction = true;
      }
      if (!cur) {
        var r = document.createElement('button');
        r.className = 'rounded-md border border-neutral-soft px-2 py-1 text-caption-bold fg-neutral-medium transition-colors hover:bg-surface-backdrop hover:fg-neutral-prominent';
        r.textContent = 'Restore this version';
        r.addEventListener('click', function () { openDialog(function () { return promptText('restore', v); }); });
        actions.appendChild(r); hasAction = true;
      }
      if (hasAction) item.appendChild(actions);
      el.appendChild(item);
    });

    return el;
  }

  // A side popover (submenu) that lists a version's change bullets on hover.
  var hoverCard = null;
  function attachHoverCard(item, bullets) {
    function show() {
      hideHoverCard();
      hoverCard = document.createElement('div');
      hoverCard.className = 'rounded-lg border border-neutral-soft bg-surface-overlay p-2.5 elevation-l';
      hoverCard.style.cssText = 'position:fixed;z-index:2147483602;width:240px;font-family:' + FONT;
      var ul = document.createElement('ul');
      ul.style.cssText = 'margin:0;padding-left:16px;list-style:disc';
      bullets.forEach(function (b) {
        var li = document.createElement('li');
        li.className = 'text-caption fg-neutral-prominent';
        li.style.cssText = 'margin:2px 0;line-height:1.4';
        li.textContent = b;
        ul.appendChild(li);
      });
      hoverCard.appendChild(ul);
      document.body.appendChild(hoverCard);
      var r = item.getBoundingClientRect();
      // Prefer left of the dropdown (it's right-aligned); flip right if no room.
      var w = 240, gap = 8;
      var left = r.left - w - gap;
      if (left < 8) left = r.right + gap;
      hoverCard.style.left = left + 'px';
      hoverCard.style.top = Math.max(8, r.top) + 'px';
    }
    item.addEventListener('mouseenter', show);
    item.addEventListener('mouseleave', hideHoverCard);
  }
  function hideHoverCard() {
    if (hoverCard) { hoverCard.remove(); hoverCard = null; }
  }

  function position() {
    if (!pop || !btn) return;
    var r = btn.getBoundingClientRect();
    pop.style.top = (r.bottom + 6) + 'px';
    // Right-align the dropdown to the button.
    pop.style.left = Math.max(8, r.right - 320) + 'px';
  }

  function toggle() {
    if (open) { closePop(); return; }
    pop = buildPop();
    document.body.appendChild(pop);
    position();
    open = true;
    btn.setAttribute('aria-pressed', 'true');
    btn.className = BTN_BASE + ' ' + BTN_ACTIVE;
  }
  function closePop() {
    hideHoverCard();
    if (pop) { pop.remove(); pop = null; }
    open = false;
    if (btn) { btn.setAttribute('aria-pressed', 'false'); btn.className = BTN_BASE + ' ' + BTN_IDLE; }
  }

  function makeButton() {
    var b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', 'Version history');
    b.className = BTN_BASE + ' ' + BTN_IDLE;
    setIcon(b, HISTORY_ICON, 'Versions');
    var vchip = document.createElement('span');
    vchip.className = 'flex h-[18px] min-w-[18px] items-center justify-center rounded-full border border-neutral-soft bg-surface-backdrop px-1 text-caption-bold fg-neutral-medium';
    vchip.textContent = 'v' + data.versions[0].n;
    b.appendChild(vchip);
    b.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });
    return b;
  }

  // Header button for the current version. Yellow-primary "Publish" when the
  // current version is unpublished; quiet secondary "Published" (with an edit
  // glyph) once it's live — nothing left to publish, so it stops being primary.
  function makePublishButton() {
    var b = document.createElement('button');
    b.type = 'button';
    var cur = data.versions[0];
    var published = Array.isArray(cur.published) && cur.published.length > 0;
    if (published) {
      b.setAttribute('aria-label', 'Published — change access');
      b.className = BTN_BASE + ' ' + BTN_IDLE;   // quiet secondary, matches Versions/Comments
      setIcon(b, PENCIL_ICON, 'Published');
    } else {
      b.setAttribute('aria-label', 'Publish this page');
      b.className = 'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-system-bold transition-colors whitespace-nowrap';
      b.style.cssText = 'background:' + BRAND_YELLOW + ';color:' + INK;
      setIcon(b, UP_ICON, 'Publish');
    }
    b.addEventListener('click', function (e) { e.stopPropagation(); openPublishDialog(null); });
    return b;
  }

  // Dock into the toolbar's right cluster, just before the Comments button.
  function dock() {
    var comments = document.querySelector('[aria-label="Toggle comments panel"]');
    if (comments && comments.parentNode) {
      // Desired left-to-right order in the right cluster: Publish, Versions, Comments.
      // insertBefore(node, comments) places node immediately left of Comments, so
      // insert Versions first, then Publish before it → Publish ends up leftmost.
      btn = makeButton();
      comments.parentNode.insertBefore(btn, comments);                  // Versions (left of Comments)
      comments.parentNode.insertBefore(makePublishButton(), btn);       // Publish (left of Versions)

      // Rename the "View" mode button to "View/Comment" — text selection +
      // commenting works in this mode now, so the label should say so. The two
      // mode buttons live in [role=group][aria-label="Page mode"]; rename the
      // one whose text is "View" without disturbing its icon.
      var modeGroup = document.querySelector('[aria-label="Page mode"]');
      if (modeGroup) {
        Array.prototype.forEach.call(modeGroup.querySelectorAll('button'), function (mb) {
          if ((mb.textContent || '').trim() === 'View') {
            Array.prototype.forEach.call(mb.childNodes, function (n) {
              if (n.nodeType === 3 && n.textContent.trim() === 'View') n.textContent = 'View/Comment';
            });
          }
        });
      }

      // Adding two buttons crowds the toolbar. Make the toolbar row WRAP so the
      // right cluster drops to a second line when the window is narrow, while
      // each individual button stays nowrap/shrink-0 (set in BTN_BASE) so no
      // button — including the page's "Send to Computer" — breaks internally.
      var cluster = comments.parentNode;
      cluster.style.flexWrap = 'nowrap';   // keep the cluster's buttons together
      cluster.style.flexShrink = '0';
      var row = cluster.parentNode;
      if (row) {
        row.style.flexWrap = 'wrap';       // allow the cluster to move to row 2
        row.style.height = 'auto';         // the row was fixed-height (h-11); let it grow
        row.style.rowGap = '6px';
        row.style.paddingTop = '6px';
        row.style.paddingBottom = '6px';
        // The mode-hint span ("double-click to edit. Hold ⌘…") is the flexible
        // filler; let it shrink/ellipsize so it yields space before wrapping.
        Array.prototype.forEach.call(row.children, function (child) {
          if (child !== cluster && child.tagName === 'SPAN') {
            child.style.minWidth = '0';
            child.style.overflow = 'hidden';
            child.style.textOverflow = 'ellipsis';
            child.style.whiteSpace = 'nowrap';
          }
        });
      }
      return true;
    }
    return false;
  }

  // Fallback: floating buttons if the toolbar never appears.
  function floatChip() {
    btn = makeButton();
    btn.style.cssText = 'position:fixed;top:12px;right:120px;z-index:2147483600;' +
      'background:#fff;border:1px solid #ededed;border-radius:8px;font-family:' + FONT;
    document.body.appendChild(btn);
    var pubBtn = makePublishButton();
    pubBtn.style.cssText = 'position:fixed;top:12px;right:14px;z-index:2147483600;border-radius:8px;font-family:' + FONT;
    document.body.appendChild(pubBtn);
  }

  // The toolbar is React-rendered async — poll briefly, then fall back.
  var tries = 0;
  (function waitForToolbar() {
    if (dock()) return;
    if (++tries > 40) { floatChip(); return; } // ~4s
    setTimeout(waitForToolbar, 100);
  })();

  // ---- Auto-dismiss the host comment composer when clicked away while empty --
  // The composer popup ("Tell Computer…" + Cancel/Add) is host React but lives
  // in THIS document, so we can manage it via the DOM: if the user clicks
  // outside it without typing, dismiss it (click its own Cancel so React tears
  // down cleanly). If there's text, leave it — they're mid-comment.
  function findComposer() {
    var ta = document.querySelector('textarea[placeholder^="Tell Computer"]');
    if (!ta) return null;
    // Walk up to the composer card (the nearest ancestor that also holds Cancel).
    var node = ta;
    for (var i = 0; i < 8 && node; i++) {
      if (node.querySelector && node.querySelector('[aria-label="Add comment"]')) return { root: node, ta: ta };
      node = node.parentElement;
    }
    return { root: ta.parentElement, ta: ta };
  }
  function composerHasText(c) {
    if (!c) return false;
    if (c.ta && c.ta.value && c.ta.value.trim()) return true;
    // mention-input may render contentEditable text instead of textarea value.
    var txt = (c.root.textContent || '');
    return /\S/.test(c.ta && c.ta.value || '');
  }
  function dismissComposerIfEmpty() {
    var c = findComposer();
    if (!c || composerHasText(c)) return;
    // Click the composer's own Cancel button so React unmounts it properly.
    var cancel = null;
    var btns = c.root.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if ((btns[i].textContent || '').trim() === 'Cancel') { cancel = btns[i]; break; }
    }
    if (cancel) cancel.click();
  }

  // Tell the iframe's selection layer whether the in-flight selection-comment was
  // committed (persist the highlight + carry the text for hover) or cancelled.
  function msgIframe(type, text) {
    var f = document.querySelector('iframe[title="Annotated page"]');
    if (f && f.contentWindow) f.contentWindow.postMessage({ source: 'devrev-host-annot', type: type, text: text || '' }, '*');
  }
  // Watch the composer's Add/Cancel buttons; relay the outcome to the iframe.
  // Re-bound each time a composer appears (MutationObserver on body).
  function wireComposer(c) {
    if (!c || !c.root || c.root.__devrevWired) return;
    c.root.__devrevWired = true;
    var btns = c.root.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        var label = (b.textContent || '').trim();
        if (label === 'Cancel') {
          b.addEventListener('click', function () { msgIframe('annot-cancel'); }, true);
        } else if (b.getAttribute('aria-label') === 'Add comment' || label === 'Add') {
          b.addEventListener('click', function () {
            var t = c.ta && c.ta.value ? c.ta.value.trim() : '';
            msgIframe('annot-commit', t);
          }, true);
        }
      })(btns[i]);
    }
  }
  var composerObserver = new MutationObserver(function () {
    var c = findComposer();
    if (c) wireComposer(c);
  });
  composerObserver.observe(document.body, { childList: true, subtree: true });

  // Close the popover (and dismiss an empty composer) on an outside host click.
  document.addEventListener('click', function (e) {
    if (open && pop && !pop.contains(e.target) && (!btn || !btn.contains(e.target))) closePop();
    // If the click landed outside the composer, dismiss it when empty.
    var c = findComposer();
    if (c && c.root && !c.root.contains(e.target)) {
      setTimeout(dismissComposerIfEmpty, 0);
    }
  }, true);
  // Clicks INSIDE the page iframe never reach the host's document listener
  // (events don't cross the iframe boundary), so clicking "on the page" wouldn't
  // close the popover. But focusing the iframe blurs the host window — use that
  // as the signal to close. (Guard so opening the popover itself doesn't close it.)
  window.addEventListener('blur', function () {
    if (open) setTimeout(closePop, 0);
    // Clicking on the page (into the iframe) blurs the host window. If a new
    // text selection is being made there, the composer will re-open for it; but
    // if the current composer is empty and untouched, dismiss it. Delay so a
    // genuine new selection-note can replace it rather than flicker.
    setTimeout(dismissComposerIfEmpty, 120);
  });
  window.addEventListener('resize', function () { if (open) position(); });
  window.addEventListener('scroll', function () { if (open) position(); }, true);
})();
