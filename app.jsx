const { useEffect, useMemo, useRef, useState } = React;

/* =========================
   Types / Data Shape (doc)
   Card: {
     id, ref, text, pack,
     srs: {
       slow: { bucket, nextDue, updatedAt, ease, reps, lapses, intervalDays, leech },
       fast: { bucket, nextDue, updatedAt, ease, reps, lapses, intervalDays, leech }
     },
     order, createdAt, updatedAt
   }
========================= */

// ----- Utilities -----
const LS_KEY = "scripture_srs_v1";
const now = () => Date.now();
const day = 24 * 60 * 60 * 1000;

// --- Fixed buckets for display only (scheduling is fixed by button) ---
const BUCKETS = ["0D", "1D", "3D", "7D", "30D", "90D"];
function bucketFromDays(d) {
  if (d <= 0) return "0D";
  if (d <= 1) return "1D";
  if (d <= 3) return "3D";
  if (d <= 7) return "7D";
  if (d <= 30) return "30D";
  if (d <= 90) return "90D";
  return "90D";
}

// For migration bookkeeping
const SCHEMA_VERSION = 1;

// Both schedules start at 0D and are due now
function makeInitialSrs() {
  const t = now();
  const sub = {
    bucket: "0D",
    nextDue: 0,
    updatedAt: t,
    // legacy fields kept for backward-compat; not used by fixed scheduling
    ease: 2.5,
    reps: 0,
    lapses: 0,
    intervalDays: 0,
    leech: false,
  };
  return { slow: { ...sub }, fast: { ...sub } };
}

function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/* ============================================================
   NEW: robust line parser (supports Hangul + verse lists)
   (unchanged from your latest working version)
============================================================ */
function parseLineToCard(line, fileName) {
  const clean = line.trim();
  if (!clean) return null;

  const refMatch = clean.match(
    /^(?<ref>(?:[1-3]\s*)?(?:[A-Za-zÀ-ÖØ-öø-ÿ\u3131-\u318E\uAC00-\uD7A3\u00B7'`´^.\-]+(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ\u3131-\u318E\uAC00-\uD7A3\u00B7'`´^.\-]+)*)\s*\d{1,3}:\d{1,3}(?:[-,]\d{1,3})?)/
  );

  let ref, text;
  if (refMatch?.groups?.ref) {
    ref = refMatch.groups.ref.trim();
    const rest = clean.slice(refMatch[0].length);
    text = rest.replace(/^\s*[:\-–]?\s*/, "");
  } else {
    const m = clean.match(/^(.*?\d{1,3}:\d{1,3}(?:[-,]\d{1,3})?)(?:\s+|$)/);
    if (m) {
      ref = m[1].trim();
      text = clean.slice(m[0].length).trim();
    } else {
      ref = fileName.replace(/\.[^.]+$/, "");
      text = clean;
    }
  }

  const id = hashString(`${fileName}|${ref}|${text}`);
  return {
    id,
    ref,
    text,
    pack: fileName,
    srs: makeInitialSrs(),
    order: undefined,
    createdAt: now(),
    updatedAt: now(),
  };
}

function saveState(state) {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
}
function loadState() {
  const raw = localStorage.getItem(LS_KEY);
  if (!raw) return { cards: [], settings: defaultSettings(), capLog: {} };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.settings) parsed.settings = defaultSettings();
    if (!parsed.capLog) parsed.capLog = {};
    return parsed;
  } catch {
    return { cards: [], settings: defaultSettings(), capLog: {} };
  }
}

// --- Migration & ordering ---

// Ensure srs.slow / srs.fast exist on a card
function migrateCardSRS(card) {
  if (card?.srs?.slow || card?.srs?.fast) {
    const normalize = (sub) => ({
      bucket: sub?.bucket || "0D",
      nextDue: Number.isFinite(sub?.nextDue) ? sub.nextDue : 0,
      updatedAt: sub?.updatedAt || card.updatedAt || now(),
      ease: Number.isFinite(sub?.ease) ? sub.ease : 2.5,
      reps: Number.isFinite(sub?.reps) ? sub.reps : 0,
      lapses: Number.isFinite(sub?.lapses) ? sub.lapses : 0,
      intervalDays: Number.isFinite(sub?.intervalDays) ? sub.intervalDays : 0,
      leech: !!sub?.leech,
    });
    return {
      ...card,
      srs: {
        slow: normalize(card.srs.slow),
        fast: normalize(card.srs.fast),
      },
    };
  }
  return { ...card, srs: makeInitialSrs() };
}

// Assign 1-based `order` per pack; preserve existing order if present, else use createdAt then id
function assignOrdersByPack(cards) {
  const byPack = new Map();
  for (const c of cards) {
    const key = c.pack || "(unknown)";
    if (!byPack.has(key)) byPack.set(key, []);
    byPack.get(key).push(c);
  }

  const orderMap = new Map();
  for (const [, arr] of byPack.entries()) {
    const sorted = arr
      .slice()
      .sort((a, b) => {
        const ao = a.order ?? Number.POSITIVE_INFINITY;
        const bo = b.order ?? Number.POSITIVE_INFINITY;
        if (ao !== bo) return ao - bo;
        const ac = a.createdAt ?? 0;
        const bc = b.createdAt ?? 0;
        if (ac !== bc) return ac - bc;
        return String(a.id).localeCompare(String(b.id));
      });
    sorted.forEach((c, idx) => orderMap.set(c.id, idx + 1));
  }

  return cards.map((c) => {
    const newOrder = orderMap.get(c.id);
    return newOrder && newOrder !== c.order ? { ...c, order: newOrder } : c;
  });
}

// Full migration for a list of cards
function migrateAllCards(cards) {
  const srsReady = cards.map(migrateCardSRS);
  const ordered = assignOrdersByPack(srsReady);
  return ordered;
}

// --- NEW: default Writing comparison options (persisted locally only) ---
function defaultWritingOptions() {
  return {
    nfc: true,                 // 1) Unicode normalize to NFC (on)
    trim: true,                // 2) Trim edges (on)
    collapseWS: false,         // 3) Collapse internal whitespace (off)
    ignorePunct: false,        // 4) Ignore punctuation (off)
    caseInsensitive: false,    // 5) Case-insensitive (off)
    normalizeQuoteHyphen: true,// 6) Normalize quotes/hyphens (on)
    stripZeroWidth: true,      // 7) Strip ZW + NBSP (on)
  };
}

// Bump settings schema version or fill defaults
function upgradeSettings(settings) {
  const s = { ...defaultSettings(), ...(settings || {}) };
  if (!s.schemaVersion || s.schemaVersion < SCHEMA_VERSION) {
    s.schemaVersion = SCHEMA_VERSION;
  }
  if (s.mode === "full") s.mode = "review";
  // ensure writing options exist
  if (!s.writing) s.writing = defaultWritingOptions();
  return s;
}

// --- Fixed scheduler helpers: map labels to exact day intervals ---
const LABEL_TO_DAYS = {
  Again: 0, // due now
  "1D": 1,
  "3D": 3,
  "7D": 7,
  "30D": 30,
  "90D": 90,
};

// Optional small jitter so due lists aren't perfectly synchronized
function applyFixedSchedule(sub, days, jitterPct = 0.1) {
  const nowTs = now();
  let interval = Math.max(0, Math.round(days));
  if (interval > 0 && jitterPct > 0) {
    const j = 1 + (Math.random() * 2 * jitterPct - jitterPct);
    interval = Math.max(1, Math.round(interval * j));
  }
  const nextDue = nowTs + interval * day;
  return {
    ...sub,
    bucket: bucketFromDays(interval),
    nextDue,
    updatedAt: nowTs,
    intervalDays: interval, // for reference in stats
  };
}

// Apply chosen fixed label to the correct schedule (fast for recognition; slow otherwise)
function applyLabel(card, label, mode, jitterPct = 0.1) {
  const key = mode === "recognition" ? "fast" : "slow";
  const days = LABEL_TO_DAYS[label] ?? 0;
  const updatedSub = applyFixedSchedule(card.srs[key], days, jitterPct);
  return { ...card, srs: { ...card.srs, [key]: updatedSub }, updatedAt: now() };
}

// --- Misc helpers ---
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function getActiveBucket(card, mode) {
  const key = mode === "recognition" ? "fast" : "slow";
  return card?.srs?.[key]?.bucket || "0D";
}
function daysSince(ts) { if (!ts) return null; return Math.floor((now() - ts) / day); }
function daysTill(ts) { if (!ts) return null; const d = Math.ceil((ts - now()) / day); return Math.max(0, d); }
function previewText(text, words = 6) {
  const parts = String(text || "").split(/\s+/);
  return parts.slice(0, words).join(" ") + (parts.length > words ? " …" : "");
}
function todayKey() { return new Date().toISOString().slice(0, 10); }
function isoDay(dateLike) {
  const d = new Date(dateLike);
  const z = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  return z.toISOString().slice(0, 10);
}
function startOfWeekISO(dt) {
  const d = new Date(dt);
  const w = (d.getDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - w);
  d.setUTCHours(0,0,0,0);
  return d.toISOString().slice(0,10);
}
function weekKey(dt) { return startOfWeekISO(dt); }
function monthKey(dt) { const d=new Date(dt); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`; }
function yearKey(dt) { return String(new Date(dt).getUTCFullYear()); }

// --- Phase 5: keyboard shortcuts ---
const SHORTCUT_MAP = { a: "Again", "1": "1D", "3": "3D", "7": "7D", "0": "30D", "9": "90D" };

// --- NEW: tiny util to shuffle (Writing mode randomization) ---
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ======================================================================
   NEW: Smart comparison utilities for Writing mode
   - normalizeForCompare(text, opts)
   - diffCharsLCS(typedRaw, targetRaw, opts) -> [{text, ok}] runs
   Notes:
     * Works at grapheme level so Hangul clusters behave well.
     * Ignored chars (punctuation/trimmed/collapsed extras) render neutral.
====================================================================== */

// Grapheme splitter with fallback
function graphemesWithRanges(str) {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const out = [];
    for (const s of seg.segment(str)) out.push({ start: s.index, end: s.index + s.segment.length, str: s.segment });
    return out;
  }
  // Fallback: code-point step
  const out = [];
  for (let i = 0; i < str.length;) {
    const cp = str.codePointAt(i);
    const len = cp > 0xFFFF ? 2 : 1;
    out.push({ start: i, end: i + len, str: str.slice(i, i + len) });
    i += len;
  }
  return out;
}

// helpers
const ZW_RE = /[\u200B\u200C\u200D\uFEFF]/g; // ZWSP, ZWNJ, ZWJ, BOM
const NBSP = "\u00A0";
const WS_RE = /\s/;
const PUNCT_RE = /[\p{P}\p{S}]/u; // Unicode punctuation & symbols
function isWhitespaceCluster(s) { return WS_RE.test(s) || s === NBSP; }
function isPunctCluster(s) { return PUNCT_RE.test(s); }
function mapQuotesHyphens(s) {
  return s
    // quotes
    .replace(/[\u2018\u2019\u201B\u2032]/g,"'")
    .replace(/[\u201C\u201D\u2033]/g,'"')
    // hyphens/dashes
    .replace(/[\u2012\u2013\u2014\u2015\u2212]/g,"-")
    // ellipsis
    .replace(/\u2026/g,"...");
}

function normalizeForCompare(text, opts = defaultWritingOptions()) {
  const clusters = graphemesWithRanges(text);
  const pre = [];

  // 1) cluster-level normalization (without trim yet)
  let prevKeptWasWS = false;
  for (const c of clusters) {
    let raw = c.str;
    // (7) strip zero-width + NBSP (NBSP removal is optional per spec; they asked to strip NBSP)
    if (opts.stripZeroWidth) raw = raw.replace(ZW_RE, "").replace(new RegExp(NBSP, "g"), " ");
    if (!raw) { // fully stripped → ignore
      pre.push({ ...c, keep:false, isWS:false, key:"" });
      continue;
    }
    // (6) normalize quote/hyphen variants
    if (opts.normalizeQuoteHyphen) raw = mapQuotesHyphens(raw);
    // (5) case-insensitive for Latin: use toLowerCase; harmless for Hangul
    if (opts.caseInsensitive) raw = raw.toLocaleLowerCase();
    // unicode NFC
    if (opts.nfc && raw.normalize) raw = raw.normalize("NFC");

    const wasWS = isWhitespaceCluster(raw);
    // (4) ignore punctuation (entire cluster is punct/symbol)
    if (opts.ignorePunct && !wasWS && isPunctCluster(raw)) {
      pre.push({ ...c, keep:false, isWS:false, key:"" });
      continue;
    }

    let key = raw;
    // (3) collapse internal whitespace runs to a single space
    if (opts.collapseWS && wasWS) {
      if (prevKeptWasWS) { // drop extra ws clusters
        pre.push({ ...c, keep:false, isWS:true, key:"" });
        continue;
      }
      key = " ";
    }
    pre.push({ ...c, keep:true, isWS:wasWS, key });
    prevKeptWasWS = pre[pre.length-1].keep && wasWS ? true : (!wasWS && false);
  }

  // 2) (2) trim leading/trailing whitespace clusters
  let first = 0, last = pre.length - 1;
  if (opts.trim) {
    while (first <= last && pre[first].keep && pre[first].isWS) { pre[first].keep = false; first++; }
    while (last >= first && pre[last].keep && pre[last].isWS) { pre[last].keep = false; last--; }
  }

  // 3) build kept units + raw→unit mapping
  const units = [];
  const rawToUnit = new Array(text.length).fill(-1);
  for (const p of pre) {
    if (!p.keep) continue;
    const idx = units.length;
    units.push({ rawStart: p.start, rawEnd: p.end, key: p.key });
    for (let i = p.start; i < p.end; i++) rawToUnit[i] = idx;
  }

  const keys = units.map(u => u.key);
  return { keys, units, rawToUnit, rawLength: text.length };
}

// classic LCS to mark which typed keys are matched
function lcsMatchMask(aKeys, bKeys) {
  const m = aKeys.length, n = bKeys.length;
  const dp = Array.from({length:m+1}, () => new Array(n+1).fill(0));
  for (let i=1;i<=m;i++){
    for (let j=1;j<=n;j++){
      if (aKeys[i-1] === bKeys[j-1]) dp[i][j] = dp[i-1][j-1] + 1;
      else dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
    }
  }
  const mask = new Array(m).fill(false);
  let i=m, j=n;
  while (i>0 && j>0){
    if (aKeys[i-1] === bKeys[j-1]) { mask[i-1] = true; i--; j--; }
    else if (dp[i-1][j] >= dp[i][j-1]) i--;
    else j--;
  }
  return mask;
}

// Main diff that returns runs over TYPED RAW string only
// Main diff that returns runs over TYPED RAW string only
function diffCharsLCS(typedRaw, targetRaw, opts = defaultWritingOptions()) {
  const T = normalizeForCompare(typedRaw, opts);
  const G = normalizeForCompare(targetRaw, opts);

  // Exact after normalization?
  let exact = false;
  if (T.keys.length === G.keys.length) {
    exact = true;
    for (let k = 0; k < T.keys.length; k++) if (T.keys[k] !== G.keys[k]) { exact = false; break; }
  }

  // LCS mask for the typed units (for per-char highlights)
  const mask = lcsMatchMask(T.keys, G.keys);
  const runs = [];
  let pos = 0;
  for (let u = 0; u < T.units.length; u++) {
    const unit = T.units[u];
    if (pos < unit.rawStart) runs.push({ text: typedRaw.slice(pos, unit.rawStart), ok: null });
    runs.push({ text: typedRaw.slice(unit.rawStart, unit.rawEnd), ok: !!mask[u] });
    pos = unit.rawEnd;
  }
  if (pos < T.rawLength) runs.push({ text: typedRaw.slice(pos), ok: null });

  // --- NEW: contiguous alignment of the T-prefix somewhere inside G (to find missed head/tail) ---
  let startIdx = null;                    // index in G.keys where user's first kept unit aligns
  let matchedLen = 0;                     // how many units match contiguously from that start
  if (T.keys.length > 0) {
    for (let s = 0; s < G.keys.length; s++) {
      if (T.keys[0] !== G.keys[s]) continue;
      let m = 0;
      while (m < T.keys.length && s + m < G.keys.length && T.keys[m] === G.keys[s + m]) m++;
      if (m > matchedLen) { startIdx = s; matchedLen = m; }
      if (m === T.keys.length) break; // perfect contiguous alignment for the whole typed input
    }
  }

  // Compute raw indices for head/mid/tail
  let missingHeadRaw = "", missingHeadEndRawIndex = null;
  let missingTailRaw = "", missingTailStartRawIndex = null;

  // Tail by "how much of T was typed" (used in Typing panel append)
  if (startIdx !== null) {
    const tailUnitIdxByTyped = startIdx + T.keys.length;
    if (tailUnitIdxByTyped < G.units.length) {
      missingTailStartRawIndex = G.units[tailUnitIdxByTyped].rawStart;
      missingTailRaw = targetRaw.slice(missingTailStartRawIndex);
    }
  }

  // Head (if user started later than the verse start)
  if (startIdx !== null && startIdx > 0) {
    missingHeadEndRawIndex = G.units[startIdx].rawStart;
    missingHeadRaw = targetRaw.slice(0, missingHeadEndRawIndex);
  }

  // Also expose mid slice for the Actual panel (based on "how much matched contiguously")
  let midStartRawIndex = null, midEndRawIndex = null;
  if (startIdx !== null) {
    midStartRawIndex = G.units[startIdx].rawStart;
    midEndRawIndex =
      matchedLen > 0
        ? G.units[startIdx + matchedLen - 1].rawEnd
        : midStartRawIndex;
  }

  return {
    runs,
    exact,
    // head
    missingHeadRaw,
    missingHeadEndRawIndex,   // end of head (start of aligned middle)
    // tail (by "typed length" for user's-typing append)
    missingTailRaw,
    missingTailStartRawIndex,
    // mid slice for Actual panel
    midStartRawIndex,
    midEndRawIndex,
  };
}

/* =========================
   Settings defaults
========================= */
function defaultSettings() {
  return {
    sessionTarget: 50,
    mode: "recognition",            // "recognition" | "review" | "writing"
    showFirstNWords: 6,
    shuffle: false,
    dailyCapSlow: 60,
    dailyCapFast: 200,
    jitterPct: 0.1,
    schemaVersion: SCHEMA_VERSION,
    // NEW: writing comparison options (local only)
    writing: defaultWritingOptions(),
  };
}

/* =========================
   App
========================= */
function App() {
  const [cards, setCards] = useState([]);
  const [settings, setSettings] = useState(defaultSettings());
  const [history, setHistory] = useState([]);
  const [sessionStart, setSessionStart] = useState(0);
  const [completed, setCompleted] = useState(0);
  const [filterPack, setFilterPack] = useState("ALL");
  const [sessionQueue, setSessionQueue] = useState([]); // frozen queue (ids)
  const [viewScheduleKey, setViewScheduleKey] = useState("slow");
  const [versesPack, setVersesPack] = useState("ALL");
  const [capLog, setCapLog] = useState({});
  const [daily, setDaily] = useState({ key: todayKey(), slow: 0, fast: 0 });
  // Needed by header & Advanced modal
  const [packManagerOpen, setPackManagerOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const fileInputRef = useRef(null);

  // NEW: writing state: whether current card has been submitted
  const [writingSubmitted, setWritingSubmitted] = useState(false);

  // Sync status
  const [sync, setSync] = useState(() => (window.srsSync ?? { pushing:false, pulling:false, lastPullAt:null, lastPushAt:null }));
  useEffect(() => {
    const onSync = () => setSync({ ...(window.srsSync ?? {}) });
    window.addEventListener('srs-sync', onSync);
    onSync();
    return () => window.removeEventListener('srs-sync', onSync);
  }, []);

  useEffect(() => {
    const bump = () => setSync((s) => ({ ...s }));
    window.addEventListener('online', bump);
    window.addEventListener('offline', bump);
    return () => { window.removeEventListener('online', bump); window.removeEventListener('offline', bump); };
  }, []);

  function fmtTime(ts) { if (!ts) return '—'; try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return '—'; } }

  // Load & persist
  useEffect(() => {
    const s = loadState();
    const migratedCards = migrateAllCards(Array.isArray(s.cards) ? s.cards : []);
    const upgradedSettings = upgradeSettings(s.settings);
    const loadedHistory = Array.isArray(s.history) ? s.history : [];
    const loadedDaily = s.daily && s.daily.key === todayKey() ? s.daily : { key: todayKey(), slow: 0, fast: 0 };

    setCards(migratedCards);
    setSettings(upgradedSettings);
    setHistory(loadedHistory);
    setDaily(loadedDaily);
    setCapLog(s.capLog || {});
  }, []);
  useEffect(() => { saveState({ cards, settings, history, daily, capLog }); }, [cards, settings, history, daily, capLog]);

  // Apply pulled
  useEffect(() => {
    function applyPulled() {
      try {
        const s = loadState();
        if (Array.isArray(s.cards)) setCards(s.cards);
        if (s.settings) setSettings(prev => ({ ...s.settings, mode: prev.mode })); // keep current mode
        if (Array.isArray(s.history)) setHistory(s.history);
        if (s.daily) setDaily(s.daily);
        if (s.capLog) setCapLog(s.capLog);
      } catch (e) { console.warn('Failed to apply pulled state', e); }
    }
    const onPulled = () => applyPulled();
    const onStorage = (e) => { if (e.key === LS_KEY) applyPulled(); };
    window.addEventListener('srs:pulled', onPulled);
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && window.pullSRS) window.pullSRS(); });
    return () => {
      window.removeEventListener('srs:pulled', onPulled);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  // Keep daily caps snapshot
  useEffect(() => {
    const key = todayKey();
    setCapLog(prev => {
      const existing = prev[key] || {};
      const next = { ...prev, [key]: { slow: settings.dailyCapSlow, fast: settings.dailyCapFast } };
      if (existing.slow === next[key].slow && existing.fast === next[key].fast) return prev;
      window.markDirty?.('capLog');
      return next;
    });
  }, [settings.dailyCapSlow, settings.dailyCapFast, daily.key]);


  const packs = useMemo(() => ["ALL", ...Array.from(new Set(cards.map((c) => c.pack))).sort()], [cards]);

  // History counts for header (MUST be above dueCards)
  const dailyReviewed = useMemo(() => {
    const tk = todayKey(); let slow = 0, fast = 0;
    for (const h of history) {
      if (isoDay(h.ts || Date.now()) === tk) { if (h.mode === "slow") slow++; else fast++; }
    }
    return { slow, fast };
  }, [history]);

  const todayCaps = useMemo(() => {
    const tk = todayKey();
    const entries = Object.entries(capLog)
      .map(([k, v]) => [k, { slow: Number(v?.slow || 0), fast: Number(v?.fast || 0) }])
      .sort((a, b) => a[0].localeCompare(b[0]));
    let res = { slow: 0, fast: 0 };
    for (const [k, v] of entries) { if (k <= tk) res = v; else break; }
    return res;
  }, [capLog]);

  // Due list (used by recognition/review)
  const dueCards = useMemo(() => {
    const t = now();
    const key = settings.mode === "recognition" ? "fast" : "slow";
    let list = cards.filter((c) => (c?.srs?.[key]?.nextDue ?? 0) <= t);
    if (filterPack !== "ALL") list = list.filter((c) => c.pack === filterPack);
    list.sort((a, b) => {
      if (filterPack === "ALL" && a.pack !== b.pack) return String(a.pack).localeCompare(String(b.pack));
      const ao = a.order ?? Number.POSITIVE_INFINITY, bo = b.order ?? Number.POSITIVE_INFINITY;
      if (ao !== bo) return ao - bo;
      const ar = String(a.ref || ""), br = String(b.ref || "");
      if (ar !== br) return ar.localeCompare(br);
      return String(a.id).localeCompare(String(b.id));
    });
    const remain = Math.max(0, dailyRemaining(settings.mode));
    return list.slice(0, remain);
  }, [cards, filterPack, settings.mode, daily, dailyReviewed, todayCaps]); // (deps ok if you like)


  // Current card source:
  // - Writing: always from sessionQueue
  // - Others: from sessionQueue if present else dueCards[0]
  const currentCard = useMemo(() => {
    if (sessionQueue.length > 0) {
      const id = sessionQueue[0];
      return cards.find((c) => c.id === id) || null;
    }
    if (settings.mode === "writing") return null; // require Start Session / or manual write selection
    return dueCards[0];
  }, [sessionQueue, cards, dueCards, settings.mode]);

  // Keyboard shortcuts (DISABLE in writing mode) — moved below currentCard
  useEffect(() => {
    function onKey(e) {
      const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
      if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;
      if (settings.mode === "writing") return;
      const lbl = SHORTCUT_MAP[e.key.toLowerCase?.() || e.key];
      if (!lbl) return;
      if (!currentCard) return;
      e.preventDefault();
      handleGrade(lbl);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentCard, settings.mode]);

  // Reset "submitted" when card/mode changes
  useEffect(() => { setWritingSubmitted(false); }, [settings.mode, currentCard?.id]);

  function dailyRemaining(mode) {
    const goal = mode === "recognition" ? todayCaps.fast : todayCaps.slow;
    const done = mode === "recognition" ? dailyReviewed.fast : dailyReviewed.slow;
    return Math.max(0, goal - done);
  }

  // Start session
  async function startSession() {
    try { if (typeof window.pullSRS === 'function') await window.pullSRS(); } catch {}
    setSessionStart(now());
    setCompleted(0);

    if (settings.mode === "writing") {
      // Random pool = all (pack-filtered), ignoring due
      let pool = filterPack === "ALL" ? cards.slice() : cards.filter(c => c.pack === filterPack);
      pool = shuffleInPlace(pool);
      setSessionQueue(pool.map(c => c.id));
      setWritingSubmitted(false);
      return;
    }
    // unchanged: freeze due list for other modes
    setSessionQueue(dueCards.map(c => c.id));
  }

  function popQueueIfHeadIs(id) {
    setSessionQueue((q) => (q.length && q[0] === id ? q.slice(1) : q));
  }

  // NEW: Skip (no history/srs changes)
  function handleSkip() {
    if (!currentCard) return;
    popQueueIfHeadIs(currentCard.id);
    setWritingSubmitted(false);
  }

  function handleGrade(label) {
    if (!currentCard) return;

    // scheduleKey for SRS write: slow for writing/review, fast for recognition
    const scheduleKey = settings.mode === "recognition" ? "fast" : "slow";
    const fromBucket = currentCard?.srs?.[scheduleKey]?.bucket || "0D";

    // Reset daily if new day
    setDaily((prev) => prev.key === todayKey() ? prev : { key: todayKey(), slow: 0, fast: 0 });

    const updated = applyLabel(currentCard, label, settings.mode, settings.jitterPct ?? 0.1);

    setCards((prev) => prev.map((c) => (c.id === currentCard.id ? updated : c)));
    setCompleted((x) => x + 1);

    setDaily((prev) => {
      const key = todayKey(); const base = prev.key === key ? prev : { key, slow: 0, fast: 0 };
      if (scheduleKey === "fast") return { ...base, fast: base.fast + 1 };
      return { ...base, slow: base.slow + 1 };
    });

    const toBucket = updated.srs?.[scheduleKey]?.bucket || fromBucket;
    setHistory((prev) => [
      ...prev,
      { id: crypto.randomUUID(), cardId: updated.id, pack: updated.pack, ref: updated.ref,
        mode: scheduleKey, fromBucket, toBucket, ts: now() }
    ]);
    window.markDirty?.('cards', 'history');

    popQueueIfHeadIs(currentCard.id);
    if (settings.mode === "writing") setWritingSubmitted(false);
  }

  async function importTxtFiles(files) {
    const imported = [];
    for (const f of files) {
      const text = await f.text();
      const lines = text.split(/\r?\n/);
      let seq = 0; const base = Date.now();
      for (const line of lines) {
        const card = parseLineToCard(line, f.name);
        if (!card) continue;
        seq += 1; const t = base + seq;
        card.createdAt = t; card.updatedAt = t;
        imported.push(migrateCardSRS(card));
      }
    }
    const all = [...cards];
    const existing = new Set(all.map((c) => c.id));
    const fresh = imported.filter((c) => !existing.has(c.id));
    const merged = [...all, ...fresh];
    const withOrder = assignOrdersByPack(merged);
    setCards(withOrder);
    window.markDirty?.('cards');
    alert(`Imported ${fresh.length} new cards from ${files.length} file(s).`);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify({ cards, settings }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `scripture_srs_backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (Array.isArray(data.cards)) setCards(data.cards);
        if (data.settings) setSettings({ ...defaultSettings(), ...data.settings });
        alert("Backup imported.");
      } catch { alert("Invalid JSON."); }
    };
    reader.readAsText(file);
  }

  function editCurrentCard(newRef, newText) {
    if (!currentCard) return;
    const newId = hashString(`${currentCard.pack}|${newRef}|${newText}`);
    const updated = { ...currentCard, ref: newRef, text: newText, id: newId, updatedAt: now() };
    setCards((prev) => prev.map((c) => (c.id === currentCard.id ? updated : c)));
    window.markDirty?.('cards');
  }

  const sessionElapsedMin = sessionStart ? Math.round((now() - sessionStart) / 6000) / 10 : 0;

  // Helpers for UI conditions
  const showGradeButtons = !(settings.mode === "writing" && !writingSubmitted);

  return (
    <div className="min-h-screen bg-gray-50 p-4 pb-28 sm:pb-4">
      <div className="max-w-3xl mx-auto space-y-4">
        <header className="flex flex-wrap items-center gap-2 sm:justify-between">
          <h1 className="text-2xl font-bold">Scripture SRS</h1>
          <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
            <button className="px-3 py-2 rounded-xl bg-gray-200 shrink-0" onClick={() => setPackManagerOpen(true)}>Manage Packs</button>
            <div className="text-sm text-gray-600 min-w-0">
              Due: {dueCards.length} | Done: {completed} | {sessionElapsedMin}m
            </div>
            {/* Sync chip (unchanged) */}
            {(() => {
              const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
              const isSyncing = sync.pushing || sync.pulling;
              const label = isOffline ? "Offline" : (isSyncing ? "Syncing…" : "Synced");
              const color =
                isOffline ? "bg-rose-100 text-rose-800"
                : isSyncing ? "bg-amber-100 text-amber-800"
                : "bg-emerald-50 text-emerald-700";
              return (
                <button
                  onClick={() => setSyncOpen(true)}
                  className={`relative text-xs px-2 py-1 rounded-full ${color} shrink-0 cursor-pointer whitespace-nowrap`}
                  title={`Status • Last pull: ${fmtTime(sync.lastPullAt)} • Last push: ${fmtTime(sync.lastPushAt)}`}
                >
                  <span className="invisible block">Syncing…</span>
                  <span className="absolute inset-0 flex items-center justify-center">{label}</span>
                </button>
              );
            })()}
          </div>
        </header>

        {/* Daily goal status bar */}
        <div className="text-xs text-gray-500">
          Daily {settings.mode === "recognition" ? "FAST" : "SLOW"} goal:{" "}
          {settings.mode === "recognition" ? todayCaps.fast : todayCaps.slow}
          {" · "}done:{" "}
          {settings.mode === "recognition" ? dailyReviewed.fast : dailyReviewed.slow}
          {" · "}left: {dailyRemaining(settings.mode)}
        </div>

        {/* Settings */}
        <section className="rounded-2xl shadow p-4 bg-white grid gap-3 sm:grid-cols-4 items-end">
          <div>
            <label className="block text-sm font-medium">Mode</label>
            <select
              className="mt-1 w-full border rounded-xl p-2"
              value={settings.mode}
              onChange={(e) => setSettings({ ...settings, mode: e.target.value })}
            >
              <option value="recognition">Recognition (fast)</option>
              <option value="review">Review (narrow, revealed)</option>
              {/* NEW: Writing mode option */}
              <option value="writing">Writing (slow)</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium">Filter Pack</label>
            <select className="mt-1 w-full border rounded-xl p-2" value={filterPack} onChange={(e) => setFilterPack(e.target.value)}>
              {packs.map((p) => (<option key={p} value={p}>{p}</option>))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium">Daily goals</label>
            <div className="mt-2">
              <label className="block text-sm font-medium">Daily goal – Slow</label>
              <input className="mt-1 w-full border rounded-xl p-2" type="number" min={0}
                value={settings.dailyCapSlow}
                onChange={(e) => { setSettings({ ...settings, dailyCapSlow: Math.max(0, Number(e.target.value || 0)) }); window.markDirty?.('settings'); }} />
            </div>
            <div className="mt-3">
              <label className="block text-sm font-medium">Daily goal – Fast</label>
              <input className="mt-1 w-full border rounded-xl p-2" type="number" min={0}
                value={settings.dailyCapFast}
                onChange={(e) => { setSettings({ ...settings, dailyCapFast: Math.max(0, Number(e.target.value || 0)) }); window.markDirty?.('settings'); }} />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium">Advanced</label>
            <button className="mt-1 w-full px-3 py-2 rounded-xl bg-gray-200" onClick={() => setSyncOpen(true)}>Advanced...</button>
          </div>
        </section>

        {/* Session Controls */}
        <section className="rounded-2xl shadow p-4 bg-white flex items-center justify-between gap-2">
          <div className="text-sm text-gray-600">
            {settings.mode === "writing" ? "Writing session uses random order over the pack." : "Cards due now: "}{settings.mode === "writing" ? "" : dueCards.length}
          </div>
          <div className="flex gap-2">
            <button className="px-4 py-2 rounded-xl bg-indigo-600 text-white" onClick={startSession}>Start Session</button>
          </div>
        </section>

        {/* Review / Writing Card */}
        <section className="rounded-2xl shadow p-6 bg-white">
          {/* Manual queue banner */}
          {sessionQueue.length > 0 && (
            <div className="rounded-xl border p-3 mb-4 bg-amber-50 text-amber-900 flex items-center justify-between">
              <span>
                Manual review queue active: {sessionQueue.length} verse{sessionQueue.length > 1 ? "s" : ""} remaining.
              </span>
              <button className="ml-4 text-xs px-2 py-1 rounded bg-amber-200 hover:bg-amber-300" onClick={() => setSessionQueue([])}>
                Cancel
              </button>
            </div>
          )}

          {!currentCard ? (
            <div className="text-center text-gray-500">
              {settings.mode === "writing" ? "Start a writing session (randomized) or choose verses from 'View Verses' → 'Write selected now'." : "No cards due. Great job!"}
            </div>
          ) : (
            <div className="space-y-4">
              {/* Header strip differs for Writing */}
              {settings.mode !== "writing" ? (
                <div className="text-xs text-gray-500">
                  Pack: {currentCard.pack}
                  {" · "}
                  {currentCard?.order ? `${ordinal(currentCard.order)} Verse · ` : ""}
                  {getActiveBucket(currentCard, settings.mode)}
                </div>
              ) : (
                <div className="flex items-center justify-between text-xs text-gray-600">
                  <div className="truncate">
                    <span className="font-medium text-gray-700">{currentCard.ref}</span>{" · "}
                    <span className="truncate">{currentCard.pack}</span>{" · "}
                    <span>{getActiveBucket(currentCard, "review")}</span>
                  </div>
                  <HintToggle text={currentCard.text} words={settings.showFirstNWords} />
                </div>
              )}

              {/* Title / prompt area */}
              <div className="text-lg font-semibold">
                {settings.mode === "recognition" ? (
                  <CardFrontRecognition card={currentCard} words={settings.showFirstNWords} />
                ) : settings.mode === "review" ? (
                  <div><div className="text-gray-700 text-sm">{currentCard.ref}</div></div>
                ) : (
                  <div className="text-gray-700 text-sm">{currentCard.ref}</div>
                )}
              </div>

              {/* Keyboard shortcuts note (hide for writing) */}
              {settings.mode !== "writing" && (
                <div className="text-[11px] text-gray-500">
                  Shortcuts: A (Again), 1, 3, 7, 0 (30D), 9 (90D).
                </div>
              )}

              {/* Bodies */}
              {settings.mode === "recognition" && (
                <div className="rounded-xl border p-4 bg-gray-50">
                  <div className="text-sm whitespace-pre-wrap">{currentCard.text}</div>
                </div>
              )}

              {settings.mode === "review" && (
                <div className="rounded-2xl border p-4 bg-gray-50 flex justify-center">
                  <div className="text-base whitespace-pre-wrap break-words font-mono w-[25ch]">
                    {currentCard.text}
                  </div>
                </div>
              )}

              {/* NEW: Writing box + feedback */}
              {settings.mode === "writing" && (
                <WritingCard
                  key={currentCard.id}
                  card={currentCard}
                  opts={settings.writing || defaultWritingOptions()}
                  onSubmit={() => setWritingSubmitted(true)}
                  onSkip={handleSkip}
                />
              )}

              {/* SRS buttons (desktop) – hidden until Submit in writing */}
              {showGradeButtons && (
                <div className="hidden sm:grid sm:grid-cols-6 gap-2">
                  <button title="Again (A)" aria-label="Again (A)"
                    className="px-3 py-2 rounded-xl bg-rose-600 text-white"
                    onClick={() => handleGrade("Again")}><div className="font-semibold">Again</div></button>

                  <button title="1 day (1)" aria-label="1 day (1)"
                    className="px-3 py-2 rounded-xl bg-gray-800 text-white"
                    onClick={() => handleGrade("1D")}><div className="font-semibold">1D</div></button>

                  <button title="3 days (3)" aria-label="3 days (3)"
                    className="px-3 py-2 rounded-xl bg-gray-700 text-white"
                    onClick={() => handleGrade("3D")}><div className="font-semibold">3D</div></button>

                  <button title="7 days (7)" aria-label="7 days (7)"
                    className="px-3 py-2 rounded-xl bg-indigo-600 text-white"
                    onClick={() => handleGrade("7D")}><div className="font-semibold">7D</div></button>

                  <button title="30 days (0)" aria-label="30 days (0)"
                    className="px-3 py-2 rounded-xl bg-violet-600 text-white"
                    onClick={() => handleGrade("30D")}><div className="font-semibold">30D</div></button>

                  <button title="90 days (9)" aria-label="90 days (9)"
                    className="px-3 py-2 rounded-xl bg-emerald-600 text-white"
                    onClick={() => handleGrade("90D")}><div className="font-semibold">90D</div></button>
                </div>
              )}

              {/* Sticky mobile grading bar – hidden until Submit in writing */}
              {showGradeButtons && (
                <div className="sm:hidden fixed left-0 right-0 bottom-0 z-40 border-t bg-white/95 backdrop-blur p-3">
                  <div className="grid grid-cols-3 gap-2">
                    <button title="Again (A)" aria-label="Again (A)" className="px-3 py-2 rounded-xl bg-rose-600 text-white" onClick={() => handleGrade("Again")}><div className="font-semibold">Again</div></button>
                    <button title="1 day (1)" aria-label="1 day (1)" className="px-3 py-2 rounded-xl bg-gray-800 text-white" onClick={() => handleGrade("1D")}><div className="font-semibold">1D</div></button>
                    <button title="3 days (3)" aria-label="3 days (3)" className="px-3 py-2 rounded-xl bg-gray-700 text-white" onClick={() => handleGrade("3D")}><div className="font-semibold">3D</div></button>
                    <button title="7 days (7)" aria-label="7 days (7)" className="px-3 py-2 rounded-xl bg-indigo-600 text-white" onClick={() => handleGrade("7D")}><div className="font-semibold">7D</div></button>
                    <button title="30 days (0)" aria-label="30 days (0)" className="px-3 py-2 rounded-xl bg-violet-600 text-white" onClick={() => handleGrade("30D")}><div className="font-semibold">30D</div></button>
                    <button title="90 days (9)" aria-label="90 days (9)" className="px-3 py-2 rounded-xl bg-emerald-600 text-white" onClick={() => handleGrade("90D")}><div className="font-semibold">90D</div></button>
                  </div>
                </div>
              )}

              <EditableArea card={currentCard} onSave={editCurrentCard} />
            </div>
          )}
        </section>

        {/* Stats */}
        <section className="rounded-2xl shadow p-4 bg-white">
          <h2 className="font-semibold mb-2">Stats</h2>
          <Stats cards={cards} />
        </section>

        {/* View Verses */}
        <VersesView
          cards={cards}
          packs={packs}
          currentPack={versesPack}
          onChangePack={setVersesPack}
          scheduleKey={viewScheduleKey}
          onChangeScheduleKey={setViewScheduleKey}
          onStartManual={(ids) => {
            if (!ids?.length) return;
            setSessionQueue(ids);
            setCompleted(0);
            setSessionStart(now());
          }}
          /* NEW: queue selected verses directly into Writing mode */
          onStartWriting={(ids) => {
            if (!ids?.length) return;
            setSettings(s => ({ ...s, mode: "writing" }));
            setSessionQueue(ids);
            setCompleted(0);
            setSessionStart(now());
            setWritingSubmitted(false);
          }}
        />

        {/* History */}
        <GoalHistoryView history={history} capLog={capLog} defaultWindowDays={14} />

        {/* Pack Manager Modal */}
        {packManagerOpen && (
          <PackManager
            cards={cards}
            onClose={() => setPackManagerOpen(false)}
            onDelete={async (packsToDelete) => {
              const norm = (s) => {
                const raw = String(s ?? "");
                const n = typeof raw.normalize === "function" ? raw.normalize("NFC") : raw;
                return n.replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
              };
              const delNorm = new Set(packsToDelete.map(norm));
              try {
                const client = window.supabaseClient;
                if (client) {
                  const { data: u } = await client.auth.getUser();
                  const uid = u?.user?.id;
                  if (uid) {
                    const { error } = await client
                      .from("cards")
                      .delete()
                      .eq("user_id", uid)
                      .in("pack", packsToDelete);
                    if (error) { console.error("Server delete failed:", error); alert("Server delete failed: " + error.message); }
                  }
                }
              } catch (e) { console.warn("Delete on server skipped/failed:", e); }
              setCards((prev) => {
                const before = prev.length;
                const next = prev.filter((c) => !delNorm.has(norm(c.pack)));
                const removed = before - next.length;
                if (removed === 0) alert("No cards matched those pack names.");
                else alert(`Deleted ${removed} card(s) from ${delNorm.size} pack(s).`);
                return next;
              });
              if (filterPack !== "ALL" && delNorm.has(norm(filterPack))) setFilterPack("ALL");
              setPackManagerOpen(false);
            }}
            onExport={(packsToExport) => {
              const norm = (s) => {
                const raw = String(s ?? "");
                const n = typeof raw.normalize === "function" ? raw.normalize("NFC") : raw;
                return n.replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
              };
              const exp = new Set(packsToExport.map(norm));
              const subset = cards.filter((c) => exp.has(norm(c.pack)));
              if (subset.length === 0) { alert("No cards found for the selected packs."); return; }
              const blob = new Blob([JSON.stringify({ cards: subset, settings: defaultSettings() }, null, 2)], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `scripture_srs_packs_${new Date().toISOString().slice(0, 10)}.json`;
              document.body.appendChild(a); a.click(); document.body.removeChild(a);
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          />
        )}
        {/* Advanced Modal (add Writing toggles) */}
        {syncOpen && (
          <AdvancedModal
            sync={sync}
            fmtTime={fmtTime}
            onClose={() => setSyncOpen(false)}
            fileInputRef={fileInputRef}
            importTxtFiles={importTxtFiles}
            exportJson={exportJson}
            importJson={importJson}
            /* NEW: writing options control */
            writingOpts={settings.writing || defaultWritingOptions()}
            onChangeWritingOpts={(next) => {
              setSettings(prev => ({ ...prev, writing: next }));
              window.markDirty?.('settings'); // harmless; server ignores unknown fields
            }}
          />
        )}
      </div>
    </div>
  );
}

/* =========================
   Small presentational bits
========================= */

function CardFrontRecognition({ card, words }) {
  const firstWords = React.useMemo(
    () => card.text.split(/\s+/).slice(0, words).join(" "),
    [card.text, words]
  );
  return (
    <div>
      <div className="text-gray-700 text-sm">{card.ref}</div>
      <div className="mt-1 text-2xl">
        {firstWords}
        {card.text.split(/\s+/).length > words ? " …" : ""}
      </div>
    </div>
  );
}

/* NEW: Header hint toggle for Writing */
function HintToggle({ text, words }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs">
      <button className="underline text-gray-500" onClick={() => setOpen(v => !v)}>
        {open ? "Hide hint ▾" : "Show hint ▸"}
      </button>
      {open && (
        <div className="mt-1 px-2 py-1 rounded bg-gray-100 text-gray-700 max-w-[60vw] truncate">
          {previewText(text, words)}
        </div>
      )}
    </div>
  );
}

/* =========================
   NEW: WritingCard
   - IME safe textarea
   - Submit computes LCS diff (typed vs card.text)
   - Shows inline colored runs on typed text only
   - Skip available before submit
========================= */
function WritingCard({ card, opts, onSubmit, onSkip }) {
  const [value, setValue] = useState("");
  const [composing, setComposing] = useState(false);
  const [feedback, setFeedback] = useState(null); // {runs, exact, missingHead*, missingTail*, mid*}
  const [view, setView] = useState("typed"); // "typed" | "actual"
  const taRef = useRef(null);

  // Auto-grow textarea
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 320) + "px";
  }, [value]);

  // Reset when card changes
  useEffect(() => {
    setValue("");
    setFeedback(null);
    setView("typed");
  }, [card.id]);

  function handleSubmit() {
    if (composing) return;
    const diff = diffCharsLCS(value, card.text, opts);
    setFeedback(diff);
    setView("typed");
    onSubmit?.();
  }

  // --- Panels ---
  function TypingPanel() {
    const hasHead = !!feedback.missingHeadRaw;
    const hasTail = !!feedback.missingTailRaw;

    return (
      <div className="rounded-xl border p-3 bg-gray-50">
        <div className="font-mono whitespace-pre-wrap leading-6 break-words">
          {/* NEW: missed head */}
          {hasHead && (
            <span className="bg-rose-200 text-rose-900 rounded-sm">{feedback.missingHeadRaw}</span>
          )}
          {/* user's typing with LCS highlights */}
          {feedback.runs.map((r, i) =>
            r.ok === true ? (
              <span key={i} className="bg-emerald-200 text-emerald-900 rounded-sm">{r.text}</span>
            ) : r.ok === false ? (
              <span key={i} className="bg-rose-200 text-rose-900 rounded-sm">{r.text}</span>
            ) : (
              <span key={i}>{r.text}</span>
            )
          )}
          {/* missed tail */}
          {hasTail && (
            <>
              {" "}
              <span className="bg-rose-200 text-rose-900 rounded-sm">{feedback.missingTailRaw}</span>
            </>
          )}
        </div>
        {!feedback.exact ? (
          <div className="mt-2 text-xs text-gray-500">
            Green = correct, Red = incorrect. Red at the start/end shows skipped opening/ending words.
          </div>
        ) : (
          <div className="mt-2 text-xs text-emerald-700">Perfect match after normalization.</div>
        )}
      </div>
    );
  }

  function ActualPanel() {
    const f = feedback;
    const hasHead = f?.missingHeadEndRawIndex != null;
    const hasTail = f?.midEndRawIndex != null && f.midEndRawIndex < card.text.length;

    if (!f || (f.midStartRawIndex == null)) {
      // fallback: plain verse
      return (
        <div className="rounded-xl border p-3 bg-gray-50">
          <div className="font-mono whitespace-pre-wrap leading-6 break-words">{card.text}</div>
        </div>
      );
    }

    const headEnd = f.missingHeadEndRawIndex ?? 0; // start of aligned mid
    const midStart = f.midStartRawIndex ?? headEnd;
    const midEnd = f.midEndRawIndex ?? midStart;

    const head = card.text.slice(0, headEnd);
    const mid = card.text.slice(midStart, midEnd);
    const tail = card.text.slice(midEnd);

    return (
      <div className="rounded-xl border p-3 bg-gray-50">
        <div className="font-mono whitespace-pre-wrap leading-6 break-words">
          {/* missed head */}
          {hasHead ? (
            <span className="bg-rose-200 text-rose-900 rounded-sm">{head}</span>
          ) : (
            <span>{card.text.slice(0, midStart)}</span>
          )}
          {/* matched middle (normal) */}
          <span>{mid}</span>
          {/* missed tail */}
          {hasTail ? (
            <span className="bg-rose-200 text-rose-900 rounded-sm">{tail}</span>
          ) : (
            <span>{card.text.slice(midEnd)}</span>
          )}
        </div>
        <div className="mt-2 text-xs text-gray-500">
          Red = parts you didn’t type (beginning or end).
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Editor (hidden after submit) */}
      {!feedback && (
        <>
          <textarea
            ref={taRef}
            className="w-full border rounded-xl p-3 font-mono text-base whitespace-pre-wrap leading-6 min-h-32 max-h-80 overflow-auto"
            placeholder="Type the verse exactly as memorized…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
          />
          <div className="flex gap-2">
            <button
              className={`px-4 py-2 rounded-xl text-white ${composing ? "bg-gray-300 cursor-not-allowed" : "bg-indigo-600"}`}
              disabled={composing}
              onClick={handleSubmit}
              title={composing ? "Wait for IME composition to finish" : "Check"}
            >
              Submit
            </button>
            <button className="px-4 py-2 rounded-xl bg-gray-200" onClick={onSkip}>Skip</button>
          </div>
        </>
      )}

      {/* Feedback + toggle */}
      {feedback && (
        <>
          <div className="flex gap-2">
            <button
              className={`px-3 py-1 rounded-full text-sm ${view === "typed" ? "bg-indigo-600 text-white" : "bg-gray-200"}`}
              onClick={() => setView("typed")}
              aria-pressed={view === "typed"}
              title="Show your typing with highlights"
            >
              My typing
            </button>
            <button
              className={`px-3 py-1 rounded-full text-sm ${view === "actual" ? "bg-indigo-600 text-white" : "bg-gray-200"}`}
              onClick={() => setView("actual")}
              aria-pressed={view === "actual"}
              title="Show the actual verse"
            >
              Actual verse
            </button>
          </div>

          {view === "typed" ? <TypingPanel /> : <ActualPanel />}
        </>
      )}
    </div>
  );
}

/* =========================
   Editable / Packs / Stats (mostly unchanged)
   - Pack Manager extracted to container for brevity
========================= */
function EditableArea({ card, onSave }) {
  const [editing, setEditing] = useState(false);
  const [ref, setRef] = useState(card.ref);
  const [text, setText] = useState(card.text);
  useEffect(() => { setRef(card.ref); setText(card.text); }, [card.id]);
  if (!editing)
    return (
      <div className="flex justify-end">
        <button className="text-sm text-gray-500 underline" onClick={() => setEditing(true)}>Edit card</button>
      </div>
    );
  return (
    <div className="space-y-2">
      <input className="w-full border rounded-xl p-2" value={ref} onChange={(e) => setRef(e.target.value)} />
      <textarea className="w-full border rounded-xl p-2 h-32" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex gap-2 justify-end">
        <button className="px-3 py-2 rounded-xl bg-gray-200" onClick={() => setEditing(false)}>Cancel</button>
        <button className="px-3 py-2 rounded-xl bg-gray-900 text-white" onClick={() => { onSave(ref, text); setEditing(false); }}>Save</button>
      </div>
    </div>
  );
}

// PackManager wrapper (your logic unchanged; moved to keep App readable)
function PackManagerContainer({ cards, setCards, filterPack, setFilterPack }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="hidden" onClick={() => setOpen(true)}></button>
      {open && (
        <PackManager
          cards={cards}
          onClose={() => setOpen(false)}
          onDelete={async (packsToDelete) => {
            const norm = (s) => {
              const raw = String(s ?? "");
              const n = typeof raw.normalize === "function" ? raw.normalize("NFC") : raw;
              return n.replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
            };
            const delNorm = new Set(packsToDelete.map(norm));
            try {
              const client = window.supabaseClient;
              if (client) {
                const { data: u } = await client.auth.getUser();
                const uid = u?.user?.id;
                if (uid) {
                  const { error } = await client
                    .from("cards")
                    .delete()
                    .eq("user_id", uid)
                    .in("pack", packsToDelete);
                  if (error) { console.error("Server delete failed:", error); alert("Server delete failed: " + error.message); }
                }
              }
            } catch (e) { console.warn("Delete on server skipped/failed:", e); }
            setCards((prev) => {
              const before = prev.length;
              const next = prev.filter((c) => !delNorm.has(norm(c.pack)));
              const removed = before - next.length;
              if (removed === 0) alert("No cards matched those pack names.");
              else alert(`Deleted ${removed} card(s) from ${delNorm.size} pack(s).`);
              return next;
            });
            if (filterPack !== "ALL" && delNorm.has(norm(filterPack))) setFilterPack("ALL");
            setOpen(false);
          }}
          onExport={(packsToExport) => {
            const norm = (s) => {
              const raw = String(s ?? "");
              const n = typeof raw.normalize === "function" ? raw.normalize("NFC") : raw;
              return n.replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
            };
            const exp = new Set(packsToExport.map(norm));
            const subset = cards.filter((c) => exp.has(norm(c.pack)));
            if (subset.length === 0) { alert("No cards found for the selected packs."); return; }
            const blob = new Blob([JSON.stringify({ cards: subset, settings: defaultSettings() }, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `scripture_srs_packs_${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        />
      )}
      {/* expose open button through your existing "Manage Packs" button in header */}
      <script>{/* no-op */}</script>
    </>
  );
}

function PackManager({ cards, onClose, onDelete, onExport }) {
  const summary = useMemo(() => {
    const m = new Map();
    for (const c of cards) {
      const p = c.pack;
      const b = c?.srs?.slow?.bucket || "0D";
      const v = m.get(p) || { count: 0, buckets: Object.fromEntries(BUCKETS.map((k) => [k, 0])) };
      v.count++; v.buckets[b] = (v.buckets[b] || 0) + 1; m.set(p, v);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [cards]);
  const [checked, setChecked] = useState(() => new Set());
  function toggleAll(state) { if (state) setChecked(new Set(summary.map(([p]) => p))); else setChecked(new Set()); }
  function toggle(p) { setChecked((prev) => { const n = new Set(prev); if (n.has(p)) n.delete(p); else n.add(p); return n; }); }
  const canAct = checked.size > 0;

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="max-w-3xl w-full bg-white rounded-2xl shadow-xl p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Bulk Pack Manager</h3>
          <button className="px-3 py-2 rounded-xl bg-gray-200" onClick={onClose}>Close</button>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button className="px-3 py-2 rounded-xl bg-gray-100" onClick={() => toggleAll(true)}>Select All</button>
          <button className="px-3 py-2 rounded-xl bg-gray-100" onClick={() => toggleAll(false)}>Clear</button>
          <button className={`px-3 py-2 rounded-xl ${canAct ? "bg-rose-600 text-white" : "bg-gray-200 text-gray-400"}`} disabled={!canAct}
            onClick={() => { if (!canAct) return; if (confirm(`Delete ${checked.size} pack(s)?`)) onDelete(Array.from(checked)); }}>
            Delete Selected
          </button>
          <button className={`px-3 py-2 rounded-xl ${canAct ? "bg-indigo-600 text-white" : "bg-gray-200 text-gray-400"}`} disabled={!canAct}
            onClick={() => onExport(Array.from(checked))}>
            Export Selected
          </button>
        </div>
        <div className="max-h-[60vh] overflow-auto grid sm:grid-cols-2 gap-2">
          {summary.map(([pack, v]) => (
            <label key={pack} className="flex items-start gap-3 p-3 border rounded-xl bg-gray-50 cursor-pointer">
              <input type="checkbox" checked={checked.has(pack)} onChange={() => toggle(pack)} />
              <div className="min-w-0">
                <div className="font-semibold text-gray-800 truncate" title={pack}>{pack}</div>
                <div className="text-xs text-gray-600">Cards: {v.count}</div>
                <div className="text-[11px] text-gray-500">{BUCKETS.map((k) => `${k}:${v.buckets[k] || 0}`).join("  ")}</div>
              </div>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stats({ cards }) {
  const total = cards.length;
  const byPack = useMemo(() => {
    const m = new Map();
    for (const c of cards) {
      const key = c.pack;
      const v = m.get(key) || {
        count: 0,
        slow: Object.fromEntries(BUCKETS.map((k) => [k, 0])),
        fast: Object.fromEntries(BUCKETS.map((k) => [k, 0])),
      };
      v.count++;
      v.slow[c?.srs?.slow?.bucket || "0D"]++;
      v.fast[c?.srs?.fast?.bucket || "0D"]++;
      m.set(key, v);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [cards]);

  const totals = useMemo(() => {
    const slow = Object.fromEntries(BUCKETS.map((k) => [k, 0]));
    const fast = Object.fromEntries(BUCKETS.map((k) => [k, 0]));
    for (const c of cards) {
      slow[c?.srs?.slow?.bucket || "0D"]++;
      fast[c?.srs?.fast?.bucket || "0D"]++;
    }
    return { slow, fast };
  }, [cards]);

  return (
    <div className="text-sm space-y-3">
      <div> Total cards: <b>{total}</b> </div>
      <div className="flex flex-wrap gap-2">
        <span className="px-2 py-1 rounded bg-gray-100 text-xs font-medium">Slow</span>
        {BUCKETS.map((k) => (<span key={`slow-${k}`} className="px-3 py-1 rounded-full bg-gray-100">{k}: {totals.slow[k]}</span>))}
      </div>
      <div className="flex flex-wrap gap-2">
        <span className="px-2 py-1 rounded bg-gray-100 text-xs font-medium">Fast</span>
        {BUCKETS.map((k) => (<span key={`fast-${k}`} className="px-3 py-1 rounded-full bg-gray-100">{k}: {totals.fast[k]}</span>))}
      </div>
      <div className="mt-2">
        <div className="font-medium mb-1">By Pack (slow / fast)</div>
        <div className="grid sm:grid-cols-2 gap-2">
          {byPack.map(([pack, v]) => (
            <div key={pack} className="rounded-xl border p-2 bg-gray-50">
              <div className="font-semibold text-gray-700 truncate" title={pack}>{pack}</div>
              <div className="text-xs text-gray-600">Cards: {v.count}</div>
              <div className="text-xs text-gray-600">Slow: {BUCKETS.map((k) => `${k}:${v.slow[k]}`).join("  ")}</div>
              <div className="text-xs text-gray-600">Fast: {BUCKETS.map((k) => `${k}:${v.fast[k]}`).join("  ")}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function VersesView({
  cards,
  packs,
  currentPack,
  onChangePack,
  scheduleKey,
  onChangeScheduleKey,
  onStartManual,
  /* NEW */ onStartWriting,
}) {
  // Filter by pack
  const list = useMemo(() => {
    const arr = currentPack && currentPack !== "ALL" ? cards.filter((c) => c.pack === currentPack) : cards.slice();
    return arr.sort((a, b) => {
      if (a.pack !== b.pack) return a.pack.localeCompare(b.pack);
      const ao = a.order ?? Number.POSITIVE_INFINITY, bo = b.order ?? Number.POSITIVE_INFINITY;
      if (ao !== bo) return ao - bo;
      return String(a.ref).localeCompare(String(b.ref));
    });
  }, [cards, currentPack]);

  const [checked, setChecked] = useState(() => new Set());
  const allVisibleIds = list.map((c) => c.id);
  const allChecked = checked.size > 0 && allVisibleIds.every((id) => checked.has(id));
  const toggleOne = (id) => setChecked((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  const toggleAll = () => setChecked((prev) => (allChecked ? new Set() : new Set(allVisibleIds)));
  const selectedIdsOrdered = list.filter(c => checked.has(c.id)).map(c => c.id);

  return (
    <section className="rounded-2xl shadow p-4 bg-white">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="font-semibold">View Verses</h2>
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full">
          <div className="flex items-center gap-2">
            <label className="text-sm">Schedule:</label>
            <select className="border rounded-xl p-2 text-sm" value={scheduleKey} onChange={(e) => onChangeScheduleKey(e.target.value)}>
              <option value="slow">Slow (Review/Writing)</option>
              <option value="fast">Fast (Recognition)</option>
            </select>
          </div>
          <div className="flex items-center gap-2 sm:ml-3 min-w-0 w-full">
            <label className="text-sm">Pack:</label>
            <div className="min-w-0 flex-1">
              <select className="border rounded-xl p-2 text-sm w-full sm:w-56" value={currentPack} onChange={(e) => onChangePack(e.target.value)}>
                {packs.map((p) => (<option key={p} value={p}>{p}</option>))}
              </select>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 flex gap-2 flex-wrap">
        <button className="px-3 py-2 rounded-xl bg-gray-100" onClick={toggleAll}>
          {allChecked ? "Clear All" : "Select All"}
        </button>
        <button
          className={`px-3 py-2 rounded-xl ${checked.size ? "bg-indigo-600 text-white" : "bg-gray-200 text-gray-400"}`}
          disabled={!checked.size}
          onClick={() => onStartManual(selectedIdsOrdered)}
        >
          Review selected now
        </button>
        {/* NEW: Write selected now */}
        <button
          className={`px-3 py-2 rounded-xl ${checked.size ? "bg-emerald-600 text-white" : "bg-gray-200 text-gray-400"}`}
          disabled={!checked.size}
          onClick={() => onStartWriting(selectedIdsOrdered)}
        >
          Write selected now
        </button>
      </div>

      <div className="mt-3 grid gap-2 overflow-x-auto">
        {list.map((c) => {
          const sub = c?.srs?.[scheduleKey];
          const since = daysSince(sub?.updatedAt);
          const till = daysTill(sub?.nextDue);
          const bucket = sub?.bucket || "0D";
          return (
            <label key={c.id} className="flex items-start gap-3 p-3 border rounded-xl bg-gray-50">
              <input type="checkbox" checked={checked.has(c.id)} onChange={() => toggleOne(c.id)} />
              <div className="min-w-0">
                <div className="font-semibold text-gray-800 truncate" title={c.ref}>{c.ref}</div>
                <div className="text-xs text-gray-600 truncate">{previewText(c.text, 10)}</div>
                <div className="text-[11px] text-gray-500 mt-1">
                  {c.pack} · #{c.order ?? "?"} · {bucket} · since: {since ?? "–"}d · till: {till ?? "–"}d
                </div>
              </div>
            </label>
          );
        })}
        {list.length === 0 && (
          <div className="text-sm text-gray-500">No verses in this filter.</div>
        )}
      </div>
    </section>
  );
}

function GoalHistoryView({ history, capLog, defaultWindowDays = 14 }) {
  const [group, setGroup] = React.useState("day");
  const windowSizes = { day: defaultWindowDays, week: 12, month: 12, year: 5 };

  const perDayCounts = React.useMemo(() => {
    const map = new Map();
    for (const h of history) {
      const key = isoDay(h.ts || Date.now());
      const cur = map.get(key) || { slow: 0, fast: 0 };
      if (h.mode === "slow") cur.slow += 1; else cur.fast += 1;
      map.set(key, cur);
    }
    return map;
  }, [history]);

  const effectiveCapsForDate = React.useMemo(() => {
    const entries = Object.entries(capLog)
      .map(([k,v]) => [k, { slow: Number(v?.slow||0), fast: Number(v?.fast||0) }])
      .sort((a,b) => a[0].localeCompare(b[0]));
    return function getCaps(dayKey) {
      let lo = 0, hi = entries.length - 1, ans = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const mk = entries[mid][0];
        if (mk <= dayKey) { ans = entries[mid][1]; lo = mid + 1; }
        else { hi = mid - 1; }
      }
      return ans || { slow: 0, fast: 0 };
    };
  }, [capLog]);

  const rows = React.useMemo(() => {
    const nowTs = Date.now();
    const out = [];
    const kind = group;
    const N = windowSizes[kind];

    const periodKeys = [];
    if (kind === "day") { for (let i = 0; i < N; i++) periodKeys.push(isoDay(new Date(nowTs - i*day))); }
    else if (kind === "week") {
      let d = new Date(); d.setUTCHours(0,0,0,0);
      let start = new Date(startOfWeekISO(d));
      for (let i = 0; i < N; i++) periodKeys.push(isoDay(new Date(start.getTime() - i*7*day)));
    } else if (kind === "month") {
      let cur = new Date(); cur.setUTCDate(1); cur.setUTCHours(0,0,0,0);
      for (let i = 0; i < N; i++) {
        const d = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() - i, 1));
        periodKeys.push(monthKey(d));
      }
    } else { const y = new Date().getUTCFullYear(); for (let i = 0; i < N; i++) periodKeys.push(String(y - i)); }

    function bucketKeyByGroup(dt) {
      if (kind === "day") return isoDay(dt);
      if (kind === "week") return weekKey(dt);
      if (kind === "month") return monthKey(dt);
      return yearKey(dt);
    }

    const aggReviews = new Map();
    for (const [dKey, counts] of perDayCounts.entries()) {
      const pKey = bucketKeyByGroup(dKey);
      const cur = aggReviews.get(pKey) || { slow: 0, fast: 0 };
      cur.slow += counts.slow; cur.fast += counts.fast;
      aggReviews.set(pKey, cur);
    }

    function* iterateDaysOfPeriod(pKey) {
      if (kind === "day") { yield pKey; return; }
      if (kind === "week") {
        const start = new Date(pKey + "T00:00:00Z");
        for (let i = 0; i < 7; i++) yield isoDay(new Date(start.getTime() + i*day));
        return;
      }
      if (kind === "month") {
        const [yy, mm] = pKey.split("-").map(Number);
        const start = Date.UTC(yy, mm - 1, 1);
        const next = Date.UTC(yy, mm, 1);
        for (let t = start; t < next; t += day) yield isoDay(t);
        return;
      }
      const y = Number(pKey);
      const start = Date.UTC(y, 0, 1), next = Date.UTC(y+1, 0, 1);
      for (let t = start; t < next; t += day) yield isoDay(t);
    }

    const aggCaps = new Map();
    for (const pKey of periodKeys) {
      let slow = 0, fast = 0;
      for (const dKey of iterateDaysOfPeriod(pKey)) {
        if (dKey > isoDay(nowTs)) break;
        const caps = effectiveCapsForDate(dKey);
        slow += caps.slow || 0; fast += caps.fast || 0;
      }
      aggCaps.set(pKey, { slow, fast });
    }

    for (const pKey of periodKeys) {
      const cap = aggCaps.get(pKey) || { slow: 0, fast: 0 };
      const rev = aggReviews.get(pKey) || { slow: 0, fast: 0 };
      const okSlow = rev.slow >= cap.slow, okFast = rev.fast >= cap.fast;
      const label = (function(){ if (kind === "day") return pKey; if (kind === "week") return `Week of ${pKey}`; if (kind === "month") return pKey; return pKey; })();
      out.push({ key: pKey, label, cap, rev, okSlow, okFast });
    }
    return out;
  }, [group, perDayCounts, capLog]);

  return (
    <section className="rounded-2xl shadow p-4 bg-white">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="font-semibold">History (Goals vs. Reviews)</h2>
        <div className="flex items-center gap-2">
          <label className="text-sm">Group:</label>
          <select className="border rounded-xl p-2 text-sm" value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="day">Day (last {windowSizes.day})</option>
            <option value="week">Week (last {windowSizes.week})</option>
            <option value="month">Month (last {windowSizes.month})</option>
            <option value="year">Year (last {windowSizes.year})</option>
          </select>
        </div>
      </div>

      <div className="mt-3 grid gap-2">
        {rows.map(r => {
          const slowClass = r.okSlow ? "text-emerald-700" : "text-rose-700";
          const fastClass = r.okFast ? "text-emerald-700" : "text-rose-700";
          const totalCap = (r.cap.slow || 0) + (r.cap.fast || 0);
          const totalRev = (r.rev.slow || 0) + (r.rev.fast || 0);
          const totalOk = totalRev >= totalCap;
          const totalClass = totalOk ? "text-emerald-800" : "text-rose-800";
          return (
            <div key={r.key} className="p-3 border rounded-xl bg-gray-50">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">{r.label}</div>
                <div className={`text-sm font-semibold ${totalClass}`}>Total {totalRev} / {totalCap}</div>
              </div>
              <div className="text-xs text-gray-700 mt-1 flex flex-wrap gap-4">
                <div className={slowClass}>Slow: {r.rev.slow} / {r.cap.slow}</div>
                <div className={fastClass}>Fast: {r.rev.fast} / {r.cap.fast}</div>
              </div>
            </div>
          );
        })}
        {rows.length === 0 && (<div className="text-sm text-gray-500">No data yet.</div>)}
      </div>
      <p className="mt-3 text-[11px] text-gray-500">Goals are snapshotted daily and summed for weekly/monthly/yearly views. Colors: green = goal met, red = not met.</p>
    </section>
  );
}

/* =========================
   Advanced modal with NEW Writing toggles
========================= */
function AdvancedModal({ sync, onClose, fmtTime, fileInputRef, importTxtFiles, exportJson, importJson, writingOpts, onChangeWritingOpts }) {
  const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
  const isSyncing = !!(sync.pushing || sync.pulling);
  async function syncNow() { try { if (window.pushSRS) await window.pushSRS(); if (window.pullSRS) await window.pullSRS(); } catch (e) {} }

  const setOpt = (k, v) => onChangeWritingOpts({ ...writingOpts, [k]: v });

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="max-w-3xl w-full bg-white rounded-2xl shadow-xl p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Advanced</h3>
          <button className="px-3 py-2 rounded-xl bg-gray-200" onClick={onClose}>Close</button>
        </div>

        {/* Sync status row */}
        <div className="text-sm text-gray-700 grid sm:grid-cols-3 gap-2 items-center">
          <div><span className="font-medium">Status:</span> {isOffline ? "Offline" : (isSyncing ? "Syncing…" : "Idle")}</div>
          <div><span className="font-medium">Last pull:</span> {fmtTime(sync.lastPullAt)}</div>
          <div><span className="font-medium">Last push:</span> {fmtTime(sync.lastPushAt)}</div>
        </div>
        <div>
          <button className={`px-4 py-2 rounded-xl text-white ${isOffline || isSyncing ? "bg-gray-300 cursor-not-allowed" : "bg-indigo-600"}`}
            onClick={syncNow} disabled={isOffline || isSyncing}
            title={isOffline ? "Go online to sync" : (isSyncing ? "Already syncing" : "Push & Pull now")}>
            Sync now
          </button>
          <p className="text-[11px] text-gray-500 mt-1">Sync is automatic. Use “Sync now” if you think this device missed an update.</p>
        </div>

        {/* Import / Export */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border p-4 bg-gray-50 space-y-2">
            <h4 className="font-semibold mb-1">Import TXT Packs</h4>
            <button className="px-3 py-2 rounded-xl bg-gray-900 text-white w-full sm:w-auto" onClick={() => fileInputRef?.current?.click()}>Select .txt files</button>
            <input ref={fileInputRef} type="file" multiple accept=".txt,text/plain" className="hidden"
              onChange={(e) => e.target.files && importTxtFiles(Array.from(e.target.files))} />
            <p className="text-xs text-gray-500">Tip: Each non-empty line becomes a card. Use "Reference: Verse".</p>
          </div>

          <div className="rounded-2xl border p-4 bg-gray-50 space-y-2">
            <h4 className="font-semibold mb-1">Backup / Restore</h4>
            <div className="flex flex-wrap gap-2">
              <button className="px-3 py-2 rounded-xl bg-gray-900 text-white w-full sm:w-auto" onClick={exportJson}>Export JSON</button>
              <label className="px-3 py-2 rounded-xl bg-gray-200 cursor-pointer w-full sm:w-auto text-center inline-flex justify-center">
                Import JSON
                <input type="file" className="hidden" accept="application/json" onChange={(e) => e.target.files && importJson(e.target.files[0])} />
              </label>
            </div>
            <p className="text-xs text-gray-500">Use this to move progress between devices (manual).</p>
          </div>
        </div>

        {/* NEW: Writing options */}
        <div className="rounded-2xl border p-4 bg-gray-50 space-y-2">
          <h4 className="font-semibold">Writing ▸ Smart comparison</h4>
          <div className="grid sm:grid-cols-2 gap-2 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={!!writingOpts.nfc} onChange={e => setOpt('nfc', e.target.checked)} /> Unicode normalize to NFC <span className="text-xs text-gray-500">(on)</span></label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={!!writingOpts.trim} onChange={e => setOpt('trim', e.target.checked)} /> Trim leading/trailing whitespace <span className="text-xs text-gray-500">(on)</span></label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={!!writingOpts.collapseWS} onChange={e => setOpt('collapseWS', e.target.checked)} /> Collapse internal whitespace runs <span className="text-xs text-gray-500">(off)</span></label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={!!writingOpts.ignorePunct} onChange={e => setOpt('ignorePunct', e.target.checked)} /> Ignore punctuation <span className="text-xs text-gray-500">(off)</span></label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={!!writingOpts.caseInsensitive} onChange={e => setOpt('caseInsensitive', e.target.checked)} /> Case-insensitive (A=a) <span className="text-xs text-gray-500">(off)</span></label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={!!writingOpts.normalizeQuoteHyphen} onChange={e => setOpt('normalizeQuoteHyphen', e.target.checked)} /> Normalize quote/hyphen variants <span className="text-xs text-gray-500">(on)</span></label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={!!writingOpts.stripZeroWidth} onChange={e => setOpt('stripZeroWidth', e.target.checked)} /> Strip zero-widths & NBSP <span className="text-xs text-gray-500">(on)</span></label>
          </div>
          <p className="text-[11px] text-gray-500">These toggles affect comparison only. Your verse text stays unchanged; highlights are applied to your typed text.</p>
        </div>
      </div>
    </div>
  );
}

/* Mount */
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
