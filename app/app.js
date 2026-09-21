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

  // Whoever opens the page with ?host=<key> gets the start button. The key is a
  // secret on the server; a player who has not been given it sees nothing.
  var HOST_KEY = (function () {
    try {
      return new URLSearchParams(window.location.search).get("host") || "";
    } catch (err) { return ""; }
  })();

  var E = QuickFireEngine;
  var COSTS = RULES.picture.clueCosts;

  var $ = function (id) { return document.getElementById(id); };

  /* ============================================================== state === */

  var state = null;
  var ticker = null;

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
      seconds: RULES.live.seconds - secondsLeft(),
      finisher: perfect ? RULES.picture.finisherBonus : 0,
      cleanSweep: perfect && clues.length === 0 ? RULES.picture.cleanSweepBonus : 0,
      get running() { return Math.max(0, this.base - this.spent); },
      get total() { return Math.max(0, this.base - this.spent + this.finisher + this.cleanSweep); }
    };
  }

  function save() {
    if (!state) return;
    try {
      window.localStorage.setItem(STORE_ROUND, JSON.stringify(state));
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
    if (screen !== "screen-round") $("gauge-place").hidden = true;
    $("quit-link").hidden = screen !== "screen-round";
    measureMasthead();
    window.scrollTo(0, 0);
  }

  function formatClock(seconds) {
    var minutes = Math.floor(seconds / 60);
    var rest = seconds % 60;
    return minutes + ":" + (rest < 10 ? "0" : "") + rest;
  }

  function renderGauges() {
    var scores = tally();
    var left = secondsLeft();
    $("score").textContent = scores.running;
    $("tally").textContent = scores.found + "/" + scores.of;
    $("clock").textContent = formatClock(left);
    $("clock").parentNode.classList.toggle("urgent", left <= 60);
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

      var verdict = document.createElement("p");
      verdict.className = "verdict";
      verdict.setAttribute("role", "status");
      verdict.setAttribute("aria-live", "polite");
      body.appendChild(verdict);

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
    applyHideFound();
    renderGauges();
  }

  /** Shorten the list as it gets easier, rather than scrolling past what is done. */
  function applyHideFound() {
    $("item-list").classList.toggle("hide-found", $("hide-found").checked);
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
      var row = $("item-" + index);
      // Opening a row near the bottom would otherwise put the input and its clue
      // sheet below the fold, which is the scrolling this layout exists to avoid.
      if (row) row.scrollIntoView({ behavior: "smooth", block: "nearest" });
      var input = document.querySelector("#item-" + index + " input");
      if (input) input.focus({ preventScroll: true });
    }
  }

  /**
   * Say something, inside the row it is about.
   *
   * It used to sit above the list, which on a phone meant the answer to "was
   * that right?" was off the top of the screen by the time you had typed it.
   */
  function say(index, text, kind) {
    var host = document.querySelector("#item-" + index + " .verdict");
    if (!host) return;
    host.textContent = text;
    host.className = "verdict " + (kind || "");
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
      pushProgress(true);
      if (everythingResolved()) offerResult();
      return;
    }
    entry.typed = typed;
    save();
    say(index, "Not that one. Try again, or buy a clue.", "bad");
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
      flash("Shown — that one scores nothing now.");
      pushProgress(false);
      if (everythingResolved()) offerResult();
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
      say(index, "−" + COSTS[clue.key] + " points — ringed in the picture above.", "soft");
    } else {
      say(index, "−" + COSTS[clue.key] + " points.", "soft");
    }
    pushProgress(false);
  }

  /** A brief note where the list header is, for when the row it concerns has closed. */
  var flashTimer = null;
  function flash(text) {
    var host = $("all-found");
    host.hidden = false;
    host.textContent = text;
    host.className = "allfound";
    if (flashTimer) window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(function () {
      if (state && !everythingResolved()) { host.hidden = true; host.textContent = ""; }
    }, 2200);
  }

  function everythingResolved() {
    return state.items.every(function (entry) { return entry.status !== "open"; });
  }

  /**
   * Nothing left open.
   *
   * Offered rather than taken: dropping someone straight onto the results page
   * the instant they fill the last blank gives them no moment to look at what
   * they have done, and no way back if the last one was a guess.
   */
  function offerResult() {
    if (flashTimer) window.clearTimeout(flashTimer);
    var host = $("all-found");
    host.hidden = false;
    host.className = "allfound";
    host.innerHTML = "";
    host.appendChild(document.createTextNode("That is every one of them. "));
    var button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.textContent = "See the result";
    button.addEventListener("click", finish);
    host.appendChild(button);
    host.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* ============================================================= the server ===
     The clock lives on the server. Everyone in the room is counting down to the
     same instant, and a client never decides for itself that time is up - it
     asks, and it measures its own clock against the server's so that a laptop
     three minutes fast does not get a three minute shorter game.
  */

  var server = {
    offset: 0,        // serverNow - ourNow, in ms
    phase: "offline",
    endsAt: null,
    players: 0,
    you: null,
    board: null,
    reachable: Boolean(LEADERBOARD)
  };

  var poller = null;

  function api(path, body) {
    if (!LEADERBOARD) return Promise.reject(new Error("no server"));
    var url = LEADERBOARD.url + path;
    var options = body
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : { method: "GET" };
    return fetch(url, options).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) throw new Error(data && data.error ? data.error : "server error");
        return data;
      });
    });
  }

  /** Fold a reply into what we know, including how far our own clock is out. */
  function absorb(data) {
    if (typeof data.now === "number") server.offset = data.now - Date.now();
    if (data.phase) server.phase = data.phase;
    if ("endsAt" in data) server.endsAt = data.endsAt;
    if (typeof data.players === "number") server.players = data.players;
    if (data.you) server.you = data.you;
    if (data.board) server.board = data.board;
    server.reachable = true;
    return data;
  }

  function serverNow() {
    return Date.now() + server.offset;
  }

  /** Seconds left of the shared five minutes, by the server's clock. */
  function secondsLeft() {
    if (!server.endsAt) return RULES.live.seconds;
    return Math.max(0, Math.ceil((server.endsAt - serverNow()) / 1000));
  }

  /* ================================================================ lobby === */

  function renderLobby() {
    var joined = Boolean(state);
    $("join-btn").hidden = joined;
    $("waiting").hidden = !joined;
    $("wait-count").textContent = server.players === 1
      ? "1 player in so far."
      : server.players + " players in so far.";
    $("wait-text").textContent = server.phase === "running"
      ? "The game is already running \u2014 joining you now\u2026"
      : "Waiting for the host to start\u2026";

    if (HOST_KEY) {
      $("hostbox").hidden = false;
      $("host-note").textContent = server.phase === "lobby"
        ? "Everyone in the room should have joined before you press this."
        : server.phase === "running"
          ? "Running. It stops for everybody at the same moment."
          : "That game is over. Start a new one to play again.";
      $("start-btn").disabled = server.phase !== "lobby";
    }
  }

  function joinGame() {
    var name = $("player-name").value.trim();
    if (!name) {
      $("name-note").textContent = "Put a name in first \u2014 it is how you will show up on the board.";
      $("name-note").style.color = "var(--crimson)";
      $("player-name").focus();
      return;
    }
    remember(STORE_NAME, name);

    if (!LEADERBOARD) {
      // No server means no shared clock, so there is no game to join. Say so
      // rather than quietly starting a solo round nobody else is in.
      offline("This copy has no game server configured, so it cannot run a live game. "
        + "You can still play it on your own against the clock.");
      beginSolo();
      return;
    }

    api("/join", { player: playerId(), name: name }).then(function (data) {
      absorb(data);
      state = state || freshRound();
      save();
      renderLobby();
      if (server.phase === "running") enterRound();
    }).catch(function (err) {
      offline("Could not reach the game server (" + err.message + "). Playing on your own instead.");
      beginSolo();
    });
  }

  function offline(message) {
    server.reachable = false;
    $("offline-note").hidden = false;
    $("offline-note").textContent = message;
  }

  /* ================================================================ round === */

  function freshRound() {
    return {
      round: ROUND.id,
      open: null,
      items: ROUND.items.map(function () {
        return { status: "open", clues: [], letters: 0, typed: "" };
      })
    };
  }

  /** A round with nobody else in it, for a page that cannot reach the server. */
  function beginSolo() {
    state = freshRound();
    server.phase = "running";
    server.endsAt = Date.now() + RULES.live.seconds * 1000;
    server.offset = 0;
    enterRound();
  }

  function enterRound() {
    show("screen-round");
    paintPicture();
    renderItems();
    startTicking();
    pushProgress();
  }

  function startTicking() {
    stopTicking();
    ticker = window.setInterval(function () {
      renderGauges();
      if (secondsLeft() <= 0) finish();
    }, 500);
  }

  function stopTicking() {
    if (ticker) window.clearInterval(ticker);
    ticker = null;
  }

  /* ============================================================== polling === */

  function startPolling(everyMs) {
    stopPolling();
    if (!LEADERBOARD) return;
    poller = window.setInterval(pollOnce, everyMs);
    pollOnce();
  }

  function stopPolling() {
    if (poller) window.clearInterval(poller);
    poller = null;
  }

  function pollOnce() {
    if (!LEADERBOARD) return;
    api("/game?player=" + encodeURIComponent(playerId())).then(function (data) {
      var was = server.phase;
      absorb(data);
      if (was !== "running" && server.phase === "running" && state) {
        enterRound();
        startPolling(RULES.live.playPollMs);
      } else if (server.phase === "over" && $("screen-round").hidden === false) {
        finish();
      } else if ($("screen-result").hidden === false) {
        renderFinalBoard();
      } else if ($("screen-home").hidden === false) {
        renderLobby();
      }
    }).catch(function () { /* a dropped poll is not worth shouting about */ });
  }

  /**
   * Tell the server where we have got to, and say where that puts us.
   *
   * Sent on every answer rather than at the end, because the board is live and
   * because a browser that dies at minute four should still have its score.
   */
  function pushProgress(announce) {
    if (!LEADERBOARD || !server.reachable || !state) return;
    var scores = tally();
    api("/progress", {
      player: playerId(),
      found: scores.found,
      clues: scores.clues
    }).then(function (data) {
      absorb(data);
      renderRank(data, announce);
      if (data.phase === "over") finish();
    }).catch(function () { /* keep playing; the next answer will try again */ });
  }

  /** The running position, and a louder version of it the moment it changes. */
  function renderRank(data, announce) {
    if (!data.you) return;
    $("gauge-place").hidden = false;
    $("rank").textContent = ordinal(data.you.rank);
    if (announce) {
      // The alert the round is played for: told where that answer just put you.
      flash("Right \u2014 " + ordinal(data.you.rank) + " of " + data.players
        + " on " + data.you.score + ".");
      var gauge = $("gauge-place");
      gauge.classList.remove("bump");
      void gauge.offsetWidth;
      gauge.classList.add("bump");
    }
  }

  var finishing = false;

  /**
   * Time is up, for everybody at once.
   *
   * The last thing sent is the final progress, so a point earned in the closing
   * seconds still counts, and only then is the shared table fetched. Guarded,
   * because the ticker and a poll can both notice the end in the same moment.
   */
  function finish() {
    if (!state || finishing) return;
    finishing = true;
    stopTicking();
    stash();

    var scores = tally();
    var finished = state;
    clearSaved();

    var done = function () {
      state = null;
      finishing = false;
      renderResult(finished, scores);
      show("screen-result");
      startPolling(RULES.live.playPollMs);
    };

    if (!LEADERBOARD || !server.reachable) { done(); return; }
    api("/progress", { player: playerId(), found: scores.found, clues: scores.clues })
      .then(absorb)
      .catch(function () { /* the board will show what it last heard */ })
      .then(function () { return api("/board").then(absorb).catch(function () {}); })
      .then(done);
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
      + (scores.clues.length
          ? ", " + scores.clues.length + " clue" + (scores.clues.length === 1 ? "" : "s") + " bought"
          : ", no clues bought");
    renderFinalBoard();

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

  /**
   * The table everybody sees at the end.
   *
   * Drawn from whatever the server last told us, and redrawn by the poll that
   * keeps running after the whistle - so a straggler's final answer still shows
   * up on everyone else's screen a few seconds later.
   */
  function renderFinalBoard() {
    var place = $("result-place");
    if (server.you) {
      place.textContent = ordinal(server.you.rank) + " of " + server.players;
    } else {
      place.textContent = "";
    }

    var board = $("board");
    var rows = server.board;
    if (!rows || !rows.length) {
      board.hidden = true;
      return;
    }
    board.hidden = false;
    $("board-title").textContent = "Final table \u2014 " + server.players
      + (server.players === 1 ? " player" : " players");

    var table = $("board-table");
    table.innerHTML = "";
    var head = table.createTHead().insertRow();
    ["", "Player", "Found", "Score"].forEach(function (label) {
      var th = document.createElement("th");
      th.textContent = label;
      head.appendChild(th);
    });
    var body = table.createTBody();
    rows.forEach(function (row, index) {
      var tr = body.insertRow();
      tr.insertCell().textContent = String(index + 1);
      tr.insertCell().textContent = row.name;
      tr.insertCell().textContent = row.found + "/" + ROUND.items.length;
      tr.insertCell().textContent = row.score.toLocaleString();
      if (server.you && row.name === server.you.name && row.score === server.you.score) {
        tr.className = "you";
      }
    });
    $("board-note").textContent = server.reachable
      ? ""
      : "Shown from the last thing this device heard from the game server.";
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
    renderLobby();
    startPolling(RULES.live.lobbyPollMs);
  }

  /**
   * Tell the stylesheet how tall the masthead actually is.
   *
   * It wraps to two lines on a narrow screen, so a fixed offset for the sticky
   * picture hid its top row behind the header on exactly the devices most likely
   * to be used.
   */
  function measureMasthead() {
    var bar = document.querySelector(".masthead");
    if (!bar) return;
    document.documentElement.style.setProperty(
      "--mast", Math.round(bar.getBoundingClientRect().height) + "px");
  }

  function wire() {
    $("join-btn").addEventListener("click", joinGame);
    $("start-btn").addEventListener("click", function () {
      $("start-btn").disabled = true;
      api("/host/start", { key: HOST_KEY }).then(function (data) {
        absorb(data);
        renderLobby();
        if (server.phase === "running" && state) enterRound();
      }).catch(function (err) {
        $("host-note").textContent = "Could not start it: " + err.message;
        $("start-btn").disabled = false;
      });
    });
    $("reset-btn").addEventListener("click", function () {
      if (!window.confirm("Start a new game? Everyone will have to join again.")) return;
      api("/host/open", { key: HOST_KEY, round: ROUND.id }).then(function (data) {
        absorb(data);
        goHome();
      }).catch(function (err) { $("host-note").textContent = "Could not reset: " + err.message; });
    });
    $("home-link").addEventListener("click", function () {
      if (!state || window.confirm("Leave this round? Your score stands as it is.")) goHome();
    });
    $("quit-link").addEventListener("click", function () {
      if (window.confirm("Stop here? The clock carries on for everyone else.")) finish();
    });
    $("rules-link").addEventListener("click", function () { $("rules-sheet").hidden = false; });
    $("rules-close").addEventListener("click", function () { $("rules-sheet").hidden = true; });
    $("rules-sheet").addEventListener("click", function (event) {
      if (event.target === $("rules-sheet")) $("rules-sheet").hidden = true;
    });
    $("again-btn").addEventListener("click", goHome);
    $("hide-found").addEventListener("change", applyHideFound);
    $("finish-btn").addEventListener("click", finish);
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
    window.addEventListener("resize", measureMasthead);
    window.addEventListener("orientationchange", measureMasthead);
  }

  /** Pick up a round that was interrupted. The clock is the server's, not ours. */
  function resume() {
    var saved;
    try { saved = JSON.parse(window.localStorage.getItem(STORE_ROUND)); } catch (err) { saved = null; }
    if (!saved || saved.round !== ROUND.id || !Array.isArray(saved.items)
        || saved.items.length !== ROUND.items.length) {
      return null;
    }
    return saved;
  }

  function boot() {
    wire();
    measureMasthead();
    $("home-subject").textContent = ROUND.subject;
    $("home-title").textContent = ROUND.title;
    $("home-blurb").textContent = ROUND.blurb;
    $("tally").textContent = "0/" + ROUND.items.length;
    $("player-name").value = remembered(STORE_NAME, "");
    state = resume();

    show("screen-home");
    renderLobby();

    if (!LEADERBOARD) {
      offline("No game server is configured, so this copy plays on its own rather than "
        + "against the room. Everything else works the same.");
      return;
    }
    // Ask once straight away so the lobby is right on the first paint, then settle
    // into the slower poll.
    startPolling(RULES.live.lobbyPollMs);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
