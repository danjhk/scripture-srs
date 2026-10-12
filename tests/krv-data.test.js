// Run with: node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const data = require("../krv/verses.json");

const BOOKS = new Set(["창","출","레","민","신","수","삿","룻","삼상","삼하","왕상","왕하","대상","대하","스","느","에","욥","시","잠","전","아","사","렘","애","겔","단","호","욜","암","옵","욘","미","나","합","습","학","슥","말","마","막","눅","요","행","롬","고전","고후","갈","엡","빌","골","살전","살후","딤전","딤후","딛","몬","히","약","벧전","벧후","요일","요이","요삼","유","계"]);
const allVerses = data.packs.flatMap((p) => p.verses.map((v) => ({ pack: p.name, ...v })));

test("credits the 개역한글 source", () => {
  assert.equal(data.source, "성경전서 개역한글판 (대한성서공회)");
});

test("has the 11 packs in their usual order with 315 verses", () => {
  assert.deepEqual(data.packs.map((p) => [p.name, p.verses.length]), [
    ["5확신", 5], ["8동행", 8], ["60구절", 60],
    ["DEP1 - 구원의 확신", 18], ["DEP2 - Quiet Time", 26], ["DEP3 - 말씀", 37], ["DEP4 - 기도", 32],
    ["DEP5 - 교제", 30], ["DEP6 - 증거", 55], ["DEP7 - 그리스도의 주재권", 26], ["DEP8 - 세계비전", 18],
  ]);
  assert.equal(allVerses.length, 315);
});

test("no brackets are left from the (heading) - [title] format", () => {
  for (const v of allVerses) {
    for (const field of ["heading", "title"])
      assert.doesNotMatch(v[field], /[\[\]()]/, `${v.pack} ${v.ref} ${field}`);
    // Parentheses inside the verse are 개역한글's own, e.g. 히 11:38 (이런 사람은 …)
    assert.doesNotMatch(v.text, /[\[\]]|^\(|^\s*-/, `${v.pack} ${v.ref} text`);
  }
});

test("every verse has a title and text", () => {
  for (const v of allVerses) {
    assert.ok(v.title.trim(), `${v.pack} ${v.ref} title`);
    assert.ok(v.text.trim(), `${v.pack} ${v.ref} text`);
  }
});

test("every reference is a known book, chapter and verses", () => {
  for (const v of allVerses) {
    const m = v.ref.match(/^([가-힣]+) (\d+):(\d+(?:[-,]\d+)*)(?: [상하])?$/);
    assert.ok(m, `unreadable reference: ${v.pack} ${v.ref}`);
    assert.ok(BOOKS.has(m[1]), `unknown book: ${v.pack} ${v.ref}`);
  }
});

test("no card appears twice in the same pack", () => {
  // The same verse may appear twice under different headings (행 17:11 in DEP3)
  const seen = new Set();
  for (const v of allVerses) {
    const key = `${v.pack}|${v.heading}|${v.title}|${v.ref}|${v.text}`;
    assert.ok(!seen.has(key), `duplicate: ${v.pack} ${v.ref}`);
    seen.add(key);
  }
});
