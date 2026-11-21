/* ======================================================================
   Speaking checker: compares what the transcriber heard with the verse.

   Both texts are split into Hangul letters (jamo), ignoring spaces and
   punctuation, and aligned with LCS twice:
     exact  - the spelling must match                       -> "ok"   (green)
     sound  - spellings that sound the same count as equal  -> "near" (yellow)
   Anything else in the verse is "bad" (red).

   Works in the browser (window.SpeakCompare) and in Node (require).
====================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SpeakCompare = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CHO = ["ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ","ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
  const JUNG = ["ㅏ","ㅐ","ㅑ","ㅒ","ㅓ","ㅔ","ㅕ","ㅖ","ㅗ","ㅘ","ㅙ","ㅚ","ㅛ","ㅜ","ㅝ","ㅞ","ㅟ","ㅠ","ㅡ","ㅢ","ㅣ"];
  const JONG = ["","ㄱ","ㄲ","ㄳ","ㄴ","ㄵ","ㄶ","ㄷ","ㄹ","ㄺ","ㄻ","ㄼ","ㄽ","ㄾ","ㄿ","ㅀ","ㅁ","ㅂ","ㅄ","ㅅ","ㅆ","ㅇ","ㅈ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];

  // Sound rules
  const PLAIN = { "ㄲ":"ㄱ", "ㄸ":"ㄷ", "ㅃ":"ㅂ", "ㅆ":"ㅅ", "ㅉ":"ㅈ" };              // 될찌라 = 될지라
  const VOWEL_SOUND = { "ㅔ":"ㅐ", "ㅖ":"ㅒ", "ㅞ":"ㅙ", "ㅚ":"ㅙ", "ㅛ":"ㅗ" };      // 네게 = 내게, 것이요 = 것이오
  const VOWEL_ALSO = { "ㅢ": ["ㅣ", "ㅐ"] };                                          // 의 is said [이] or [에]
  const JONG_SPLIT = { "ㄳ":["ㄱ","ㅅ"], "ㄵ":["ㄴ","ㅈ"], "ㄶ":["ㄴ","ㅎ"], "ㄺ":["ㄹ","ㄱ"], "ㄻ":["ㄹ","ㅁ"], "ㄼ":["ㄹ","ㅂ"], "ㄽ":["ㄹ","ㅅ"], "ㄾ":["ㄹ","ㅌ"], "ㄿ":["ㄹ","ㅍ"], "ㅀ":["ㄹ","ㅎ"], "ㅄ":["ㅂ","ㅅ"] };
  const PALATAL = { "ㄷ":"ㅈ", "ㅌ":"ㅊ" };                                            // 같이 = 가치
  const NASAL = { "ㄱ":"ㅇ", "ㄲ":"ㅇ", "ㅋ":"ㅇ", "ㄳ":"ㅇ", "ㄺ":"ㅇ",                // 맺나니 = 맨나니
                  "ㄷ":"ㄴ", "ㅅ":"ㄴ", "ㅆ":"ㄴ", "ㅈ":"ㄴ", "ㅊ":"ㄴ", "ㅌ":"ㄴ", "ㅎ":"ㄴ",
                  "ㅂ":"ㅁ", "ㅍ":"ㅁ", "ㅄ":"ㅁ", "ㄿ":"ㅁ" };
  const D_TYPE = new Set(["ㄷ","ㅅ","ㅆ","ㅈ","ㅊ","ㅌ"]);                              // 숫군 = 수꾼, 맟도록 = 맞도록
  const OBSTRUENT = new Set(["ㄱ","ㄲ","ㄷ","ㄸ","ㅂ","ㅃ","ㅅ","ㅆ","ㅈ","ㅉ"]);

  // The same words however the transcriber writes them (green)
  const ALIASES = [
    { key: "<QT>", re: /quiet\s*time|[콰과화](?:\s*이)?(?:\s*어\s*트|\s*엇)?\s*타\s*임/iy },
  ];

  // 개역한글 words the transcriber swaps for common modern words (yellow).
  // Found in the iPhone test on 2026-10-12; add new swaps here.
  const MISHEARINGS = [
    ["미쁘시", "믿으시", "이쁘시"],
    ["식언", "시원"],
    ["인자", "임재"],
    ["이김과위엄", "이힘과위험"],
    ["낫겠삽", "낫게사", "낮게삶", "낮게사"],
    ["주여내", "주연의"],
    ["깨끗케", "깨끗하게", "깨끗게", "깨끗해"],
    ["만족케", "만족하게", "만족게", "만족해"],
    ["원하심", "원하신"],
    ["거듭남", "거듭난"],
    ["주심", "주신"],
    ["기쁜", "기쁨"],
    ["뭇", "못"],
    ["가까와", "가까워"],
    ["가까왔", "가까웠"],
  ].map((spellings, i) => ({
    key: `<M${i}>`,
    // Longest spelling first; spaces allowed between letters
    re: new RegExp(spellings.slice().sort((a, b) => b.length - a.length)
      .map((w) => Array.from(w).join("\\s*")).join("|"), "y"),
  }));

  const LETTER_RE = /[\p{L}\p{N}]/u;
  const DIGITS_RE = /\d+(?:,\d{3})*/y;

  function hangulParts(ch) {
    const n = ch ? ch.charCodeAt(0) - 0xAC00 : -1;
    if (n < 0 || n > 11171) return null;
    return [CHO[Math.floor(n / 588)], JUNG[Math.floor((n % 588) / 28)], JONG[n % 28]];
  }

  function nextSyllable(text, i) {
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    return hangulParts(text[j]);
  }

  // How a syllable sounds, given the syllable after it
  function soundOf(parts, next) {
    const [L, V, T] = parts;
    const out = [];
    if (L !== "ㅇ") out.push(PLAIN[L] || L);           // silent ㅇ: 이를 = 일을
    out.push(VOWEL_SOUND[V] || V);
    if (!T) return out;
    let finals = JONG_SPLIT[T] || [T];
    if (next) {
      const [nL, nV] = next;
      if (PALATAL[T] && nL === "ㅇ" && nV === "ㅣ") finals = [PALATAL[T]];
      else if (NASAL[T] && (nL === "ㄴ" || nL === "ㅁ")) finals = [NASAL[T]];
      else if (D_TYPE.has(T) && OBSTRUENT.has(nL)) finals = [];
    }
    for (const f of finals) out.push(PLAIN[f] || f);
    return out;
  }

  // Sino-Korean reading of a number: 40000 -> 사만
  function sino(n) {
    const d = ["", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];
    const place = ["", "십", "백", "천"], group = ["", "만", "억", "조"];
    if (n === 0) return "영";
    let out = "";
    for (let g = 0; n > 0; g++, n = Math.floor(n / 10000)) {
      let part = n % 10000, s = "";
      for (let p = 0; part > 0; p++, part = Math.floor(part / 10)) {
        const k = part % 10;
        if (k) s = (k === 1 && p > 0 ? "" : d[k]) + place[p] + s;
      }
      if (s) out = s + group[g] + out;
    }
    return out;
  }

  // Splits text into comparable units; each unit remembers the characters [s, e) it came from
  function unitize(text, mode) {
    const units = [];
    const special = mode === "sound" ? ALIASES.concat(MISHEARINGS) : ALIASES;
    let i = 0;
    outer: while (i < text.length) {
      for (const a of special) {
        a.re.lastIndex = i;
        const m = a.re.exec(text);
        if (m) {
          units.push({ k: a.key, s: i, e: i + m[0].length });
          i += m[0].length;
          continue outer;
        }
      }
      const ch = text[i];
      if (mode === "sound" && /\d/.test(ch)) {
        DIGITS_RE.lastIndex = i;
        const run = DIGITS_RE.exec(text)[0];
        for (const syl of sino(parseInt(run.replace(/,/g, ""), 10)))
          for (const k of soundOf(hangulParts(syl), null)) units.push({ k, s: i, e: i + run.length });
        i += run.length;
        continue;
      }
      const parts = hangulParts(ch);
      if (parts) {
        const keys = mode === "exact" ? parts.filter(Boolean) : soundOf(parts, nextSyllable(text, i));
        for (const k of keys) units.push({ k, s: i, e: i + 1 });
      } else if (LETTER_RE.test(ch)) {
        units.push({ k: ch.toLowerCase(), s: i, e: i + 1 });
      }
      i++;
    }
    return units;
  }

  function same(a, b, mode) {
    if (a === b) return true;
    if (mode !== "sound") return false;
    return (VOWEL_ALSO[a] || []).includes(b) || (VOWEL_ALSO[b] || []).includes(a);
  }

  // Returns [maskA, maskB]: which units of a and b are part of the LCS
  function lcsMasks(a, b, mode) {
    const m = a.length, n = b.length, W = n + 1;
    const dp = new Uint16Array((m + 1) * W);
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i * W + j] = same(a[i - 1].k, b[j - 1].k, mode)
          ? dp[(i - 1) * W + j - 1] + 1
          : Math.max(dp[(i - 1) * W + j], dp[i * W + j - 1]);
    const ma = new Array(m).fill(false), mb = new Array(n).fill(false);
    let i = m, j = n;
    while (i > 0 && j > 0) {
      if (same(a[i - 1].k, b[j - 1].k, mode) && dp[i * W + j] === dp[(i - 1) * W + j - 1] + 1) {
        ma[i - 1] = mb[j - 1] = true; i--; j--;
      } else if (dp[(i - 1) * W + j] >= dp[i * W + j - 1]) i--;
      else j--;
    }
    return [ma, mb];
  }

  // Per character: "ok" | "near" | "bad", or null for spaces and punctuation
  function charStates(text, exactUnits, exactMask, soundUnits, soundMask) {
    const mark = (units, mask) => {
      const arr = new Array(text.length).fill(null);
      units.forEach((u, idx) => {
        for (let c = u.s; c < u.e; c++)
          if (LETTER_RE.test(text[c])) arr[c] = (arr[c] === null ? true : arr[c]) && mask[idx];
      });
      return arr;
    };
    const ex = mark(exactUnits, exactMask), so = mark(soundUnits, soundMask);
    return ex.map((e, c) => (e === null && so[c] === null ? null : e ? "ok" : so[c] ? "near" : "bad"));
  }

  function summarize(targetStates, heardStates) {
    const count = (arr, s) => arr.filter((x) => x === s).length;
    const ok = count(targetStates, "ok"), near = count(targetStates, "near"), bad = count(targetStates, "bad");
    const total = ok + near + bad;
    return {
      targetStates, heardStates, ok, near, bad, total,
      extra: count(heardStates, "bad"),
      score: total ? Math.round((100 * (ok + near)) / total) : 0,
    };
  }

  function compare(heard, target) {
    heard = heard || "";
    const H = { exact: unitize(heard, "exact"), sound: unitize(heard, "sound") };
    const G = { exact: unitize(target, "exact"), sound: unitize(target, "sound") };
    const [hEx, gEx] = lcsMasks(H.exact, G.exact, "exact");
    const [hSo, gSo] = lcsMasks(H.sound, G.sound, "sound");
    return summarize(
      charStates(target, G.exact, gEx, G.sound, gSo),
      charStates(heard, H.exact, hEx, H.sound, hSo)
    );
  }

  // "I said this right": the red letters of the word at index become yellow
  function acceptWord(result, target, index) {
    let s = index, e = index;
    while (s > 0 && !/\s/.test(target[s - 1])) s--;
    while (e < target.length && !/\s/.test(target[e])) e++;
    const targetStates = result.targetStates.map((st, i) => (i >= s && i < e && st === "bad" ? "near" : st));
    return summarize(targetStates, result.heardStates);
  }

  return { compare, acceptWord };
});
