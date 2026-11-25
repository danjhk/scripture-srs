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
  const host = React.useRef(null);
  React.useEffect(() => WakeUpBattleUI.mount(host.current, deck), [deck]);
  return <div ref={host} />;
}
