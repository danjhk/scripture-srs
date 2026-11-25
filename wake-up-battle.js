(function () {
  const labels = {
    en: {
      answerLanguage: "pt",
      time: "Time left", base: "Base", hits: "Hits", bossHealth: "Boss health",
      waves: ["Wave 1", "Wave 2", "Boss"],
      instruction: "Type the first five letters. Spaces and accents are ignored.",
      attack: "Attack", units: "letters", upgrade: "Choose one upgrade",
      repair: "Repair +2 base health", power: "Power +1 boss damage",
      feedback: { hit: "Hit!", miss: "Miss. Base took damage.", timeout: "Enemy reached the base." },
      outcome: { victory: "Boss defeated", defeat: "Base fell", time: "Time’s up" },
      summary: (hits, misses) => `${hits} ${hits === 1 ? "hit" : "hits"} · ${misses} ${misses === 1 ? "verse missed" : "verses missed"}`,
      typed: "You typed", correct: "Correct", blank: "No answer entered",
    },
    ko: {
      answerLanguage: "ko",
      time: "남은 시간", base: "기지", hits: "명중", bossHealth: "보스 체력",
      waves: ["1차 공세", "2차 공세", "보스"],
      instruction: "구절 본문의 첫 두 음절을 입력하세요. 띄어쓰기는 무시해요.",
      attack: "공격", units: "음절", upgrade: "강화 선택",
      repair: "기지 체력 +2", power: "보스 공격력 +1",
      feedback: { hit: "명중!", miss: "틀렸어요. 기지 체력이 줄었어요.", timeout: "적이 기지에 도착했어요." },
      outcome: { victory: "보스를 물리쳤어요", defeat: "기지가 무너졌어요", time: "시간이 끝났어요" },
      summary: (hits, misses) => `명중 ${hits}회 · 놓친 구절 ${misses}개`,
      typed: "입력한 답", correct: "정답", blank: "입력 없음",
    },
  };

  function showRecap(host, round, copy) {
    const missed = new Map();
    for (const { card, typed } of round.misses) {
      if (!missed.has(card.id)) missed.set(card.id, { card, attempts: [] });
      missed.get(card.id).attempts.push(typed);
    }

    host.innerHTML = '<section class="wake-up-panel wake-up-recap"><h2 tabindex="-1"></h2><p></p></section>';
    const panel = host.firstElementChild;
    const heading = panel.querySelector("h2");
    heading.textContent = copy.outcome[round.outcome];
    panel.querySelector("p").textContent = copy.summary(round.hits, missed.size);
    if (missed.size) {
      const list = document.createElement("ul");
      for (const { card, attempts } of missed.values()) {
        const item = document.createElement("li");
        item.innerHTML = `<strong></strong><dl><dt>${copy.typed}</dt><dd></dd><dt>${copy.correct}</dt><dd><code class="wake-up-correct"></code></dd></dl><p></p>`;
        item.querySelector("strong").textContent = card.ref;
        item.querySelector("p").textContent = card.text;
        item.querySelector(".wake-up-correct").textContent = card.answer;
        const answers = item.querySelector("dd");
        for (const typed of attempts) {
          const answer = document.createElement(typed.trim() ? "code" : "span");
          answer.textContent = typed.trim() ? typed : copy.blank;
          answers.appendChild(answer);
        }
        list.appendChild(item);
      }
      panel.appendChild(list);
    }
    heading.focus();
  }

  function mount(host, deck, language = "en") {
    const copy = labels[language];
    // Only interface strings are inserted as markup. Verse data and answers use textContent.
    host.innerHTML = `
      <section class="wake-up-panel">
        <div class="wake-up-stats">
          <div>${copy.time}<strong data-time></strong></div>
          <div>${copy.base}<strong data-base></strong></div>
          <div>${copy.hits}<strong data-hits></strong></div>
        </div>
        <div class="wake-up-arena">
          <div class="wake-up-wave"><span data-wave></span><span data-boss></span></div>
          <div class="wake-up-lane" aria-hidden="true">
            <div class="wake-up-base"></div><div class="wake-up-enemy"></div>
          </div>
        </div>
        <div class="wake-up-controls">
          <h2 data-reference lang="${copy.answerLanguage}"></h2>
          <label for="wake-up-answer">${copy.instruction}</label>
          <div class="wake-up-entry">
            <input id="wake-up-answer" lang="${copy.answerLanguage}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" />
            <button type="button" data-attack>${copy.attack}</button>
          </div>
          <div class="wake-up-feedback"><span role="status"></span><span data-count></span></div>
          <div class="wake-up-upgrades" role="group" aria-label="${copy.upgrade}" hidden>
            <button type="button" data-repair>${copy.repair}</button>
            <button type="button" data-power>${copy.power}</button>
          </div>
        </div>
      </section>`;

    const find = (selector) => host.querySelector(selector);
    const time = find("[data-time]"), base = find("[data-base]"), hits = find("[data-hits]");
    const wave = find("[data-wave]"), boss = find("[data-boss]"), lane = find(".wake-up-lane");
    const reference = find("[data-reference]"), input = find("input"), attack = find("[data-attack]");
    const feedback = find('[role="status"]'), count = find("[data-count]");
    const upgrades = find(".wake-up-upgrades"), repair = find("[data-repair]"), power = find("[data-power]");
    let enemy = find(".wake-up-enemy");
    let round = WakeUp.startRound(deck, performance.now());
    let shownTurn = -1;
    let composingTurn = null;
    let timer;

    function setText(element, value) {
      if (element.textContent !== value) element.textContent = value;
    }

    function updateInput() {
      const length = WakeUp.letters(round.draft).length;
      const required = [...WakeUp.currentEnemy(round).answer].length;
      setText(count, `${length}/${required} ${copy.units}`);
      count.classList.toggle("wake-up-error", length > required);
      attack.disabled = length !== required;
    }

    function render(at) {
      if (round.outcome) {
        stop();
        showRecap(host, round, copy);
        return;
      }
      const seconds = Math.max(0, Math.ceil((round.endsAt - at) / 1000));
      const bossWave = round.wave === WakeUp.WAVES.length - 1;
      setText(time, `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`);
      setText(base, `${round.health}/${WakeUp.BASE_HEALTH}`);
      setText(hits, String(round.hits));
      setText(wave, copy.waves[round.wave]);
      setText(boss, bossWave ? `${copy.bossHealth} ${round.bossHealth}/${WakeUp.BOSS_HEALTH}` : "");
      setText(feedback, copy.feedback[round.feedback] || "");
      feedback.classList.toggle("wake-up-hit", round.feedback === "hit");
      upgrades.hidden = round.wave === 0 || Boolean(round.upgrade);
      repair.disabled = round.health === WakeUp.BASE_HEALTH;

      if (shownTurn !== round.turn) {
        shownTurn = round.turn;
        setText(reference, WakeUp.currentEnemy(round).ref);
        if (composingTurn !== null) {
          // A prompt can expire while an IME is composing. End that composition before resetting the field.
          input.blur();
          input.focus({ preventScroll: true });
        }
        input.value = round.draft;
        const newEnemy = enemy.cloneNode();
        enemy.replaceWith(newEnemy);
        enemy = newEnemy;
        lane.querySelector(".wake-up-shot")?.remove();
        if (round.feedback === "hit") {
          const shot = document.createElement("div");
          shot.className = "wake-up-shot";
          lane.appendChild(shot);
        }
        updateInput();
      }
      enemy.classList.toggle("wake-up-enemy-boss", bossWave);
      const progress = Math.min(1, Math.max(0, (at - round.enemyStartedAt) / (round.enemyEndsAt - round.enemyStartedAt)));
      enemy.style.right = `${5 + progress * 79}%`;
    }

    function updateDraft() {
      if (composingTurn !== null && composingTurn !== round.turn) return;
      round = { ...round, draft: input.value };
      updateInput();
    }

    function submit() {
      if (round.outcome) return;
      if (composingTurn !== null) input.blur();
      const at = performance.now();
      round = WakeUp.attack(round, at, round.turn, input.value);
      render(at);
      if (!round.outcome) input.focus({ preventScroll: true });
    }

    function upgrade(kind) {
      const at = performance.now();
      round = WakeUp.chooseUpgrade(round, at, kind);
      render(at);
      if (!round.outcome) input.focus({ preventScroll: true });
    }

    function tick() {
      const at = performance.now();
      round = WakeUp.advanceRound(round, at);
      render(at);
    }

    function stop() {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    }

    input.addEventListener("input", updateDraft);
    input.addEventListener("compositionstart", () => { composingTurn = round.turn; });
    input.addEventListener("compositionend", () => {
      if (composingTurn !== null && composingTurn !== round.turn) input.value = round.draft;
      composingTurn = null;
      if (!round.outcome) updateDraft();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing || event.keyCode === 229 || composingTurn !== null) return;
      event.preventDefault();
      if (!attack.disabled) submit();
    });
    attack.addEventListener("mousedown", (event) => event.preventDefault());
    attack.addEventListener("click", submit);
    repair.addEventListener("click", () => upgrade("repair"));
    power.addEventListener("click", () => upgrade("power"));

    render(round.startedAt);
    timer = setInterval(tick, 100);
    document.addEventListener("visibilitychange", tick);
    input.focus({ preventScroll: true });
    return () => { stop(); host.replaceChildren(); };
  }

  window.WakeUpBattleUI = { mount };
})();
