const assert = require("node:assert/strict");
const test = require("node:test");
const { attack, advanceRound, chooseUpgrade, currentEnemy, makeDeck, startRound } = require("../wake-up.js");

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
