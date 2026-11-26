(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WakeUp = api;
})(globalThis, function () {
  const ANSWER_LENGTH = 5;
  const KOREAN_ANSWER_LENGTH = 2;
  const KOREAN_GROUPS = ["5확신", "8동행", "60구절", "242"];
  const TMS_PARTS = ["A", "B", "C", "D", "E"];
  const VERSES_PER_TMS_PART = 12;
  const ROUND_MS = 180_000;
  const BASE_HEALTH = 6;
  const BOSS_HEALTH = 6;
  const WAVES = [
    { startsAt: 0, enemyMs: 15_000 },
    { startsAt: 60_000, enemyMs: 12_000 },
    { startsAt: 150_000, enemyMs: 10_000 },
  ];

  function letters(text) {
    const plain = text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
    return plain.match(/\p{L}/gu) || [];
  }

  function verseContent(text) {
    // Older cards can start with multiple bracketed labels or a parenthesized heading.
    const labels = /^(?:\([^)]*\)\s*[-–—]\s*(?=\[))?(?:\[[^\]]*\]\s*(?:[-–—]\s*(?=\[))?)+/u;
    return text.trim().replace(labels, "").replace(/\s*\(Vers[aã]o [^)]*\)$/i, "").trim();
  }

  function makeDeck(shuffledCards, today) {
    const familiar = [];
    const due = [];
    const seen = new Set();
    for (const card of shuffledCards) {
      const packNumber = /^\s*(\d+)\s*[-–—]/.exec(card.pack)?.[1];
      if (!packNumber || Number(packNumber) < 22 || !card.ref?.trim() || card.deleted_at) continue;

      const text = verseContent(card.text || "");
      const prefix = letters(text).slice(0, ANSWER_LENGTH);
      if (prefix.length < ANSWER_LENGTH) continue;
      const answer = prefix.join("");
      const key = `${card.ref.trim().toLowerCase()}|${answer}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pile = (card.srs_slow_next_due ?? 0) <= today ? due : familiar;
      pile.push({ id: card.id, ref: card.ref, text, answer });
    }

    const deck = [];
    for (let i = 0; i * 2 < familiar.length || i < due.length; i++) {
      if (familiar[i * 2]) deck.push(familiar[i * 2]);
      if (familiar[i * 2 + 1]) deck.push(familiar[i * 2 + 1]);
      if (due[i]) deck.push(due[i]);
    }
    return deck;
  }

  function makeKoreanDeck(packs, { groups = KOREAN_GROUPS, answerSource = "text", depTitleSource = "subtitle" } = {}) {
    const cards = [];
    const packsByReference = new Map();
    const promptsByPack = new Map();
    const selected = new Set(groups);
    const titleMode = answerSource === "title";
    for (const { name, verses } of packs) {
      const dep = /^DEP[1-8](?=\s|[-–—]|$)/u.exec(name)?.[0];
      const group = dep ? "242" : name;
      if (!KOREAN_GROUPS.includes(group)) continue;
      const pack = dep || name;
      const splitDepTitles = titleMode && /^DEP[2-7]$/.test(pack);
      for (const [index, verse] of verses.entries()) {
        const reference = verse.ref.trim().replace(/\s+(?=\d)/g, "");
        if (!packsByReference.has(reference)) packsByReference.set(reference, new Set());
        packsByReference.get(reference).add(pack);
        const part = group === "60구절" ? TMS_PARTS[Math.floor(index / VERSES_PER_TMS_PART)] : null;
        const selection = part ? `${group} ${part}` : pack;
        if (!selected.has(group) && !selected.has(selection)) continue;

        const hasDepHeading = splitDepTitles && Boolean(verse.heading?.trim());
        const useHeading = hasDepHeading && depTitleSource === "heading";
        const field = useHeading ? "heading" : titleMode ? "title" : "text";
        const answerKind = hasDepHeading && !useHeading ? "subtitle" : titleMode ? "title" : "text";
        const text = verse[field] || "";
        const prefix = letters(text).slice(0, KOREAN_ANSWER_LENGTH);
        if (prefix.length < KOREAN_ANSWER_LENGTH) continue;
        const answer = prefix.join("");
        const id = `${pack}|${reference}|${answer}`;
        const key = `${pack}|${reference}`;
        if (!promptsByPack.has(key)) promptsByPack.set(key, new Set());
        const answers = promptsByPack.get(key);
        if (answers.has(answer)) continue;
        answers.add(answer);
        const relatedTitle = useHeading ? verse.title : verse.heading;
        cards.push({ id, pack, ref: reference, text, answer, answerKind, relatedTitle });
      }
    }
    return cards.map(({ pack, ref, relatedTitle, ...card }) => {
      const repeatedInPack = promptsByPack.get(`${pack}|${ref}`).size > 1;
      const labeled = repeatedInPack || packsByReference.get(ref).size > 1;
      return {
        ...card,
        ref: labeled ? `${pack} - ${ref}` : ref,
        hint: repeatedInPack && answerSource === "title" ? relatedTitle : undefined,
      };
    });
  }

  function startRound(deck, at) {
    return {
      deck, startedAt: at, endsAt: at + ROUND_MS,
      wave: 0, turn: 0, enemyStartedAt: at, enemyEndsAt: at + WAVES[0].enemyMs,
      health: BASE_HEALTH, bossHealth: BOSS_HEALTH, hits: 0, misses: [],
      draft: "", upgrade: null, feedback: null, outcome: null,
    };
  }

  function currentEnemy(round) {
    return round.deck[round.turn % round.deck.length];
  }

  function recordMiss(round, typed) {
    return [...round.misses, { card: currentEnemy(round), typed }];
  }

  function resolveTurn(round, at, feedback, typed = round.draft) {
    const hit = feedback === "hit";
    const health = round.health - Number(!hit);
    const damage = hit && round.wave === WAVES.length - 1 ? (round.upgrade === "power" ? 2 : 1) : 0;
    const bossHealth = Math.max(0, round.bossHealth - damage);
    return {
      ...round, health, bossHealth, feedback, draft: "",
      hits: round.hits + Number(hit),
      misses: hit ? round.misses : recordMiss(round, typed),
      outcome: health === 0 ? "defeat" : bossHealth === 0 ? "victory" : null,
      turn: round.turn + 1, enemyStartedAt: at, enemyEndsAt: at + WAVES[round.wave].enemyMs,
    };
  }

  function advanceRound(round, at) {
    if (round.outcome) return round;
    if (at >= round.endsAt) {
      const misses = round.draft.trim() ? recordMiss(round, round.draft) : round.misses;
      return { ...round, misses, draft: "", outcome: "time" };
    }
    let wave = round.wave;
    while (wave + 1 < WAVES.length && at - round.startedAt >= WAVES[wave + 1].startsAt) wave++;
    if (wave !== round.wave) round = { ...round, wave };
    if (at >= round.enemyEndsAt) return resolveTurn(round, at, "timeout");
    return round;
  }

  function attack(round, at, turn, text) {
    const next = advanceRound(round, at);
    if (next.outcome || next.turn !== turn) return next;
    const typed = letters(text);
    const answer = currentEnemy(next).answer;
    if (typed.length !== [...answer].length) return next;
    return resolveTurn(next, at, typed.join("") === answer ? "hit" : "miss", text);
  }

  function chooseUpgrade(round, at, upgrade) {
    const next = advanceRound(round, at);
    if (next.outcome || next.wave === 0 || next.upgrade) return next;
    if (upgrade === "power") return { ...next, upgrade };
    if (upgrade === "repair" && next.health < BASE_HEALTH) {
      return { ...next, upgrade, health: Math.min(BASE_HEALTH, next.health + 2) };
    }
    return next;
  }

  return {
    BASE_HEALTH, BOSS_HEALTH, WAVES, letters, makeDeck, makeKoreanDeck, startRound,
    currentEnemy, advanceRound, attack, chooseUpgrade,
  };
});
