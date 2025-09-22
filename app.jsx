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
  const id = hashString(`${ref}|${text}`);
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
  // If we’re not currently applying a cloud pull, schedule a push
  if (!window._syncFromCloud && typeof window.schedulePush === 'function') {
    window.schedulePush();
  }
}
function loadState() {
  const raw = localStorage.getItem(LS_KEY);
  if (!raw) return { cards: [], settings: defaultSettings() };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.settings) parsed.settings = defaultSettings();
    return parsed;
  } catch {
    return { cards: [], settings: defaultSettings() };
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
    shuffle: true,
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
  }, []);

  useEffect(() => {
    saveState({ cards, settings, history, daily });
  }, [cards, settings, history, daily]);

  // When index.html finishes a pull (or another tab updates storage), reload into state
  useEffect(() => {
    function applyPulled() {
      try {
        const s = loadState();
        if (Array.isArray(s.cards)) setCards(s.cards);
        if (s.settings) setSettings(s.settings);
        if (Array.isArray(s.history)) setHistory(s.history);
        if (s.daily) setDaily(s.daily);
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

  const packs = useMemo(
    () => ["ALL", ...Array.from(new Set(cards.map((c) => c.pack))).sort()],
    [cards]
  );

  const dueCards = useMemo(() => {
    const t = now();
    const key = settings.mode === "recognition" ? "fast" : "slow";
    let list = cards.filter((c) => {
      const nd = c?.srs?.[key]?.nextDue ?? 0;
      return nd <= t;
    });
    if (filterPack !== "ALL") list = list.filter((c) => c.pack === filterPack);
    if (settings.shuffle) list = shuffle([...list]);
    const remain = Math.max(0, dailyRemaining(settings.mode));
    return list.slice(0, remain);
  }, [cards, filterPack, settings.shuffle, settings.mode, daily]);

  // If manual queue is active, pull from it; else, use dueCards
  const currentCard = useMemo(() => {
    if (sessionQueue.length > 0) {
      const id = sessionQueue[0];
      return cards.find((c) => c.id === id) || null;
    }
    return dueCards[0];
  }, [sessionQueue, cards, dueCards]);

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
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
      for (const line of lines) {
        const card = parseLineToCard(line, f.name);
        if (card) imported.push(migrateCardSRS(card));
      }
    }

    const all = [...cards];
    const existing = new Set(all.map((c) => c.id));
    const fresh = imported.filter((c) => !existing.has(c.id));

    const merged = [...all, ...fresh];
    const withOrder = assignOrdersByPack(merged);

    setCards(withOrder);
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
    const updated = {
      ...currentCard,
      ref: newRef,
      text: newText,
      id: hashString(`${newRef}|${newText}`),
      updatedAt: now(),
    };
    setCards((prev) => prev.map((c) => (c.id === currentCard.id ? updated : c)));
  }

  // minutes with one decimal
  const sessionElapsedMin = sessionStart
    ? Math.round((now() - sessionStart) / 6000) / 10
    : 0;

  return (
    <div className="min-h-screen bg-gray-50 p-4 pb-28 sm:pb-4">
      <div className="max-w-3xl mx-auto space-y-4">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Scripture SRS</h1>
          <div className="flex items-center gap-2">
            <button
              className="px-3 py-2 rounded-xl bg-gray-200"
              onClick={() => setPackManagerOpen(true)}
            >
              Manage Packs
            </button>
            <button
              className="px-3 py-2 rounded-xl bg-gray-200"
              onClick={() => window.pullSRS ? window.pullSRS() : alert('Sign in first (top-right)')}
            >
              Pull from Cloud
            </button>
            <button
              className="px-3 py-2 rounded-xl bg-gray-200"
              onClick={() => window.pushSRS ? window.pushSRS() : alert('Sign in first (top-right)')}
            >
              Push to Cloud
            </button>

            <div className="text-sm text-gray-600">
              Due: {dueCards.length} | Done: {completed} | {sessionElapsedMin}m
            </div>
            {/* Sync status chip */}
            <span
              className={
                "text-xs px-2 py-1 rounded-full " +
                (sync.pushing || sync.pulling ? "bg-amber-100 text-amber-800" : "bg-gray-100 text-gray-700")
              }
              title={`Last pull: ${fmtTime(sync.lastPullAt)} · Last push: ${fmtTime(sync.lastPushAt)}`}
            >
              {sync.pushing ? "Pushing…" : (sync.pulling ? "Pulling…" : `Last pull ${fmtTime(sync.lastPullAt)}`)}
            </span>
          </div>
        </header>

        {/* Daily cap status bar */}
        <div className="text-xs text-gray-500">
          Daily {settings.mode === "recognition" ? "FAST" : "SLOW"} cap:{" "}
          {settings.mode === "recognition"
            ? settings.dailyCapFast
            : settings.dailyCapSlow}
          {" · "}used:{" "}
          {settings.mode === "recognition" ? daily.fast : daily.slow}
          {" · "}left: {Math.max(0, dailyRemaining(settings.mode))}
        </div>

        {/* Import / Export */}
        <section className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl shadow p-4 bg-white">
            <h2 className="font-semibold mb-2">Import TXT Packs</h2>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".txt"
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
            <div className="flex gap-2">
              <button
                className="px-3 py-2 rounded-xl bg-gray-900 text-white"
                onClick={exportJson}
              >
                Export JSON
              </button>
              <label className="px-3 py-2 rounded-xl bg-gray-200 cursor-pointer">
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
            <label className="block text-sm font-medium">Session Target</label>
            <input
              className="mt-1 w-full border rounded-xl p-2"
              type="number"
              min={10}
              max={200}
              value={settings.sessionTarget}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  sessionTarget: Number(e.target.value),
                })
              }
            />
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
        <HistoryView history={history} cards={cards} />

        {/* Bulk Pack Manager Modal */}
        {packManagerOpen && (
          <PackManager
            cards={cards}
            onClose={() => setPackManagerOpen(false)}
            onDelete={(packsToDelete) => {
              const norm = (s) => {
                const raw = String(s ?? "");
                const n =
                  typeof raw.normalize === "function"
                    ? raw.normalize("NFC")
                    : raw;
                return n.replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
              };
              const del = new Set(packsToDelete.map(norm));
              setCards((prev) => {
                const before = prev.length;
                const next = prev.filter((c) => !del.has(norm(c.pack)));
                const removed = before - next.length;
                if (removed === 0) alert("No cards matched those pack names.");
                else alert(`Deleted ${removed} card(s) from ${del.size} pack(s).`);
                return next;
              });
              if (filterPack !== "ALL" && del.has(norm(filterPack)))
                setFilterPack("ALL");
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
      const ao = a.order ?? 1,
        bo = b.order ?? 1;
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

function HistoryView({ history, cards }) {
  const thirtyDaysAgo = now() - 30 * day;

  const rows = useMemo(() => {
    // newest → oldest, last 30 days
    const recent = history
      .filter((h) => (h.ts || 0) >= thirtyDaysAgo)
      .sort((a, b) => b.ts - a.ts);
    return recent.map((h) => {
      const card = cards.find((c) => c.id === h.cardId);
      const sub = card?.srs?.[h.mode]; // 'fast' or 'slow' as logged
      const since = daysSince(sub?.updatedAt);
      const till = daysTill(sub?.nextDue);
      return { ...h, card, since, till, bucketNow: sub?.bucket || null };
    });
  }, [history, cards]);

  return (
    <section className="rounded-2xl shadow p-4 bg-white">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">View History (last 30 days)</h2>
        <div className="text-sm text-gray-500">{rows.length} entries</div>
      </div>

      <div className="mt-3 grid gap-2 overflow-x-auto">
        {rows.map((r) => (
          <div key={r.id} className="p-3 border rounded-xl bg-gray-50">
            <div className="text-sm font-semibold">
              {r.card?.ref || "(deleted)"}{" "}
              <span className="text-xs text-gray-500">· {r.pack}</span>
            </div>
            <div className="text-xs text-gray-600">
              {new Date(r.ts).toLocaleString()} ·{" "}
              {r.mode === "fast" ? "Recognition" : "Review/Full"}
            </div>
            <div className="text-xs text-gray-700 mt-1">
              {r.fromBucket} → {r.toBucket}
              {r.bucketNow && r.bucketNow !== r.toBucket ? ` (now: ${r.bucketNow})` : ""}
            </div>
            <div className="text-[11px] text-gray-500">
              since: {r.since ?? "–"}d · till: {r.till ?? "–"}d
            </div>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="text-sm text-gray-500">No reviews in the last 30 days.</div>
        )}
      </div>
    </section>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
