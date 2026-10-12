# 개역한글 Speaking Practice Page — Design

Date: 2026-10-12
Status: draft for review

## Goal

A public page, no login, where Korean speakers practise reciting the 개역한글
memory verses by speaking. The page transcribes the recitation with the
browser's speech recognition and shows which words were right.

Success looks like: pick a pack, recite a verse from memory, and see within a
second or two which words matched, without being marked wrong for spelling
differences or for the transcriber's known mishearings of 개역한글 words.

## Background

- A throwaway test (`speak-test.html`, 16 verses, 33 attempts on iPhone
  Safari and Firefox) showed Apple's recognizer gets 94% of the verse text
  right, and 97% with the extra sound-alike rules below. The remaining
  misses are rare 개역한글 words replaced by common modern words, and they
  repeat in the same places every time.
- Chrome on Android (Google's recognizer) has not been tested.

## Scope

In:
- Practice only: no grading buttons, no spaced repetition, no login, no sync.
- All 316 verses from the eunjin account, in their 11 packs.
- Recited text = heading + title + verse, with no brackets or parentheses. The
  reference (e.g. 요일 5:11,12) is shown as the prompt and is not spoken.

Out:
- Changes to the main app (`index.html`, `app.jsx`).
- Live data from Supabase. The verses are a one-time snapshot.

Also in scope, as a separate step done before the export: the same
corrections are applied to the eunjin account's cards in Supabase (see
"Fixing the eunjin account").

## Page

Address: `https://danjhk.github.io/scripture-srs/krv.html`. It is a
standalone page in plain JavaScript (no React or Babel) with Korean labels.
It carries `noindex`, so search engines skip it, and the footer credits the
text as "성경전서 개역한글판 (대한성서공회)".

### Practice flow

- **Pack picker** with the 11 packs in their original order (5확신, 8동행,
  60구절, DEP1 구원의 확신 … DEP8 세계비전).
- Verses play in pack order. A **Shuffle** switch randomizes the order.
- **Verse card:** pack name, position (e.g. 3 / 26) and the reference in
  large text. The verse is hidden. A **Show verse** switch (off by default)
  shows it for reading practice.
- **Mic button:** tap to start, tap to stop. Words appear live while you speak.
- **Result:** the verse is coloured green (same), yellow (sounds the same,
  or a known mishearing) or red (missed or wrong), with a % score. Below it is
  the transcript, with words that aren't in the verse in red. **수정** opens
  the transcript for editing and the colours update as you type.
- **Tap to accept:** tapping a red word in the verse marks it yellow ("I said
  this right") and updates the score. This is not saved.
- **다시** (try again), **다음 ▶** (next), **◀** (previous).
- **Saved on the device** (localStorage, wrapped in try/catch): the last pack
  and verse, Shuffle and Show verse. Nothing else is stored.
- **Browser without speech recognition** (e.g. desktop Firefox): a message
  asks the user to switch to Safari or Chrome. Show verse still works.

## Checker

This is the test page's algorithm, moved into its own file and extended.

1. Split both texts into Hangul letters (jamo), ignoring spaces and
   punctuation.
2. Align twice with LCS:
   - **exact:** the spelling must match. Result: green.
   - **sound:** spelling variants that sound the same are equal. Result:
     yellow.
3. Sound-alike rules:
   - Already in the test page:
     - Plain and tense consonants match (ㅈ/ㅉ etc.), e.g. 될지라 / 될찌라.
     - ㅐ/ㅔ, ㅒ/ㅖ and ㅙ/ㅞ/ㅚ match.
     - Silent ㅇ is ignored, so 이를 matches 일을.
     - Final consonant clusters are split, so 읽어 matches 일거.
   - New:
     - ㅢ matches ㅣ and ㅔ/ㅐ (의 is said as [에] or [이]).
     - ㅛ matches ㅗ (것이요 / 것이오).
     - Palatalization: ㄷ/ㅌ + 이 matches ㅈ/ㅊ + 이 (같이 / 가치).
     - Nasalization: a final ㄱ/ㄷ/ㅂ-type sound before ㄴ/ㅁ matches the
       nasal (맺나니 / 맨나니).
     - Numbers written as digits are read in Sino-Korean (40,000 → 사만).
     - A final ㄷ-type sound (ㄷ ㅅ ㅆ ㅈ ㅊ ㅌ) before ㄱ ㄷ ㅂ ㅅ ㅈ is
       silent, so the old spellings match what the transcriber writes:
       파숫군 / 파수꾼, 밤이 맟도록 / 맞도록.
4. Aliases:
   - "Quiet Time" counts as the same (green) as 콰이어트 타임, 콰이 타임,
     과 타임, 화이 타임, etc.
5. Known mishearings count as yellow. They are kept in one list in the
   checker file and are easy to extend:
   - 미쁘시 ≈ 믿으시 / 이쁘시, 식언 ≈ 시원, 인자 ≈ 임재
   - 이김과 위엄 ≈ 이 힘과 위험, 낫겠삽 ≈ 낫게 사, 주여 내 ≈ 주연의
   - 깨끗케 / 만족케 ≈ 깨끗게 / 깨끗해 / 만족해
   - 원하심 ≈ 원하신, 거듭남 ≈ 거듭난, 주심 ≈ 주신
   - 기쁜 ≈ 기쁨, 뭇 ≈ 못
   - 가까와 / 가까왔 ≈ 가까워 / 가까웠 (old spelling)
6. Score = (green + yellow letters) / all verse letters.

Trade-off, accepted: a real slip that happens to sound the same as the verse,
or that matches a known mishearing, shows yellow instead of red. Yellow always
means "probably fine, check yourself".

## Data

One-time export, with no export script in the repo:

- The 316 verses were already read (read-only) from Supabase with the CLI
  login on the development PC. The token is never written to the repo.
- Cleaned into `krv/verses.json`:
  ```json
  { "source": "성경전서 개역한글판 (대한성서공회)",
    "packs": [ { "name": "5확신",
                 "verses": [ { "ref": "요일 5:11,12", "heading": "",
                               "title": "구원의 확신", "text": "…" } ] } ] }
  ```
- Pack names drop the `01 - ` prefix and `.txt`. Packs keep their numeric
  order. Verses are ordered by `order_in_pack`, with ties broken by creation
  time.
- Text was checked against the 개역한글 text in
  [crizin/bible-db](https://github.com/crizin/bible-db) (holybible.or.kr
  crawl, cross-checked with bskorea.or.kr):
  - 275 verses match exactly.
  - 5 are intentional partial verses (e.g. 대하 16:9, 히 11:36-38 상).
  - The rest are listed below.
- If the eunjin account's packs change, the export is redone on request.

### Corrections

Reference fixes (the verse text is correct):

| Pack | Stored | Fixed |
|---|---|---|
| 60구절 #29 | 렘 3:22,23 | 애 3:22,23 |
| DEP5 교제 #13 | 행 2:42,27 | 행 2:42,47 |
| DEP5 교제 #6 | 명하심 133:1,3, title "[복을]" | 시 133:1-3 (the text includes verse 2), title "[복을 명하심]" (best guess: "명하심" slipped from the title into the reference during import) |
| DEP7 주재권 #26 | 히11:36-38, with "상" at the start of the text | 히 11:36-38 상 |

Duplicate: DEP4 기도 has 딤전 2:1,2 twice at #29, once with the typo 모**드**.
Neither copy has been reviewed, so the typo copy is removed and the pack
becomes 1..32.

Wording fixes (these change what is said):

| Verse | Stored | 개역한글 |
|---|---|---|
| 요 3:16 | 하나님**의** 세상을 | 하나님**이** 세상을 |
| 고후 9:6,7 | 많**은** 심는 자는 | 많**이** 심는 자는 |
| 마 7:7,8 | 구하라 그러면 주실 것이요 | 구하라 그러면 **너희에게** 주실 것이요 |
| 벧전 2:11 | 영혼**은** 거스려 | 영혼**을** 거스려 |
| 히 4:12 | 하나님**이** 말씀은 | 하나님**의** 말씀은 |
| 계 1:3 | 그 가운**에** | 그 가운**데** |
| 요일 1:3 | 전함**을** 너희로 | 전함**은** 너희로 |
| 마 5:23,24 | 형제**엑** | 형제**에게** |
| 딤전 2:1,2 | 모**드** 사람 | 모**든** 사람 |
| 대상 29:11-13 | 다 주께 속하였**으**니 | 다 주께 속하였**사오**니 |
| 딤전 2:1,2 | (duplicate card with 모**드** 사람) | removed, see above |
| 빌 2:15,16 | 헛되지 아니하**며** | 헛되지 아니하**고** |
| 계 21:8 | 불**화** 유황 … 참예하리니 | 불**과** 유황 … 참예하리니 **이것이 둘째 사망이라** |
| 말 1:11 | 해 지는 곳까지의 **이방 민족 중에서 내 이름이 크게 될 것이라** 이방 민족 중에서 … | the bold phrase is repeated by mistake; it is removed |
| 잠 3:9,10 | 네 **제**물 (offering) | 네 **재**물 (wealth) |

Spelling-only differences (same words, older spelling in 개역한글). Decided:
follow 개역한글 spelling strictly, because that is how the users test
themselves. These 19 cards are changed too:
- 지 → 찌: 15 places, e.g. 볼지어다 → 볼찌어다, 섬길지어다 → 섬길찌어다
- 일꾼 / 삯꾼 → 일군 / 삯군 (3 verses), 파수꾼 → 파숫군 (시 130:5,6)
- 세배대 → 세베대 (막 1:20)
- 가까웠으니 → 가까왔으니 (벧전 4:7), 가까워졌느니라 → 가까와졌느니라 (엡 2:13)
- 밤이 맞도록 → 밤이 맟도록 (눅 5:5,6)

### Fixing the eunjin account

The same corrections are applied to the eunjin account's `cards` rows, so the
main app gets them too.

- **Backup first:** all 316 rows are saved in full to a local JSON file before
  any change is made.
- **One transaction:**
  - The 17 wording/reference fixes, plus the spelling-only changes if
    chosen, are made with `UPDATE`.
  - The duplicate 딤전 2:1,2 is removed with a soft delete
    (`deleted_at = now()`), the same way the app deletes.
- **Database rules are kept:**
  - In the database, the text keeps its `(heading) - [title]` format.
  - Each changed row's `content_hash` is recomputed with the app's formula
    (FNV-1a of `ref|text`, base 36). The formula was checked against all 316
    existing rows. The unique index on (user, pack, content_hash) stays
    unique.
- **Progress is kept:** card ids don't change, so review progress and
  history are untouched.
- **How the phone picks it up:**
  - The database trigger stamps each changed row with the current time, so on
    the next sync the server copy is newer than the phone's copy and wins.
  - The account was last used on 2026-08-14.
  - Caution: open the app online and let it sync before reviewing. A card
    reviewed offline first would keep its old text and could push it back.
- **Check afterwards:** re-read the rows and confirm every fixed verse matches
  개역한글.

## Files

| File | Purpose |
|---|---|
| `krv.html` | The page: markup, styles, practice flow |
| `speak-compare.js` | The checker. A plain script that sets `window.SpeakCompare` and also works with Node's `require` for tests, so the main app can reuse it later |
| `krv/verses.json` | The 316 cleaned verses |
| `tests/speak-compare.test.js` | Checker tests, including the 33 iPhone test attempts (`tests/fixtures/`) |
| `tests/krv-data.test.js` | Data checks for `krv/verses.json` |

Run the tests with `node --test tests/*.test.js`.

`speak-test.html` is deleted once `krv.html` is live.

## Testing

- **Checker unit tests** (Node's built-in test runner, no dependencies):
  - Each sound-alike rule and alias.
  - Each known mishearing gives yellow, not red.
  - Real slips stay red (a skipped word, a different ending such as
    의로우사 → 의로우시니).
  - Digits are read as Korean.
  - The transcripts from the test run reach at least the measured 97%
    average.
- **Data check:**
  - 316 verses in 11 packs.
  - No `[`, `]` or `(` left in heading, title or text.
  - Each pack is numbered 1..n with no gaps or duplicates.
  - Every reference parses.
- **Layout:** headless Chrome render at 360px wide. No horizontal scroll, and
  the result view looks right with a fake transcript.
- **Manual:** speak-test on iPhone (the user). Android Chrome if anyone will
  use it.

## Rollout

The safety check blocks the assistant from pushing data that came out of
another user's account, so the user commits and pushes `krv.html`,
`speak-compare.js` and `krv/verses.json` themselves.
