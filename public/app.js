const socket = io();

const elLobby = document.getElementById("panel-lobby");
const elGame = document.getElementById("panel-game");
const btnCreate = document.getElementById("btn-create");
const btnJoin = document.getElementById("btn-join");
const inputCode = document.getElementById("input-code");
const lobbyError = document.getElementById("lobby-error");
const roomCodeDisplay = document.getElementById("room-code-display");
const statusLine = document.getElementById("status-line");
const boardEl = document.getElementById("board");
const overlayResult = document.getElementById("overlay-result");
const resultText = document.getElementById("result-text");
const btnAgain = document.getElementById("btn-again");
const btnLeave = document.getElementById("btn-leave");
const btnCopy = document.getElementById("btn-copy");
const hintWait = document.getElementById("hint-wait");

const cells = [];

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

function applyState(state) {
  if (!state || !state.roomCode) return;

  roomCodeDisplay.textContent = state.roomCode;
  hintWait.classList.toggle("hidden", state.status !== "waiting" || state.playersConnected >= 2);

  const sym = state.yourSymbol;
  const playing = state.status === "playing";
  const finished = state.status === "finished";

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
      playing &&
      sym &&
      state.turn === sym &&
      !state.board[i] &&
      !finished;
    if (canClick) {
      cell.classList.add("interactive");
    }
  }

  if (finished && state.winner) {
    overlayResult.classList.remove("hidden");
    if (state.winner === "draw") {
      resultText.textContent = "Draw.";
    } else if (sym && state.winner === sym) {
      resultText.textContent = "You win!";
    } else {
      resultText.textContent = "Opponent wins.";
    }
  } else {
    overlayResult.classList.add("hidden");
  }

  if (!sym) {
    statusLine.innerHTML = "Spectating…";
    return;
  }

  if (state.status === "waiting") {
    statusLine.innerHTML = `You are <strong>${sym}</strong>. Share the room code or link.`;
    return;
  }

  if (finished) {
    if (state.winner === "draw") {
      statusLine.innerHTML = `You are <strong>${sym}</strong>. Game over.`;
    } else if (state.winner === sym) {
      statusLine.innerHTML = `You are <strong>${sym}</strong>.`;
    } else {
      statusLine.innerHTML = `You are <strong>${sym}</strong>.`;
    }
    return;
  }

  if (state.turn === sym) {
    statusLine.innerHTML = `You are <strong>${sym}</strong>. Your turn.`;
  } else {
    statusLine.innerHTML = `You are <strong>${sym}</strong>. Opponent's turn.`;
  }
}

socket.on("gameState", (state) => {
  setLobbyVisible(false);
  applyState(state);
});

function readRoomFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const r = params.get("room");
  if (r && /^[A-Z0-9]{6}$/i.test(r)) {
    return r.trim().toUpperCase();
  }
  return "";
}

window.addEventListener("DOMContentLoaded", () => {
  const pre = readRoomFromUrl();
  if (pre) inputCode.value = pre;
});

btnCreate.addEventListener("click", () => {
  showLobbyError("");
  socket.emit("createRoom", (res) => {
    if (!res || !res.ok) {
      showLobbyError("Could not create room.");
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("room", res.roomCode);
    window.history.replaceState({}, "", url);
    setLobbyVisible(false);
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
  socket.emit("joinRoom", c, (res) => {
    if (!res || !res.ok) {
      const map = {
        room_not_found: "No room with that code.",
        room_full: "That room is full.",
        room_code_invalid: "Invalid room code.",
      };
      showLobbyError(map[res.error] || "Could not join.");
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("room", res.roomCode);
    window.history.replaceState({}, "", url);
    setLobbyVisible(false);
  });
}

btnJoin.addEventListener("click", () => joinWithCode(inputCode.value));

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

btnLeave.addEventListener("click", () => {
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
