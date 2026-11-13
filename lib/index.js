import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { connect as tlsConnect } from "node:tls";

/** Bridge route prefix used by the browser half. */
export const BRIDGE_PREFIX = "/api/dsh-step-title-translate";
/** Microsoft Edge anonymous translation endpoint (the one the official translator uses). */
export const BING_ENDPOINT = "https://edge.microsoft.com/translate/translatetext";
/** The endpoint answers 400 "Client Browser Version not supported" without a browser UA. */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
/** Anonymous secondary engine, asked only when Bing hands its source text back unchanged. */
export const FALLBACK_ENDPOINT = "https://api.mymemory.translated.net/get";
/** Bing keeps answering some short fragments with the source, so echoes fall through to the fallback. */
export const FALLBACK_MAX_TEXTS = 4;
/**
 * The fallback is a courtesy, not a dependency: one stalled request must never
 * hold the whole batch hostage, so it gets a much shorter budget than Bing.
 */
export const FALLBACK_TIMEOUT_MS = 4000;
/** Persisted user settings live beside the rest of the DSH state. */
export const CONFIG_FILE_NAME = "step-title-translate.json";
/** Settings the bridge exposes; the profile patch may override any of them. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  targetLanguage: "zh-Hans",
  translateTitle: true,
  translateErrors: true,
  proxy: "",
});

const MAX_TEXTS = 24;
const MAX_TEXT_CHARS = 4000;
const MAX_TOTAL_CHARS = 24000;
const MAX_BODY_BYTES = 512 * 1024;
/** Beyond this the rest of an oversized body is discarded and the socket closed. */
const MAX_BODY_DRAIN_BYTES = MAX_BODY_BYTES * 4;
/** A body that trickles in forever must not hold its socket either. */
const READ_BODY_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Copy that is already Chinese has nothing to translate when the target is Chinese. */
const CJK_TEST = /[\u3400-\u9fff\uf900-\ufaff]/;
/** Punctuation and spacing that carry no meaning when two strings are compared. */
const EDGE_PUNCTUATION = /^[\s"'\u201c\u201d\u300c\u300d(\[{]+|[\s."'\u3002\u201d\u300f)\]}]+$/g;
/**
 * Entries are capped by count *and* by the characters they hold: a single Bing
 * reply may be megabytes, so a count-only budget is not a memory budget.
 */
const CACHE_LIMIT = 2000;
const CACHE_CHAR_BUDGET = 200000;
/** Distinct proxy strings may not accumulate agents without bound. */
const AGENT_LIMIT = 4;
/** How many outbound translation requests may run at the same time. */
const MAX_INFLIGHT_REQUESTS = 4;
/**
 * Request-option slot carrying the caller's own marker into
 * `TunnelAgent#createConnection`, which is the only place that can see the
 * tunnel a request is still waiting for.
 */
const ABORT_TAG = "__stepTitleTranslateRequest";
/**
 * Background refinement runs on its own small budget, on top of the request
 * slots, so a burst of echoes can never inflate outbound concurrency beyond
 * `MAX_INFLIGHT_REQUESTS + REFINE_MAX_INFLIGHT` and can never starve the
 * foreground path into answering `busy`.
 */
const REFINE_MAX_INFLIGHT = 2;
/**
 * How long a request may wait for a free outbound slot before it is told to come
 * back. The browser half already backs off on a failure, so `busy` is safe.
 */
const BUSY_WAIT_MS = 5000;

/**
 * Map a UI language tag onto the tag Bing expects for Chinese variants.
 * @param tag - language tag from the browser or the persisted settings.
 * @returns the effective Bing target language.
 */
export function normalizeLanguage(tag) {
  const value = typeof tag === "string" ? tag.trim() : "";
  if (value === "") return DEFAULTS.targetLanguage;
  const lower = value.toLowerCase();
  if (["zh", "zh-cn", "zh-sg", "zh-hans"].includes(lower)) return "zh-Hans";
  if (["zh-tw", "zh-hk", "zh-mo", "zh-hant"].includes(lower)) return "zh-Hant";
  return value;
}

/**
 * Read a Cordis configuration field, which may be a volatile accessor.
 * @param source - raw config entry value.
 * @param fallback - value used when the entry is absent or unreadable.
 * @returns the plain value.
 */
function readField(source, fallback) {
  if (source === undefined || source === null) return fallback;
  if (typeof source === "object" && typeof source.get === "function") {
    try {
      const value = source.get();
      return value === undefined || value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }
  return source;
}

/**
 * Normalize persisted or patch-provided settings into the shape the bridge serves.
 * @param raw - candidate settings object.
 * @returns complete settings with every default filled in.
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const enabled = readField(source.enabled, DEFAULTS.enabled);
  const targetLanguage = readField(source.targetLanguage, DEFAULTS.targetLanguage);
  const translateTitle = readField(source.translateTitle, DEFAULTS.translateTitle);
  const translateErrors = readField(source.translateErrors, DEFAULTS.translateErrors);
  const proxy = readField(source.proxy, DEFAULTS.proxy);
  return {
    enabled: enabled !== false,
    targetLanguage: normalizeLanguage(targetLanguage),
    translateTitle: translateTitle !== false,
    translateErrors: translateErrors !== false,
    proxy: typeof proxy === "string" ? proxy.trim() : "",
  };
}

/**
 * Build the JSON body Bing expects: one array element per submitted string.
 * @param to - target language tag.
 * @param from - source language tag, or "auto".
 * @param texts - submitted strings, already bounded by the caller.
 * @returns endpoint URL and request init.
 */
export function buildBingRequest(to, from, texts) {
  const url = new URL(BING_ENDPOINT);
  const source = typeof from === "string" ? from.trim() : "auto";
  if (source !== "" && source.toLowerCase() !== "auto") url.searchParams.set("from", normalizeLanguage(source));
  url.searchParams.set("to", normalizeLanguage(to));
  url.searchParams.set("isEnterpriseClient", "false");
  return {
    url,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9",
        "user-agent": BROWSER_USER_AGENT,
      },
      body: JSON.stringify(texts),
    },
  };
}

/**
 * Extract one translation per submitted string from a Bing response body.
 * @param payload - decoded JSON body.
 * @param count - number of submitted strings.
 * @returns translations, with \`null\` where Bing produced no usable text.
 */
export function parseBingTranslations(payload, count) {
  const out = new Array(count).fill(null);
  if (!Array.isArray(payload)) return out;
  for (let index = 0; index < count; index += 1) {
    const item = payload[index];
    if (item === null || typeof item !== "object") continue;
    const translations = item.translations;
    if (!Array.isArray(translations) || translations.length === 0) continue;
    const first = translations[0];
    if (first === null || typeof first !== "object") continue;
    const text = first.text;
    if (typeof text === "string" && text.trim() !== "") out[index] = text;
  }
  return out;
}

/**
 * Whether two strings are the same copy, ignoring case, spacing and edge punctuation.
 * @param source - submitted text.
 * @param translated - answered text.
 * @returns whether the endpoint echoed the source.
 */
export function isEcho(source, translated) {
  const normalize = (value) => value.toLowerCase().replace(EDGE_PUNCTUATION, "").replace(/\s+/g, " ").trim();
  return normalize(source) === normalize(translated);
}

/**
 * Translate one string through the anonymous MyMemory endpoint.
 *
 * Bing answers a few short sentence fragments with the source text itself; this
 * single-string engine still translates them, so the reader is not left with an
 * English row. It is only ever asked for those echoes.
 *
 * @param text - one string, already bounded by the caller.
 * @param to - target language tag.
 * @param agent - tunnel agent, or `undefined` for a direct connection.
 * @returns the translated copy, or `null` when the engine refused or echoed.
 */
export async function translateFallback(text, to, agent) {
  const target = normalizeLanguage(to);
  const language = target.toLowerCase().startsWith("zh-hant") ? "zh-TW" : target.toLowerCase().startsWith("zh") ? "zh-CN" : target;
  const url = new URL(FALLBACK_ENDPOINT);
  url.searchParams.set("q", text);
  url.searchParams.set("langpair", "en|" + language);
  const payload = await postJson(url, "", agent, "GET", FALLBACK_TIMEOUT_MS);
  const value = payload?.responseData?.translatedText;
  if (typeof value !== "string" || value.trim() === "" || isEcho(text, value)) return null;
  return value;
}

/**
 * Bound the texts of one request and reject payloads the endpoint cannot serve.
 * @param texts - submitted strings.
 * @returns trimmed texts, or an error code when the batch is unusable.
 */
export function boundTexts(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return { ok: false, code: "texts-required" };
  if (texts.length > MAX_TEXTS) return { ok: false, code: "too-many-texts" };
  const trimmed = [];
  let total = 0;
  for (const text of texts) {
    if (typeof text !== "string") return { ok: false, code: "text-type" };
    if (text.length > MAX_TEXT_CHARS) return { ok: false, code: "text-too-long" };
    total += text.length;
    trimmed.push(text);
  }
  if (total > MAX_TOTAL_CHARS) return { ok: false, code: "batch-too-large" };
  return { ok: true, texts: trimmed };
}

/**
 * Create the bounded translation cache used by every request.
 *
 * Two budgets bound it, because either alone leaks: a count cap still lets a few
 * megabyte replies (Bing may answer up to MAX_RESPONSE_BYTES) sit in memory, and
 * a character cap alone would let millions of tiny entries cost the same. Expired
 * entries are dropped on read and whenever the character budget is enforced.
 *
 * @returns cache with \`get\`, \`set\`, \`clear\` and \`size\`.
 */
export function createCache() {
  const entries = new Map();
  let chars = 0;
  const drop = (key) => {
    const hit = entries.get(key);
    if (hit === undefined) return;
    chars -= hit.chars;
    entries.delete(key);
  };
  return {
    get(key) {
      const hit = entries.get(key);
      if (hit === undefined) return undefined;
      if (hit.expiresAt <= Date.now()) {
        drop(key);
        return undefined;
      }
      // Refresh recency, keeping the map in LRU order.
      entries.delete(key);
      entries.set(key, hit);
      return hit.value;
    },
    set(key, value) {
      // Re-setting a key that is already cached REPLACES it and moves it to the
      // most-recently-used end (drop, then insert at the tail). Consequence, and
      // this is intended LRU behaviour rather than a bug: writing an entry that
      // was about to be evicted saves *it* and lets the genuinely oldest
      // untouched entry be evicted instead. `get` does the same re-ordering.
      drop(key);
      const cost = key.length + value.length;
      entries.set(key, { value, chars: cost, expiresAt: Date.now() + CACHE_TTL_MS });
      chars += cost;
      while (entries.size > CACHE_LIMIT || chars > CACHE_CHAR_BUDGET) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        drop(oldest.value);
      }
    },
    clear() {
      entries.clear();
      chars = 0;
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * An HTTPS agent that tunnels through an HTTP proxy with CONNECT.
 *
 * Implemented locally so the plugin needs no third-party networking package and
 * never inherits a global dispatcher installed by another plugin.
 *
 * **`maxSockets` does not cap concurrency on this agent.** `createConnection`
 * returns `undefined` and hands the socket back later, through its callback,
 * but `Agent#createSocket` only accounts for the socket inside `oncreate` and
 * treats an undefined return as "no socket yet", so every concurrent request
 * still sees a free pool (measured: 8 concurrent requests produce 8 tunnels
 * although `maxSockets` is 4). This is inherent to an asynchronous tunnel and
 * is not worked around here on purpose.
 *
 * The real limits live one level up, in `apply()`:
 *  - `MAX_INFLIGHT_REQUESTS` bounds foreground `/translate` work;
 *  - `REFINE_MAX_INFLIGHT` bounds detached refinement.
 * Both are counted in `apply()` rather than trusted to the agent.
 */
export class TunnelAgent extends HttpsAgent {
  constructor(proxy, options = {}) {
    super({ keepAlive: true, maxSockets: 4, ...options });
    this.proxy = new URL(proxy);
    /** Tunnels that are still handshaking, so `destroy()` can reach them too. */
    this.pending = new Set();
  }

  /** @param {object} options - agent options. @param {Function} callback - done. */
  createConnection(options, callback) {
    const tunnel = { host: options.host + ":" + options.port };
    const request = (this.proxy.protocol === "https:" ? httpsRequest : httpRequest)({
      host: this.proxy.hostname,
      port: this.proxy.port === "" ? (this.proxy.protocol === "https:" ? 443 : 80) : Number(this.proxy.port),
      method: "CONNECT",
      path: tunnel.host,
      headers: { host: tunnel.host },
      timeout: REQUEST_TIMEOUT_MS,
    });
    const pending = { request, tag: options[ABORT_TAG], socket: null, secure: null, timer: null };
    this.pending.add(pending);
    const forget = () => {
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.timer = null;
      this.pending.delete(pending);
    };
    let called = false;
    const settle = (error, socket) => {
      if (called) return;
      called = true;
      forget();
      callback(error, socket);
    };
    request.once("connect", (response, socket) => {
      pending.socket = socket;
      if (response.statusCode !== 200) {
        socket.destroy();
        settle(new Error("proxy CONNECT refused with HTTP " + String(response.statusCode)));
        return;
      }
      const secure = tlsConnect({ socket, servername: options.host });
      pending.secure = secure;
      // The TLS socket is not owned by the agent until it is handed over, so the
      // request's own timeout cannot reach it: without this timer a proxy that
      // answers CONNECT and then goes silent pins the socket forever. The raw
      // proxy socket is destroyed too, because `secure` may not have bound to it
      // yet when the handshake never starts.
      pending.timer = setTimeout(() => {
        pending.timer = null;
        socket.destroy();
        secure.destroy();
        settle(Object.assign(new Error("tls handshake timed out after " + String(REQUEST_TIMEOUT_MS) + "ms"), { code: "tunnel-handshake-timeout" }));
      }, REQUEST_TIMEOUT_MS);
      const onError = (error) => {
        secure.destroy();
        settle(error);
      };
      secure.once("error", onError);
      secure.once("secureConnect", () => {
        // Detach the guard so a later socket error is the request's business.
        secure.removeListener("error", onError);
        settle(null, secure);
      });
    });
    request.once("error", (error) => settle(error));
    request.once("timeout", () => request.destroy(new Error("proxy CONNECT timed out")));
    request.end();
  }

  /**
   * Abort the tunnel that was opened on behalf of one caller request.
   *
   * The caller cannot identify the tunnel by object: it holds the https request
   * to the origin, while the tunnel is a *separate* CONNECT request to the
   * proxy. The caller stamps `options[ABORT_TAG]` and that value is carried
   * through `Agent#createSocket` into `createConnection`, so matching happens
   * on that tag instead.
   *
   * @param tag - the marker `postJson` put on its request options.
   * @returns whether a still-handshaking tunnel was found and torn down.
   */
  abortTunnel(tag) {
    if (tag === undefined) return false;
    for (const pending of this.pending) {
      if (pending.tag !== tag) continue;
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.timer = null;
      this.pending.delete(pending);
      if (pending.secure !== null) pending.secure.destroy();
      if (pending.socket !== null) pending.socket.destroy();
      pending.request.destroy();
      return true;
    }
    return false;
  }

  /** Abort every tunnel still mid-handshake; the agent never owned them. */
  destroy() {
    for (const pending of this.pending) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.timer = null;
      pending.request.destroy();
      if (pending.socket !== null) pending.socket.destroy();
      if (pending.secure !== null) pending.secure.destroy();
    }
    this.pending.clear();
    super.destroy();
  }

}

/**
 * POST one JSON body and decode the JSON reply.
 *
 * The socket `timeout` only fires on an idle socket, so it cannot cover a
 * connection that is making slow progress, nor an interrupted response body (a
 * truncated reply fires `aborted`, never `end`). A whole-request deadline and an
 * explicit settlement guard keep every path terminating exactly once.
 *
 * @param url - absolute HTTPS URL.
 * @param body - request body text.
 * @param agent - tunnel agent, or `undefined` for a direct connection.
 * @param method - HTTP method.
 * @param timeoutMs - whole-request budget; the fallback engine gets a shorter one.
 * @returns decoded JSON payload.
 */
export function postJson(url, body, agent, method = "POST", timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(body, "utf8");
    const headers = {
      "content-type": "application/json",
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
      "user-agent": BROWSER_USER_AGENT,
    };
    if (method !== "GET") headers["content-length"] = payload.length;
    let settled = false;
    let deadline = null;
    // Identifies this request inside `createConnection`, where the tunnel that
    // is still being negotiated is the only thing there is to abort.
    const abortTag = {};
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (deadline !== null) clearTimeout(deadline);
      if (error === null) resolve(value);
      else {
        // A request abandoned before its tunnel was handed over is invisible to
        // the agent's bookkeeping, so the half-open tunnel is torn down by tag.
        if (agent instanceof TunnelAgent) agent.abortTunnel(abortTag);
        reject(error);
      }
    };
    const outgoing = httpsRequest(
      {
        host: url.hostname,
        port: url.port === "" ? 443 : Number(url.port),
        path: url.pathname + url.search,
        method,
        agent,
        [ABORT_TAG]: abortTag,
        headers,
        timeout: timeoutMs,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        // A body that never ends must not keep the promise (and these chunks)
        // alive; `aborted`/`error` are the only signals an interrupted one gives.
        response.once("aborted", () => finish(Object.assign(new Error("translation response aborted"), { code: "translation-aborted" })));
        response.once("error", (error) => finish(error));
        response.on("data", (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy(new Error("translation response exceeded " + String(MAX_RESPONSE_BYTES) + " bytes"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            const error = new Error("bing translation failed with HTTP " + String(status) + ": " + text.slice(0, 160));
            error.code = "translation-http-" + String(status);
            finish(error);
            return;
          }
          try {
            finish(null, JSON.parse(text));
          } catch {
            finish(Object.assign(new Error("bing returned invalid JSON"), { code: "translation-invalid-json" }));
          }
        });
      },
    );
    deadline = setTimeout(() => {
      deadline = null;
      // Settle first: a request still waiting for its socket emits nothing on
      // destroy(), so relying on that event would keep the promise pending.
      const error = new Error("translation request timed out after " + String(timeoutMs) + "ms");
      error.code = "translation-timeout";
      finish(error);
      outgoing.destroy(error);
    }, timeoutMs);
    deadline.unref?.();
    outgoing.once("error", (error) => finish(error));
    outgoing.once("timeout", () => outgoing.destroy(new Error("translation request timed out")));
    outgoing.end(payload);
  });
}

/**
 * Translate a bounded batch through Bing, reusing cached results.
 * @param texts - strings to translate.
 * @param options - target/source language, cache, agents and an optional proxy.
 * @returns translations aligned with \`texts\`, with \`null\` for untranslated entries.
 */
export async function translateBatch(texts, options) {
  const cache = options.cache;
  const to = normalizeLanguage(options.to);
  // The request key must be the effective source language, not its spelling:
  // "auto", " AUTO" and "" all mean the same request and must share one entry.
  const rawFrom = typeof options.from === "string" ? options.from.trim() : "auto";
  const from = rawFrom === "" || rawFrom.toLowerCase() === "auto" ? "auto" : normalizeLanguage(rawFrom);
  const results = new Array(texts.length).fill(null);
  const pending = [];
  for (let index = 0; index < texts.length; index += 1) {
    const text = texts[index];
    if (typeof text !== "string") continue;
    if (text.trim() === "") {
      results[index] = text;
      continue;
    }
    const key = to + "\u0000" + from + "\u0000" + text;
    const hit = cache.get(key);
    if (typeof hit === "string") {
      results[index] = hit;
      continue;
    }
    pending.push({ index, key, text });
  }
  if (pending.length === 0) return results;
  const { url, init } = buildBingRequest(to, from, pending.map((entry) => entry.text));
  const payload = await postJson(url, init.body, options.agent);
  const parsed = parseBingTranslations(payload, pending.length);
  const echoes = [];
  for (let slot = 0; slot < pending.length; slot += 1) {
    const translated = parsed[slot];
    const entry = pending[slot];
    if (typeof translated !== "string") {
      echoes.push(slot);
      continue;
    }
    if (isEcho(entry.text, translated) && !CJK_TEST.test(entry.text)) {
      echoes.push(slot);
      continue;
    }
    cache.set(entry.key, translated);
    results[entry.index] = translated;
  }
  // Bing echoed the source of these strings: hand the echo back at once so the
  // browser gets an answer, then ask the secondary engine in the background.
  //
  // The fallback used to be awaited inline, and one stalled MyMemory request held
  // every other string in the batch (the row button sat on "translating…" for
  // the whole 20 s socket budget). Answers arrive on a later request instead.
  for (const slot of echoes) {
    const entry = pending[slot];
    results[entry.index] = typeof parsed[slot] === "string" ? parsed[slot] : entry.text;
  }
  const asked = echoes.slice(0, FALLBACK_MAX_TEXTS);
  if (asked.length > 0) {
    void refineEchoes(
      asked.map((slot) => pending[slot]),
      to,
      options,
      cache,
    );
  }
  return results;
}

/**
 * Ask the secondary engine for the strings Bing only echoed back.
 *
 * Runs detached: the echoed answer is already on its way to the browser, and a
 * later request picks the improved translation out of the shared cache.
 *
 * @param entries - echoed strings.
 * @param to - target language tag.
 * @param options - cache and tunnel agent.
 * @param cache - the batch cache the improved copy is written into.
 */
async function refineEchoes(entries, to, options, cache) {
  // Every refinement request takes a background slot, so the total number of
  // outbound connections stays bounded no matter how many batches are in
  // flight. A slot that is not immediately free means "skip this string" --
  // waiting here would let courtesy work hold sockets without any bound.
  const takeSlot = typeof options.tryRefineSlot === "function" ? options.tryRefineSlot : () => true;
  const freeSlot = typeof options.releaseRefineSlot === "function" ? options.releaseRefineSlot : () => undefined;
  const run = Promise.all(
    entries.map(async (entry) => {
      if (!takeSlot()) return;
      let fallback = null;
      try {
        fallback = await translateFallback(entry.text, to, options.agent);
      } catch {
        fallback = null;
      } finally {
        freeSlot();
      }
      // Only a real translation is worth caching: an echo must be asked again,
      // otherwise every later request would serve the untranslated source.
      if (fallback !== null) cache.set(entry.key, fallback);
    }),
  );
  if (typeof options.track !== "function") {
    await run;
    return;
  }
  // Detached from the request, but not from the plugin: dispose() waits for the
  // short remainder of these so a reloaded plugin cannot keep writing into the
  // cache of an unloaded one.
  const tracked = run.catch(() => undefined);
  options.track(tracked);
  await tracked;
}

/**
 * Run one batch, sharing the work of an identical one already in flight.
 *
 * Two clients asking for the same strings at the same time used to send two
 * identical Bing requests. Now the second one awaits the first one's promise and
 * the cache write still happens exactly once, inside that shared promise.
 *
 * @param admit - async gate that resolves `true` once an outbound slot is held.
 * @param texts - bounded texts of this request.
 * @param options - batch options forwarded to `translateBatch`.
 * @returns translations aligned with `texts`.
 */
async function runShared(admit, texts, options) {
  const to = normalizeLanguage(options.to);
  const rawFrom = typeof options.from === "string" ? options.from.trim() : "auto";
  const from = rawFrom === "" || rawFrom.toLowerCase() === "auto" ? "auto" : normalizeLanguage(rawFrom);
  const key = to + "\u0000" + from + "\u0000" + texts.join("\u0000");
  const shared = options.inFlight.get(key);
  if (shared !== undefined) return shared;
  const run = (async () => {
    // `admit` returns false only after giving its slot back.
    if (!(await admit())) {
      throw Object.assign(new Error("too many translations are in flight, retry shortly"), { code: "busy" });
    }
    try {
      return await translateBatch(texts, options);
    } finally {
      options.release();
    }
  })();
  const tracked = run.then(
    (value) => {
      options.inFlight.delete(key);
      return value;
    },
    (error) => {
      options.inFlight.delete(key);
      throw error;
    },
  );
  // Keep the raw promise in the map so every waiter sees the same rejection.
  options.inFlight.set(key, tracked);
  return tracked;
}

function loopbackRequest(request) {
  const address = request.socket?.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
  const host = request.headers.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try {
    hostUrl = new URL("http://" + host);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  res.end(JSON.stringify(body));
}

/** Marker telling the route that the body was too large, so it may answer 413. */
const BODY_TOO_LARGE = Symbol("body-too-large");

/**
 * Read and decode a JSON request body.
 *
 * An oversized body is still drained (so the caller can answer 413 on the same
 * kept-alive socket instead of leaving unread bytes behind), but a body that
 * keeps streaming far past the cap is cut off rather than absorbed.
 *
 * @param request - incoming request.
 * @returns decoded JSON, `undefined` when unreadable, or `BODY_TOO_LARGE`.
 */
async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  const guard = setTimeout(() => request.destroy(new Error("request body timed out")), READ_BODY_TIMEOUT_MS);
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (tooLarge) {
        if (size > MAX_BODY_DRAIN_BYTES) {
          request.destroy();
          break;
        }
        continue;
      }
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        continue;
      }
      chunks.push(chunk);
    }
  } catch {
    return undefined;
  } finally {
    clearTimeout(guard);
  }
  if (tooLarge) return BODY_TOO_LARGE;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function guard(request, response) {
  if (!loopbackRequest(request)) {
    writeJson(response, 403, { ok: false, code: "not-loopback", message: "loopback requests only" });
    return false;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { ok: false, code: "method", message: "POST only" });
    return false;
  }
  return true;
}

/**
 * Normalise a proxy URL down to the endpoint that actually identifies it.
 *
 * A pasted `/?x=1`, a trailing slash or a `#fragment` must not create a second
 * tunnel to the very same host, so only scheme, host and port survive.
 *
 * @param parsed - an already-parsed http(s) URL.
 * @returns `scheme//host:port`.
 */
function proxyEndpoint(parsed) {
  const port = parsed.port === "" ? (parsed.protocol === "https:" ? "443" : "80") : parsed.port;
  return parsed.protocol + "//" + parsed.hostname + ":" + port;
}

/**
 * The proxy this process is expected to use when the user configured none.
 *
 * DSH may be started with `NODE_USE_ENV_PROXY=1` together with `https_proxy`;
 * in that setup Node's global agent routes through the proxy automatically.
 * A plugin-owned direct agent would bypass it and fail on any network that
 * needs the proxy, so the environment has to be honoured explicitly.
 *
 * @returns normalised endpoint, or "" when no usable proxy is configured.
 */
function envProxy() {
  const names = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
  for (const name of names) {
    const raw = typeof process.env[name] === "string" ? process.env[name].trim() : "";
    if (raw === "") continue;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    if (parsed.hostname === "") continue;
    return proxyEndpoint(parsed);
  }
  return "";
}

/**
 * Resolve the DSH home directory the same way the rest of the harness does.
 * @returns absolute home path.
 */
function resolveHome() {
  const configured = typeof process.env.DSH_HOME === "string" ? process.env.DSH_HOME.trim() : "";
  if (configured !== "") return configured;
  return join(homedir(), ".dsh");
}

export const inject = ["webServer"];

/**
 * Mount the bridge: configuration endpoints plus the Bing translation endpoint.
 * @param ctx - host plugin context.
 * @param config - the profile patch settings for this row.
 */
export function apply(ctx, config) {
  const logger = ctx.logger;
  const patchConfig = normalizeConfig(config);
  const cache = createCache();
  const agents = new Map();
  const configPath = join(resolveHome(), CONFIG_FILE_NAME);
  /** Serialises settings writes: two concurrent ones must not share a temp file. */
  let configWrite = Promise.resolve();
  /** Detached refine tasks, awaited on dispose so they cannot outlive the cache. */
  const background = new Set();
  const track = (promise) => {
    background.add(promise);
    void promise.catch(() => undefined).finally(() => background.delete(promise));
  };
  let current = { ...patchConfig };
  /** In-flight outbound translation work, so identical batches share one request. */
  const inFlight = new Map();
  let inflightSlots = MAX_INFLIGHT_REQUESTS;
  /** Queued waiters, oldest first. Each one settles exactly once. */
  const inflightWaiters = [];
  /**
   * Take an outbound slot, or give up after `waitMs`.
   *
   * The wait itself must be bounded: an unbounded queue would leave the caller
   * waiting for a whole outbound budget (20s) instead of the advertised short
   * `busy` window, which is worse for the browser than a fast refusal.
   *
   * @param waitMs - longest time to queue for a slot.
   * @returns whether a slot is now held.
   */
  const acquire = (waitMs) => {
    if (inflightSlots > 0) {
      inflightSlots -= 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiter = { state: "waiting", timer: null, resolve };
      waiter.timer = setTimeout(() => {
        // Leaving a timed-out waiter in the queue would let a later release()
        // hand it a slot it never takes, stranding the counter forever.
        if (waiter.state !== "waiting") return;
        waiter.state = "timeout";
        waiter.timer = null;
        const at = inflightWaiters.indexOf(waiter);
        if (at !== -1) inflightWaiters.splice(at, 1);
        resolve(false);
      }, waitMs);
      inflightWaiters.push(waiter);
    });
  };
  const release = () => {
    while (inflightWaiters.length > 0) {
      const waiter = inflightWaiters.shift();
      if (waiter.state !== "waiting") continue;
      waiter.state = "granted";
      if (waiter.timer !== null) clearTimeout(waiter.timer);
      waiter.timer = null;
      // The slot moves from the releasing caller to this waiter, so the count
      // stays exactly the same.
      waiter.resolve(true);
      return;
    }
    inflightSlots += 1;
  };
  /**
   * Slots for background refinement.
   *
   * Refinement is a courtesy that improves an already-delivered answer, so it
   * gets its own small budget instead of competing for the request slots: it
   * must never make `/translate` return `busy`. When no slot is free it simply
   * skips the string (the next request will retry it) rather than queueing.
   */
  let refineSlots = REFINE_MAX_INFLIGHT;
  const tryRefineSlot = () => {
    if (refineSlots <= 0) return false;
    refineSlots -= 1;
    return true;
  };
  const releaseRefineSlot = () => {
    refineSlots += 1;
  };
  const loaded = (async () => {
    try {
      const raw = await readFile(configPath, "utf8");
      current = { ...patchConfig, ...normalizeConfig(JSON.parse(raw)) };
    } catch (error) {
      if (error?.code !== "ENOENT") logger.warn("step-title-translate: ignoring unreadable settings file (" + String(error?.message ?? error) + ")");
    }
  })().catch((error) => {
    logger.warn("step-title-translate: settings load failed (" + String(error?.message ?? error) + ")");
  });

  const readConfig = async () => {
    await loaded;
    return { ...current };
  };

  const writeConfig = async (patch) => {
    await loaded;
    // One writer at a time: concurrent saves would otherwise race on the temp
    // file and on `current`, losing a rename and desynchronising memory from disk.
    const run = configWrite.then(async () => {
      const next = normalizeConfig({ ...current, ...patch });
      await mkdir(dirname(configPath), { recursive: true });
      const temporary = configPath + "." + String(process.pid) + ".tmp";
      await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", "utf8");
      await rename(temporary, configPath);
      // Only publish the new settings once they are actually durable, so a
      // failed write cannot leave the process serving values that were never saved.
      current = next;
      return { ...next };
    });
    configWrite = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await run;
    } catch (error) {
      // A leftover temp file from the failed attempt would otherwise linger.
      void rm(configPath + "." + String(process.pid) + ".tmp", { force: true }).catch(() => undefined);
      throw error;
    }
  };

  /**
   * Resolve (and memoise) the agent for one proxy setting.
   *
   * Agents are keyed by the normalised URL, so `http://h:1`, `http://h:1/` and
   * `http://H:1` share one tunnel instead of three. The map is a small LRU:
   * a caller-supplied proxy string may not grow it without bound, and an evicted
   * agent is destroyed so its keep-alive sockets go with it. An empty proxy gets
   * its own direct agent rather than `undefined`, which would fall back to Node's
   * global agent and silently honour `https_proxy` from the environment.
   *
   * @param proxy - proxy URL from the request or the settings, may be empty.
   * @returns `{ agent }`, or `{ code }` when the URL cannot be used.
   */
  const agentFor = (proxy) => {
    let key;
    let endpoint = "";
    // An empty setting means "whatever this host can actually reach". A direct
    // connection is only right when the environment is not itself routing
    // through a proxy: DSH may run with NODE_USE_ENV_PROXY=1 plus https_proxy,
    // and bypassing that silently makes every translation fail (ECONNRESET)
    // for users who never configured anything.
    if (proxy === "") {
      const inherited = envProxy();
      if (inherited === "") {
        key = "direct:";
      } else {
        endpoint = inherited;
        key = "env:" + inherited;
      }
    } else {
      let parsed;
      try {
        parsed = new URL(proxy);
      } catch {
        return { code: "proxy-invalid" };
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { code: "proxy-unsupported" };
      endpoint = proxyEndpoint(parsed);
      key = endpoint;
    }
    const cached = agents.get(key);
    if (cached !== undefined) {
      agents.delete(key);
      agents.set(key, cached);
      return { agent: cached };
    }
    // Direct connections stay plugin-owned (never `undefined`), so they cannot
    // inherit whatever global agent another plugin installs.
    const agent = key === "direct:" ? new HttpsAgent({ keepAlive: true, maxSockets: MAX_INFLIGHT_REQUESTS }) : new TunnelAgent(endpoint);
    agents.set(key, agent);
    while (agents.size > AGENT_LIMIT) {
      const oldest = agents.keys().next();
      if (oldest.done) break;
      const evicted = agents.get(oldest.value);
      agents.delete(oldest.value);
      if (evicted !== undefined) evicted.destroy();
    }
    return { agent };
  };

  ctx.inject(["webServer"], (sctx) => {
    sctx.effect(() => {
      const routes = [
        {
          kind: "exact",
          path: BRIDGE_PREFIX + "/config",
          handler: async (request, response) => {
            if (!guard(request, response)) return;
            writeJson(response, 200, { ok: true, value: await readConfig() });
          },
        },
        {
          kind: "exact",
          path: BRIDGE_PREFIX + "/config/set",
          handler: async (request, response) => {
            if (!guard(request, response)) return;
            const body = await readJsonBody(request);
            if (body === BODY_TOO_LARGE) {
              writeJson(response, 413, { ok: false, code: "body-too-large", message: "settings body exceeds " + String(MAX_BODY_BYTES) + " bytes" });
              return;
            }
            if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
              writeJson(response, 400, { ok: false, code: "settings-rejected", message: "malformed settings body" });
              return;
            }
            try {
              const value = await writeConfig(body);
              writeJson(response, 200, { ok: true, value });
            } catch (error) {
              writeJson(response, 200, { ok: false, code: "settings-write-failed", message: String(error?.message ?? error) });
            }
          },
        },
        {
          kind: "exact",
          path: BRIDGE_PREFIX + "/translate",
          handler: async (request, response) => {
            if (!guard(request, response)) return;
            const body = await readJsonBody(request);
            if (body === BODY_TOO_LARGE) {
              writeJson(response, 413, { ok: false, code: "body-too-large", message: "translation body exceeds " + String(MAX_BODY_BYTES) + " bytes" });
              return;
            }
            if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
              writeJson(response, 400, { ok: false, code: "translate-rejected", message: "malformed translation body" });
              return;
            }
            const bounded = boundTexts(body.texts);
            if (!bounded.ok) {
              writeJson(response, 200, { ok: false, code: bounded.code, message: "this batch cannot be translated: " + bounded.code });
              return;
            }
            const settings = await readConfig();
            const to = normalizeLanguage(typeof body.to === "string" && body.to !== "" ? body.to : settings.targetLanguage);
            const from = typeof body.from === "string" && body.from !== "" ? body.from : "auto";
            const proxy = typeof body.proxy === "string" ? body.proxy.trim() : settings.proxy;
            const tunnel = agentFor(proxy);
            if (tunnel.code !== undefined) {
              writeJson(response, 200, {
                ok: false,
                code: tunnel.code,
                message: tunnel.code === "proxy-invalid" ? `"${proxy}" is not a valid proxy URL` : "only http(s) proxies are supported",
              });
              return;
            }
            const admit = () => acquire(BUSY_WAIT_MS);
            try {
              const translations = await runShared(admit, bounded.texts, {
                to,
                from,
                cache,
                agent: tunnel.agent,
                track,
                inFlight,
                release,
                tryRefineSlot,
                releaseRefineSlot,
              });
              writeJson(response, 200, { ok: true, value: { to, translations } });
            } catch (error) {
              const cause = error?.cause === undefined ? "" : " (" + String(error.cause?.code ?? error.cause?.message ?? error.cause) + ")";
              const message = String(error?.message ?? error) + cause;
              logger.warn("step-title-translate: translation failed: " + message);
              writeJson(response, 200, {
                ok: false,
                code: typeof error?.code === "string" ? error.code : "translation-failed",
                message,
              });
            }
          },
        },
        {
          kind: "exact",
          path: BRIDGE_PREFIX + "/health",
          handler: async (request, response) => {
            if (!guard(request, response)) return;
            const settings = await readConfig();
            writeJson(response, 200, { ok: true, value: { settings, cache: cache.size } });
          },
        },
      ];
      const disposers = routes.map((route) => sctx.webServer.register(route));
      return () => {
        for (const dispose of disposers) dispose();
        for (const agent of agents.values()) agent.destroy();
        agents.clear();
        // Neither the cache nor the detached refine tasks may outlive the plugin.
        cache.clear();
        for (const pending of background) void pending.catch(() => undefined);
        background.clear();
      };
    }, "step-title-translate: bridge routes");
  });
}