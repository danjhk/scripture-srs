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

function parseLineToCard(line, fileName) {
  const clean = line.trim();
  if (!clean) return null;
  const refMatch = clean.match(
    /^(?<ref>(?:[1-3]\s+)?[A-Za-zÀ-ÖØ-öø-ÿ'`´^.\-]+(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ'`´^.\-]+)*\s+\d{1,3}:\d{1,3}(?:-\d{1,3})?)/
  );
  let ref, text;
  if (refMatch?.groups?.ref) {
    ref = refMatch.groups.ref.trim();
    const rest = clean.slice(refMatch[0].length);
    text = rest.replace(/^\s*[:\-–]?\s*/, "");
  } else {
    const firstColon = clean.indexOf(":");
    const secondColon = firstColon >= 0 ? clean.indexOf(":", firstColon + 1) : -1;
    const sepIdx = secondColon > -1 ? secondColon : clean.search(/[\-–:]/);
    if (sepIdx > -1 && sepIdx < clean.length - 1) {
      ref = clean.slice(0, sepIdx).trim();
      text = clean.slice(sepIdx + 1).replace(/^\s*/, "");
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
  // If card already has srs, normalize fields; else create fresh at 0D
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

// Bump settings schema version or fill defaults
function upgradeSettings(settings) {
  const s = { ...defaultSettings(), ...(settings || {}) };
  if (!s.schemaVersion || s.schemaVersion < SCHEMA_VERSION) {
    s.schemaVersion = SCHEMA_VERSION;
  }
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

// --- Misc helpers: ordinal, deltas, preview text ---

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"],
    v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function getActiveBucket(card, mode) {
  const key = mode === "recognition" ? "fast" : "slow";
  return card?.srs?.[key]?.bucket || "0D";
}

function daysSince(ts) {
  if (!ts) return null;
  return Math.floor((now() - ts) / day);
}
function daysTill(ts) {
  if (!ts) return null;
  const d = Math.ceil((ts - now()) / day);
  return Math.max(0, d);
}
function previewText(text, words = 6) {
  const parts = String(text || "").split(/\s+/);
  return parts.slice(0, words).join(" ") + (parts.length > words ? " …" : "");
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
} // YYYY-MM-DD

function isoDay(dateLike) {
  const d = new Date(dateLike);
  const z = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  return z.toISOString().slice(0, 10); // YYYY-MM-DD (UTC-normalized)
}
function startOfWeekISO(dt) {
  const d = new Date(dt);
  const day = (d.getDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0,0,0,0);
  return d.toISOString().slice(0,10);
}
function weekKey(dt) { return startOfWeekISO(dt); }         // YYYY-MM-DD (Mon)
function monthKey(dt) { const d=new Date(dt); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`; }
function yearKey(dt) { return String(new Date(dt).getUTCFullYear()); }

// --- Phase 5: keyboard shortcuts ---
const SHORTCUT_MAP = {
  a: "Again",
  "1": "1D",
  "3": "3D",
  "7": "7D",
  "0": "30D",
  "9": "90D",
};

function defaultSettings() {
  return {
    sessionTarget: 50,
    mode: "recognition",
    showFirstNWords: 6,
    shuffle: false,
    dailyCapSlow: 60, // max slow reviews per day
    dailyCapFast: 200, // max fast reviews per day
    jitterPct: 0.1, // used by fixed scheduler
    schemaVersion: SCHEMA_VERSION,
  };
}

// ----- Components -----
function App() {
  const [cards, setCards] = useState([]);
  const [settings, setSettings] = useState(defaultSettings());
  const [history, setHistory] = useState([]);
  const [revealed, setRevealed] = useState(false);
  const [sessionStart, setSessionStart] = useState(0);
  const [completed, setCompleted] = useState(0);
  const [filterPack, setFilterPack] = useState("ALL");
  const [sessionQueue, setSessionQueue] = useState([]); // array of card ids
  const [viewScheduleKey, setViewScheduleKey] = useState("slow"); // "slow" | "fast"
  const [versesPack, setVersesPack] = useState("ALL");
  const [capLog, setCapLog] = useState({});
  const [daily, setDaily] = useState({ key: todayKey(), slow: 0, fast: 0 });
  const dailyRemaining = (mode) =>
    mode === "recognition"
      ? settings.dailyCapFast - daily.fast
      : settings.dailyCapSlow - daily.slow;

  const [packManagerOpen, setPackManagerOpen] = useState(false);
  const fileInputRef = useRef(null);

  // --- Sync status (listen to global events from index.html) ---
  const [sync, setSync] = useState(() => (window.srsSync ?? { pushing:false, pulling:false, lastPullAt:null, lastPushAt:null }));
  useEffect(() => {
    const onSync = () => setSync({ ...(window.srsSync ?? {}) });
    window.addEventListener('srs-sync', onSync);
    // Also pick up initial state if pull happened before mount
    onSync();
    return () => window.removeEventListener('srs-sync', onSync);
  }, []);

  function fmtTime(ts) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch { return '—'; }
  }

  // Load & persist
  useEffect(() => {
    const s = loadState();
    const loadedCards = Array.isArray(s.cards) ? s.cards : [];
    const migratedCards = migrateAllCards(loadedCards);
    const upgradedSettings = upgradeSettings(s.settings);
    const loadedHistory = Array.isArray(s.history) ? s.history : [];
    const loadedDaily =
      s.daily && s.daily.key === todayKey()
        ? s.daily
        : { key: todayKey(), slow: 0, fast: 0 };

    setCards(migratedCards);
    setSettings(upgradedSettings);
    setHistory(loadedHistory);
    setDaily(loadedDaily);
    setCapLog(s.capLog || {});          // ← NEW
  }, []);

  useEffect(() => {
    saveState({ cards, settings, history, daily, capLog });   // ← include capLog
  }, [cards, settings, history, daily, capLog]);

  // When index.html finishes a pull (or another tab updates storage), reload into state
  useEffect(() => {
    function applyPulled() {
      try {
        const s = loadState();
        if (Array.isArray(s.cards)) setCards(s.cards);
        // Keep current UI mode; accept other server-side settings.
        if (s.settings) setSettings(prev => ({ ...s.settings, mode: prev.mode }));
        if (Array.isArray(s.history)) setHistory(s.history);
        if (s.daily) setDaily(s.daily);
        if (s.capLog) setCapLog(s.capLog);
      } catch (e) { console.warn('Failed to apply pulled state', e); }
    }
    const onPulled = () => applyPulled();
    const onStorage = (e) => {
      if (e.key === LS_KEY) applyPulled();
    };
    window.addEventListener('srs:pulled', onPulled);
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && window.pullSRS) window.pullSRS();
    });
    return () => {
      window.removeEventListener('srs:pulled', onPulled);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  // Keyboard shortcuts: grade with A / 1 / 3 / 7 / 0 / 9, Reveal with Enter/Space in Full
  useEffect(() => {
    function onKey(e) {
      // ignore when typing in inputs/textareas
      const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
      if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;

      // Reveal in Full mode
      if ((e.key === "Enter" || e.key === " ") && settings.mode === "full" && !revealed) {
        e.preventDefault();
        handleReveal();
        return;
      }

      // Grade shortcuts
      const lbl = SHORTCUT_MAP[e.key.toLowerCase?.() || e.key];
      if (!lbl) return;
      // Don't trigger if no card
      if (!currentCard) return;
      e.preventDefault();
      handleGrade(lbl);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentCard, settings.mode, revealed]);

  // Keep a daily snapshot of caps in capLog[YYYY-MM-DD] = { slow, fast }
  useEffect(() => {
    const key = todayKey();
    setCapLog(prev => {
      const existing = prev[key] || {};
      const next = {
        ...prev,
        [key]: {
          slow: settings.dailyCapSlow,
          fast: settings.dailyCapFast,
        }
      };
      // Avoid churn if nothing changed
      if (existing.slow === next[key].slow && existing.fast === next[key].fast) return prev;
      // Only mark dirty when the snapshot for today actually changes
      window.markDirty?.('capLog');
      return next;
    });
  }, [settings.dailyCapSlow, settings.dailyCapFast, daily.key]); // update if new day or caps changed

  const packs = useMemo(
    () => ["ALL", ...Array.from(new Set(cards.map((c) => c.pack))).sort()],
    [cards]
  );

  const dueCards = useMemo(() => {
    const t = now();
    const key = settings.mode === "recognition" ? "fast" : "slow";

    // 1) due filter
    let list = cards.filter((c) => {
      const nd = c?.srs?.[key]?.nextDue ?? 0;
      return nd <= t;
    });

    // 2) optional pack filter
    if (filterPack !== "ALL") {
      list = list.filter((c) => c.pack === filterPack);
    }

    // 3) deterministic ordering:
    //    - when ALL: by pack A→Z, then order 1→N, then ref
    //    - when single pack: order 1→N, then ref
    list.sort((a, b) => {
      if (filterPack === "ALL" && a.pack !== b.pack) {
        return String(a.pack).localeCompare(String(b.pack));
      }
      const ao = a.order ?? Number.POSITIVE_INFINITY;
      const bo = b.order ?? Number.POSITIVE_INFINITY;
      if (ao !== bo) return ao - bo;
      // very stable fallback to keep ties consistent
      const ar = String(a.ref || "");
      const br = String(b.ref || "");
      if (ar !== br) return ar.localeCompare(br);
      return String(a.id).localeCompare(String(b.id));
    });

    const remain = Math.max(0, dailyRemaining(settings.mode));
    return list.slice(0, remain);
  }, [cards, filterPack, settings.mode, daily]);


  // If manual queue is active, pull from it; else, use dueCards
  const currentCard = useMemo(() => {
    if (sessionQueue.length > 0) {
      const id = sessionQueue[0];
      return cards.find((c) => c.id === id) || null;
    }
    return dueCards[0];
  }, [sessionQueue, cards, dueCards]);

  async function startSession() {
    try {
      // If signed in and pull is available, refresh first.
      if (typeof window.pullSRS === 'function') {
        await window.pullSRS();
      }
    } catch {}
    setSessionStart(now());
    setCompleted(0);
    setRevealed(false);
    // Freeze the current due list for this session so realtime/pulls don't reshuffle it.
    setSessionQueue(dueCards.map(c => c.id));
  }

  function handleGrade(label) {
    if (!currentCard) return;

    // Before the update, capture from-bucket for the correct schedule
    const scheduleKey = settings.mode === "recognition" ? "fast" : "slow";
    const fromBucket = currentCard?.srs?.[scheduleKey]?.bucket || "0D";

    // Reset daily counters if day has rolled
    setDaily((prev) =>
      prev.key === todayKey() ? prev : { key: todayKey(), slow: 0, fast: 0 }
    );

    // Apply fixed label schedule with small jitter
    const updated = applyLabel(
      currentCard,
      label,
      settings.mode,
      settings.jitterPct ?? 0.1
    );

    setCards((prev) => prev.map((c) => (c.id === currentCard.id ? updated : c)));
    setRevealed(false);
    setCompleted((x) => x + 1);

    // Increment daily counter for the schedule used
    setDaily((prev) => {
      const key = todayKey();
      const base = prev.key === key ? prev : { key, slow: 0, fast: 0 };
      if (scheduleKey === "fast") return { ...base, fast: base.fast + 1 };
      return { ...base, slow: base.slow + 1 };
    });

    // Append to history
    const toBucket = updated.srs?.[scheduleKey]?.bucket || fromBucket;
    setHistory((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        cardId: updated.id,
        pack: updated.pack,
        ref: updated.ref,
        mode: scheduleKey, // 'fast' or 'slow'
        fromBucket,
        toBucket,
        ts: now(),
      },
    ]);
    // Durable: cards + history changed
    window.markDirty?.('cards', 'history');

    // If manual queue is active, pop the current id
    setSessionQueue((q) => (q.length && q[0] === currentCard.id ? q.slice(1) : q));
  }

  function handleReveal() {
    setRevealed(true);
  }

  async function importTxtFiles(files) {
    const imported = [];
    for (const f of files) {
      const text = await f.text();
      const lines = text.split(/\r?\n/);
      // Ensure strict, stable ordering inside this file:
      // give each createdAt/updatedAt a unique, increasing tick.
      let seq = 0;
      const base = Date.now();
      for (const line of lines) {
        const card = parseLineToCard(line, f.name);
        if (!card) continue;
        seq += 1;
        const t = base + seq; // strictly increasing per file
        card.createdAt = t;
        card.updatedAt = t;
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
    const blob = new Blob([JSON.stringify({ cards, settings }, null, 2)], {
      type: "application/json",
    });
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
        if (data.settings)
          setSettings({ ...defaultSettings(), ...data.settings });
        alert("Backup imported.");
      } catch {
        alert("Invalid JSON.");
      }
    };
    reader.readAsText(file);
  }

  function editCurrentCard(newRef, newText) {
    if (!currentCard) return;
    const newId = hashString(`${currentCard.pack}|${newRef}|${newText}`); // include pack!
    const updated = {
      ...currentCard,
      ref: newRef,
      text: newText,
      id: newId,
      updatedAt: now(),
    };
    setCards((prev) => prev.map((c) => (c.id === currentCard.id ? updated : c)));
    window.markDirty?.('cards');
  }

  // minutes with one decimal
  const sessionElapsedMin = sessionStart
    ? Math.round((now() - sessionStart) / 6000) / 10
    : 0;

  return (
    <div className="min-h-screen bg-gray-50 p-4 pb-28 sm:pb-4">
      <div className="max-w-3xl mx-auto space-y-4">
        <header className="flex flex-wrap items-center gap-2 sm:justify-between">
          <h1 className="text-2xl font-bold">Scripture SRS</h1>
          <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
            <button
              className="px-3 py-2 rounded-xl bg-gray-200 shrink-0"
              onClick={() => setPackManagerOpen(true)}
            >
              Manage Packs
            </button>
            <button
              className="px-3 py-2 rounded-xl bg-gray-200 shrink-0"
              onClick={() => window.pullSRS ? window.pullSRS() : alert('Sign in first (top-right)')}
            >
              Pull from Cloud
            </button>
            <button
              className="px-3 py-2 rounded-xl bg-gray-200 shrink-0"
              onClick={() => window.pushSRS ? window.pushSRS() : alert('Sign in first (top-right)')}
            >
              Push to Cloud
            </button>

            <div className="text-sm text-gray-600 min-w-0">
              Due: {dueCards.length} | Done: {completed} | {sessionElapsedMin}m
            </div>
            {/* Sync status chip */}
            <span
              className={
                "text-xs px-2 py-1 rounded-full " +
                (sync.pushing || sync.pulling ? "bg-amber-100 text-amber-800" : "bg-gray-100 text-gray-700")
              + " shrink-0"
              }
              title={`Last pull: ${fmtTime(sync.lastPullAt)} · Last push: ${fmtTime(sync.lastPushAt)}`}
            >
              {sync.pushing ? "Pushing…" : (sync.pulling ? "Pulling…" : `Last pull ${fmtTime(sync.lastPullAt)}`)}
            </span>
          </div>
        </header>

        {/* Daily goal status bar */}
        <div className="text-xs text-gray-500">
          Daily {settings.mode === "recognition" ? "FAST" : "SLOW"} goal:{" "}
          {settings.mode === "recognition" ? settings.dailyCapFast : settings.dailyCapSlow}
          {" · "}done:{" "}
          {settings.mode === "recognition" ? daily.fast : daily.slow}
          {" · "}left: {Math.max(0, dailyRemaining(settings.mode))}
        </div>

        {/* Import / Export */}
        <section className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl shadow p-4 bg-white space-y-2">
            <h2 className="font-semibold mb-2">Import TXT Packs</h2>
            {/* Button triggers hidden input to avoid iOS file input overflow */}
            <button
              className="px-3 py-2 rounded-xl bg-gray-900 text-white w-full sm:w-auto"
              onClick={() => fileInputRef.current?.click()}
            >
              Select .txt files
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".txt,text/plain"
              className="hidden"
              onChange={(e) =>
                e.target.files && importTxtFiles(Array.from(e.target.files))
              }
            />
            <p className="text-xs text-gray-500 mt-2">
              Tip: Each non-empty line becomes a card. Use "Reference: Verse".
            </p>
          </div>
          <div className="rounded-2xl shadow p-4 bg-white space-y-2">
            <h2 className="font-semibold">Backup / Restore</h2>
            <div className="flex flex-wrap gap-2">
              <button
                className="px-3 py-2 rounded-xl bg-gray-900 text-white w-full sm:w-auto"
                onClick={exportJson}
              >
                Export JSON
              </button>
              <label className="px-3 py-2 rounded-xl bg-gray-200 cursor-pointer w-full sm:w-auto text-center inline-flex justify-center">
                Import JSON
                <input
                  type="file"
                  className="hidden"
                  accept="application/json"
                  onChange={(e) =>
                    e.target.files && importJson(e.target.files[0])
                  }
                />
              </label>
            </div>
            <p className="text-xs text-gray-500">
              Use this to move progress between devices (manual).
            </p>
          </div>
        </section>

        {/* Settings */}
        <section className="rounded-2xl shadow p-4 bg-white grid gap-3 sm:grid-cols-3 items-end">
          <div>
            <label className="block text-sm font-medium">Mode</label>
            <select
              className="mt-1 w-full border rounded-xl p-2"
              value={settings.mode}
              onChange={(e) => setSettings({ ...settings, mode: e.target.value })}
            >
              <option value="recognition">Recognition (fast)</option>
              <option value="full">Full (hide all)</option>
              <option value="review">Review (narrow, revealed)</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium">Filter Pack</label>
            <select
              className="mt-1 w-full border rounded-xl p-2"
              value={filterPack}
              onChange={(e) => setFilterPack(e.target.value)}
            >
              {packs.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium">Daily goals</label>

            <div className="mt-2">
              <label className="block text-sm font-medium">Daily goal – Slow</label>
              <input
                className="mt-1 w-full border rounded-xl p-2"
                type="number"
                min={0}
                value={settings.dailyCapSlow}
                onChange={(e) => {
                  setSettings({ ...settings, dailyCapSlow: Math.max(0, Number(e.target.value || 0)) });
                  window.markDirty?.('settings');
                }}
              />
            </div>

            <div className="mt-3">
              <label className="block text-sm font-medium">Daily goal – Fast</label>
              <input
                className="mt-1 w-full border rounded-xl p-2"
                type="number"
                min={0}
                value={settings.dailyCapFast}
                onChange={(e) => {
                  setSettings({ ...settings, dailyCapFast: Math.max(0, Number(e.target.value || 0)) });
                  window.markDirty?.('settings');
                }}
              />
            </div>
          </div>
        </section>

        {/* Session Controls */}
        <section className="rounded-2xl shadow p-4 bg-white flex items-center justify-between gap-2">
          <div className="text-sm text-gray-600">
            Cards due now: {dueCards.length}
          </div>
          <div className="flex gap-2">
            <button
              className="px-4 py-2 rounded-xl bg-indigo-600 text-white"
              onClick={startSession}
            >
              Start Session
            </button>
            <button
              className="px-4 py-2 rounded-xl bg-gray-200"
              onClick={() => setRevealed(false)}
            >
              Reset Reveal
            </button>
          </div>
        </section>

        {/* Review Card */}
        <section className="rounded-2xl shadow p-6 bg-white">
          {/* Manual queue banner */}
          {sessionQueue.length > 0 && (
            <div className="rounded-xl border p-3 mb-4 bg-amber-50 text-amber-900 flex items-center justify-between">
              <span>
                Manual review queue active: {sessionQueue.length} verse
                {sessionQueue.length > 1 ? "s" : ""} remaining.
              </span>
              <button
                className="ml-4 text-xs px-2 py-1 rounded bg-amber-200 hover:bg-amber-300"
                onClick={() => setSessionQueue([])}
              >
                Cancel
              </button>
            </div>
          )}

          {!currentCard ? (
            <div className="text-center text-gray-500">No cards due. Great job!</div>
          ) : (
            <div className="space-y-4">
              <div className="text-xs text-gray-500">
                Pack: {currentCard.pack}
                {" · "}
                {currentCard?.order ? `${ordinal(currentCard.order)} Verse · ` : ""}
                {getActiveBucket(currentCard, settings.mode)}
              </div>

              <div className="text-lg font-semibold">
                {settings.mode === "recognition" ? (
                  <CardFrontRecognition
                    card={currentCard}
                    words={settings.showFirstNWords}
                  />
                ) : settings.mode === "full" ? (
                  <div>
                    <div className="text-gray-700 text-sm">{currentCard.ref}</div>
                    {!revealed && (
                      <div className="mt-2 text-xs text-gray-400">
                        (Tap Reveal to see the verse text)
                      </div>
                    )}
                  </div>
                ) : (
                  <div>
                    <div className="text-gray-700 text-sm">{currentCard.ref}</div>
                  </div>
                )}
              </div>

              {settings.mode === "full" && !revealed && (
                <button
                  className="px-4 py-2 rounded-xl bg-gray-900 text-white"
                  onClick={handleReveal}
                >
                  Reveal
                </button>
              )}

              <div className="text-[11px] text-gray-500">
                Shortcuts: A (Again), 1, 3, 7, 0 (30D), 9 (90D). In Full mode, press Enter/Space to Reveal.
              </div>

              {/* Verse body */}
              {settings.mode === "recognition" && (
                <div className="rounded-xl border p-4 bg-gray-50">
                  <div className="text-sm whitespace-pre-wrap">
                    {currentCard.text}
                  </div>
                </div>
              )}

              {settings.mode === "full" && revealed && (
                <div className="rounded-xl border p-4 bg-gray-50">
                  <div className="text-sm whitespace-pre-wrap">
                    {currentCard.text}
                  </div>
                </div>
              )}

              {settings.mode === "review" && (
                <div className="rounded-xl border p-4 bg-gray-50 flex justify-center">
                  <div className="text-base whitespace-pre-wrap break-words font-mono w-[25ch]">
                    {currentCard.text}
                  </div>
                </div>
              )}

              {/* Fixed-interval buttons (desktop/tablet) */}
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

              {/* Sticky mobile grading bar */}
              <div className="sm:hidden fixed left-0 right-0 bottom-0 z-40 border-t bg-white/95 backdrop-blur p-3">
                <div className="grid grid-cols-3 gap-2">
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
              </div>

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
            setRevealed(false);
            setCompleted(0);
            setSessionStart(now());
          }}
        />

        {/* View History */}
        <GoalHistoryView
          history={history}
          capLog={capLog}
          defaultWindowDays={14}
        />

        {/* Bulk Pack Manager Modal */}
        {packManagerOpen && (
          <PackManager
            cards={cards}
            onClose={() => setPackManagerOpen(false)}
            onDelete={async (packsToDelete) => {
              // Normalize helper (same as before)
              const norm = (s) => {
                const raw = String(s ?? "");
                const n = typeof raw.normalize === "function" ? raw.normalize("NFC") : raw;
                return n.replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
              };
              const delNorm = new Set(packsToDelete.map(norm));

              // 1) Delete on server (if signed in)
              try {
                const client = window.supabaseClient;
                if (client) {
                  const { data: u } = await client.auth.getUser();
                  const uid = u?.user?.id;
                  if (uid) {
                    // Use raw pack names (not normalized) for the DB filter
                    const { error } = await client
                      .from("cards")
                      .delete()
                      .eq("user_id", uid)
                      .in("pack", packsToDelete);
                    if (error) {
                      console.error("Server delete failed:", error);
                      alert("Server delete failed: " + error.message);
                    }
                  }
                }
              } catch (e) {
                console.warn("Delete on server skipped/failed:", e);
              }

              // 2) Prune locally so UI matches immediately
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
                const n =
                  typeof raw.normalize === "function"
                    ? raw.normalize("NFC")
                    : raw;
                return n.replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
              };
              const exp = new Set(packsToExport.map(norm));
              const subset = cards.filter((c) => exp.has(norm(c.pack)));
              if (subset.length === 0) {
                alert("No cards found for the selected packs.");
                return;
              }
              const blob = new Blob(
                [JSON.stringify({ cards: subset, settings }, null, 2)],
                { type: "application/json" }
              );
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `scripture_srs_packs_${new Date()
                .toISOString()
                .slice(0, 10)}.json`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          />
        )}
      </div>
    </div>
  );
}

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

function EditableArea({ card, onSave }) {
  const [editing, setEditing] = useState(false);
  const [ref, setRef] = useState(card.ref);
  const [text, setText] = useState(card.text);
  useEffect(() => {
    setRef(card.ref);
    setText(card.text);
  }, [card.id]);
  if (!editing)
    return (
      <div className="flex justify-end">
        <button
          className="text-sm text-gray-500 underline"
          onClick={() => setEditing(true)}
        >
          Edit card
        </button>
      </div>
    );
  return (
    <div className="space-y-2">
      <input
        className="w-full border rounded-xl p-2"
        value={ref}
        onChange={(e) => setRef(e.target.value)}
      />
      <textarea
        className="w-full border rounded-xl p-2 h-32"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex gap-2 justify-end">
        <button className="px-3 py-2 rounded-xl bg-gray-200" onClick={() => setEditing(false)}>
          Cancel
        </button>
        <button
          className="px-3 py-2 rounded-xl bg-gray-900 text-white"
          onClick={() => {
            onSave(ref, text);
            setEditing(false);
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function PackManager({ cards, onClose, onDelete, onExport }) {
  const summary = useMemo(() => {
    const m = new Map();
    for (const c of cards) {
      const p = c.pack;
      const b = c?.srs?.slow?.bucket || "0D";
      const v =
        m.get(p) || { count: 0, buckets: Object.fromEntries(BUCKETS.map((k) => [k, 0])) };
      v.count++;
      v.buckets[b] = (v.buckets[b] || 0) + 1;
      m.set(p, v);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [cards]);
  const [checked, setChecked] = useState(() => new Set());

  function toggleAll(state) {
    if (state) setChecked(new Set(summary.map(([p]) => p)));
    else setChecked(new Set());
  }
  function toggle(p) {
    setChecked((prev) => {
      const n = new Set(prev);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  }
  const canAct = checked.size > 0;

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="max-w-3xl w-full bg-white rounded-2xl shadow-xl p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Bulk Pack Manager</h3>
          <button className="px-3 py-2 rounded-xl bg-gray-200" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button className="px-3 py-2 rounded-xl bg-gray-100" onClick={() => toggleAll(true)}>
            Select All
          </button>
          <button className="px-3 py-2 rounded-xl bg-gray-100" onClick={() => toggleAll(false)}>
            Clear
          </button>
          <button
            className={`px-3 py-2 rounded-xl ${
              canAct ? "bg-rose-600 text-white" : "bg-gray-200 text-gray-400"
            }`}
            disabled={!canAct}
            onClick={() => {
              if (!canAct) return;
              if (confirm(`Delete ${checked.size} pack(s)?`)) onDelete(Array.from(checked));
            }}
          >
            Delete Selected
          </button>
          <button
            className={`px-3 py-2 rounded-xl ${
              canAct ? "bg-indigo-600 text-white" : "bg-gray-200 text-gray-400"
            }`}
            disabled={!canAct}
            onClick={() => onExport(Array.from(checked))}
          >
            Export Selected
          </button>
        </div>
        <div className="max-h-[60vh] overflow-auto grid sm:grid-cols-2 gap-2">
          {summary.map(([pack, v]) => (
            <label
              key={pack}
              className="flex items-start gap-3 p-3 border rounded-xl bg-gray-50 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={checked.has(pack)}
                onChange={() => toggle(pack)}
              />
              <div className="min-w-0">
                <div className="font-semibold text-gray-800 truncate" title={pack}>
                  {pack}
                </div>
                <div className="text-xs text-gray-600">Cards: {v.count}</div>
                <div className="text-[11px] text-gray-500">
                  {BUCKETS.map((k) => `${k}:${v.buckets[k] || 0}`).join("  ")}
                </div>
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
      const v =
        m.get(key) || {
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
      <div>
        Total cards: <b>{total}</b>
      </div>

      <div className="flex flex-wrap gap-2">
        <span className="px-2 py-1 rounded bg-gray-100 text-xs font-medium">Slow</span>
        {BUCKETS.map((k) => (
          <span key={`slow-${k}`} className="px-3 py-1 rounded-full bg-gray-100">
            {k}: {totals.slow[k]}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <span className="px-2 py-1 rounded bg-gray-100 text-xs font-medium">Fast</span>
        {BUCKETS.map((k) => (
          <span key={`fast-${k}`} className="px-3 py-1 rounded-full bg-gray-100">
            {k}: {totals.fast[k]}
          </span>
        ))}
      </div>

      <div className="mt-2">
        <div className="font-medium mb-1">By Pack (slow / fast)</div>
        <div className="grid sm:grid-cols-2 gap-2">
          {byPack.map(([pack, v]) => (
            <div key={pack} className="rounded-xl border p-2 bg-gray-50">
              <div className="font-semibold text-gray-700 truncate" title={pack}>
                {pack}
              </div>
              <div className="text-xs text-gray-600">Cards: {v.count}</div>
              <div className="text-xs text-gray-600">
                Slow: {BUCKETS.map((k) => `${k}:${v.slow[k]}`).join("  ")}
              </div>
              <div className="text-xs text-gray-600">
                Fast: {BUCKETS.map((k) => `${k}:${v.fast[k]}`).join("  ")}
              </div>
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
}) {
  // Filter by pack
  const list = useMemo(() => {
    const arr =
      currentPack && currentPack !== "ALL"
        ? cards.filter((c) => c.pack === currentPack)
        : cards.slice();
    // Sort by pack order then ref for stability
    return arr.sort((a, b) => {
      if (a.pack !== b.pack) return a.pack.localeCompare(b.pack);
      const ao = a.order ?? Number.POSITIVE_INFINITY,
            bo = b.order ?? Number.POSITIVE_INFINITY;
      if (ao !== bo) return ao - bo;
      return String(a.ref).localeCompare(String(b.ref));
    });
  }, [cards, currentPack]);

  const [checked, setChecked] = useState(() => new Set());

  const allVisibleIds = list.map((c) => c.id);
  const allChecked = checked.size > 0 && allVisibleIds.every((id) => checked.has(id));

  const toggleOne = (id) =>
    setChecked((prev) => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });

  const toggleAll = () =>
    setChecked((prev) => {
      if (allChecked) return new Set(); // clear
      return new Set(allVisibleIds); // select all
    });

  return (
    <section className="rounded-2xl shadow p-4 bg-white">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="font-semibold">View Verses</h2>
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full">
          <div className="flex items-center gap-2">
            <label className="text-sm">Schedule:</label>
            <select
              className="border rounded-xl p-2 text-sm"
              value={scheduleKey}
              onChange={(e) => onChangeScheduleKey(e.target.value)}
            >
              <option value="slow">Slow (Review/Full)</option>
              <option value="fast">Fast (Recognition)</option>
            </select>
          </div>

          <div className="flex items-center gap-2 sm:ml-3 min-w-0 w-full">
            <label className="text-sm">Pack:</label>
            <div className="min-w-0 flex-1">
              <select
                className="border rounded-xl p-2 text-sm w-full sm:w-56"
                value={currentPack}
                onChange={(e) => onChangePack(e.target.value)}
              >
                {packs.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        <button className="px-3 py-2 rounded-xl bg-gray-100" onClick={toggleAll}>
          {allChecked ? "Clear All" : "Select All"}
        </button>
        <button
          className={`px-3 py-2 rounded-xl ${
            checked.size ? "bg-indigo-600 text-white" : "bg-gray-200 text-gray-400"
          }`}
          disabled={!checked.size}
          onClick={() =>
            onStartManual(
              // Manual queue order: by pack order
              list.filter((c) => checked.has(c.id)).map((c) => c.id)
            )
          }
        >
          Review selected now
        </button>
      </div>

      <div className="mt-3 grid gap-2 overflow-x-auto">
        {list.map((c) => {
          const sub = c?.srs?.[scheduleKey];
          const since = daysSince(sub?.updatedAt);
          const till = daysTill(sub?.nextDue);
          const bucket = sub?.bucket || "0D";
          return (
            <label
              key={c.id}
              className="flex items-start gap-3 p-3 border rounded-xl bg-gray-50"
            >
              <input
                type="checkbox"
                checked={checked.has(c.id)}
                onChange={() => toggleOne(c.id)}
              />
              <div className="min-w-0">
                <div className="font-semibold text-gray-800 truncate" title={c.ref}>
                  {c.ref}
                </div>
                <div className="text-xs text-gray-600 truncate">
                  {previewText(c.text, 10)}
                </div>
                <div className="text-[11px] text-gray-500 mt-1">
                  {c.pack} · #{c.order ?? "?"} · {bucket} · since: {since ?? "–"}d ·
                  till: {till ?? "–"}d
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
  const [group, setGroup] = React.useState("day"); // "day" | "week" | "month" | "year"
  // Choose rolling window sizes
  const windowSizes = { day: defaultWindowDays, week: 12, month: 12, year: 5 };

  // Build per-day review counts from raw history
  const perDayCounts = React.useMemo(() => {
    const map = new Map(); // key YYYY-MM-DD -> { slow: n, fast: n }
    for (const h of history) {
      const key = isoDay(h.ts || Date.now());
      const cur = map.get(key) || { slow: 0, fast: 0 };
      if (h.mode === "slow") cur.slow += 1;
      else cur.fast += 1;
      map.set(key, cur);
    }
    return map;
  }, [history]);

  // Helper: effective caps for a date = snapshot that day if present, else the latest prior snapshot if any
  const effectiveCapsForDate = React.useMemo(() => {
    const entries = Object.entries(capLog)
      .map(([k,v]) => [k, { slow: Number(v?.slow||0), fast: Number(v?.fast||0) }])
      .sort((a,b) => a[0].localeCompare(b[0])); // sort by day ascending
    return function getCaps(dayKey) {
      // binary search latest entry <= dayKey
      let lo = 0, hi = entries.length - 1, ans = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const mk = entries[mid][0];
        if (mk <= dayKey) { ans = entries[mid][1]; lo = mid + 1; }
        else { hi = mid - 1; }
      }
      return ans || { slow: 0, fast: 0 }; // default if we have no snapshots yet
    };
  }, [capLog]);

  // Build rows based on grouping
  const rows = React.useMemo(() => {
    const nowTs = Date.now();
    const out = [];
    const kind = group;

    // Select the last N periods and aggregate both caps and reviews
    const N = windowSizes[kind];

    // Build a list of period keys (most recent first)
    const periodKeys = [];
    if (kind === "day") {
      for (let i = 0; i < N; i++) {
        const d = new Date(nowTs - i*day);
        periodKeys.push(isoDay(d));
      }
    } else if (kind === "week") {
      let d = new Date(); d.setUTCHours(0,0,0,0);
      // align to week start
      let start = new Date(startOfWeekISO(d));
      for (let i = 0; i < N; i++) {
        const key = isoDay(new Date(start.getTime() - i*7*day));
        periodKeys.push(key); // week key is a Monday date
      }
    } else if (kind === "month") {
      let cur = new Date(); cur.setUTCDate(1); cur.setUTCHours(0,0,0,0);
      for (let i = 0; i < N; i++) {
        const d = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() - i, 1));
        periodKeys.push(monthKey(d));
      }
    } else { // year
      const y = new Date().getUTCFullYear();
      for (let i = 0; i < N; i++) periodKeys.push(String(y - i));
    }

    // Aggregation helpers
    function bucketKeyByGroup(dt) {
      if (kind === "day") return isoDay(dt);
      if (kind === "week") return weekKey(dt);
      if (kind === "month") return monthKey(dt);
      return yearKey(dt);
    }

    // Aggregate reviews by period
    const aggReviews = new Map(); // periodKey -> { slow, fast }
    for (const [dKey, counts] of perDayCounts.entries()) {
      const pKey = bucketKeyByGroup(dKey);
      const cur = aggReviews.get(pKey) || { slow: 0, fast: 0 };
      cur.slow += counts.slow;
      cur.fast += counts.fast;
      aggReviews.set(pKey, cur);
    }

    // Aggregate caps by period by summing effective caps of each day in that period
    function* iterateDaysOfPeriod(pKey) {
      if (kind === "day") {
        yield pKey;
        return;
      }
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
      // year
      const y = Number(pKey);
      const start = Date.UTC(y, 0, 1), next = Date.UTC(y+1, 0, 1);
      for (let t = start; t < next; t += day) yield isoDay(t);
    }

    const aggCaps = new Map(); // periodKey -> { slow, fast }
    for (const pKey of periodKeys) {
      let slow = 0, fast = 0;
      for (const dKey of iterateDaysOfPeriod(pKey)) {
        // Only sum days up to today
        if (dKey > isoDay(nowTs)) break;
        const caps = effectiveCapsForDate(dKey);
        slow += caps.slow || 0;
        fast += caps.fast || 0;
      }
      aggCaps.set(pKey, { slow, fast });
    }

    // Build output rows newest → oldest
    for (const pKey of periodKeys) {
      const cap = aggCaps.get(pKey) || { slow: 0, fast: 0 };
      const rev = aggReviews.get(pKey) || { slow: 0, fast: 0 };
      const okSlow = rev.slow >= cap.slow;
      const okFast = rev.fast >= cap.fast;
      const label = (function() {
        if (kind === "day") return pKey;
        if (kind === "week") return `Week of ${pKey}`;
        if (kind === "month") return pKey;
        return pKey;
      })();
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
          <select
            className="border rounded-xl p-2 text-sm"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
          >
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
                <div className={`text-sm font-semibold ${totalClass}`}>
                  Total {totalRev} / {totalCap}
                </div>
              </div>
              <div className="text-xs text-gray-700 mt-1 flex flex-wrap gap-4">
                <div className={slowClass}>
                  Slow: {r.rev.slow} / {r.cap.slow}
                </div>
                <div className={fastClass}>
                  Fast: {r.rev.fast} / {r.cap.fast}
                </div>
              </div>
            </div>
          );
        })}
        {rows.length === 0 && (
          <div className="text-sm text-gray-500">No data yet.</div>
        )}
      </div>
      <p className="mt-3 text-[11px] text-gray-500">
        Goals are snapshotted daily and summed for weekly/monthly/yearly views. Colors: green = goal met, red = not met.
      </p>
    </section>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
