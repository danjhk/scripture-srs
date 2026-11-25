function WakeUpGame({ userId, onClose }) {
  const [deck, setDeck] = React.useState(null);
  const [error, setError] = React.useState(false);
  const [loadAttempt, setLoadAttempt] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    async function loadCards() {
      const cards = [];
      const pageSize = 1000;
      for (let start = 0; ; start += pageSize) {
        const { data, error } = await window.supabaseClient.from("cards")
          .select("id, ref, text, pack, srs_slow_next_due")
          .eq("user_id", userId)
          .is("deleted_at", null)
          .order("id")
          .range(start, start + pageSize - 1);
        if (cancelled) return;
        if (error) throw error;
        cards.push(...data);
        if (data.length < pageSize) break;
      }
      setDeck(WakeUp.makeDeck(shuffleInPlace(cards), Date.now()));
    }
    loadCards().catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [userId, loadAttempt]);

  return (
    <main className="min-h-screen bg-slate-950 px-3 pb-8 pt-14 text-slate-100 sm:px-6">
      <div className="mx-auto max-w-xl space-y-3">
        <header className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Wake-Up</h1>
          <button type="button" className="min-h-11 rounded-lg px-2.5 text-sm text-slate-300 hover:bg-slate-800" onClick={onClose}>
            Back to Scripture SRS
          </button>
        </header>
        {deck?.length ? <WakeUpBattle deck={deck} /> : (
          <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
            <p role="status" className="text-slate-300">
              {error ? "Couldn’t load your verse cards." : deck ? "Wake-Up uses cards from pack 22 (Treinamento60) onward. Add or sync those packs to play." : "Loading your verse cards…"}
            </p>
            {error && (
              <button type="button" className="min-h-11 rounded-lg bg-teal-300 px-4 font-semibold text-slate-950"
                onClick={() => { setError(false); setLoadAttempt((attempt) => attempt + 1); }}>
                Try again
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

function WakeUpBattle({ deck }) {
  const [round, setRound] = React.useState(() => WakeUp.startRound(deck, performance.now()));
  const [clock, setClock] = React.useState(round.startedAt);
  const input = React.useRef(null);
  const resultHeading = React.useRef(null);
  const composing = React.useRef(false);

  React.useEffect(() => {
    if (round.outcome) {
      resultHeading.current?.focus();
      return;
    }
    function tick() {
      const at = performance.now();
      setClock(at);
      setRound((current) => WakeUp.advanceRound(current, at));
    }
    const timer = setInterval(tick, 100);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [round.outcome]);

  if (round.outcome) {
    const heading = { victory: "Boss defeated", defeat: "Base fell", time: "Time’s up" }[round.outcome];
    const missed = new Map();
    for (const { card, typed } of round.misses) {
      if (!missed.has(card.id)) missed.set(card.id, { card, attempts: [] });
      missed.get(card.id).attempts.push(typed);
    }
    return (
      <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-5">
        <div>
          <h2 ref={resultHeading} tabIndex={-1} className="text-2xl font-bold">{heading}</h2>
          <p className="mt-1 text-slate-300">{round.hits} {round.hits === 1 ? "hit" : "hits"} · {missed.size} {missed.size === 1 ? "verse missed" : "verses missed"}</p>
        </div>
        {missed.size > 0 && (
          <ul className="divide-y divide-slate-800">
            {Array.from(missed.values(), ({ card, attempts }) => (
              <li key={card.id} className="py-3 first:pt-0 last:pb-0">
                <strong>{card.ref}</strong>
                <dl className="mb-2 mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-slate-300">You typed</dt>
                  <dd>
                    {attempts.map((typed, index) => (
                      <div key={index}>
                        {typed.trim()
                          ? <code className="whitespace-pre-wrap break-words text-rose-300">{typed}</code>
                          : <span className="text-slate-400">No answer entered</span>}
                      </div>
                    ))}
                  </dd>
                  <dt className="text-slate-300">Correct</dt>
                  <dd><code className="uppercase tracking-widest text-teal-300">{card.answer}</code></dd>
                </dl>
                <p className="mt-1 text-sm leading-relaxed text-slate-300">{card.text}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  const answer = round.draft;
  const count = WakeUp.letters(answer).length;
  const seconds = Math.max(0, Math.ceil((round.endsAt - clock) / 1000));
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const approaching = Math.min(1, Math.max(0, (clock - round.enemyStartedAt) / (round.enemyEndsAt - round.enemyStartedAt)));
  const wave = WakeUp.WAVES[round.wave];
  const boss = round.wave === WakeUp.WAVES.length - 1;
  const feedback = { hit: "Hit!", miss: "Miss. Base took damage.", timeout: "Enemy reached the base." }[round.feedback];

  function updateAnswer(event) {
    const draft = event.target.value;
    setRound((current) => current.turn === round.turn && !current.outcome ? { ...current, draft } : current);
  }

  function submit(event) {
    event.preventDefault();
    if (composing.current) return;
    const at = performance.now();
    setRound((current) => WakeUp.attack(current, at, round.turn, answer));
    input.current?.focus({ preventScroll: true });
  }

  function upgrade(kind) {
    const at = performance.now();
    setRound((current) => WakeUp.chooseUpgrade(current, at, kind));
    input.current?.focus({ preventScroll: true });
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-lg shadow-black/30">
      <div className="grid grid-cols-3 gap-2 border-b border-slate-800 px-4 py-2.5 text-sm">
        <div><span className="block text-xs text-slate-300">Time left</span><strong className="font-mono text-lg tabular-nums">{time}</strong></div>
        <div className="text-center"><span className="block text-xs text-slate-300">Base</span><strong className="text-lg text-teal-300 tabular-nums">{round.health}/{WakeUp.BASE_HEALTH}</strong></div>
        <div className="text-right"><span className="block text-xs text-slate-300">Hits</span><strong className="text-lg tabular-nums">{round.hits}</strong></div>
      </div>
      <div className="wake-up-arena">
        <div className="relative z-10 flex justify-between px-4 pt-2.5 text-xs font-semibold text-slate-200">
          <span>{wave.name}</span>
          {boss && <span>Boss health {round.bossHealth}/{WakeUp.BOSS_HEALTH}</span>}
        </div>
        <div className="wake-up-lane" aria-hidden="true">
          <div className="wake-up-base" />
          <div key={round.turn} className={`wake-up-enemy${boss ? " wake-up-enemy-boss" : ""}`} style={{ right: `${5 + approaching * 79}%` }} />
          {round.feedback === "hit" && <div key={`shot-${round.turn}`} className="wake-up-shot" />}
        </div>
      </div>
      <div className="space-y-2 px-4 pb-4 pt-3 sm:px-5">
        <h2 className="text-2xl font-bold leading-tight" lang="pt">{WakeUp.currentEnemy(round).ref}</h2>
        <form onSubmit={submit}>
          <label htmlFor="wake-up-answer" className="block text-sm text-slate-300">Type the first five letters. Spaces and accents are ignored.</label>
          <div className="mt-2 flex gap-2">
            <input id="wake-up-answer" ref={input} autoFocus value={answer} onChange={updateAnswer}
              onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
              autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="go" lang="pt"
              className="min-h-11 min-w-0 flex-1 rounded-lg border border-slate-600 bg-slate-950 px-3 font-mono text-lg text-white focus:border-teal-300 focus:outline-none focus:ring-2 focus:ring-teal-300/40" />
            <button type="submit" disabled={count !== WakeUp.ANSWER_LENGTH} onMouseDown={(event) => event.preventDefault()}
              className="min-h-11 shrink-0 rounded-lg bg-teal-300 px-4 font-bold text-slate-950 hover:bg-teal-200 disabled:bg-slate-800 disabled:text-slate-400">
              Attack
            </button>
          </div>
        </form>
        <div className="flex min-h-5 items-baseline justify-between gap-2 text-sm">
          <span role="status" className={round.feedback === "hit" ? "text-teal-300" : "text-rose-300"}>{feedback}</span>
          <span className={count > WakeUp.ANSWER_LENGTH ? "text-rose-300" : "text-slate-300"}>{count}/{WakeUp.ANSWER_LENGTH} letters</span>
        </div>
        {round.wave > 0 && !round.upgrade && (
          <div className="flex flex-wrap gap-2 border-t border-slate-800 pt-3" role="group" aria-label="Choose one upgrade">
            <button type="button" disabled={round.health === WakeUp.BASE_HEALTH} onClick={() => upgrade("repair")}
              className="min-h-11 rounded-lg border border-slate-600 px-3 text-sm disabled:opacity-50">Repair +2 base health</button>
            <button type="button" onClick={() => upgrade("power")}
              className="min-h-11 rounded-lg border border-slate-600 px-3 text-sm">Power +1 boss damage</button>
          </div>
        )}
      </div>
    </section>
  );
}
