/* ---------------------------------------------------------------------------
   Quick Fire - the picture round.

   One drawing, nineteen missing words, and a clue sheet you pay for out of your
   own score. Self-paced: there is no clock, and the timer that does run is only
   ever used to separate two people who finished on the same number.

   The whole game runs in the browser. There is no server to ask, which is the
   point: a team can play it from a static page with nothing deployed. The
   leaderboard is the one exception, and it is optional - with no address built
   in, the game plays exactly the same and makes no network calls at all.

   Answers are in the page source. That is unavoidable in an offline game and is
   not worth pretending otherwise: this is an ice breaker, and the person who
   reads the source to win has already lost. The leaderboard does refuse to
   believe a score it was simply handed, so the board stays honest about what a
   round could have been worth.
   --------------------------------------------------------------------------- */
(function () {
  "use strict";

  // Filled in by scripts/build.py.
  var ROUND = __ROUND__;
  var RULES = __RULES__;
  var LEADERBOARD = __LEADERBOARD__;
  var SCENE = __SCENE__;

  var STORE_PLAYER = "quickfire.player";
  var STORE_NAME = "quickfire.name";
  var STORE_ROUND = "quickfire.picture";

  var E = QuickFireEngine;
  var COSTS = RULES.picture.clueCosts;

  var $ = function (id) { return document.getElementById(id); };

  /* ============================================================== state === */

  var state = null;
  var ticker = null;

  function freshRound() {
    return {
      round: ROUND.id,
      startedAt: Date.now(),
      elapsed: 0,
      open: null,
      items: ROUND.items.map(function () {
        return { status: "open", clues: [], letters: 0, typed: "" };
      })
    };
  }

  /** Seconds played. Held as a running total so closing the tab does not bank time. */
  function elapsed() {
    return state.elapsed + Math.floor((Date.now() - state.startedAt) / 1000);
  }

  function cluesBought() {
    var all = [];
    state.items.forEach(function (entry) {
      entry.clues.forEach(function (key) { all.push(key); });
    });
    return all;
  }

  /**
   * What the round is worth.
   *
   * Both bonuses want a clean sheet - every answer found, which rules out
   * reveals because a revealed item is never marked found. That is what lets
   * reveal be free without making "reveal the lot" a way to collect them.
   */
  function tally() {
    var found = 0;
    state.items.forEach(function (entry) { if (entry.status === "found") found += 1; });
    var clues = cluesBought();
    var spent = clues.reduce(function (sum, key) { return sum + (COSTS[key] || 0); }, 0);
    var perfect = found === state.items.length;
    return {
      found: found,
      of: state.items.length,
      base: found * RULES.picture.pointsPerItem,
      spent: spent,
      clues: clues,
      seconds: elapsed(),
      finisher: perfect ? RULES.picture.finisherBonus : 0,
      cleanSweep: perfect && clues.length === 0 ? RULES.picture.cleanSweepBonus : 0,
      get running() { return Math.max(0, this.base - this.spent); },
      get total() { return Math.max(0, this.base - this.spent + this.finisher + this.cleanSweep); }
    };
  }

  function save() {
    if (!state) return;
    try {
      var snapshot = JSON.parse(JSON.stringify(state));
      snapshot.elapsed = elapsed();
      snapshot.startedAt = Date.now();
      window.localStorage.setItem(STORE_ROUND, JSON.stringify(snapshot));
    } catch (err) { /* private browsing; the round will not survive a refresh */ }
  }

  function clearSaved() {
    try { window.localStorage.removeItem(STORE_ROUND); } catch (err) { /* nothing to clear */ }
  }

  function remembered(key, fallback) {
    try { return window.localStorage.getItem(key) || fallback; } catch (err) { return fallback; }
  }

  function remember(key, value) {
    try { window.localStorage.setItem(key, value); } catch (err) { /* not essential */ }
  }

  function playerId() {
    var id = remembered(STORE_PLAYER, "");
    if (!id) {
      id = "p-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      remember(STORE_PLAYER, id);
    }
    return id;
  }

  /* ========================================================== the picture === */

  function paintPicture() {
    $("picture-frame").innerHTML = SCENE;
  }

  /** Switch on the ring around one vignette, and take any other ring off. */
  function ringOn(n) {
    ["picture-frame", "lightbox-inner"].forEach(function (host) {
      var root = $(host);
      if (!root) return;
      Array.prototype.forEach.call(root.querySelectorAll(".ring"), function (ring) {
        ring.classList.toggle("on", ring.id === "ring-" + n);
      });
    });
  }

  function ringsOff() {
    ["picture-frame", "lightbox-inner"].forEach(function (host) {
      var root = $(host);
      if (!root) return;
      Array.prototype.forEach.call(root.querySelectorAll(".ring"), function (ring) {
        ring.classList.remove("on");
      });
    });
  }

  /* ============================================================ rendering === */

  function show(screen) {
    ["screen-home", "screen-round", "screen-result"].forEach(function (id) {
      $(id).hidden = id !== screen;
    });
    $("scoreboard").hidden = screen !== "screen-round";
    $("quit-link").hidden = screen !== "screen-round";
    window.scrollTo(0, 0);
  }

  function formatClock(seconds) {
    var minutes = Math.floor(seconds / 60);
    var rest = seconds % 60;
    return minutes + ":" + (rest < 10 ? "0" : "") + rest;
  }

  function renderGauges() {
    var scores = tally();
    $("score").textContent = scores.running;
    $("tally").textContent = scores.found + "/" + scores.of;
    $("clock").textContent = formatClock(scores.seconds);
  }

  function blanksFor(item, entry) {
    var row = document.createElement("span");
    row.className = "blanks";
    E.blanks(item, entry.letters).forEach(function (cell) {
      if (cell.space) {
        var gap = document.createElement("span");
        gap.className = "gap";
        row.appendChild(gap);
        return;
      }
      var box = document.createElement("span");
      box.className = "box" + (cell.letter ? " filled" : "");
      box.textContent = cell.letter || "";
      row.appendChild(box);
    });
    return row;
  }

  function renderClues(index) {
    var item = ROUND.items[index];
    var entry = state.items[index];
    var list = document.createElement("ul");
    list.className = "clues";

    E.pictureClues(item, entry.letters).forEach(function (clue) {
      var bought = entry.clues.indexOf(clue.key) !== -1;
      if (clue.reveal && entry.status !== "open") return;

      var li = document.createElement("li");
      var button = document.createElement("button");
      button.type = "button";
      button.className = "clue" + (bought && !clue.repeatable ? " bought" : "");
      button.disabled = entry.status !== "open" || (bought && !clue.repeatable);

      var body = document.createElement("span");
      body.className = "cluename";
      var label = document.createElement("span");
      label.textContent = clue.repeatable && bought
        ? clue.label + " (" + entry.letters + " so far)"
        : clue.label;
      body.appendChild(label);

      if (bought && clue.give) {
        var given = document.createElement("span");
        given.className = "given plain";
        given.textContent = clue.give;
        body.appendChild(given);
      }

      var cost = document.createElement("span");
      cost.className = "cost";
      cost.textContent = clue.reveal ? "free, scores 0" : "−" + COSTS[clue.key];

      button.appendChild(body);
      button.appendChild(cost);
      button.addEventListener("click", function () { buy(index, clue); });
      li.appendChild(button);
      list.appendChild(li);
    });
    return list;
  }

  function renderItem(index) {
    var item = ROUND.items[index];
    var entry = state.items[index];
    var li = document.createElement("li");
    li.className = "item is-" + entry.status + (state.open === index ? " open" : "");
    li.id = "item-" + index;

    var head = document.createElement("button");
    head.type = "button";
    head.className = "itemhead";
    head.setAttribute("aria-expanded", state.open === index ? "true" : "false");

    var num = document.createElement("span");
    num.className = "itemno";
    num.textContent = String(index + 1);

    var main = document.createElement("span");
    main.className = "itemmain";

    var template = document.createElement("span");
    template.className = "template";
    // The blanks sit inside the day's name, so "World ___ Day" reads as a sentence.
    var parts = item.template.split("___");
    template.appendChild(document.createTextNode(parts[0]));
    if (entry.status === "open") {
      template.appendChild(blanksFor(item, entry));
    } else {
      var solved = document.createElement("strong");
      solved.className = "solved";
      solved.textContent = item.answer;
      template.appendChild(solved);
    }
    template.appendChild(document.createTextNode(parts[1] || ""));
    main.appendChild(template);

    var meta = document.createElement("span");
    meta.className = "itemmeta";
    var spent = entry.clues.reduce(function (sum, key) { return sum + COSTS[key]; }, 0);
    if (entry.status === "found") meta.textContent = "Found · " + Math.max(0, 100 - spent) + " points";
    else if (entry.status === "shown") meta.textContent = "Shown · scores 0";
    else meta.textContent = E.lengthNote(item.answer) + (spent ? " · " + spent + " spent" : "");
    main.appendChild(meta);

    head.appendChild(num);
    head.appendChild(main);
    head.addEventListener("click", function () { toggle(index); });
    li.appendChild(head);

    if (state.open === index) {
      var body = document.createElement("div");
      body.className = "itembody";

      if (entry.status === "open") {
        var form = document.createElement("form");
        form.className = "answerbar";
        form.autocomplete = "off";
        var input = document.createElement("input");
        input.type = "text";
        input.maxLength = 40;
        input.placeholder = "The missing word";
        input.value = entry.typed || "";
        input.setAttribute("autocapitalize", "words");
        input.setAttribute("spellcheck", "false");
        input.setAttribute("enterkeyhint", "go");
        var go = document.createElement("button");
        go.type = "submit";
        go.className = "primary";
        go.textContent = "Answer";
        form.appendChild(input);
        form.appendChild(go);
        form.addEventListener("submit", function (event) {
          event.preventDefault();
          guess(index, input.value);
        });
        body.appendChild(form);
      } else if (item.note) {
        var note = document.createElement("p");
        note.className = "itemnote";
        note.textContent = item.note;
        body.appendChild(note);
      }

      body.appendChild(renderClues(index));
      li.appendChild(body);
    }
    return li;
  }

  function renderItems() {
    var list = $("item-list");
    list.innerHTML = "";
    ROUND.items.forEach(function (_, index) { list.appendChild(renderItem(index)); });
    renderGauges();
  }

  /** Redraw one row, so typing in another row is not thrown away by a full repaint. */
  function refreshItem(index) {
    var existing = $("item-" + index);
    if (!existing) { renderItems(); return; }
    existing.replaceWith(renderItem(index));
    renderGauges();
  }

  /* ============================================================== playing === */

  function stash() {
    if (state.open === null) return;
    var input = document.querySelector("#item-" + state.open + " input");
    if (input) state.items[state.open].typed = input.value;
  }

  function toggle(index) {
    stash();
    var previous = state.open;
    state.open = previous === index ? null : index;
    ringsOff();
    save();
    if (previous !== null && previous !== index) refreshItem(previous);
    refreshItem(index);
    if (state.open === index) {
      var input = document.querySelector("#item-" + index + " input");
      if (input) input.focus();
    }
  }

  function say(text, kind) {
    $("verdict").textContent = text;
    $("verdict").className = "verdict " + (kind || "");
  }

  function guess(index, typed) {
    var item = ROUND.items[index];
    var entry = state.items[index];
    if (entry.status !== "open") return;
    if (!E.normalize(typed)) return;

    if (E.answers(typed, item)) {
      entry.status = "found";
      entry.typed = "";
      state.open = null;
      ringsOff();
      save();
      refreshItem(index);
      say("“" + item.answer + "” — right.", "good");
      if (everythingResolved()) finish();
      return;
    }
    entry.typed = typed;
    save();
    say("Not that one. Try again, or buy a clue.", "bad");
    var input = document.querySelector("#item-" + index + " input");
    if (input) input.select();
  }

  function buy(index, clue) {
    var entry = state.items[index];
    if (entry.status !== "open") return;

    if (clue.reveal) {
      entry.status = "shown";
      entry.typed = "";
      save();
      refreshItem(index);
      say("Shown — that one scores nothing now.", "soft");
      if (everythingResolved()) finish();
      return;
    }

    if (clue.repeatable) {
      entry.letters += 1;
      entry.clues.push(clue.key);
    } else if (entry.clues.indexOf(clue.key) === -1) {
      entry.clues.push(clue.key);
    }

    stash();
    save();
    refreshItem(index);

    if (clue.key === "where") {
      ringOn(ROUND.items[index].n);
      $("picture").scrollIntoView({ behavior: "smooth", block: "center" });
      say("−" + COSTS[clue.key] + " points. It is ringed in the picture.", "soft");
    } else {
      say("−" + COSTS[clue.key] + " points.", "soft");
    }
  }

  function everythingResolved() {
    return state.items.every(function (entry) { return entry.status !== "open"; });
  }

  /* ================================================================ round === */

  function begin() {
    var name = $("player-name").value.trim();
    if (!name) {
      $("name-note").textContent = "Put a name in first — it is how your team will find you on the board.";
      $("name-note").style.color = "var(--amber)";
      $("player-name").focus();
      return;
    }
    remember(STORE_NAME, name);

    state = freshRound();
    save();
    show("screen-round");
    paintPicture();
    renderItems();
    startTicking();
    startRound().then(function (token) {
      if (state) { state.token = token; save(); }
    });
  }

  function startTicking() {
    stopTicking();
    ticker = window.setInterval(renderGauges, 1000);
  }

  function stopTicking() {
    if (ticker) window.clearInterval(ticker);
    ticker = null;
  }

  function finish() {
    if (!state) return;
    stopTicking();
    stash();
    var scores = tally();
    var finished = state;
    var token = state.token;
    clearSaved();
    state = null;

    renderResult(finished, scores);
    show("screen-result");
    submitRound(token, scores);
  }

  /* ============================================================== results === */

  function row(table, label, value, className) {
    var tr = table.insertRow();
    tr.insertCell().textContent = label;
    var cell = tr.insertCell();
    cell.textContent = value;
    if (className) cell.className = className;
    if (className === "total") tr.className = "total";
    return tr;
  }

  function renderResult(finished, scores) {
    $("result-kicker").textContent = ROUND.title;
    $("result-total").textContent = scores.total.toLocaleString();
    $("result-sub").textContent = scores.found + " of " + scores.of + " found"
      + (scores.clues.length ? ", " + scores.clues.length + " clue" + (scores.clues.length === 1 ? "" : "s") + " bought" : ", no clues bought")
      + ", in " + formatClock(scores.seconds);

    var table = $("breakdown");
    table.innerHTML = "";
    row(table, scores.found + " × " + RULES.picture.pointsPerItem + " each", scores.base);
    if (scores.spent) row(table, "Clues bought", "−" + scores.spent, "minus");
    if (scores.finisher) row(table, "All " + scores.of + " found", "+" + scores.finisher, "bonus");
    if (scores.cleanSweep) row(table, "Clean sweep, not a single clue", "+" + scores.cleanSweep, "bonus");
    if (scores.found !== scores.of && scores.found) {
      var note = table.insertRow();
      var cell = note.insertCell();
      cell.colSpan = 2;
      cell.className = "boardnote";
      cell.textContent = "The bonuses need all " + scores.of + " — next time.";
    }
    row(table, "Total", scores.total, "total");

    var answers = $("answer-list");
    answers.innerHTML = "";
    ROUND.items.forEach(function (item, index) {
      var entry = finished.items[index];
      var li = document.createElement("li");

      var name = document.createElement("p");
      name.className = "aa " + (entry.status === "found" ? "got" : "missed");
      name.textContent = item.template.replace("___", item.answer);
      li.appendChild(name);

      if (item.note) {
        var note = document.createElement("p");
        note.className = "an";
        note.textContent = item.note;
        li.appendChild(note);
      }
      answers.appendChild(li);
    });

    $("share-btn").onclick = function () { copyResult(finished, scores, $("share-btn")); };
  }

  /** A Wordle-shaped line for the team chat: clean, helped, or not at all. */
  function shareText(finished, scores) {
    var squares = finished.items.map(function (entry) {
      if (entry.status !== "found") return "⬛";
      return entry.clues.length ? "🟨" : "🟩";
    });
    var rows = [];
    for (var i = 0; i < squares.length; i += 10) rows.push(squares.slice(i, i + 10).join(""));
    var lines = [
      "Quick Fire — " + ROUND.title,
      scores.total.toLocaleString() + " points · " + scores.found + "/" + scores.of
        + " · " + formatClock(scores.seconds)
    ].concat(rows);
    if (window.location && window.location.href) lines.push(window.location.href.split("?")[0]);
    return lines.join("\n");
  }

  function copyResult(finished, scores, button) {
    var text = shareText(finished, scores);
    var done = function (ok) {
      button.textContent = ok ? "Copied" : "Press and hold to copy";
      window.setTimeout(function () { button.textContent = "Copy my result"; }, 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else {
      done(false);
    }
  }

  /* ========================================================= leaderboard === */

  function boardUrl(path) {
    return LEADERBOARD ? LEADERBOARD.url + path : null;
  }

  function startRound() {
    var url = boardUrl("/round/start");
    if (!url) return Promise.resolve(null);
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pack: ROUND.id })
    }).then(function (response) {
      return response.ok ? response.json() : null;
    }).then(function (body) {
      return body ? body.token : null;
    }).catch(function () { return null; });
  }

  function submitRound(token, scores) {
    var url = boardUrl("/round/finish");
    var board = $("board");
    if (!url || !token) { board.hidden = true; return; }

    board.hidden = false;
    $("board-title").textContent = "Leaderboard — " + ROUND.title;
    $("board-note").textContent = "Posting your score…";
    $("board-table").innerHTML = "";

    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: token,
        player: playerId(),
        name: remembered(STORE_NAME, "") || $("player-name").value.trim(),
        right: scores.found,
        questions: scores.of,
        clues: scores.clues,
        seconds: scores.seconds
      })
    }).then(function (response) {
      return response.json().then(function (body) { return { ok: response.ok, body: body }; });
    }).then(function (result) {
      if (!result.ok) throw new Error(result.body && result.body.error);
      renderBoard(result.body);
    }).catch(function () {
      $("board-note").textContent = "The leaderboard could not be reached. Your score still stands — "
        + "use “Copy my result” to post it to the team.";
    });
  }

  function renderBoard(body) {
    var table = $("board-table");
    table.innerHTML = "";
    var head = table.createTHead().insertRow();
    ["", "Player", "Score"].forEach(function (label) {
      var th = document.createElement("th");
      th.textContent = label;
      head.appendChild(th);
    });
    var tbody = table.createTBody();
    (body.top || []).forEach(function (entry, index) {
      var tr = tbody.insertRow();
      tr.insertCell().textContent = String(index + 1);
      tr.insertCell().textContent = entry.name;
      tr.insertCell().textContent = entry.score.toLocaleString();
      if (body.you && entry.name === body.you.name && entry.score === body.you.score) {
        tr.className = "you";
      }
    });

    var parts = [];
    if (body.you) parts.push("You are " + ordinal(body.you.rank) + " of " + body.players + ".");
    if (body.counted === false) parts.push("Only your first attempt counts, so this run did not move the board.");
    $("board-note").textContent = parts.join(" ");
  }

  function ordinal(n) {
    var rest = n % 100;
    if (rest >= 11 && rest <= 13) return n + "th";
    var suffixes = { 1: "st", 2: "nd", 3: "rd" };
    return n + (suffixes[n % 10] || "th");
  }

  /* ================================================================ boot === */

  function goHome() {
    stopTicking();
    state = null;
    clearSaved();
    show("screen-home");
  }

  function wire() {
    $("start-btn").addEventListener("click", begin);
    $("home-link").addEventListener("click", function () {
      if (!state || window.confirm("Leave this round? It will not be scored.")) goHome();
    });
    $("quit-link").addEventListener("click", function () {
      if (window.confirm("Finish here and see the answers?")) finish();
    });
    $("rules-link").addEventListener("click", function () { $("rules-sheet").hidden = false; });
    $("rules-close").addEventListener("click", function () { $("rules-sheet").hidden = true; });
    $("rules-sheet").addEventListener("click", function (event) {
      if (event.target === $("rules-sheet")) $("rules-sheet").hidden = true;
    });
    $("again-btn").addEventListener("click", goHome);
    $("player-name").addEventListener("change", function () {
      remember(STORE_NAME, $("player-name").value.trim());
    });
    $("zoom-btn").addEventListener("click", function () {
      $("lightbox-inner").innerHTML = SCENE;
      // Carry any ring that is currently lit through to the big copy.
      var lit = $("picture-frame").querySelector(".ring.on");
      if (lit) {
        var twin = $("lightbox-inner").querySelector("#" + lit.id);
        if (twin) twin.classList.add("on");
      }
      $("lightbox").hidden = false;
    });
    $("lightbox-close").addEventListener("click", function () {
      $("lightbox").hidden = true;
      $("lightbox-inner").innerHTML = "";
    });
    window.addEventListener("beforeunload", save);
  }

  function resume() {
    var saved;
    try { saved = JSON.parse(window.localStorage.getItem(STORE_ROUND)); } catch (err) { saved = null; }
    if (!saved || saved.round !== ROUND.id || !Array.isArray(saved.items)
        || saved.items.length !== ROUND.items.length) {
      return false;
    }
    state = saved;
    state.startedAt = Date.now();
    show("screen-round");
    paintPicture();
    renderItems();
    startTicking();
    return true;
  }

  function boot() {
    wire();
    $("home-subject").textContent = ROUND.subject;
    $("home-title").textContent = ROUND.title;
    $("home-blurb").textContent = ROUND.blurb;
    $("tally").textContent = "0/" + ROUND.items.length;
    $("player-name").value = remembered(STORE_NAME, "");
    if (!resume()) show("screen-home");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
