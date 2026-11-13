window.__ModuleLoader__.load({
  id: "dsh-step-title-translate",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");

    //#region constants
    const BRIDGE = "/api/dsh-step-title-translate";
    const NS = "stepTitleTranslate";
    /** Every disclosure row the plugin reads: tool rows, the shell sample row and reasoning rows. */
    const ROW_SELECTOR = '[data-tool], [data-sample="bash"], [data-variant="think"]';
    /** Marks DOM the plugin itself injected, so scanning and translation never touch it. */
    const OWN_ATTR = "data-stt-ui";
    const ROW_ACTION = "row-action";
    /** Prose body parts that carry a failure explanation or a detail summary. */
    const BODY_SELECTOR = '[class*="ioText"], [class*="errorSummary"], [class*="failure"], [class*="expandedSummary"], [data-error]';
    /** Containers whose text is code, aligned output or a rendered diff: never rewrite them. */
    const SKIP_SELECTOR = 'pre, code, samp, kbd, [class*="terminal"], [class*="diffBody"], [class*="codeBody"], [class*="searchBody"], [class*="webBody"], [class*="imageMeta"]';
    const BATCH_SIZE = 8;
    /**
     * Character budget of one request. The check in takeBatch() keeps the first
     * chunk unconditionally, so a batch is never empty; BATCH_SIZE * CHUNK_CHARS
     * (9600) stays far below the host's MAX_TOTAL_CHARS (24000).
     */
    const BATCH_CHARS = 6000;
    const CHUNK_CHARS = 1200;
    const TEXT_LIMIT = 20000;
    /** A request that never settles must not pin the row button on "translating…" forever. */
    const REQUEST_TIMEOUT_MS = 22000;
    const MAX_FAILURES = 3;
    /** Bing answers some fragments with the source text; one lonely retry usually breaks the tie. */
    const MAX_IDENTITY_ATTEMPTS = 2;
    /** Echoes get a few spaced-out retries so the host's background refinement can land. */
    const ECHO_ATTEMPTS = 4;
    const ECHO_RETRY_MS = 5000;
    const RETRY_DELAY_MS = 1500;
    /** How long a clicked row keeps its "asked the endpoint" note visible. */
    const PING_MS = 1200;
    const SCAN_DELAY_MS = 160;
    const BOOT_RETRIES = 4;
    const BOOT_RETRY_DELAY_MS = 700;
    /** Upper bound of the prose-keyed caches, so a long session cannot grow without end. */
    const CACHE_LIMIT = 2000;
    /** Upper bound of the bookkeeping maps that describe a single attempt. */
    const META_LIMIT = 1000;
    /** Entries one pruneState() round may inspect, so a scan stays cheap on a huge transcript. */
    const PRUNE_BUDGET = 200;
    /** The element sweep finishes a pass in at most two rounds, but never walks more than this per scan. */
    const PRUNE_MIN = 2048;
    const PRUNE_MAX = 8192;

    const css = [
      ".stt-tip{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin:0}",
      ".stt-field{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}",
      ".stt-label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}",
      ".stt-input,.stt-select{font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;width:100%}",
      ".stt-check{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer}",
      ".stt-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px}",
      ".stt-btn{font:inherit;font-size:13px;cursor:pointer;border-radius:6px;padding:5px 12px;border:1px solid var(--dsw-alias-button-info-fill);background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground)}",
      ".stt-btn:disabled{opacity:.5;cursor:default}",
      ".stt-note{color:var(--dsw-alias-label-tertiary);font-size:12px}",
      "[data-stt-ui] [data-shimmer-text]{color:inherit}",
      ".stt-action{display:inline-flex;flex:none;align-items:center;gap:3px;height:18px;margin:0;padding:0 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:16px;white-space:nowrap;cursor:pointer;opacity:.55;transition:opacity .1s,background-color .1s,color .1s}",
      ".stt-action:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}",
      "@media (hover:hover){[data-stt-row]:hover .stt-action{opacity:1}}",
      ".stt-action:focus-visible{opacity:1}",
      ".stt-action[data-busy] .stt-action-mark{animation:stt-spin .9s linear infinite}",
      ".stt-action[data-failed]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);opacity:1}",
      ".stt-action[data-pinged]{border-color:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary);opacity:1}",
      "@keyframes stt-spin{to{transform:rotate(360deg)}}",
      "@media (prefers-reduced-motion:reduce){.stt-action[data-busy] .stt-action-mark{animation:none}}",
    ];

    /**
     * Put the plugin stylesheet into the document exactly once.
     *
     * The module factory runs once per page load, but a disable/enable cycle
     * tears the tag down, so apply() calls this again — the querySelector guard
     * keeps a second apply() from stacking a duplicate.
     */
    function ensureStyles() {
      if (typeof document === "undefined") return;
      const existing = document.querySelectorAll('style[data-plugin-css="' + NS + '"]');
      if (existing.length > 0) {
        // A hot reload may leave a stale copy behind: collapse to exactly one.
        for (let index = 1; index < existing.length; index += 1) existing[index].remove();
        return;
      }
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-step-title-translate";
      tag.dataset.pluginCss = NS;
      tag.textContent = css.join("\n");
      document.head.appendChild(tag);
    }

    ensureStyles();
    //#endregion

    //#region i18n
    const I18N = {
      zh: {
        summary: "把工具行的标题、描述与报错经 Bing 翻译后显示",
        enabled: "启用翻译",
        translateTitle: "同时翻译工具类型标题（代码 / 运行命令 等）",
        translateErrors: "同时翻译报错与失败输出",
        language: "目标语言",
        proxy: "HTTP 代理（可选）",
        proxyHint: "留空表示直连。中国大陆网络通常需要代理，例如 http://127.0.0.1:10808。",
        save: "保存",
        saving: "保存中…",
        saved: "已保存，立即生效",
        failed: "保存失败",
        reload: "清空缓存并重译",
        rowAction: "翻译这一行",
        rowActionGlyph: "译",
        rowActionBusy: "翻译中…",
        rowActionFailed: "翻译失败，点击重试",
        rowActionReason: "上次失败原因：",
        rowActionClicked: "已重新请求",
        rowActionDone: "这一行没有需要翻译的内容了",
        shortcut: "Alt+T 在原文与译文之间切换；每行右侧的「译」按钮只翻译该行还空着的内容。",
        privacy: "行的标题、描述与报错文本会发送到 Bing 匿名翻译接口，可能包含代码路径等细节。代码块、终端输出与 diff 不会被翻译。",
      },
      en: {
        summary: "Translates tool-row titles, descriptions and failures through Bing",
        enabled: "Enable translation",
        translateTitle: "Also translate the tool-type title (Code / Run command …)",
        translateErrors: "Also translate failures and error output",
        language: "Target language",
        proxy: "HTTP proxy (optional)",
        proxyHint: "Leave empty for a direct connection, e.g. http://127.0.0.1:10808.",
        save: "Save",
        saving: "Saving…",
        saved: "Saved — applied immediately",
        failed: "Save failed",
        reload: "Clear cache and re-translate",
        rowAction: "Translate this row",
        rowActionGlyph: "A",
        rowActionBusy: "Translating…",
        rowActionFailed: "Translation failed — click to retry",
        rowActionReason: "Last failure: ",
        rowActionClicked: "Asked the endpoint again",
        rowActionDone: "Nothing left to translate in this row",
        shortcut: "Press Alt+T to switch between the original and the translation; the 译 button on a row translates only what that row still shows untranslated.",
        privacy: "Row titles, descriptions and failure text are sent to the anonymous Bing endpoint and may contain code paths and other details. Code blocks, terminal output and diffs are never translated.",
      },
    };
    function pickLocale() {
      const primary = typeof navigator === "undefined" ? "zh" : String((navigator.languages && navigator.languages[0]) || navigator.language || "zh").toLowerCase();
      return primary.startsWith("zh") ? I18N.zh : I18N.en;
    }
    //#endregion

    //#region bridge
    async function bridgeConfig() {
      const response = await fetch(BRIDGE + "/config", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      return response.json();
    }
    async function bridgeSave(patch) {
      const response = await fetch(BRIDGE + "/config/set", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      return response.json();
    }
    async function bridgeTranslate(payload) {
      // A dead socket (sleeping proxy, dropped tunnel) would otherwise leave the
      // promise pending for as long as the browser keeps the connection open:
      // the row button spins on "translating…" and every click is ignored
      // because the single pump is still busy.
      const abort = typeof AbortController === "function" ? new AbortController() : null;
      const timer = abort === null ? 0 : window.setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(BRIDGE + "/translate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: abort === null ? undefined : abort.signal,
        });
        return response.json();
      } finally {
        if (timer !== 0) window.clearTimeout(timer);
      }
    }
    //#endregion

    //#region heuristics
    const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
    /** Punctuation and spacing that carry no meaning when two strings are compared. */
    const EDGE_ORNAMENT = /^[\s"'\u201c\u201d\u300c\u300d(\[{]+|[\s."'\u3002\u201d\u300f)\]}]+$/g;
    const LATIN = /[A-Za-z]/;
    const LETTERS = /[A-Za-z\u3400-\u9fff]/;
    /** A single token with no spaces: a path, an identifier, a hash, a version. */
    const IDENTIFIER = /^[\w.\-\\/:~@+=%$#]+$/;
    /** File-ish copy such as `tmpscripts/e2e.sh 1KB` (path + size suffix). */
    const PATH_SUMMARY = /^[\w.\-\\/:~@+=%$#\s]+\s+[\d.]+\s?(?:B|KB|MB|GB|TB|bytes?)$/i;

    function targetIsChinese(tag) {
      const value = String(tag || "").toLowerCase();
      return value === "" || value === "auto" || value.startsWith("zh");
    }

    /**
     * Decide whether one rendered string is worth sending to Bing.
     *
     * @param text - the original copy of the leaf.
     * @param kind - \`title\`, \`summary\` (row header) or \`body\` (failure output).
     * @returns whether the text should be translated.
     */
    function shouldTranslate(text, targetLanguage, kind) {
      const value = typeof text === "string" ? text : "";
      const trimmed = value.trim();
      if (trimmed === "") return false;
      if (value.length > TEXT_LIMIT) return false;
      if (!LATIN.test(trimmed)) return false;
      if (!LETTERS.test(trimmed)) return false;
      if (IDENTIFIER.test(trimmed)) return false;
      if (PATH_SUMMARY.test(trimmed)) return false;
      if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("<")) return false;
      if (targetIsChinese(targetLanguage) && CJK.test(trimmed) && !/[A-Za-z]{4,}/.test(trimmed)) return false;
      // A body leaf without a single space is a path, a flag or an enum value.
      if (kind === "body" && !/\s/.test(trimmed)) return false;
      return true;
    }

    /**
     * Compare a translation with its source, ignoring spacing, case and edge punctuation.
     *
     * Bing silently answers a few sentence fragments with the source text; those
     * look translated but are not, so they are never cached as a result.
     *
     * @param source - the submitted string.
     * @param translated - what the endpoint answered.
     * @returns whether the endpoint handed the source back unchanged.
     */
    /**
     * Whether the copy is already written in the target language.
     *
     * A string that is already Chinese cannot be "translated" — Bing answering
     * with the same text means there was nothing to do, not that it failed.
     *
     * @param text - candidate copy.
     * @returns whether the target language is already in use.
     */
    function isMostlyLocal(text) {
      return targetIsChinese(state.config.targetLanguage) && CJK.test(text);
    }

    function isEcho(source, translated) {
      const normalize = (value) => value.toLowerCase().replace(EDGE_ORNAMENT, "").replace(/\s+/g, " ").trim();
      return normalize(source) === normalize(translated);
    }

    /** The first line of a stack trace, or -1 when the text carries none. */
    const STACK_LINE = /(^|\n)[ \t]+at[ \t]/;

    /**
     * Separate prose from a trailing stack trace.
     *
     * Bing mangles `    at fn (file:///…) :1068:60` into prose, losing the frames
     * a reader needs, so the frames are kept byte-for-byte and only the message
     * in front of them is translated.
     *
     * @param text - the whole rendered string.
     * @returns the translatable head and the verbatim tail.
     */
    function splitProse(text) {
      const match = STACK_LINE.exec(text);
      if (match === null) return { prose: text, tail: "" };
      const cut = match.index === 0 ? 0 : match.index + 1;
      return { prose: text.slice(0, cut), tail: text.slice(cut) };
    }

    /**
     * Split one long string into request-sized pieces without cutting words.
     *
     * @param text - the original copy.
     * @param limit - maximum piece length.
     * @returns pieces that concatenate back to the original text.
     */
    function chunkText(text, limit) {
      if (text.length <= limit) return [text];
      const out = [];
      let rest = text;
      while (rest.length > limit) {
        let cut = rest.lastIndexOf("\n", limit);
        if (cut >= limit / 2) cut += 1;
        else {
          cut = rest.lastIndexOf(" ", limit);
          if (cut >= limit / 2) cut += 1;
          else cut = limit;
        }
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      if (rest !== "") out.push(rest);
      return out;
    }
    //#endregion

    //#region engine
    const state = {
      config: { enabled: true, targetLanguage: "zh-Hans", translateTitle: true, translateErrors: true, proxy: "" },
      loaded: false,
      showOriginal: false,
      /** prose -> { text, weak }; weak means Bing echoed the source back unchanged. */
      cache: new Map(),
      /** prose -> consecutive request failures. */
      failures: new Map(),
      /** prose -> the last failure code/message the bridge reported. */
      reasons: new Map(),
      /** prose -> how many times Bing answered with the source text itself. */
      identities: new Map(),
      /** prose -> timestamp before which no automatic retry is attempted. */
      retry: new Map(),
      jobs: new Map(),
      queue: [],
      running: false,
      records: new Map(),
      wanted: new Map(),
      /** row element -> its translatable leaves, refreshed on every scan. */
      rowLeaves: new Map(),
      /** row element -> the injected per-row translate button. */
      rowActions: new Map(),
      /** row element -> timestamp until which its button shows a "clicked" note. */
      pings: new Map(),
      /** Timers that repaint a clicked button when its note expires. */
      pingTimers: new Set(),
      observer: null,
      timer: 0,
      /** Single-slot sentinel for the retry scan; retryTimerAt is its deadline. */
      retryTimer: 0,
      retryTimerAt: 0,
      pumpTimer: 0,
      /** Snapshot of the element keys the amortised leak sweep still has to inspect. */
      pruneKeys: null,
      pruneCursor: 0,
      disposed: false,
    };

    /**
     * Write one prose-keyed entry and keep the map bounded.
     *
     * A Map iterates in insertion order and \`set\` of an existing key keeps its
     * original position, so re-inserting after a delete makes the first key the
     * least recently written one — a plain LRU eviction without extra bookkeeping.
     *
     * @param map - the map to write.
     * @param key - prose key.
     * @param value - entry to store.
     * @param limit - maximum number of entries.
     */
    function setBounded(map, key, value, limit) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > limit) {
        const oldest = map.keys().next();
        if (oldest.done === true) break;
        map.delete(oldest.value);
      }
    }

    function rememberResult(prose, text, weak) {
      setBounded(state.cache, prose, { text, weak }, CACHE_LIMIT);
    }

    function rememberFailure(prose, reason) {
      const failures = (state.failures.get(prose) ?? 0) + 1;
      setBounded(state.failures, prose, failures, META_LIMIT);
      setBounded(state.reasons, prose, reason, META_LIMIT);
      setBounded(state.retry, prose, Date.now() + backoffFor(failures), META_LIMIT);
      return failures;
    }

    function rememberIdentity(prose, attempts) {
      setBounded(state.identities, prose, attempts, META_LIMIT);
    }

    function rememberRetry(prose, until) {
      setBounded(state.retry, prose, until, META_LIMIT);
    }

    /**
     * Drop entries whose DOM element left the document.
     *
     * records / wanted / pings are keyed by Element, and React unmounts and
     * re-creates row nodes all the time. Without this sweep every unmounted row
     * stayed reachable through its parent chain, together with the whole tool
     * output below it.
     *
     * The element sweep is amortised inside a scan: pruneKeys is a snapshot of
     * the keys to inspect and pruneCursor walks it in slices no larger than
     * PRUNE_MAX. A single scan therefore finishes a whole pass, but its cost is
     * still bounded by PRUNE_MAX per slice instead of walking everything at once.
     */
    function pruneState() {
      // Finish the element pass in this call: slices stay bounded, but a key is
      // never left for "some later DOM change" that may never come.
      for (let slice = 0; slice < 8; slice += 1) {
        pruneElements();
        if (!Array.isArray(state.pruneKeys)) break;
        if (state.pruneCursor >= state.pruneKeys.length) break;
      }
      pruneWanted();
      pruneRetry();
    }

    /** Inspect up to PRUNE_MAX keyed elements; the caller loops until a pass ends. */
    function pruneElements() {
      if (!Array.isArray(state.pruneKeys) || state.pruneCursor >= state.pruneKeys.length) {
        state.pruneKeys = [];
        state.pruneCursor = 0;
        for (const key of state.records.keys()) state.pruneKeys.push(key);
        for (const key of state.pings.keys()) state.pruneKeys.push(key);
      }
      // A pass always completes in this scan (so a detached subtree never waits
      // for another DOM change to be released), while each slice stays bounded.
      const budget = Math.min(PRUNE_MAX, Math.max(PRUNE_MIN, Math.ceil(state.pruneKeys.length / 4) * 4));
      const end = Math.min(state.pruneKeys.length, state.pruneCursor + budget);
      for (; state.pruneCursor < end; state.pruneCursor += 1) {
        const key = state.pruneKeys[state.pruneCursor];
        if (!(key instanceof Element)) continue;
        if (key.isConnected) continue;
        state.records.delete(key);
        state.pings.delete(key);
      }
    }

    /**
     * Drop detached elements from the wanted sets.
     *
     * Walks from the head with a fixed budget and no cursor on purpose: wanted
     * is drained by finish() the moment a translation lands, so in practice it
     * holds live keys only, and a head-biased budget can never starve a tail
     * that does not exist. Introducing a cursor here would add state without
     * buying anything measurable.
     */
    function pruneWanted() {
      let wantedBudget = PRUNE_BUDGET;
      for (const [key, set] of state.wanted) {
        if (wantedBudget <= 0) break;
        wantedBudget -= 1;
        for (const element of set) {
          if (element instanceof Element && !element.isConnected) set.delete(element);
        }
        if (set.size === 0) state.wanted.delete(key);
      }
    }

    // retry: a deadline that passed long ago can never fire again.
    function pruneRetry() {
      const now = Date.now();
      for (const [key, until] of state.retry) {
        if (until + 60000 < now) state.retry.delete(key);
      }
    }

    function rowOf(leaf) {
      return leaf.closest(ROW_SELECTOR);
    }

    function headerOf(row) {
      return row.querySelector("[data-disclosure-header]") || row;
    }

    /**
     * Read the visible text of one leaf.
     *
     * Rows paint their copy through TextShimmer, which stores the string in a
     * \`data-shimmer-text\` attribute and renders it with CSS \`content\`, so the
     * attribute — not the text node — carries the words in the real page.
     */
    function readText(element) {
      const attribute = element.getAttribute("data-shimmer-text");
      if (attribute !== null) return attribute;
      return element.textContent ?? "";
    }

    function writeText(element, value) {
      if (element.hasAttribute("data-shimmer-text")) element.setAttribute("data-shimmer-text", value);
      else element.textContent = value;
    }

    function usableLeaf(element) {
      if (element.children.length > 0) return false;
      if (element.closest("[inert]") !== null) return false;
      if (element.closest("[" + OWN_ATTR + "]") !== null) return false;
      if (element.getAttribute("aria-hidden") === "true") return false;
      if (element.closest(SKIP_SELECTOR) !== null) return false;
      return readText(element).trim() !== "";
    }

    /**
     * The two prose leaves of one row header.
     *
     * A disclosure header may carry an accessory next to the clickable row (the
     * plugin's own button lives there), so only leaves inside the disclosure row
     * count as copy. Rows without a disclosure row — the shell sample — keep
     * their whole header.
     */
    function headerLeaves(row) {
      const header = headerOf(row);
      const owned = header.querySelector("[data-disclosure-row]");
      const out = [];
      for (const element of header.querySelectorAll("span,button,a")) {
        if (owned !== null && element.closest("[data-disclosure-row]") === null) continue;
        if (usableLeaf(element)) out.push(element);
      }
      // The first header leaf is the tool-type title, the rest is the summary.
      return out.map((element, index) => (index === 0 ? { element, kind: "title" } : { element, kind: "summary" }));
    }

    /**
     * Whether `element` sits inside `container`.
     *
     * DOM `closest` takes a selector, and the header is only known by identity,
     * so the ancestry walk is done by hand.
     */
    function within(element, container) {
      let node = element.parentElement;
      while (node !== null && node !== undefined) {
        if (node === container) return true;
        node = node.parentElement;
      }
      return false;
    }

    function bodyLeaves(row) {
      const out = [];
      const header = headerOf(row);
      for (const element of row.querySelectorAll(BODY_SELECTOR)) {
        if (!(element instanceof Element)) continue;
        if (within(element, header)) continue;
        if (usableLeaf(element)) {
          out.push({ element, kind: "body" });
          continue;
        }
        for (const leaf of element.querySelectorAll("span,div")) {
          if (usableLeaf(leaf)) out.push({ element: leaf, kind: "body" });
        }
      }
      return out;
    }

    function collect() {
      const found = [];
      state.rowLeaves.clear();
      pruneState();
      if (typeof document === "undefined") return found;
      for (const row of document.querySelectorAll(ROW_SELECTOR)) {
        if (!(row instanceof Element)) continue;
        // A reasoning row never nests another row, but tool rows may sit inside one.
        if (row.getAttribute("data-variant") === "think" && row.closest(ROW_SELECTOR) !== row) continue;
        const head = headerLeaves(row);
        const own = [];
        for (let index = 0; index < head.length; index += 1) {
          const item = head[index];
          const isTitle = index === 0;
          // The tool-type title carries its own switch; a reasoning row has only a title.
          if (isTitle && !state.config.translateTitle) {
            own.push({ element: item.element, kind: "title" });
            continue;
          }
          own.push({ element: item.element, kind: isTitle ? "title" : "summary" });
          found.push({ element: item.element, kind: isTitle ? "title" : "summary" });
        }
        if (state.config.translateErrors && row.getAttribute("data-state") === "error") {
          for (const item of bodyLeaves(row)) {
            own.push(item);
            found.push(item);
          }
        }
        state.rowLeaves.set(row, own);
        if (row.getAttribute("data-stt-row") === null) row.setAttribute("data-stt-row", "");
      }
      return found;
    }

    function restore(element) {
      const record = state.records.get(element);
      if (record === undefined) return;
      if (record.applied !== null && readText(element) === record.applied) writeText(element, record.original);
      record.applied = null;
      element.removeAttribute("data-stt-translated");
      // The host may have had its own tooltip on this leaf; without this the
      // plugin wiped it for the rest of the page lifetime.
      if (record.hostTitle === null || record.hostTitle === undefined) element.removeAttribute("title");
      else element.setAttribute("title", record.hostTitle);
    }

    function restoreAll() {
      for (const [element, record] of state.records) {
        if (!element.isConnected) {
          state.records.delete(element);
          continue;
        }
        if (record.applied !== null) restore(element);
      }
    }

    /**
     * Whether a row still shows copy the plugin could not translate.
     *
     * The row button exists for exactly these rows: a translated row hides it,
     * an untranslatable row (all identifiers, all Chinese) never shows it.
     */
    function pendingLeaves(row) {
      const out = [];
      const leaves = state.rowLeaves.get(row);
      if (leaves === undefined) return out;
      for (const item of leaves) {
        const element = item.element;
        if (!(element instanceof Element) || !element.isConnected) continue;
        if (element.getAttribute("data-stt-translated") === "1") continue;
        // The tool-type title keeps its own switch: a row button never overrides it.
        if (item.kind === "title" && !state.config.translateTitle) continue;
        const record = state.records.get(element);
        if (record !== undefined && (record.applied !== null || record.settled === true)) continue;
        if (!shouldTranslate(readText(element), state.config.targetLanguage, item.kind)) continue;
        out.push(item);
      }
      return out;
    }

    function paint(element, record, translated) {
      const rendered = translated + record.tail;
      if (record.applied === null) record.hostTitle = element.getAttribute("title");
      record.applied = rendered;
      element.setAttribute("data-stt-translated", "1");
      element.setAttribute("title", record.original);
      if (readText(element) !== rendered) writeText(element, rendered);
    }

    function want(key, element) {
      let set = state.wanted.get(key);
      if (set === undefined) {
        set = new Set();
        state.wanted.set(key, set);
      }
      set.add(element);
    }

    /**
     * Decide what one leaf should show now.
     *
     * @param item - leaf and the role its copy plays.
     * @param force - true when a row button asked again: cached echoes, failures
     *   and backoff are ignored, so the endpoint is asked once more.
     */
    function visit({ element, kind }, force = false) {
      if (!(element instanceof Element)) return;
      const current = readText(element);
      const record = state.records.get(element);
      if (record !== undefined && record.applied !== null && current === record.applied) return;
      const original = record !== undefined && current === record.original ? record.original : current;
      if (!state.config.enabled || !shouldTranslate(original, state.config.targetLanguage, kind)) {
        if (record !== undefined && record.applied !== null) restore(element);
        return;
      }
      if (state.showOriginal) {
        if (record !== undefined && record.applied !== null) restore(element);
        return;
      }
      const split = kind === "body" ? splitProse(original) : { prose: original, tail: "" };
      const next = { original, applied: null, kind, prose: split.prose, tail: split.tail, settled: false, hostTitle: null };
      state.records.set(element, next);
      if (split.prose.trim() === "") return;
      const hit = state.cache.get(split.prose);
      if (hit !== undefined) {
        if (!hit.weak) {
          paint(element, next, hit.text);
          return;
        }
        // A known echo of copy that is already in the target language: nothing to do.
        if (isMostlyLocal(split.prose)) {
          next.settled = true;
          return;
        }
        // A known echo: the row button asks again right away, the automatic scan
        // waits a little longer — the host refines echoes through a second engine
        // in the background, and that answer arrives a few seconds later.
        if (!force) {
          if ((state.identities.get(split.prose) ?? 0) >= ECHO_ATTEMPTS) {
            // Still an echo after every attempt: stop offering a button that can
            // only fail, and leave the row readable in its original language.
            next.settled = true;
            return;
          }
          const until = state.retry.get(split.prose);
          if (until !== undefined && until > Date.now()) return;
          rememberRetry(split.prose, Date.now() + ECHO_RETRY_MS);
        }
      }
      if (force) {
        state.failures.delete(split.prose);
        state.reasons.delete(split.prose);
        state.identities.delete(split.prose);
        state.retry.delete(split.prose);
        state.cache.delete(split.prose);
        dropJob(split.prose);
        state.pings.set(rowOf(element), Date.now() + PING_MS);
        want(split.prose, element);
        ensureJob(split.prose, true);
        return;
      } else {
        // Failures are not permanent: they only push the next automatic attempt
        // further out (see backoffFor), so a row that failed while the proxy was
        // asleep heals by itself instead of staying red until the reader clicks.
        const until = state.retry.get(split.prose);
        if (until !== undefined && until > Date.now()) return;
      }
      want(split.prose, element);
      ensureJob(split.prose);
    }

    /**
     * How long to wait before the next automatic attempt at one sentence.
     *
     * @param failures - consecutive failures so far.
     * @returns delay in milliseconds, capped so a dead endpoint costs one request a minute.
     */
    function backoffFor(failures) {
      return Math.min(60000, 3000 * Math.pow(2, Math.max(0, failures - 1)));
    }

    function ensureJob(key, forced = false) {
      if (state.jobs.has(key)) return;
      const job = { key, forced, chunks: chunkText(key, CHUNK_CHARS), results: [], echoes: new Set() };
      job.results = new Array(job.chunks.length).fill(null);
      state.jobs.set(key, job);
      state.queue.push(job);
    }

    /** Drop a job that is still queued, so a forced retry starts from scratch. */
    function dropJob(key) {
      const job = state.jobs.get(key);
      if (job === undefined) return;
      state.jobs.delete(key);
      state.queue = state.queue.filter((item) => item !== job);
    }

    function finish(job) {
      if (state.disposed) return;
      state.jobs.delete(job.key);
      state.queue = state.queue.filter((item) => item !== job);
      if (job.results.some((value) => value === null)) return;
      const joined = job.results.join("");
      if (joined.trim() === "") return;
      if (job.echoes.size > 0 || isEcho(job.key, joined)) {
        // The endpoint kept the source text. A forced attempt is the reader's
        // second opinion already, so it stops here; an automatic one retries once
        // alone, which usually breaks the endpoint's tie.
        const local = isMostlyLocal(job.key);
        const attempts = job.forced || local ? MAX_IDENTITY_ATTEMPTS : (state.identities.get(job.key) ?? 0) + 1;
        rememberIdentity(job.key, attempts);
        state.failures.delete(job.key);
        if (attempts < MAX_IDENTITY_ATTEMPTS) rememberRetry(job.key, Date.now() + RETRY_DELAY_MS);
        else rememberResult(job.key, job.key, true);
        return;
      }
      state.identities.delete(job.key);
      state.retry.delete(job.key);
      state.failures.delete(job.key);
      state.reasons.delete(job.key);
      rememberResult(job.key, joined, false);
      const targets = state.wanted.get(job.key);
      if (targets === undefined) return;
      // Consume the targets: an element that already left the document is
      // dropped instead of being kept alive by this Set for the rest of the
      // session, and an empty Set gives the prose key back to the GC as well.
      for (const element of targets) {
        if (state.disposed) break;
        if (!element.isConnected) {
          targets.delete(element);
          continue;
        }
        const record = state.records.get(element);
        if (record === undefined || record.prose !== job.key || record.applied !== null) continue;
        targets.delete(element);
        paint(element, record, joined);
      }
      if (targets.size === 0) state.wanted.delete(job.key);
    }

    /**
     * Fill the next request from every queued job.
     *
     * Chunks from several rows share one request so a screenful of rows costs a
     * single round trip instead of one per row; each chunk remembers its owner.
     */
    function takeBatch() {
      const pending = [];
      let total = 0;
      for (let index = 0; index < state.queue.length; index += 1) {
        const job = state.queue[index];
        for (let chunkIndex = 0; chunkIndex < job.chunks.length; chunkIndex += 1) {
          if (job.results[chunkIndex] !== null) continue;
          const chunk = job.chunks[chunkIndex];
          if (chunk.trim() === "") {
            job.results[chunkIndex] = chunk;
            continue;
          }
          if (pending.length >= BATCH_SIZE) return pending;
          // The first chunk always goes in, so a batch is never empty; after
          // that the budget keeps one request well under the host's limit.
          if (pending.length > 0 && total + chunk.length > BATCH_CHARS) return pending;
          pending.push({ job, chunkIndex, chunk });
          total += chunk.length;
        }
      }
      return pending;
    }

    function settledJobs() {
      let changed = true;
      while (changed) {
        changed = false;
        for (const job of [...state.queue]) {
          if (job.results.every((value) => value !== null)) {
            finish(job);
            changed = true;
          }
        }
      }
    }

    async function pump() {
      if (state.running || state.disposed) return;
      if (state.queue.length === 0) return;
      state.running = true;
      try {
        while (state.queue.length > 0 && !state.disposed) {
          const pending = takeBatch();
          if (pending.length === 0) {
            settledJobs();
            const stalled = state.queue.filter((job) => job.results.some((value) => value === null));
            if (stalled.length === 0) break;
            // Nothing was takeable: drop the stuck jobs rather than spin.
            for (const job of stalled) {
              state.jobs.delete(job.key);
              state.queue = state.queue.filter((item) => item !== job);
            }
            continue;
          }
          let ok = false;
          let reason = "";
          try {
            const result = await bridgeTranslate({
              texts: pending.map((item) => item.chunk),
              to: state.config.targetLanguage,
              proxy: state.config.proxy,
            });
            if (result && result.ok && result.value && Array.isArray(result.value.translations)) {
              const translations = result.value.translations;
              for (let index = 0; index < pending.length; index += 1) {
                const translated = translations[index];
                const entry = pending[index];
                if (typeof translated !== "string" || translated.trim() === "") continue;
                if (isEcho(entry.chunk, translated)) entry.job.echoes.add(entry.chunkIndex);
                entry.job.results[entry.chunkIndex] = translated;
              }
              ok = true;
            } else if (result && typeof result.code === "string") {
              reason = result.code + (typeof result.message === "string" ? ": " + result.message : "");
            } else {
              reason = "bridge returned no translations";
            }
          } catch (error) {
            // An aborted request surfaces as AbortError; the row tooltip says so
            // instead of blaming the endpoint.
            reason = error && error.name === "AbortError" ? "request timeout after " + String(REQUEST_TIMEOUT_MS) + "ms" : "network: " + String(error && error.message ? error.message : error);
          }
          const before = state.queue.length;
          settledJobs();
          if (!ok) {
            for (const job of new Set(pending.map((entry) => entry.job))) {
              // Always release the job so the next attempt starts from scratch:
              // keeping a half-filled job would freeze the row on "translating…".
              state.jobs.delete(job.key);
              state.queue = state.queue.filter((item) => item !== job);
              rememberFailure(job.key, reason);
            }
            scheduleRetry();
            break;
          }
          if (state.queue.length >= before) break;
        }
      } finally {
        state.running = false;
      }
      paintActions();
      if (state.queue.length === 0) scheduleRetry();
      else queuePump();
    }

    /**
     * Ask for another request round after a network hiccup.
     *
     * A failed batch leaves its jobs queued; without this nudge they would wait
     * for the next DOM change, which on a settled transcript never comes.
     */
    function queuePump() {
      if (state.disposed || state.pumpTimer !== 0) return;
      state.pumpTimer = window.setTimeout(() => {
        state.pumpTimer = 0;
        void pump();
      }, RETRY_DELAY_MS);
    }

    function scan() {
      if (state.disposed || !state.loaded) return;
      // collect() runs pruneState() as its first step; calling it twice per scan
      // only rebuilt the key snapshot and walked it a second time.
      for (const item of collect()) visit(item);
      paintActions();
      void pump();
    }

    function scheduleScan() {
      if (state.disposed || state.timer !== 0) return;
      state.timer = window.setTimeout(() => {
        state.timer = 0;
        scan();
      }, SCAN_DELAY_MS);
    }

    /**
     * Re-run the scan once the earliest backoff expired, so echoes get retried untouched.
     *
     * One timer at a time: the slot is reused while its deadline is still the
     * earliest one, and re-armed early when a new key expires sooner. Without
     * the sentinel every call added another timer, and a burst of failures left
     * dozens of scans racing each other.
     */
    function scheduleRetry() {
      if (state.disposed || state.showOriginal) return;
      const now = Date.now();
      const due = [];
      let earliest = Infinity;
      // Collect first: deleting while iterating the same Map would skip entries.
      for (const [key, until] of state.retry) {
        if ((state.identities.get(key) ?? 0) >= MAX_IDENTITY_ATTEMPTS) {
          due.push(key);
          continue;
        }
        if (until <= now) {
          due.push(key);
          continue;
        }
        if (until < earliest) earliest = until;
      }
      // Every expired key is released in the same round, not just the first one.
      for (const key of due) state.retry.delete(key);
      if (earliest === Infinity) {
        if (state.retryTimer !== 0) {
          window.clearTimeout(state.retryTimer);
          state.retryTimer = 0;
          state.retryTimerAt = 0;
        }
        if (due.length > 0) scan();
        return;
      }
      if (state.retryTimer !== 0) {
        // The armed timer already fires no later than the new deadline: keep it.
        if (state.retryTimerAt <= earliest) return;
        window.clearTimeout(state.retryTimer);
        state.retryTimer = 0;
      }
      const delay = Math.max(50, earliest - now);
      state.retryTimerAt = earliest;
      state.retryTimer = window.setTimeout(() => {
        state.retryTimer = 0;
        state.retryTimerAt = 0;
        scan();
      }, delay);
    }

    //#region row action
    /**
     * The button injected into one disclosure header.
     *
     * It is plain DOM the plugin owns: React never renders it, and the plugin
     * never claims React's nodes, so the row keeps its keyed identity and the
     * button is simply re-added after a re-render drops it.
     */
    function actionLabel(t, key) {
      const row = t[key];
      return typeof row === "string" ? row : "";
    }

    function buildAction() {
      const t = pickLocale();
      const container = document.createElement("span");
      container.setAttribute(OWN_ATTR, ROW_ACTION);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "stt-action";
      button.tabIndex = -1;
      button.setAttribute("aria-label", actionLabel(t, "rowAction"));
      button.setAttribute("title", actionLabel(t, "rowAction"));
      const mark = document.createElement("span");
      mark.className = "stt-action-mark";
      mark.setAttribute("aria-hidden", "true");
      const glyph = document.createElement("span");
      glyph.className = "stt-action-glyph";
      mark.appendChild(glyph);
      const text = document.createElement("span");
      text.className = "stt-action-text";
      button.appendChild(mark);
      button.appendChild(text);
      container.appendChild(button);
      // Every pointer and keyboard path has to stop at the button: the header
      // row is itself a button that toggles the disclosure.
      const swallow = (event) => {
        event.stopPropagation();
        if (event.type !== "keydown") event.preventDefault();
      };
      //
      // click and keydown are NOT bound here: they are delegated in observe().
      // React may re-render the header between pointerdown and pointerup, which
      // replaces the button — and with it any listener bound to that node — before
      // the browser dispatches click. A capture-phase delegate on document
      // survives the swap, which is what made the button "do nothing" sometimes.
      for (const type of ["pointerdown", "mousedown", "touchstart", "pointerup", "mouseup"]) {
        container.addEventListener(type, swallow);
      }
      return container;
    }

    /**
     * Run a row button that the delegated click landed on.
     *
     * @param target - the event target.
     * @returns whether a row button handled the event.
     */
    function runAction(target) {
      const element = target instanceof Element ? target : null;
      if (element === null) return false;
      const container = element.closest("[" + OWN_ATTR + "='" + ROW_ACTION + "']");
      if (container === null || !container.isConnected) return false;
      const run = container.__sttRun;
      if (typeof run !== "function") return false;
      run();
      return true;
    }

    function actionStatus(row) {
      const pending = pendingLeaves(row);
      const busy = pending.some((item) => {
        const record = state.records.get(item.element);
        if (record === undefined || record.applied !== null) return false;
        return state.jobs.has(record.prose);
      });
      return { pending, busy };
    }

    /** Refresh every injected button against the row it belongs to. */
    /** Write a node's text only when it differs, so the observer sees no self-made churn. */
    function setText(element, value) {
      if (element.textContent === value) return;
      element.textContent = value;
    }

    function setAttribute(element, name, value) {
      if (element.getAttribute(name) === value) return;
      element.setAttribute(name, value);
    }

    function paintActions() {
      if (state.disposed || typeof document === "undefined" || !state.loaded) return;
      const t = pickLocale();
      // A ping only paints a button for a second: drop expired ones here so the
      // map cannot grow with every row the reader ever clicked.
      const now = Date.now();
      for (const [row, until] of state.pings) {
        if (until <= now || !(row instanceof Element) || !row.isConnected) state.pings.delete(row);
      }
      const rows = new Set([...state.rowLeaves.keys(), ...state.rowActions.keys()]);
      for (const row of rows) {
        if (!(row instanceof Element) || !row.isConnected) {
          state.rowActions.delete(row);
          continue;
        }
        const status = actionStatus(row);
        let container = state.rowActions.get(row);
        const header = headerOf(row);
        if (status.pending.length === 0) {
          if (container !== undefined) {
            container.remove();
            state.rowActions.delete(row);
          }
          continue;
        }
        if (container === undefined || !container.isConnected) {
          container = buildAction();
          header.appendChild(container);
          state.rowActions.set(row, container);
        }
        // The disclosure header lays a plain accessory out beside the clickable row;
        // the attribute is React's own switch for that layout.
        if (header.getAttribute("data-has-accessory") === null) header.setAttribute("data-has-accessory", "");
        const button = container.querySelector("button");
        const tick = container.querySelector(".stt-action-glyph");
        const text = container.querySelector(".stt-action-text");
        if (button === null || tick === null || text === null) continue;
        const failed = status.pending.some((item) => {
          const record = state.records.get(item.element);
          if (record === undefined) return false;
          return (state.failures.get(record.prose) ?? 0) >= MAX_FAILURES;
        });
        // The last bridge error for this row, so the tooltip can name the cause
        // (429 / proxy refused / timeout) instead of a bare "failed".
        let reason = "";
        for (const item of status.pending) {
          const record = state.records.get(item.element);
          if (record === undefined) continue;
          const known = state.reasons.get(record.prose);
          if (typeof known === "string" && known !== "") {
            reason = known;
            break;
          }
        }
        const pinged = (state.pings.get(row) ?? 0) > Date.now();
        container.__sttRun = () => {
          translateRow(row);
        };
        button.tabIndex = 0;
        if (status.busy) {
          setAttribute(button, "data-busy", "");
          if (button.hasAttribute("data-failed")) button.removeAttribute("data-failed");
          setText(tick, "\u21bb");
          setText(text, actionLabel(t, "rowActionBusy"));
          setAttribute(button, "title", actionLabel(t, "rowActionBusy"));
        } else if (failed) {
          if (button.hasAttribute("data-busy")) button.removeAttribute("data-busy");
          if (button.hasAttribute("data-pinged")) button.removeAttribute("data-pinged");
          setAttribute(button, "data-failed", "");
          setText(tick, "!");
          setText(text, actionLabel(t, "rowAction"));
          const explain = actionLabel(t, "rowActionFailed") + (reason === "" ? "" : " — " + actionLabel(t, "rowActionReason") + reason);
          setAttribute(button, "title", explain);
          setAttribute(button, "aria-label", explain);
        } else if (pinged) {
          // The request is already in flight; say so, so a click that lands
          // while the pump is busy is visibly acknowledged instead of ignored.
          if (button.hasAttribute("data-busy")) button.removeAttribute("data-busy");
          if (button.hasAttribute("data-failed")) button.removeAttribute("data-failed");
          setAttribute(button, "data-pinged", "");
          setText(tick, "\u2192");
          setText(text, actionLabel(t, "rowActionClicked"));
          setAttribute(button, "title", actionLabel(t, "rowActionClicked"));
        } else {
          if (button.hasAttribute("data-busy")) button.removeAttribute("data-busy");
          if (button.hasAttribute("data-failed")) button.removeAttribute("data-failed");
          if (button.hasAttribute("data-pinged")) button.removeAttribute("data-pinged");
          setText(tick, actionLabel(t, "rowActionGlyph"));
          setText(text, "");
          setAttribute(button, "title", actionLabel(t, "rowAction"));
          setAttribute(button, "aria-label", actionLabel(t, "rowAction"));
        }
      }
    }

    /**
     * Translate one row on demand, bypassing every cache and failure memory.
     *
     * @param row - the disclosure row whose own pending leaves are translated.
     */
    function translateRow(row) {
      if (state.disposed || !state.config.enabled) return;
      const items = pendingLeaves(row);
      if (items.length === 0) {
        // Nothing pending any more: refresh instead of staying silent, so the
        // click still visibly does something.
        state.pings.set(row, Date.now() + PING_MS);
        scan();
        paintActions();
        return;
      }
      if (state.showOriginal) {
        // Asking for a translation is asking to see translations again.
        state.showOriginal = false;
        scan();
      }
      // Acknowledge the click before the network answers: the button flips to
      // "asked the endpoint again" for a moment, so a click is never silent.
      state.pings.set(row, Date.now() + PING_MS);
      for (const item of items) visit(item, true);
      paintActions();
      const timer = window.setTimeout(() => {
        state.pingTimers.delete(timer);
        paintActions();
      }, PING_MS + 50);
      state.pingTimers.add(timer);
      void pump();
    }
    //#endregion

    function toggleView() {
      state.showOriginal = !state.showOriginal;
      if (state.showOriginal) restoreAll();
      else scan();
      paintActions();
      return state.showOriginal;
    }

    /**
     * Handle a click on one of the injected row buttons.
     *
     * Runs in the capture phase so a click still lands when the header was
     * re-rendered (and the button replaced) while the pointer was down, and
     * stops the row from toggling its disclosure.
     *
     * @param event - the click event.
     */
    function onClickCapture(event) {
      const target = event.target instanceof Element ? event.target : null;
      if (target === null) return;
      if (target.closest("[" + OWN_ATTR + "='" + ROW_ACTION + "']") === null) return;
      event.stopPropagation();
      event.preventDefault();
      runAction(target);
    }

    /**
     * Enter and Space activate a focused row button.
     *
     * @param event - the keydown event.
     */
    function onActionKeyDown(event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = event.target instanceof Element ? event.target : null;
      if (target === null) return;
      if (target.closest("[" + OWN_ATTR + "='" + ROW_ACTION + "']") === null) return;
      event.stopPropagation();
      event.preventDefault();
      runAction(target);
    }

    function onKeyDown(event) {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "t" && event.key !== "T") return;
      event.preventDefault();
      toggleView();
    }

    function isOwnWrite(record) {
      const target = record.target;
      if (!(target instanceof Element)) return false;
      const stored = state.records.get(target);
      if (stored === undefined || stored.applied === null) return false;
      return target.getAttribute("data-shimmer-text") === stored.applied;
    }

    function observe() {
      if (typeof document === "undefined" || state.observer !== null) return;
      state.observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === "attributes" && isOwnWrite(record)) continue;
          scheduleScan();
          return;
        }
      });
      state.observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["data-shimmer-text", "data-state"],
      });
      document.addEventListener("keydown", onKeyDown, true);
      // Capture-phase delegates: they fire even when React swaps the header node
      // between the pointer press and the click.
      document.addEventListener("click", onClickCapture, true);
      document.addEventListener("keydown", onActionKeyDown, true);
    }
    //#endregion

    //#region config card
    function ConfigCard() {
      const t = react.useMemo(pickLocale, []);
      const [draft, setDraft] = react.useState(null);
      const [status, setStatus] = react.useState("idle");

      react.useEffect(() => {
        let alive = true;
        void bridgeConfig()
          .then((result) => {
            if (alive && result && result.ok) setDraft(result.value);
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, []);

      const update = (patch) => setDraft((currentState) => ({ ...(currentState || {}), ...patch }));

      const save = async () => {
        if (draft === null) return;
        setStatus("saving");
        try {
          const result = await bridgeSave({
            enabled: draft.enabled,
            translateTitle: draft.translateTitle,
            translateErrors: draft.translateErrors,
            targetLanguage: draft.targetLanguage,
            proxy: draft.proxy,
          });
          if (result && result.ok) {
            state.config = { ...state.config, ...result.value };
            resetCache();
            setStatus("saved");
          } else {
            setStatus("failed");
          }
        } catch (_error) {
          setStatus("failed");
        }
      };

      if (draft === null) return react_jsx_runtime.jsx("p", { className: "stt-tip", children: t.privacy });

      return react_jsx_runtime.jsxs("div", {
        children: [
          react_jsx_runtime.jsxs("label", {
            className: "stt-check",
            children: [
              react_jsx_runtime.jsx("input", {
                type: "checkbox",
                checked: draft.enabled !== false,
                onChange: (event) => update({ enabled: event.target.checked }),
              }),
              t.enabled,
            ],
          }),
          react_jsx_runtime.jsxs("label", {
            className: "stt-check",
            style: { marginTop: "8px" },
            children: [
              react_jsx_runtime.jsx("input", {
                type: "checkbox",
                checked: draft.translateTitle !== false,
                onChange: (event) => update({ translateTitle: event.target.checked }),
              }),
              t.translateTitle,
            ],
          }),
          react_jsx_runtime.jsxs("label", {
            className: "stt-check",
            style: { marginTop: "8px" },
            children: [
              react_jsx_runtime.jsx("input", {
                type: "checkbox",
                checked: draft.translateErrors !== false,
                onChange: (event) => update({ translateErrors: event.target.checked }),
              }),
              t.translateErrors,
            ],
          }),
          react_jsx_runtime.jsxs("div", {
            className: "stt-field",
            style: { marginTop: "12px" },
            children: [
              react_jsx_runtime.jsx("span", { className: "stt-label", children: t.language }),
              react_jsx_runtime.jsxs("select", {
                className: "stt-select",
                value: draft.targetLanguage || "zh-Hans",
                onChange: (event) => update({ targetLanguage: event.target.value }),
                children: [
                  react_jsx_runtime.jsx("option", { value: "zh-Hans", children: "简体中文" }),
                  react_jsx_runtime.jsx("option", { value: "zh-Hant", children: "繁體中文" }),
                  react_jsx_runtime.jsx("option", { value: "en", children: "English" }),
                  react_jsx_runtime.jsx("option", { value: "ja", children: "日本語" }),
                  react_jsx_runtime.jsx("option", { value: "ko", children: "한국어" }),
                  react_jsx_runtime.jsx("option", { value: "ru", children: "Русский" }),
                ],
              }),
            ],
          }),
          react_jsx_runtime.jsxs("div", {
            className: "stt-field",
            children: [
              react_jsx_runtime.jsx("span", { className: "stt-label", children: t.proxy }),
              react_jsx_runtime.jsx("input", {
                className: "stt-input",
                value: draft.proxy || "",
                placeholder: "http://127.0.0.1:10808",
                onChange: (event) => update({ proxy: event.target.value }),
              }),
              react_jsx_runtime.jsx("p", { className: "stt-tip", children: t.proxyHint }),
            ],
          }),
          react_jsx_runtime.jsxs("div", {
            className: "stt-row",
            children: [
              react_jsx_runtime.jsx("button", {
                type: "button",
                className: "stt-btn",
                disabled: status === "saving",
                onClick: () => {
                  void save();
                },
                children: status === "saving" ? t.saving : t.save,
              }),
              react_jsx_runtime.jsx("button", {
                type: "button",
                className: "stt-btn",
                onClick: () => {
                  resetCache();
                },
                children: t.reload,
              }),
              status === "saved" && react_jsx_runtime.jsx("span", { className: "stt-note", children: t.saved }),
              status === "failed" && react_jsx_runtime.jsx("span", { className: "stt-note", children: t.failed }),
            ],
          }),
          react_jsx_runtime.jsxs("p", {
            className: "stt-tip",
            style: { marginTop: "12px" },
            children: [t.shortcut, " ", t.privacy],
          }),
        ],
      });
    }

    function resetCache() {
      state.cache.clear();
      state.failures.clear();
      state.reasons.clear();
      state.identities.clear();
      state.retry.clear();
      state.jobs.clear();
      state.queue = [];
      state.wanted.clear();
      state.pings.clear();
      restoreAll();
      // rowLeaves and records are rebuilt by the next collect(); clearing them
      // drops every element the previous translation rounds kept reachable.
      state.records.clear();
      state.rowLeaves.clear();
      state.pruneKeys = null;
      state.pruneCursor = 0;
      scan();
    }
    //#endregion

    //#region plugin
    const inject = ["slots"];

    function apply(ctx) {
      // The module instance survives a disable/enable cycle: without this the
      // first teardown left state.disposed set and every later scan was a no-op.
      state.disposed = false;
      // A teardown must not carry the reader's "show the original" toggle over:
      // visit() returns early in that mode, so a re-enabled plugin would leave
      // every row untranslated until Alt+T was pressed again.
      state.showOriginal = false;
      // The stylesheet lives in the document, not in this closure, and teardown
      // removes it; re-add it here or the buttons come back unstyled.
      ensureStyles();
      ctx.slots.inject("plugins.row.config", () =>
        ctx.slots.register(
          {
            name: "plugins.row.config",
            key: "dsh-step-title-translate#step-title-translate",
          },
          (slotProps) =>
            slotProps && slotProps.view === "summary"
              ? pickLocale().summary
              : react_jsx_runtime.jsx(ConfigCard, {}),
        ),
      );

      /**
       * Read the settings once, retrying while the Host is still warming up.
       *
       * A page can finish loading before the bridge answers; giving up on the
       * first failure would leave the plugin inert for the whole page lifetime.
       */
      const boot = async (attempt = 0) => {
        if (state.disposed) return;
        try {
          const result = await bridgeConfig();
          if (state.disposed) return;
          if (result && result.ok && result.value) state.config = { ...state.config, ...result.value };
        } catch (_error) {
          if (attempt < BOOT_RETRIES) {
            window.setTimeout(() => {
              void boot(attempt + 1);
            }, BOOT_RETRY_DELAY_MS * (attempt + 1));
          }
          return;
        }
        state.loaded = true;
        observe();
        scheduleScan();
      };
      void boot();

      ctx.effect(
        () => () => {
          state.disposed = true;
          if (state.observer !== null) {
            state.observer.disconnect();
            state.observer = null;
          }
          if (typeof document !== "undefined") {
            document.removeEventListener("keydown", onKeyDown, true);
            // Both capture delegates have to go as well: they close over the
            // whole state object, so leaving them behind kept every Map (and
            // every element those Maps held) alive after the plugin unloaded.
            document.removeEventListener("click", onClickCapture, true);
            document.removeEventListener("keydown", onActionKeyDown, true);
          }
          if (state.retryTimer !== 0) {
            window.clearTimeout(state.retryTimer);
            state.retryTimer = 0;
            state.retryTimerAt = 0;
          }
          for (const timer of state.pingTimers) window.clearTimeout(timer);
          state.pingTimers.clear();
          if (state.pumpTimer !== 0) {
            window.clearTimeout(state.pumpTimer);
            state.pumpTimer = 0;
          }
          if (state.timer !== 0) {
            window.clearTimeout(state.timer);
            state.timer = 0;
          }
          for (const container of state.rowActions.values()) container.remove();
          state.rowActions.clear();
          state.pings.clear();
          restoreAll();
          // Give the host its markup back before the containers are dropped.
          if (typeof document !== "undefined") {
            for (const row of document.querySelectorAll("[data-stt-row]")) row.removeAttribute("data-stt-row");
            for (const header of document.querySelectorAll("[data-has-accessory]")) header.removeAttribute("data-has-accessory");
            const tag = document.querySelector('style[data-plugin-css="' + NS + '"]');
            if (tag !== null) tag.remove();
          }
          // Every collected reference has to go: the containers above are only
          // detached, and a state left populated pins them for good.
          state.cache.clear();
          state.failures.clear();
          state.reasons.clear();
          state.identities.clear();
          state.retry.clear();
          state.jobs.clear();
          state.queue = [];
          state.records.clear();
          state.wanted.clear();
          state.rowLeaves.clear();
          state.pruneKeys = null;
          state.pruneCursor = 0;
        },
        "step-title-translate: observers",
      );
    }
    //#endregion

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});