/* ---------------------------------------------------------------------------
   Red Letter Day - the picture round.

   One drawing, a list of missing words, and a clue sheet you pay for out of your
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
  var ROUNDS = __ROUNDS__;
  var SCENES = __SCENES__;
  var RULES = __RULES__;
  var LEADERBOARD = __LEADERBOARD__;

  /* ============================================================== today ===
     A round belongs to a date, and the date is its id. Today's is whichever
     round carries today's date; failing that, the most recent one that is not
     in the future, so a gap in the calendar shows yesterday's rather than
     nothing at all.
  */

  function todayISO() {
    var now = new Date();
    // Local date, not UTC: "today" is the day the player is having, and an hour
    // either side of midnight should not show them the wrong round.
    return now.getFullYear() + "-"
      + String(now.getMonth() + 1).padStart(2, "0") + "-"
      + String(now.getDate()).padStart(2, "0");
  }

  function roundFor(id) {
    for (var i = 0; i < ROUNDS.length; i += 1) {
      if (ROUNDS[i].id === id) return ROUNDS[i];
    }
    return null;
  }

  // Both live in the engine, where they can be tested against a fixed date
  // rather than against whatever day the test happens to run on.
  function roundForToday() {
    return RedLetterEngine.roundForDate(ROUNDS, todayISO());
  }

  /** Playable now: today's and everything before it, newest first. */
  function playableRounds() {
    return RedLetterEngine.playableOn(ROUNDS, todayISO());
  }

  var ROUND = roundForToday();
  var SCENE = SCENES[ROUND.scene];

  var STORE_PLAYER = "redletter.player";
  var STORE_NAME = "redletter.name";
  var STORE_ROUND = "redletter.round";

  // Whoever opens the page with ?host=<key> gets the start button. The key is a
  // secret on the server; a player who has not been given it sees nothing.
  var STORE_HOST = "redletter.host";
  var STORE_INSTALL = "redletter.install";

  // The key can arrive in the address bar or be typed in. Whichever it is, it is
  // only believed once the server has agreed to it.
  var HOST_KEY = "";
  var hostUnlocked = false;

  var E = RedLetterEngine;
  var COSTS = RULES.picture.clueCosts;

  var $ = function (id) { return document.getElementById(id); };

  /* ============================================================ briefing ===
     Written once and shown in two places: the lobby, where people are waiting
     with nothing to do and will actually read it, and the How to play sheet.
     One list, so the two cannot end up saying different things - and the prices
     come from the rules rather than being typed out again beside them.
  */

  /** A title dropped into the middle of a sentence should not shout. */
  function midSentence(title) {
    return /^The\s/.test(title) ? "t" + title.slice(1) : title;
  }

  var BRIEFING = [
    // No counts in the wording. Rounds are not all the same size, and a number
    // written into a sentence here was contradicting the one worked out from the
    // round itself. The tally in the masthead says how many there are.
    ["One picture, every answer in it.",
     "Each one is a real thing somebody celebrates on " + midSentence(ROUND.title)
       + ", and each one is drawn in the picture somewhere."],
    ["Name the missing word.",
     "Not the whole day \u2014 just the blank. Each has a couple of letters filled in to start you off."],
    ["Everyone plays at once.",
     "The host starts the clock and you all get the same " + Math.round(RULES.live.seconds / 60)
       + " minutes. When it stops it stops for everybody, and the table goes up."],
    ["100 points an answer.",
     "Spelling is forgiven on the longer ones, and accents and punctuation are optional."],
    ["The numbers match.",
     "Each drawing carries a number, and it is the number of the blank it answers."],
    ["Clues cost points.",
     "The category is " + COSTS.category + ", another letter " + COSTS.letter
       + ", describing the drawing " + COSTS.spot + ", a hint in words " + COSTS.hint
       + ", an anagram " + COSTS.anagram + ". Buy what you need and no more."],
    ["Giving up on one is free.",
     "Revealing an answer costs nothing, but that one scores nothing \u2014 and it ends any hope of the bonuses."],
    ["The bonuses need a clean sheet.",
     "Every one of them right earns " + RULES.picture.finisherBonus
       + ", and doing it without buying a single clue is another " + RULES.picture.cleanSweepBonus
       + ". In " + Math.round(RULES.live.seconds / 60) + " minutes, good luck."],
    ["The board is live.",
     "Every time you get one, you are told where you have just landed."]
  ];

  function renderBriefing() {
    ["brief", "rulelist"].forEach(function (id) {
      var list = $(id);
      if (!list || list.childNodes.length) return;
      BRIEFING.forEach(function (line) {
        var li = document.createElement("li");
        var lead = document.createElement("strong");
        lead.textContent = line[0];
        li.appendChild(lead);
        li.appendChild(document.createTextNode(" " + line[1]));
        list.appendChild(li);
      });
    });
  }

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

  /** Two names are the same person if they match once case and padding are gone. */
  function sameName(a, b) {
    return String(a).trim().toLowerCase() === String(b || "").trim().toLowerCase();
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

  /**
   * One drawing on its own, cropped out of the scene.
   *
   * The same picture with a different viewBox, so there is no second copy of the
   * artwork to keep in step - just a window onto part of the one there is. Shown
   * inside the row it belongs to, which is what stops anybody hunting for it: the
   * scene stays up top to be scanned, and the drawing you are actually answering
   * is directly above the box you type into.
   */
  function croppedScene(box) {
    return SCENE.replace(/viewBox="[^"]*"/, 'viewBox="' + box.join(" ") + '"');
  }

  /** Move to another day's round, carrying nothing from the last one. */
  function chooseRound(id) {
    var next = roundFor(id);
    if (!next) return;
    stopTicking();
    ROUND = next;
    SCENE = SCENES[ROUND.scene];
    state = null;
    clearSaved();
    $("tally").textContent = "0/" + ROUND.items.length;
    describeRound();
    goHome();
  }

  /** Put the chosen round's name and blurb on the screen. */
  function describeRound() {
    $("home-subject").textContent = ROUND.subject;
    $("home-title").textContent = ROUND.title;
    $("home-blurb").textContent = ROUND.blurb;
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
    num.textContent = String(item.n);

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

      if (item.box) {
        var pic = document.createElement("div");
        pic.className = "rowpic";
        // No number of its own: the crop already contains the badge the scene
        // draws on that vignette, and two of them side by side read as an error.
        pic.innerHTML = croppedScene(item.box);
        body.appendChild(pic);
      }

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
    save();
    if (previous !== null && previous !== index) refreshItem(previous);
    refreshItem(index);
    if (state.open === index) {
      scrollRowIntoView(index);
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
  /**
   * Put a row just below whatever is pinned above it.
   *
   * Worked out here rather than left to scroll-margin-top, because the pinned
   * height changes the moment the picture zooms and a CSS variable measured a
   * frame earlier put the row behind the picture instead of under it.
   */
  function scrollRowIntoView(index) {
    var row = $("item-" + index);
    if (!row) return;
    var bar = document.querySelector(".masthead");
    var picture = $("picture");
    var pinned = (bar ? bar.getBoundingClientRect().height : 0)
      + (picture && picture.offsetHeight ? picture.getBoundingClientRect().height : 0);
    var top = row.getBoundingClientRect().top + window.scrollY - pinned - 8;
    window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }

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

    say(index, "−" + COSTS[clue.key] + " points.", "soft");
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
    waiting: 0,
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
    if (typeof data.waiting === "number") server.waiting = data.waiting;
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
    // Once you are in, the instructions take the screen: the title and the blurb
    // have been read by then, and the briefing says everything they did.
    $("joinbox").hidden = joined;
    $("waiting").hidden = !joined;
    $("wait-count").textContent = server.waiting === 1
      ? "1 player waiting."
      : server.waiting + " players waiting.";
    $("wait-text").textContent = server.phase === "running"
      ? "The game is already running \u2014 joining you now\u2026"
      : "Waiting for the host to start\u2026";

    renderHostBox();
  }

  /** The host panel: a password to type, or the buttons it unlocks. */
  function renderHostBox() {
    $("host-unlock").hidden = hostUnlocked;
    $("host-ready").hidden = !hostUnlocked;
    if (!hostUnlocked) return;
    $("host-note").textContent = server.phase === "lobby"
      ? "Everyone in the room should have joined before you press this."
      : server.phase === "running"
        ? "Running. It stops for everybody at the same moment."
        : "That game is over. Start a new one to play again.";
    $("start-btn").disabled = server.phase !== "lobby";
  }

  /**
   * Try a host password against the server.
   *
   * /host/check exists so this can be answered without also starting the game or
   * emptying the room - finding out your password is wrong by pressing start in
   * front of everybody is how this went the first time.
   */
  function tryHostKey(key, note) {
    var candidate = String(key || "").trim();
    if (!candidate) return Promise.resolve(false);
    if (!LEADERBOARD) {
      if (note) note.textContent = "No game server is configured, so there is nothing to unlock.";
      return Promise.resolve(false);
    }
    return api("/host/check", { key: candidate }).then(function (data) {
      absorb(data);
      HOST_KEY = candidate;
      hostUnlocked = true;
      remember(STORE_HOST, candidate);
      $("hostbox").hidden = false;
      renderLobby();
      return true;
    }).catch(function (err) {
      hostUnlocked = false;
      if (note) {
        note.textContent = err.message === "that is not the host key"
          ? "That is not the password. It is the HOST_KEY you set in the Cloudflare dashboard."
          : err.message === "no host key is set on the server"
            ? "The server has no password set yet. Add HOST_KEY in the Cloudflare dashboard."
            : "Could not check it: " + err.message;
      }
      return false;
    });
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

    api("/join", { player: playerId(), name: name, round: ROUND.id }).then(function (data) {
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

  /** The list of days you can still play, with today's marked. */
  function renderRoundPicker() {
    var list = $("round-list");
    if (!list) return;
    var playable = playableRounds();
    $("past-rounds").hidden = playable.length < 2;
    list.innerHTML = "";
    playable.forEach(function (round) {
      var li = document.createElement("li");
      var button = document.createElement("button");
      button.type = "button";
      button.className = "roundpick" + (round.id === ROUND.id ? " current" : "");
      var when = document.createElement("span");
      when.className = "when";
      when.textContent = round.id === roundForToday().id ? "Today" : longDate(round.date);
      var what = document.createElement("span");
      what.className = "what";
      what.textContent = round.title;
      button.appendChild(when);
      button.appendChild(what);
      button.addEventListener("click", function () { chooseRound(round.id); });
      li.appendChild(button);
      list.appendChild(li);
    });
  }

  var MONTHS = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];

  function longDate(iso) {
    var parts = String(iso).split("-");
    return Number(parts[2]) + " " + MONTHS[Number(parts[1]) - 1];
  }

  /**
   * Play it alone, right now.
   *
   * The clock is still the server's - it hands back an end time the same way it
   * does for a hosted game - so a solo score and a hosted one are the same five
   * minutes and belong on the same table.
   */
  function playSolo() {
    var name = $("player-name").value.trim();
    if (!name) {
      $("name-note").textContent = "Put a name in first \u2014 it is how you will show up on the board.";
      $("name-note").style.color = "var(--crimson)";
      $("player-name").focus();
      return;
    }
    remember(STORE_NAME, name);

    if (!LEADERBOARD) {
      offline("No game server is configured, so there is no table to join. Playing on your own.");
      beginSolo();
      return;
    }

    $("solo-btn").disabled = true;
    api("/solo/start", { player: playerId(), name: name, round: ROUND.id })
      .then(function (data) {
        absorb(data);
        $("solo-btn").disabled = false;
        if (data.played) {
          $("name-note").textContent = "You have already played " + ROUND.title
            + ". Only your first go counts \u2014 try another day.";
          $("name-note").style.color = "var(--crimson)";
          renderRoundPicker();
          return;
        }
        state = freshRound();
        save();
        enterRound();
      })
      .catch(function (err) {
        $("solo-btn").disabled = false;
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
    api("/game?player=" + encodeURIComponent(playerId()) + "&round=" + encodeURIComponent(ROUND.id)).then(function (data) {
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
      round: ROUND.id,
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
    api("/progress", { player: playerId(), round: ROUND.id, found: scores.found, clues: scores.clues })
      .then(absorb)
      .catch(function () { /* the board will show what it last heard */ })
      .then(function () {
        return api("/board?round=" + encodeURIComponent(ROUND.id)).then(absorb).catch(function () {});
      })
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
      "Red Letter Day — " + ROUND.title,
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
    var mast = Math.round(bar.getBoundingClientRect().height);
    document.documentElement.style.setProperty("--mast", mast + "px");

    // How much of the top of the screen is pinned in total. A row scrolled to
    // without allowing for it lands underneath the picture, which hides the very
    // blanks you are filling in.
    var picture = $("picture");
    var stuck = mast;
    if (picture && !picture.hidden && picture.offsetHeight) stuck += picture.offsetHeight;
    document.documentElement.style.setProperty("--stick", stuck + "px");
  }

  /* ============================================== putting it on a phone === */

  /*
   * Two entirely different jobs wearing one name.
   *
   * Chrome fires `beforeinstallprompt`, which can be caught and re-fired from a
   * button of our own, so Android gets a real one-tap install.
   *
   * Safari fires nothing. Apple has never implemented that event, and there is
   * no way for a page to ask, so on an iPhone the prompt everyone else sees is
   * simply never coming. All a page can honestly do is point at the menu item,
   * which is why the two branches look so unalike.
   */
  var installEvent = null;

  /** iPhones and iPads, including an iPad claiming to be a Mac since iPadOS 13. */
  function isApplePhone() {
    var ua = window.navigator.userAgent || "";
    if (/iPhone|iPad|iPod/.test(ua)) return true;
    return window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1;
  }

  /** Already on the home screen? Then there is nothing to offer. */
  function alreadyInstalled() {
    if (window.navigator.standalone === true) return true;
    return Boolean(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  }

  function setUpInstall() {
    var box = $("install-box");
    if (!box) return;
    if (alreadyInstalled() || remembered(STORE_INSTALL, "") === "no") return;

    window.addEventListener("beforeinstallprompt", function (event) {
      // Chrome's own banner is suppressed by this, so having caught it we owe
      // the user a button that does the same thing.
      event.preventDefault();
      installEvent = event;
      box.hidden = false;
      $("install-btn").hidden = false;
    });

    if (isApplePhone()) {
      box.hidden = false;
      $("install-note").hidden = false;
    }
  }

  function wire() {
    $("install-btn").addEventListener("click", function () {
      if (!installEvent) return;
      installEvent.prompt();
      installEvent.userChoice.then(function () {
        installEvent = null;
        $("install-box").hidden = true;
      });
    });
    $("install-dismiss").addEventListener("click", function () {
      $("install-box").hidden = true;
      remember(STORE_INSTALL, "no");
    });
    $("solo-btn").addEventListener("click", playSolo);
    $("join-btn").addEventListener("click", joinGame);
    $("host-link").addEventListener("click", function () {
      var box = $("hostbox");
      box.hidden = !box.hidden;
      if (!box.hidden) {
        renderHostBox();
        if (!hostUnlocked) $("host-key").focus();
      }
    });
    $("host-unlock").addEventListener("submit", function (event) {
      event.preventDefault();
      $("unlock-note").textContent = "Checking\u2026";
      tryHostKey($("host-key").value, $("unlock-note")).then(function (ok) {
        if (ok) $("host-key").value = "";
      });
    });
    $("forget-btn").addEventListener("click", function () {
      HOST_KEY = "";
      hostUnlocked = false;
      try { window.localStorage.removeItem(STORE_HOST); } catch (err) { /* nothing to clear */ }
      $("unlock-note").textContent = "Forgotten. Type it again to unlock.";
      renderHostBox();
    });
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
    $("clear-btn").addEventListener("click", function () {
      var who = $("clear-name").value.trim();
      var asking = who
        ? "Clear " + who + "'s score for " + ROUND.title + "? They can then play it again."
        : "Clear every score for " + ROUND.title + "? The whole day starts over.";
      if (!window.confirm(asking)) return;
      $("clear-note").textContent = "Clearing\u2026";
      api("/host/clear", { key: HOST_KEY, round: ROUND.id, name: who }).then(function (data) {
        $("clear-name").value = "";
        $("clear-note").textContent = data.cleared
          ? "Cleared " + data.cleared + (data.cleared === 1 ? " score." : " scores.")
          : "Nothing to clear \u2014 no score by that name today.";
        // If the host cleared themselves, the copy of the round kept in this
        // browser would still refuse a second go. Drop it so the server's word
        // is the only one that counts.
        if (data.cleared && (!who || sameName(who, $("player-name").value))) {
          state = null;
          clearSaved();
        }
        absorb(data);
        renderLobby();
      }).catch(function (err) {
        $("clear-note").textContent = "Could not clear it: " + err.message;
      });
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
    setUpInstall();
    renderBriefing();
    measureMasthead();
    describeRound();
    renderRoundPicker();
    $("tally").textContent = "0/" + ROUND.items.length;
    $("player-name").value = remembered(STORE_NAME, "");
    state = resume();
    if (state && state.round !== ROUND.id) {
      // A round saved from another day. Put them back on the day they were
      // playing rather than silently scoring it against today's picture.
      var saved = roundFor(state.round);
      if (saved) { ROUND = saved; SCENE = SCENES[ROUND.scene]; }
      else { state = null; clearSaved(); }
    }

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

    // A key in the address bar, or one unlocked earlier on this device. Neither is
    // trusted until the server says so, so a stale or mistyped one just leaves the
    // password box showing rather than a start button that cannot work.
    var fromUrl = "";
    try { fromUrl = new URLSearchParams(window.location.search).get("host") || ""; } catch (err) { fromUrl = ""; }
    var candidate = fromUrl || remembered(STORE_HOST, "");
    if (candidate) {
      $("hostbox").hidden = false;
      tryHostKey(candidate, fromUrl ? $("unlock-note") : null);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
