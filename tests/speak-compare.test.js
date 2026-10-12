// Run with: node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { compare, acceptWord, cardParts } = require("../speak-compare.js");

// Collect the target characters with a given state, joined per word: "될[찌]라" -> ["찌"]
function charsWith(result, target, state) {
  const out = [];
  let run = "";
  for (let i = 0; i <= target.length; i++) {
    if (i < target.length && result.targetStates[i] === state) run += target[i];
    else if (run) { out.push(run); run = ""; }
  }
  return out;
}

function assertNear(heard, target, expectedNear, opts) {
  const r = compare(heard, target, opts);
  assert.deepEqual(charsWith(r, target, "bad"), [], `nothing should be red for ${heard} vs ${target}`);
  assert.deepEqual(charsWith(r, target, "near"), expectedNear);
}

test("identical text is all green and scores 100", () => {
  const t = "쉬지 말고 기도하라";
  const r = compare(t, t);
  assert.equal(r.score, 100);
  assert.equal(r.bad, 0);
  assert.equal(r.near, 0);
});

test("spacing and punctuation are ignored", () => {
  const r = compare("너희가 아무 것도 할수없음이라 왜 전도를 해야 하나", "너희가 아무것도 할 수 없음이라 왜 전도를 해야 하나?");
  assert.equal(r.score, 100);
  assert.equal(r.near, 0);
});

test("spaces and punctuation have no state", () => {
  const t = "하는가? 기도";
  const r = compare("하는가 기도", t);
  assert.equal(r.targetStates[3], null);
  assert.equal(r.targetStates[4], null);
});

test("plain and tense consonants sound alike", () => {
  assertNear("너는 복의 근원이 될지라", "너는 복의 근원이 될찌라", ["찌"]);
});

test("ㅐ and ㅔ sound alike", () => {
  assertNear("내게 복을 주어", "네게 복을 주어", ["네"]);
});

test("a final consonant carried into the next syllable is not marked wrong", () => {
  const r = compare("듣지도 못한 일을", "듣지도 못한 이를");
  assert.equal(r.score, 100);
});

test("의 sounds like 에 and 이", () => {
  assertNear("그리스도 안에 생활", "그리스도 안의 생활", ["의"]);
  assertNear("저는 이로우사", "저는 의로우사", ["의"]);
});

test("요 and 오 sound alike", () => {
  assertNear("하실 것이오", "하실 것이요", ["요"]);
});

test("palatalization: 같이 sounds like 가치", () => {
  assertNear("말씀의 같이", "말씀의 가치", ["치"]);
});

test("nasalization: 맨나니 sounds like 맺나니", () => {
  assertNear("과실을 많이 맨나니", "과실을 많이 맺나니", ["맺"]);
});

test("a final ㄷ-type sound before a plain consonant is silent", () => {
  assertNear("파수꾼이 아침을", "파숫군이 아침을", ["숫군"]);
  assertNear("밤이 맞도록 수고를", "밤이 맟도록 수고를", ["맟"]);
});

test("digits are read in Sino-Korean", () => {
  const target = "주는 높으사 만유의 머리심이니이다";
  const r = compare("주는 높으 40,000 유의 머리심이니이다", target);
  assert.deepEqual(charsWith(r, target, "bad"), []);
});

test("Quiet Time matches the ways the transcriber writes it", () => {
  const target = "왜 Quiet Time을 가져야 하는가?";
  for (const heard of ["왜 콰이어트 타임을 가져야 하는가", "왜 콰이 타임을 가져야 하는가", "왜과 타임을 가져야 하는가", "왜 화이 타임을 가져야 하는가", "왜 quiet time을 가져야 하는가"]) {
    const r = compare(heard, target);
    assert.equal(r.score, 100, heard);
  }
});

test("known mishearings of 개역한글 words are yellow, not red", () => {
  const cases = [
    ["저는 믿으시고", "저는 미쁘시고"],
    ["저는 이쁘시고", "저는 미쁘시고"],
    ["시원치 않으시고", "식언치 않으시고"],
    ["주의 임재로 우리를", "주의 인자로 우리를"],
    ["이 힘과 위험이 다", "이김과 위엄이 다"],
    ["내 하인이 낫게 사나이다", "내 하인이 낫겠삽나이다"],
    ["내 하인이 낮게 삶 나이다", "내 하인이 낫겠삽나이다"],
    ["주연의 집에", "주여 내 집에"],
    ["우리를 깨끗게 하실", "우리를 깨끗케 하실"],
    ["우리를 깨끗해 하실", "우리를 깨끗케 하실"],
    ["우리를 만족해 하사", "우리를 만족케 하사"],
    ["교제를 원하신", "교제를 원하심"],
    ["그리스도 안에서 거듭난", "그리스도 안에서 거듭남"],
    ["함께해 주신", "함께해 주심"],
    ["기쁨 뜻으로", "기쁜 뜻으로"],
    ["여호와께서는 못 마음을", "여호와께서는 뭇 마음을"],
    ["그리스도의 피로 가까워졌느니라", "그리스도의 피로 가까와졌느니라"],
    ["마지막이 가까웠으니", "마지막이 가까왔으니"],
  ];
  for (const [heard, target] of cases) {
    const r = compare(heard, target);
    assert.deepEqual(charsWith(r, target, "bad"), [], `${heard} vs ${target}`);
    assert.ok(r.near > 0, `${heard} vs ${target} should be yellow somewhere`);
  }
});

test("a known mishearing said correctly is green", () => {
  const r = compare("저는 미쁘시고", "저는 미쁘시고");
  assert.equal(r.near, 0);
  assert.equal(r.score, 100);
});

test("a skipped word is red", () => {
  const target = "만일 우리가 우리 죄를 자백하면";
  const r = compare("만일 우리가 죄를 자백하면", target);
  assert.deepEqual(charsWith(r, target, "bad"), ["우리"]);
});

test("a different ending is red, and the extra syllables in the transcript are counted", () => {
  const target = "저는 미쁘시고 의로우사";
  const r = compare("저는 미쁘시고 의로우시니", target);
  assert.deepEqual(charsWith(r, target, "bad"), ["사"]);
  assert.equal(r.extra, 2);
});

test("nothing heard scores 0 with every letter red", () => {
  const target = "쉬지 말고 기도하라";
  const r = compare("", target);
  assert.equal(r.score, 0);
  assert.equal(r.bad, 8);
});

test("accepting a word turns its red letters yellow and updates the score", () => {
  const target = "만일 우리가 우리 죄를 자백하면";
  const r = compare("만일 우리가 죄를 자백하면", target);
  const accepted = acceptWord(r, target, target.indexOf("우리 죄") + 1);
  assert.deepEqual(charsWith(accepted, target, "bad"), []);
  assert.deepEqual(charsWith(accepted, target, "near"), ["우리"]);
  assert.equal(accepted.score, 100);
  assert.equal(r.score < 100, true, "the original result is not changed");
});

test("the 33 attempts from the iPhone test average at least 97%", () => {
  const attempts = require("./fixtures/speak-test-2026-10-12.json");
  const avg = attempts.reduce((sum, a) => sum + compare(a.heard, a.target).score, 0) / attempts.length;
  assert.ok(avg >= 97, `average was ${avg.toFixed(1)}%`);
});

/* ---------- Portuguese (Speak mode in the main app) ---------- */
const PT = { lang: "pt" };

test("Portuguese: case and punctuation are ignored", () => {
  const r = compare("é bom que o homem suporte o jugo", "É bom que o homem suporte o jugo.", PT);
  assert.equal(r.score, 100);
  assert.equal(r.near, 0);
});

test("Portuguese: a letter that differs only by its accent sounds alike", () => {
  assertNear("e bom que", "É bom que", ["É"], PT);
  assertNear("o meu coracao", "o meu coração", ["çã"], PT);
  assertNear("voce é", "você é", ["ê"], PT);
});

test("Portuguese: verse numbers inside the text are not spoken or scored", () => {
  const target = "em seu coração. 17 Tudo o que fizerem";
  const r = compare("em seu coração tudo o que fizerem", target, PT);
  assert.equal(r.score, 100);
  assert.equal(r.targetStates[target.indexOf("17")], null);
  assert.equal(r.targetStates[target.indexOf("17") + 1], null);
});

test("Portuguese: a different word is still red", () => {
  const target = "É bom que o homem suporte o jugo";
  const r = compare("é bom que o home suporte o fogo", target, PT);
  assert.deepEqual(charsWith(r, target, "bad"), ["m", "ju"]);
});

test("cardParts splits a [title] from the verse", () => {
  assert.deepEqual(cardParts("[Vontade de Deus] É bom que o homem suporte o jugo"),
    { title: "Vontade de Deus", text: "É bom que o homem suporte o jugo" });
  assert.deepEqual(cardParts("[Teachable (Ensinável)] Venham a mim"),
    { title: "Teachable (Ensinável)", text: "Venham a mim" });
});

test("cardParts says every leading [bracket] in order", () => {
  // Some packs store "[heading] - [title] verse"; a " - " inside one bracket is kept
  assert.deepEqual(cardParts("[Why do we have Quiet Time?] - [God's command] Busquem o SENHOR"),
    { title: "Why do we have Quiet Time? - God's command", text: "Busquem o SENHOR" });
  assert.deepEqual(cardParts("[Por que? - Mandamento de Deus] Tudo o que tem vida"),
    { title: "Por que? - Mandamento de Deus", text: "Tudo o que tem vida" });
});

test("cardParts leaves a verse without a title as it is", () => {
  assert.deepEqual(cardParts("Paulo, Silvano e Timóteo, à igreja dos tessalonicenses"),
    { title: "", text: "Paulo, Silvano e Timóteo, à igreja dos tessalonicenses" });
});

test("cardParts drops a trailing Bible version note", () => {
  assert.equal(cardParts("[Paz] e uma esperança. (Versao NAA)").text, "e uma esperança.");
  assert.equal(cardParts("[Sabedoria de Deus] com integridade. (Versão NAA)").text, "com integridade.");
});

test("cardParts writes accented letters as single characters", () => {
  // "e" + combining acute -> "é", so each letter is one character to colour
  assert.equal(cardParts("[Fe\u0301] fe\u0301").text, "fé");
  assert.equal(cardParts("[Fe\u0301] fe\u0301").title, "Fé");
});
