const { useEffect, useMemo, useRef, useState } = React;

// ----- Types -----
// Card: { id, ref, text, pack, box, nextDue, createdAt, updatedAt }

// ----- Utilities -----
const LS_KEY = "scripture_srs_v1";
const now = () => Date.now();
const day = 24 * 60 * 60 * 1000;
const BOX_INTERVALS = [0, 1 * day, 3 * day, 7 * day, 14 * day, 30 * day];

function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

function parseLineToCard(line, fileName) {
  const clean = line.trim();
  if (!clean) return null;
  const refMatch = clean.match(/^(?<ref>(?:[1-3]\s+)?[A-Za-zÀ-ÖØ-öø-ÿ'`´^.\-]+(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ'`´^.\-]+)*\s+\d{1,3}:\d{1,3}(?:-\d{1,3})?)/);
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
  return { id, ref, text, pack: fileName, box: 1, nextDue: 0, createdAt: now(), updatedAt: now() };
}

function saveState(state) { localStorage.setItem(LS_KEY, JSON.stringify(state)); }
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

function defaultSettings() { return { sessionTarget: 50, mode: "recognition", showFirstNWords: 6, shuffle: true }; }
function nextDueFromBox(box) { return now() + BOX_INTERVALS[Math.max(1, Math.min(5, box))]; }
function clampBox(b) { return Math.max(1, Math.min(5, b)); }

// ----- Components -----
function App() {
  const [cards, setCards] = useState([]);
  const [settings, setSettings] = useState(defaultSettings());
  const [revealed, setRevealed] = useState(false);
  const [sessionStart, setSessionStart] = useState(0);
  const [completed, setCompleted] = useState(0);
  const [filterPack, setFilterPack] = useState("ALL");
  const [packManagerOpen, setPackManagerOpen] = useState(false);
  const fileInputRef = useRef(null);

  // Load & persist
  useEffect(() => { const s = loadState(); setCards(s.cards || []); setSettings({ ...defaultSettings(), ...(s.settings || {}) }); }, []);
  useEffect(() => { saveState({ cards, settings }); }, [cards, settings]);

  const packs = useMemo(() => ["ALL", ...Array.from(new Set(cards.map(c => c.pack))).sort()], [cards]);

  const dueCards = useMemo(() => {
    const t = now();
    let list = cards.filter(c => (c.nextDue || 0) <= t);
    if (filterPack !== "ALL") list = list.filter(c => c.pack === filterPack);
    if (settings.shuffle) list = shuffle([...list]);
    return list;
  }, [cards, filterPack, settings.shuffle]);

  const currentCard = dueCards[0];

  function shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }
  function startSession() { setSessionStart(now()); setCompleted(0); setRevealed(false); }
  function handleGrade(grade) {
    if (!currentCard) return;
    let newBox = currentCard.box;
    if (grade === "again") newBox = 1;
    if (grade === "good") newBox = clampBox(currentCard.box + 1);
    if (grade === "easy") newBox = clampBox(currentCard.box + 2);
    const updated = { ...currentCard, box: newBox, nextDue: nextDueFromBox(newBox), updatedAt: now() };
    setCards(prev => prev.map(c => (c.id === updated.id ? updated : c)));
    setRevealed(false); setCompleted(x => x + 1);
  }
  function handleReveal() { setRevealed(true); }

  async function importTxtFiles(files) {
    const imported = [];
    for (const f of files) {
      const text = await f.text();
      const lines = text.split(/\r?\n/);
      for (const line of lines) { const card = parseLineToCard(line, f.name); if (card) imported.push(card); }
    }
    const all = [...cards];
    const existing = new Set(all.map(c => c.id));
    const fresh = imported.filter(c => !existing.has(c.id));
    setCards([...all, ...fresh]);
    alert(`Imported ${fresh.length} new cards from ${files.length} file(s).`);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify({ cards, settings }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `scripture_srs_backup_${new Date().toISOString().slice(0,10)}.json`;
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
    const updated = { ...currentCard, ref: newRef, text: newText, id: hashString(`${newRef}|${newText}`), updatedAt: now() };
    setCards(prev => prev.map(c => (c.id === currentCard.id ? updated : c)));
  }

  // minutes with one decimal
  const sessionElapsedMin = sessionStart ? Math.round((now() - sessionStart) / 6000) / 10 : 0;

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-3xl mx-auto space-y-4">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Scripture SRS</h1>
          <div className="flex items-center gap-2">
            <button className="px-3 py-2 rounded-xl bg-gray-200" onClick={() => setPackManagerOpen(true)}>Manage Packs</button>
            <button className="px-3 py-2 rounded-xl bg-gray-200" onClick={() => alert('Cloud sync can be added later (Supabase).')}>Sync (later)</button>
            <div className="text-sm text-gray-600">Due: {dueCards.length} | Done: {completed} | {sessionElapsedMin}m</div>
          </div>
        </header>

        {/* Import / Export */}
        <section className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl shadow p-4 bg-white">
            <h2 className="font-semibold mb-2">Import TXT Packs</h2>
            <input ref={fileInputRef} type="file" multiple accept=".txt" onChange={(e) => e.target.files && importTxtFiles(Array.from(e.target.files))} />
            <p className="text-xs text-gray-500 mt-2">Tip: Each non-empty line becomes a card. Use "Reference: Verse".</p>
          </div>
          <div className="rounded-2xl shadow p-4 bg-white space-y-2">
            <h2 className="font-semibold">Backup / Restore</h2>
            <div className="flex gap-2">
              <button className="px-3 py-2 rounded-xl bg-gray-900 text-white" onClick={exportJson}>Export JSON</button>
              <label className="px-3 py-2 rounded-xl bg-gray-200 cursor-pointer">
                Import JSON
                <input type="file" className="hidden" accept="application/json" onChange={(e) => e.target.files && importJson(e.target.files[0])} />
              </label>
            </div>
            <p className="text-xs text-gray-500">Use this to move progress between devices (manual).</p>
          </div>
        </section>

        {/* Settings */}
        <section className="rounded-2xl shadow p-4 bg-white grid gap-3 sm:grid-cols-3 items-end">
          <div>
            <label className="block text-sm font-medium">Mode</label>
            <select className="mt-1 w-full border rounded-xl p-2" value={settings.mode} onChange={(e) => setSettings({ ...settings, mode: e.target.value })}>
              <option value="recognition">Recognition (fast)</option>
              <option value="full">Full (hide all)</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium">Filter Pack</label>
            <select className="mt-1 w-full border rounded-xl p-2" value={filterPack} onChange={(e) => setFilterPack(e.target.value)}>
              {packs.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium">Session Target</label>
            <input className="mt-1 w-full border rounded-xl p-2" type="number" min={10} max={200} value={settings.sessionTarget} onChange={(e) => setSettings({ ...settings, sessionTarget: Number(e.target.value) })} />
          </div>
        </section>

        {/* Session Controls */}
        <section className="rounded-2xl shadow p-4 bg-white flex items-center justify-between gap-2">
          <div className="text-sm text-gray-600">Cards due now: {dueCards.length}</div>
          <div className="flex gap-2">
            <button className="px-4 py-2 rounded-xl bg-indigo-600 text-white" onClick={startSession}>Start Session</button>
            <button className="px-4 py-2 rounded-xl bg-gray-200" onClick={() => setRevealed(false)}>Reset Reveal</button>
          </div>
        </section>

        {/* Review Card */}
        <section className="rounded-2xl shadow p-6 bg-white">
          {!currentCard ? (
            <div className="text-center text-gray-500">No cards due. Great job!</div>
          ) : (
            <div className="space-y-4">
              <div className="text-xs text-gray-500">Pack: {currentCard.pack} · Box {currentCard.box}</div>

              <div className="text-lg font-semibold">
                {settings.mode === "recognition" ? (
                  <CardFrontRecognition card={currentCard} words={settings.showFirstNWords} />
                ) : (
                  <div>
                    <div className="text-gray-700 text-sm">{currentCard.ref}</div>
                    {!revealed && (
                      <div className="mt-2 text-xs text-gray-400">(Tap Reveal to see the verse text)</div>
                    )}
                  </div>
                )}
              </div>

              {settings.mode === "full" && !revealed && (
                <button className="px-4 py-2 rounded-xl bg-gray-900 text-white" onClick={handleReveal}>Reveal</button>
              )}

              {(settings.mode === "recognition" || revealed) && (
                <div className="rounded-xl border p-4 bg-gray-50">
                  <div className="text-sm whitespace-pre-wrap">{currentCard.text}</div>
                </div>
              )}

              <div className="grid grid-cols-3 gap-2">
                <button className="px-4 py-3 rounded-xl bg-rose-600 text-white" onClick={() => handleGrade("again")}>Again</button>
                <button className="px-4 py-3 rounded-xl bg-amber-500 text-white" onClick={() => handleGrade("good")}>Good</button>
                <button className="px-4 py-3 rounded-xl bg-emerald-600 text-white" onClick={() => handleGrade("easy")}>Easy</button>
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

        {/* Bulk Pack Manager Modal */}
        {packManagerOpen && (
          <PackManager
            cards={cards}
            onClose={() => setPackManagerOpen(false)}
            onDelete={(packsToDelete) => {
              const norm = (s) => {
                const raw = String(s ?? '');
                const n = typeof raw.normalize === 'function' ? raw.normalize('NFC') : raw;
                return n.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
              };
              const del = new Set(packsToDelete.map(norm));
              setCards(prev => {
                const before = prev.length;
                const next = prev.filter(c => !del.has(norm(c.pack)));
                const removed = before - next.length;
                if (removed === 0) alert("No cards matched those pack names.");
                else alert(`Deleted ${removed} card(s) from ${del.size} pack(s).`);
                return next;
              });
              if (filterPack !== "ALL" && del.has(norm(filterPack))) setFilterPack("ALL");
              setPackManagerOpen(false);
            }}
            onExport={(packsToExport) => {
              const norm = (s) => {
                const raw = String(s ?? '');
                const n = typeof raw.normalize === 'function' ? raw.normalize('NFC') : raw;
                return n.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
              };
              const exp = new Set(packsToExport.map(norm));
              const subset = cards.filter(c => exp.has(norm(c.pack)));
              if (subset.length === 0) { alert("No cards found for the selected packs."); return; }
              const blob = new Blob([JSON.stringify({ cards: subset, settings }, null, 2)], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `scripture_srs_packs_${new Date().toISOString().slice(0,10)}.json`;
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
  const firstWords = React.useMemo(() => card.text.split(/\s+/).slice(0, words).join(" "), [card.text, words]);
  return (
    <div>
      <div className="text-gray-700 text-sm">{card.ref}</div>
      <div className="mt-1 text-2xl">{firstWords}{card.text.split(/\s+/).length > words ? " …" : ""}</div>
    </div>
  );
}

function EditableArea({ card, onSave }) {
  const [editing, setEditing] = useState(false);
  const [ref, setRef] = useState(card.ref);
  const [text, setText] = useState(card.text);
  useEffect(() => { setRef(card.ref); setText(card.text); }, [card.id]);
  if (!editing) return (
    <div className="flex justify-end">
      <button className="text-sm text-gray-500 underline" onClick={() => setEditing(true)}>Edit card</button>
    </div>
  );
  return (
    <div className="space-y-2">
      <input className="w-full border rounded-xl p-2" value={ref} onChange={e => setRef(e.target.value)} />
      <textarea className="w-full border rounded-xl p-2 h-32" value={text} onChange={e => setText(e.target.value)} />
      <div className="flex gap-2 justify-end">
        <button className="px-3 py-2 rounded-xl bg-gray-200" onClick={() => setEditing(false)}>Cancel</button>
        <button className="px-3 py-2 rounded-xl bg-gray-900 text-white" onClick={() => { onSave(ref, text); setEditing(false); }}>Save</button>
      </div>
    </div>
  );
}

function PackManager({ cards, onClose, onDelete, onExport }) {
  const summary = useMemo(() => {
    const m = new Map();
    for (const c of cards) {
      const v = m.get(c.pack) || { count: 0, boxes: [0,0,0,0,0,0] };
      v.count++; v.boxes[c.box] = (v.boxes[c.box]||0)+1; m.set(c.pack, v);
    }
    return Array.from(m.entries()).sort((a,b)=>a[0].localeCompare(b[0]));
  }, [cards]);
  const [checked, setChecked] = useState(() => new Set());

  function toggleAll(state) { if (state) setChecked(new Set(summary.map(([p]) => p))); else setChecked(new Set()); }
  function toggle(p) { setChecked(prev => { const n = new Set(prev); if (n.has(p)) n.delete(p); else n.add(p); return n; }); }
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
          <button className={`px-3 py-2 rounded-xl ${canAct? 'bg-rose-600 text-white' : 'bg-gray-200 text-gray-400'}`} disabled={!canAct}
            onClick={() => { if (!canAct) return; if (confirm(`Delete ${checked.size} pack(s)?`)) onDelete(Array.from(checked)); }}>
            Delete Selected
          </button>
          <button className={`px-3 py-2 rounded-xl ${canAct? 'bg-indigo-600 text-white' : 'bg-gray-200 text-gray-400'}`} disabled={!canAct}
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
                <div className="text-[11px] text-gray-500">Boxes: {v.boxes.slice(1).map((n,i)=>`#${i+1}:${n}`).join('  ')}</div>
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
      const v = m.get(key) || { count: 0, boxes: [0,0,0,0,0,0] };
      v.count++; v.boxes[c.box] = (v.boxes[c.box] || 0) + 1; m.set(key, v);
    }
    return Array.from(m.entries()).sort((a,b)=>a[0].localeCompare(b[0]));
  }, [cards]);
  const byBox = useMemo(() => { const arr = [0,0,0,0,0,0]; for (const c of cards) arr[c.box]++; return arr; }, [cards]);
  return (
    <div className="text-sm space-y-3">
      <div>Total cards: <b>{total}</b></div>
      <div className="flex gap-2 flex-wrap">{[1,2,3,4,5].map(b => (
        <span key={b} className="px-3 py-1 rounded-full bg-gray-100">Box {b}: {byBox[b]}</span>
      ))}</div>
      <div className="mt-2">
        <div className="font-medium mb-1">By Pack</div>
        <div className="grid sm:grid-cols-2 gap-2">
          {byPack.map(([pack, v]) => (
            <div key={pack} className="rounded-xl border p-2 bg-gray-50">
              <div className="font-semibold text-gray-700 truncate" title={pack}>{pack}</div>
              <div className="text-xs text-gray-600">Cards: {v.count}</div>
              <div className="text-xs text-gray-600">Boxes: {v.boxes.slice(1).map((n,i)=>`#${i+1}:${n}`).join("  ")}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
