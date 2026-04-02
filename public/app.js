const SESSION_KEY = "ttt_session_v1";

const socket = io();

const elLobby = document.getElementById("panel-lobby");
const elGame = document.getElementById("panel-game");
const btnCreate = document.getElementById("btn-create");
const btnJoin = document.getElementById("btn-join");
const btnSpectate = document.getElementById("btn-spectate");
const inputCode = document.getElementById("input-code");
const lobbyError = document.getElementById("lobby-error");
const rejoinHint = document.getElementById("rejoin-hint");
const roomCodeDisplay = document.getElementById("room-code-display");
const statusLine = document.getElementById("status-line");
const timerLine = document.getElementById("timer-line");
const boardEl = document.getElementById("board");
const overlayResult = document.getElementById("overlay-result");
const resultText = document.getElementById("result-text");
const btnAgain = document.getElementById("btn-again");
const btnLeave = document.getElementById("btn-leave");
const btnCopy = document.getElementById("btn-copy");
const hintWait = document.getElementById("hint-wait");
const scoreYou = document.getElementById("score-you");
const scoreThem = document.getElementById("score-them");
const scoreDraws = document.getElementById("score-draws");
const scoreYouLbl = document.getElementById("score-you-lbl");
const scoreThemLbl = document.getElementById("score-them-lbl");
const btnResetScores = document.getElementById("btn-reset-scores");
const resultSeries = document.getElementById("result-series");
const scoreCellYou = document.getElementById("score-cell-you");
const scoreCellThem = document.getElementById("score-cell-them");
const scoreActionsRow = document.getElementById("score-actions-row");
const historyList = document.getElementById("history-list");
const chatDock = document.getElementById("chat-dock");
const chatToggle = document.getElementById("chat-toggle");
const chatPanel = document.getElementById("chat-panel");
const chatMessages = document.getElementById("chat-messages");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatBadge = document.getElementById("chat-badge");

const cells = [];

let prevState = null;
let timerInterval = null;
let chatUnread = 0;
let chatPanelOpen = false;
let isSpectatorSession = false;

let audioCtx = null;
function getAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

function beep(freq, dur = 0.06, type = "sine", vol = 0.08) {
  try {
    const ctx = getAudio();
    if (ctx.state === "suspended") ctx.resume();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.value = vol;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    setTimeout(() => {
      o.stop();
      o.disconnect();
      g.disconnect();
    }, dur * 1000);
  } catch (_) {}
}

function playMoveSound() {
  beep(520, 0.05, "triangle", 0.07);
}
function playJoinSound() {
  beep(380, 0.08, "sine", 0.09);
  setTimeout(() => beep(520, 0.08, "sine", 0.09), 90);
}
function playWinSound() {
  [660, 880, 990].forEach((f, i) => setTimeout(() => beep(f, 0.12, "sine", 0.06), i * 120));
}
function playLoseSound() {
  beep(200, 0.2, "sawtooth", 0.05);
}
function playDrawSound() {
  beep(440, 0.15, "sine", 0.06);
  setTimeout(() => beep(440, 0.15, "sine", 0.06), 160);
}

function vibrateShort() {
  if (navigator.vibrate) navigator.vibrate(12);
}

document.body.addEventListener(
  "click",
  () => {
    getAudio().resume?.();
  },
  { once: true }
);

function saveSession(payload) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload));
  } catch (_) {}
}

function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch (_) {}
}

function showLobbyError(msg) {
  lobbyError.textContent = msg;
  lobbyError.hidden = !msg;
}

function setLobbyVisible(v) {
  elLobby.classList.toggle("hidden", !v);
  elGame.classList.toggle("hidden", v);
}

function buildBoard() {
  boardEl.innerHTML = "";
  cells.length = 0;
  for (let i = 0; i < 9; i++) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "cell";
    cell.dataset.index = String(i);
    cell.setAttribute("role", "gridcell");
    boardEl.appendChild(cell);
    cells.push(cell);
  }
}

buildBoard();

function formatPly(plies) {
  if (!plies || !plies.length) return "—";
  return plies.map((p) => `${p.s}${p.i + 1}`).join(" · ");
}

function reasonLabel(r) {
  const m = {
    normal: "",
    timeout: "time",
    disconnect: "left",
    paused: "",
  };
  return m[r] || r;
}

function renderHistory(state) {
  const list = state.gameHistory || [];
  historyList.innerHTML = "";
  if (!list.length) {
    const li = document.createElement("li");
    li.textContent = "No completed games yet.";
    historyList.appendChild(li);
    return;
  }
  list.forEach((g, idx) => {
    const n = list.length - idx;
    const li = document.createElement("li");
    const w = g.winner === "draw" ? "Draw" : `Winner ${g.winner}`;
    const tag = reasonLabel(g.reason);
    const extra = tag ? ` (${tag})` : "";
    li.innerHTML = `<span class="ply-tag">#${n}</span> ${w}${extra} — ${formatPly(g.plies)}`;
    historyList.appendChild(li);
  });
}

function applyScores(state) {
  const scores = state.scores || { winsX: 0, winsO: 0, draws: 0 };
  const sym = state.yourSymbol;
  const spec = state.viewerRole === "spectator";

  if (spec) {
    scoreYou.textContent = String(scores.winsX);
    scoreThem.textContent = String(scores.winsO);
    scoreDraws.textContent = String(scores.draws);
    scoreYouLbl.textContent = "X wins";
    scoreThemLbl.textContent = "O wins";
    scoreCellYou.classList.remove("mark-o-side");
    scoreCellYou.classList.add("mark-x-side");
    scoreCellThem.classList.remove("mark-x-side");
    scoreCellThem.classList.add("mark-o-side");
    return;
  }

  if (!sym) {
    scoreYou.textContent = "0";
    scoreThem.textContent = "0";
    scoreDraws.textContent = "0";
    scoreCellYou.classList.remove("mark-x-side", "mark-o-side");
    scoreCellThem.classList.remove("mark-x-side", "mark-o-side");
    return;
  }
  const yourWins = sym === "X" ? scores.winsX : scores.winsO;
  const theirWins = sym === "X" ? scores.winsO : scores.winsX;
  scoreYou.textContent = String(yourWins);
  scoreThem.textContent = String(theirWins);
  scoreDraws.textContent = String(scores.draws);
  scoreYouLbl.textContent = sym === "X" ? "You (X)" : "You (O)";
  scoreThemLbl.textContent = sym === "X" ? "Them (O)" : "Them (X)";
  scoreCellYou.classList.remove("mark-x-side", "mark-o-side");
  scoreCellThem.classList.remove("mark-x-side", "mark-o-side");
  scoreCellYou.classList.add(sym === "X" ? "mark-x-side" : "mark-o-side");
  scoreCellThem.classList.add(sym === "X" ? "mark-o-side" : "mark-x-side");
}

function clearTimerDisplay() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  timerLine.textContent = "";
  timerLine.classList.add("hidden");
}

function updateTimerLine(state) {
  if (state.status !== "playing" || !state.turnEndsAt) {
    clearTimerDisplay();
    return;
  }
  if (timerInterval) clearInterval(timerInterval);
  const tick = () => {
    const ms = state.turnEndsAt - Date.now();
    if (ms <= 0) {
      timerLine.textContent = "Round ending…";
      timerLine.classList.add("warn");
      return;
    }
    const s = Math.max(0, Math.ceil(ms / 1000));
    timerLine.textContent = `Turn ${state.turn} · ${s}s`;
    timerLine.classList.toggle("warn", ms < 4000);
  };
  tick();
  timerInterval = setInterval(tick, 250);
  timerLine.classList.remove("hidden");
}

let TurnMs = 15000;

function maybeReactSounds(state) {
  if (!prevState) {
    prevState = state;
    return;
  }
  const p = prevState;
  const marks = state.board.filter(Boolean).length;
  const prevMarks = p.board.filter(Boolean).length;
  if (state.status === "playing" && marks > prevMarks) {
    playMoveSound();
    vibrateShort();
  }
  if (
    p.viewerRole === "player" &&
    state.viewerRole === "player" &&
    p.playersConnected === 1 &&
    state.playersConnected === 2
  ) {
    playJoinSound();
  }
  if (p.status !== "finished" && state.status === "finished") {
    if (state.winner === "draw") playDrawSound();
    else if (state.yourSymbol && state.winner === state.yourSymbol) {
      playWinSound();
      if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
    } else if (state.yourSymbol) {
      playLoseSound();
    } else {
      playDrawSound();
    }
  }
  prevState = state;
}

function applyState(state) {
  if (!state || !state.roomCode) return;

  if (state.turnLimitMs) TurnMs = state.turnLimitMs;

  roomCodeDisplay.textContent = state.roomCode;
  applyScores(state);
  scoreActionsRow.classList.toggle("hidden", state.viewerRole === "spectator");

  const spec = state.viewerRole === "spectator";
  const sym = state.yourSymbol;
  const playing = state.status === "playing";
  const finished = state.status === "finished";
  const paused = state.status === "paused";

  hintWait.classList.toggle(
    "hidden",
    state.status !== "waiting" || state.playersConnected >= 2 || spec || paused
  );

  chatDock.classList.remove("hidden");

  for (let i = 0; i < 9; i++) {
    const cell = cells[i];
    const mark = state.board[i];
    cell.classList.remove("mark-x", "mark-o", "win", "interactive");
    cell.textContent = mark === "X" ? "X" : mark === "O" ? "O" : "";
    if (mark === "X") cell.classList.add("mark-x");
    if (mark === "O") cell.classList.add("mark-o");
    if (state.winningLine && state.winningLine.includes(i)) {
      cell.classList.add("win");
    }
    const canClick =
      playing && sym && state.turn === sym && !state.board[i] && !finished && !spec;
    if (canClick) {
      cell.classList.add("interactive");
    }
  }

  if (finished && state.winner) {
    overlayResult.classList.remove("hidden");
    btnAgain.classList.toggle("hidden", spec);

    if (state.winner === "draw") {
      resultText.textContent = "Draw.";
    } else if (spec) {
      resultText.textContent =
        state.endReason === "timeout"
          ? `Time's up — ${state.winner} wins the round.`
          : `${state.winner} wins the round.`;
    } else if (sym && state.winner === sym) {
      resultText.textContent =
        state.endReason === "timeout" ? "Time's up — you win the round." : "You win!";
    } else {
      resultText.textContent =
        state.endReason === "timeout"
          ? "Time's up — opponent wins the round."
          : "Opponent wins.";
    }

    if ((sym || spec) && state.scores) {
      const y = sym ? (sym === "X" ? state.scores.winsX : state.scores.winsO) : null;
      const t = sym ? (sym === "X" ? state.scores.winsO : state.scores.winsX) : null;
      let line = "";
      if (sym) {
        line = `Series: ${y}–${t}`;
        const d = state.scores.draws;
        if (d > 0) line += ` · ${d} draw${d === 1 ? "" : "s"}`;
      } else {
        line = `Score: X ${state.scores.winsX} — O ${state.scores.winsO}`;
        if (state.scores.draws) line += ` · ${state.scores.draws} draws`;
      }
      resultSeries.textContent = line;
      resultSeries.hidden = false;
    } else {
      resultSeries.textContent = "";
      resultSeries.hidden = true;
    }
  } else {
    overlayResult.classList.add("hidden");
    resultSeries.hidden = true;
  }

  updateTimerLine(state);

  if (spec) {
    const sc = state.spectatorCount ?? 0;
    statusLine.innerHTML = `Spectating · ${state.playersConnected} players${
      sc > 1 ? ` · ${sc} watching` : ""
    }`;
    renderHistory(state);
    maybeReactSounds(state);
    return;
  }

  if (!sym) {
    statusLine.innerHTML = "Reconnecting…";
    renderHistory(state);
    maybeReactSounds(state);
    return;
  }

  if (paused) {
    statusLine.innerHTML = `You are <strong>${sym}</strong>. Game paused — waiting for opponent to reconnect.`;
    renderHistory(state);
    maybeReactSounds(state);
    return;
  }

  if (state.status === "waiting") {
    statusLine.innerHTML = `You are <strong>${sym}</strong>. Share the room code or link.`;
    renderHistory(state);
    maybeReactSounds(state);
    return;
  }

  if (finished) {
    statusLine.innerHTML = `You are <strong>${sym}</strong>. Game over.`;
    renderHistory(state);
    maybeReactSounds(state);
    return;
  }

  if (state.turn === sym) {
    statusLine.innerHTML = `You are <strong>${sym}</strong>. Your turn.`;
  } else {
    statusLine.innerHTML = `You are <strong>${sym}</strong>. Opponent's turn.`;
  }

  renderHistory(state);
  maybeReactSounds(state);
}

socket.on("gameState", (state) => {
  setLobbyVisible(false);
  applyState(state);
});

socket.on("replacedByReconnect", () => {
  clearSession();
  showLobbyError("This tab was disconnected (you rejoined elsewhere).");
  setLobbyVisible(true);
  clearTimerDisplay();
  chatDock.classList.add("hidden");
  prevState = null;
});

socket.on("chatMessage", ({ author, text, t }) => {
  const row = document.createElement("div");
  let whoClass = "who-spec";
  if (author === "X") whoClass = "who-x";
  if (author === "O") whoClass = "who-o";
  row.className = `chat-msg ${whoClass}`;
  const time = t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  row.innerHTML = `<span class="who">${author}</span><span class="chat-text"></span>`;
  row.querySelector(".chat-text").textContent = (time ? `${time} · ` : "") + text;
  chatMessages.appendChild(row);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  if (!chatPanelOpen) {
    chatUnread += 1;
    chatBadge.textContent = String(chatUnread);
    chatBadge.classList.remove("hidden");
  }
});

function readRoomFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const r = params.get("room");
  if (r && /^[A-Z0-9]{6}$/i.test(r)) {
    return r.trim().toUpperCase();
  }
  return "";
}

function tryRejoinFromStorage() {
  const sess = loadSession();
  const urlRoom = readRoomFromUrl();
  if (!sess || !sess.token || !sess.roomCode) return;
  if (urlRoom && urlRoom !== sess.roomCode) return;
  socket.emit("rejoin", { roomCode: sess.roomCode, token: sess.token }, (res) => {
    if (!res || !res.ok) {
      clearSession();
      rejoinHint.hidden = true;
      if (urlRoom) {
        showLobbyError(
          res?.error === "room_not_found"
            ? "Room ended. Create a new one or ask for a fresh link."
            : "Could not restore your seat. Join again or use the saved link."
        );
      }
      return;
    }
    saveSession({ roomCode: res.roomCode, token: sess.token, seat: res.seat });
    const url = new URL(window.location.href);
    url.searchParams.set("room", res.roomCode);
    window.history.replaceState({}, "", url);
    isSpectatorSession = false;
    setLobbyVisible(false);
    rejoinHint.hidden = true;
  });
}

window.addEventListener("DOMContentLoaded", () => {
  const pre = readRoomFromUrl();
  if (pre) inputCode.value = pre;
  const sess = loadSession();
  if (sess && sess.token && (!pre || pre === sess.roomCode)) {
    rejoinHint.textContent = `Saved seat for room ${sess.roomCode}. Connecting…`;
    rejoinHint.hidden = false;
  }
});

socket.on("connect", () => {
  tryRejoinFromStorage();
});

btnCreate.addEventListener("click", () => {
  showLobbyError("");
  isSpectatorSession = false;
  socket.emit("createRoom", (res) => {
    if (!res || !res.ok) {
      showLobbyError("Could not create room.");
      return;
    }
    saveSession({ roomCode: res.roomCode, token: res.rejoinToken, seat: res.seat });
    const url = new URL(window.location.href);
    url.searchParams.set("room", res.roomCode);
    window.history.replaceState({}, "", url);
    setLobbyVisible(false);
    rejoinHint.hidden = true;
  });
});

function joinWithCode(code) {
  const c = String(code || "")
    .trim()
    .toUpperCase();
  showLobbyError("");
  if (c.length !== 6) {
    showLobbyError("Enter a 6-character room code.");
    return;
  }
  isSpectatorSession = false;
  socket.emit("joinRoom", c, (res) => {
    if (!res || !res.ok) {
      const map = {
        room_not_found: "No room with that code.",
        room_full: "That room is full.",
        room_code_invalid: "Invalid room code.",
        rejoin_required:
          "That seat is reserved. Open the original invite link or use the device that already joined (session restores automatically).",
      };
      showLobbyError(map[res.error] || "Could not join.");
      return;
    }
    saveSession({ roomCode: res.roomCode, token: res.rejoinToken, seat: res.seat });
    const url = new URL(window.location.href);
    url.searchParams.set("room", res.roomCode);
    window.history.replaceState({}, "", url);
    setLobbyVisible(false);
    rejoinHint.hidden = true;
  });
}

function spectateWithCode(code) {
  const c = String(code || "")
    .trim()
    .toUpperCase();
  showLobbyError("");
  if (c.length !== 6) {
    showLobbyError("Enter a room code to spectate.");
    return;
  }
  socket.emit("spectateRoom", c, (res) => {
    if (!res || !res.ok) {
      const map = {
        room_not_found: "No room with that code.",
        room_code_invalid: "Invalid room code.",
      };
      showLobbyError(map[res.error] || "Could not spectate.");
      return;
    }
    isSpectatorSession = true;
    const url = new URL(window.location.href);
    url.searchParams.set("room", res.roomCode);
    window.history.replaceState({}, "", url);
    setLobbyVisible(false);
    rejoinHint.hidden = true;
  });
}

btnJoin.addEventListener("click", () => joinWithCode(inputCode.value));
btnSpectate.addEventListener("click", () => spectateWithCode(inputCode.value));

inputCode.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinWithCode(inputCode.value);
});

boardEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".cell.interactive");
  if (!btn) return;
  const idx = Number(btn.dataset.index);
  socket.emit("move", idx);
});

btnAgain.addEventListener("click", () => {
  socket.emit("playAgain");
});

btnResetScores.addEventListener("click", () => {
  if (window.confirm("Reset wins, draws, and session history for this room?")) {
    socket.emit("resetScores");
  }
});

btnLeave.addEventListener("click", () => {
  clearSession();
  isSpectatorSession = false;
  socket.emit("leaveRoom");
  window.location.href = window.location.pathname;
});

btnCopy.addEventListener("click", async () => {
  const code = roomCodeDisplay.textContent.trim();
  const url = new URL(window.location.href);
  url.searchParams.set("room", code);
  const text = url.toString();
  try {
    await navigator.clipboard.writeText(text);
    btnCopy.textContent = "Copied!";
    setTimeout(() => {
      btnCopy.textContent = "Copy link";
    }, 2000);
  } catch {
    prompt("Copy this link:", text);
  }
});

chatToggle.addEventListener("click", () => {
  chatPanelOpen = !chatPanelOpen;
  chatPanel.classList.toggle("hidden", !chatPanelOpen);
  chatToggle.setAttribute("aria-expanded", chatPanelOpen ? "true" : "false");
  if (chatPanelOpen) {
    chatUnread = 0;
    chatBadge.classList.add("hidden");
    chatInput.focus();
  }
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit("chat", text);
  chatInput.value = "";
});
