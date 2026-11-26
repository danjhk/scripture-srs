const assert = require("node:assert/strict");
const test = require("node:test");
const { attack, advanceRound, chooseUpgrade, currentEnemy, makeDeck, makeKoreanDeck, startRound } = require("../wake-up.js");
const { packs } = require("../krv/verses.json");

const card = {
  id: "treinamento",
  ref: "Lamentações 3:27-28",
  pack: "22 - Treinamento60 - P.txt",
  text: "[Vontade de Deus] É bom que o homem suporte o jugo enquanto é jovem.",
};

test("deck starts at Treinamento60 and takes answers from verse text only", () => {
  const deck = makeDeck([
    { ...card, id: "old", pack: "21 - Series 5 - P.txt" },
    card,
    { id: "tess", pack: "29 - 1 Tessalonicenses.txt", ref: "1 Tessalonicenses 1:1", text: "Paulo, Silvano e Timóteo" },
    { id: "future", pack: "30 - Later", ref: "Colossenses 3:16-17", text: "(Louvor) - [Como?] - [Através da vida] 16 Habite ricamente em vocês (Versão NAA)" },
  ], 0);
  assert.deepEqual(deck.map(({ id, answer }) => [id, answer]), [
    ["treinamento", "ebomq"], ["tess", "paulo"], ["future", "habit"],
  ]);
  assert.equal(deck[2].text, "16 Habite ricamente em vocês");
});

test("attacks require exactly five letters and ignore spaces, case and accents", () => {
  const round = startRound(makeDeck([card], 0), 0);
  assert.equal(attack(round, 1_000, 0, "É bom"), round);
  assert.equal(attack(round, 1_000, 0, "É bom qu"), round);
  const hit = attack(round, 1_000, 0, "E BOM q");
  assert.equal(hit.hits, 1);
  assert.equal(hit.health, 6);
  assert.equal(hit.feedback, "hit");
  assert.equal(hit.turn, 1);
  assert.equal(attack(round, 1_000, 0, "E\u0301 BOM q").hits, 1);
  assert.equal(attack(round, 1_000, 0, "Ébomq").hits, 1);
  const miss = attack(round, 1_000, 0, "VÔn ta");
  assert.equal(miss.hits, 0);
  assert.equal(miss.health, 5);
  assert.deepEqual(miss.misses, [{ card: currentEnemy(round), typed: "VÔn ta" }]);
});

test("an expired prompt cannot fire an attack on the next verse or after the round ends", () => {
  const round = startRound(makeDeck([card], 0), 0);
  const next = attack(round, 15_000, 0, "Ébomq");
  assert.equal(next.feedback, "timeout");
  assert.equal(next.hits, 0);
  assert.equal(next.turn, 1);
  assert.equal(next.misses[0].typed, "");
  const final = attack(next, 180_000, 1, "Ébomq");
  assert.equal(final.outcome, "time");
  assert.equal(final.hits, 0);
});

test("unfinished answers are kept on a prompt timeout and at the end of the round", () => {
  const round = { ...startRound(makeDeck([card], 0), 0), draft: "É b" };
  const next = advanceRound(round, 15_000);
  assert.equal(next.draft, "");
  assert.deepEqual(next.misses, [{ card: currentEnemy(round), typed: "É b" }]);
  const final = advanceRound({ ...next, draft: "E bo" }, 180_000);
  assert.equal(final.outcome, "time");
  assert.equal(final.health, next.health);
  assert.deepEqual(final.misses.map(({ typed }) => typed), ["É b", "E bo"]);
});

test("the boss uses the same five-letter attacks and the power upgrade increases damage", () => {
  let round = startRound(makeDeck([card], 0), 0);
  round = chooseUpgrade(round, 60_000, "power");
  round = advanceRound(round, 150_000);
  for (let offset = 1_000; offset <= 3_000; offset += 1_000) {
    round = attack(round, 150_000 + offset, round.turn, "É bom q");
  }
  assert.equal(round.hits, 3);
  assert.equal(round.outcome, "victory");
});

test("Korean prompts cover 5확신, 8동행, 60구절 and DEP1–8 and label verses shared by packs", () => {
  const deck = makeKoreanDeck([...packs, { name: "DEP9 - Extra", verses: [{ ref: "창 1:1", text: "태초에" }] }]);
  const byRef = new Map(deck.map((entry) => [entry.ref, entry]));
  assert.equal(byRef.get("5확신 - 요일5:11,12").answer, "또증");
  assert.equal(byRef.get("DEP1 - 요일5:11,12").answer, "또증");
  assert.equal(byRef.get("8동행 - 요15:5").answer, "나는");
  assert.equal(byRef.get("60구절 - 딛3:5").answer, "우리");
  assert.equal(byRef.get("DEP1 - 딛3:5").answer, "우리");
  assert.equal(byRef.get("행17:11").answer, "베뢰");
  assert.ok(!deck.some(({ id }) => id.startsWith("DEP9|")));
  for (const { name } of packs) {
    assert.ok(deck.some(({ id }) => id.startsWith(`${name.split(" - ")[0]}|`)), name);
  }
});

test("Korean attacks use two syllables from the verse body and ignore spaces", () => {
  const deck = makeKoreanDeck(packs).filter(({ ref }) => ref === "5확신 - 요일5:11,12");
  const round = startRound(deck, 0);
  assert.equal(attack(round, 1_000, 0, "또"), round);
  assert.equal(attack(round, 1_000, 0, "또 증거"), round);
  assert.equal(attack(round, 1_000, 0, "구원").feedback, "miss");
  assert.equal(attack(round, 1_000, 0, "또증").hits, 1);
  assert.equal(attack(round, 1_000, 0, "또 증".normalize("NFD")).hits, 1);
});

test("Korean rounds use only selected packs and keep duplicate-reference labels", () => {
  const combined = makeKoreanDeck(packs, { groups: ["5확신", "60구절"] });
  assert.equal(combined.length, 65);
  assert.ok(combined.every(({ id }) => /^(?:5확신|60구절)\|/.test(id)));
  assert.ok(combined.some(({ ref }) => ref === "60구절 - 딛3:5"));
  const depOnly = makeKoreanDeck(packs, { groups: ["242"] });
  assert.ok(depOnly.every(({ id }) => /^DEP[1-8]\|/.test(id)));
  assert.equal(new Set(depOnly.map(({ id }) => id.split("|")[0])).size, 8);
  assert.deepEqual(makeKoreanDeck(packs, { groups: [] }), []);
});

test("title mode grades the first two characters of the title and distinguishes repeated DEP titles", () => {
  const titles = makeKoreanDeck(packs, { groups: ["5확신", "242"], answerSource: "title" });
  const john = titles.find(({ ref }) => ref === "5확신 - 요일5:11,12");
  assert.equal(john.text, "구원의 확신");
  assert.equal(john.answer, "구원");
  assert.equal(john.hint, undefined);
  const round = startRound([john], 0);
  assert.equal(attack(round, 1_000, 0, "구 원").hits, 1);
  assert.equal(attack(round, 1_000, 0, "또증").feedback, "miss");

  const acts = titles.filter(({ ref }) => ref === "DEP3 - 행17:11");
  assert.deepEqual(acts.map(({ hint, answer }) => [hint, answer]), [
    ["말씀에 대한 태도", "날마"],
    ["말씀의 섭취 방법", "공부"],
  ]);
});

test("60구절 parts each select their 12 verses and work with individual DEP packs", () => {
  const partStarts = { A: "고후5:17", B: "롬3:23", C: "고전3:16", D: "마6:33", E: "요13:34,35" };
  for (const [part, firstRef] of Object.entries(partStarts)) {
    const deck = makeKoreanDeck(packs, { groups: [`60구절 ${part}`] });
    assert.equal(deck.length, 12);
    assert.ok(deck[0].id.startsWith(`60구절|${firstRef}|`));
  }
  assert.equal(makeKoreanDeck(packs, { groups: Object.keys(partStarts).map((part) => `60구절 ${part}`) }).length, 60);
  for (let number = 1; number <= 8; number++) {
    const group = `DEP${number}`;
    const deck = makeKoreanDeck(packs, { groups: ["60구절 E", group] });
    assert.equal(deck.filter(({ id }) => id.startsWith("60구절|")).length, 12);
    const selectedDep = new Set(deck.map(({ id }) => id.split("|")[0]).filter((id) => id.startsWith("DEP")));
    assert.deepEqual([...selectedDep], [group]);
  }
});

test("DEP2–7 can grade two characters of the heading or subtitle and other packs keep their title", () => {
  const groups = ["DEP1", "DEP2", "DEP6", "DEP8"];
  const headings = makeKoreanDeck(packs, { groups, answerSource: "title", depTitleSource: "heading" });
  const subtitles = makeKoreanDeck(packs, { groups, answerSource: "title", depTitleSource: "subtitle" });
  const heading = headings.find(({ id }) => id.startsWith("DEP2|고전1:9|"));
  const subtitle = subtitles.find(({ id }) => id.startsWith("DEP2|고전1:9|"));
  assert.deepEqual([heading.answer, heading.answerKind], ["왜q", "title"]);
  assert.deepEqual([subtitle.answer, subtitle.answerKind], ["하나", "subtitle"]);
  assert.equal(attack(startRound([heading], 0), 500, 0, "왜 Q").hits, 1);
  assert.equal(attack(startRound([heading], 0), 500, 0, "하나").feedback, "miss");
  assert.equal(attack(startRound([subtitle], 0), 500, 0, "하나").hits, 1);
  assert.deepEqual(headings.filter(({ ref }) => ref === "DEP6 - 롬10:9,10").map(({ hint }) => hint), [
    "영접하도록 도울 것", "인간의 책임 - 영접 기도",
  ]);
  for (const group of ["DEP1", "DEP8"]) {
    assert.deepEqual(headings.filter(({ id }) => id.startsWith(group)), subtitles.filter(({ id }) => id.startsWith(group)));
    assert.equal(headings.find(({ id }) => id.startsWith(group)).answerKind, "title");
  }
});
