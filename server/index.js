import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
});

app.use(express.static(join(__dirname, "../public")));

const EMPTY = null;
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TURN_MS = 15_000;
const MAX_HISTORY = 20;
const MAX_CHAT_LEN = 200;

function randomRoomCode() {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

function randomToken() {
  return randomBytes(24).toString("base64url");
}

function newBoard() {
  return [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY];
}

function newScores() {
  return { winsX: 0, winsO: 0, draws: 0 };
}

function incrementScores(room, outcome) {
  if (!room.scores) room.scores = newScores();
  if (outcome === "X") room.scores.winsX += 1;
  else if (outcome === "O") room.scores.winsO += 1;
  else if (outcome === "draw") room.scores.draws += 1;
}

function checkWinner(board) {
  const lines = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ];
  for (const [a, b, c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line: [a, b, c] };
    }
  }
  if (board.every((cell) => cell !== EMPTY)) {
    return { winner: "draw", line: null };
  }
  return null;
}

/** @type {Map<string, object>} */
const rooms = new Map();

/** socket.id -> { roomCode, role: 'X'|'O'|'spectator' } */
const socketMeta = new Map();

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  room.turnEndsAt = null;
}

function scheduleTurnTimer(room, roomCode) {
  clearTurnTimer(room);
  if (room.status !== "playing") return;
  room.turnEndsAt = Date.now() + TURN_MS;
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    onTurnTimeout(room, roomCode);
  }, TURN_MS);
}

function onTurnTimeout(room, roomCode) {
  if (room.status !== "playing") return;
  const timed = room.turn;
  const other = timed === "X" ? "O" : "X";
  room.status = "finished";
  room.winner = other;
  room.line = null;
  room.endReason = "timeout";
  incrementScores(room, other);
  clearTurnTimer(room);
  finishGameRecord(room, "timeout");
  emitRoom(roomCode);
}

function finishGameRecord(room, reason) {
  room.gameHistory.unshift({
    winner: room.winner,
    plies: room.currentPly.map((p) => ({ ...p })),
    reason,
    at: Date.now(),
  });
  room.gameHistory = room.gameHistory.slice(0, MAX_HISTORY);
  room.currentPly = [];
}

function roomRecipients(room) {
  const ids = [];
  if (room.players.X) ids.push(room.players.X);
  if (room.players.O) ids.push(room.players.O);
  for (const sid of room.spectators) ids.push(sid);
  return ids;
}

function shouldRetainRoom(room) {
  const hasPlayer = !!(room.players.X || room.players.O);
  const hasSpec = room.spectators.size > 0;
  const hostMayReturn = !!(room.secrets.X && !room.players.X);
  const guestMayReturn = !!(room.secrets.O && !room.players.O);
  return hasPlayer || hasSpec || hostMayReturn || guestMayReturn;
}

function roomStateForClient(room, socketId) {
  const isX = room.players.X === socketId;
  const isO = room.players.O === socketId;
  const isSpec = room.spectators.has(socketId);
  const sym = isX ? "X" : isO ? "O" : null;
  const viewerRole = isSpec ? "spectator" : sym ? "player" : "gone";

  return {
    roomCode: room.code,
    board: room.board,
    turn: room.turn,
    status: room.status,
    yourSymbol: sym,
    viewerRole,
    winner: room.winner ?? null,
    winningLine: room.line ?? null,
    playersConnected: (room.players.X ? 1 : 0) + (room.players.O ? 1 : 0),
    scores: room.scores ?? newScores(),
    turnEndsAt: room.turnEndsAt ?? null,
    turnLimitMs: TURN_MS,
    spectatorCount: room.spectators.size,
    gameHistory: (room.gameHistory ?? []).slice(0, MAX_HISTORY),
    endReason: room.endReason ?? null,
  };
}

function emitRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const socketId of roomRecipients(room)) {
    const s = io.sockets.sockets.get(socketId);
    if (s) s.emit("gameState", roomStateForClient(room, socketId));
  }
}

function deleteRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (room) clearTurnTimer(room);
  rooms.delete(roomCode);
}

function assignPlayerSeat(room, seat, socketId, roomCode) {
  const key = seat;
  const prev = room.players[key];
  if (prev && prev !== socketId) {
    socketMeta.delete(prev);
    const oldSock = io.sockets.sockets.get(prev);
    oldSock?.emit("replacedByReconnect");
    oldSock?.leave(roomCode);
  }
  room.players[key] = socketId;
}

function leaveSocket(socketId) {
  const meta = socketMeta.get(socketId);
  if (!meta) return;
  const { roomCode, role } = meta;
  const room = rooms.get(roomCode);
  socketMeta.delete(socketId);
  if (!room) return;

  const sock = io.sockets.sockets.get(socketId);
  sock?.leave(roomCode);

  if (role === "spectator") {
    room.spectators.delete(socketId);
    if (!shouldRetainRoom(room)) {
      deleteRoom(roomCode);
    } else {
      emitRoom(roomCode);
    }
    return;
  }

  if (role === "X") room.players.X = null;
  if (role === "O") room.players.O = null;

  clearTurnTimer(room);

  if (room.status === "playing") {
    room.status = "paused";
  }

  if (!shouldRetainRoom(room)) {
    deleteRoom(roomCode);
  } else {
    emitRoom(roomCode);
  }
}

io.on("connection", (socket) => {
  socket.on("createRoom", (cb) => {
    leaveSocket(socket.id);
    let code = randomRoomCode();
    while (rooms.has(code)) code = randomRoomCode();
    const tokenX = randomToken();
    const room = {
      code,
      board: newBoard(),
      turn: "X",
      status: "waiting",
      players: { X: socket.id, O: null },
      secrets: { X: tokenX, O: null },
      scores: newScores(),
      spectators: new Set(),
      gameHistory: [],
      currentPly: [],
    };
    rooms.set(code, room);
    socketMeta.set(socket.id, { roomCode: code, role: "X" });
    socket.join(code);
    if (typeof cb === "function") {
      cb({ ok: true, roomCode: code, rejoinToken: tokenX, seat: "X" });
    }
    socket.emit("gameState", roomStateForClient(room, socket.id));
  });

  socket.on("joinRoom", (roomCode, cb) => {
    const code = String(roomCode || "")
      .trim()
      .toUpperCase();
    if (typeof cb !== "function") return;
    if (code.length !== 6) {
      cb({ ok: false, error: "room_code_invalid" });
      return;
    }
    const room = rooms.get(code);
    if (!room) {
      cb({ ok: false, error: "room_not_found" });
      return;
    }
    if (room.players.O) {
      cb({ ok: false, error: "room_full" });
      return;
    }
    if (room.secrets.O && !room.players.O) {
      cb({ ok: false, error: "rejoin_required" });
      return;
    }
    if (room.players.X === socket.id) {
      cb({ ok: true, roomCode: code, rejoinToken: room.secrets.X, seat: "X" });
      socket.emit("gameState", roomStateForClient(room, socket.id));
      return;
    }
    leaveSocket(socket.id);
    const tokenO = randomToken();
    room.secrets.O = tokenO;
    assignPlayerSeat(room, "O", socket.id, code);
    room.status = "playing";
    socketMeta.set(socket.id, { roomCode: code, role: "O" });
    socket.join(code);
    cb({ ok: true, roomCode: code, rejoinToken: tokenO, seat: "O" });
    emitRoom(code);
    scheduleTurnTimer(room, code);
  });

  socket.on("rejoin", (payload, cb) => {
    if (typeof cb !== "function") return;
    const code = String(payload?.roomCode || "")
      .trim()
      .toUpperCase();
    const token = String(payload?.token || "");
    if (code.length !== 6 || !token) {
      cb({ ok: false, error: "invalid" });
      return;
    }
    const room = rooms.get(code);
    if (!room) {
      cb({ ok: false, error: "room_not_found" });
      return;
    }
    let seat = null;
    if (room.secrets.X === token) seat = "X";
    else if (room.secrets.O === token) seat = "O";
    if (!seat) {
      cb({ ok: false, error: "token_invalid" });
      return;
    }
    leaveSocket(socket.id);
    assignPlayerSeat(room, seat, socket.id, code);
    socketMeta.set(socket.id, { roomCode: code, role: seat });
    socket.join(code);

    if (room.status !== "finished") {
      if (room.players.X && room.players.O) {
        room.status = "playing";
        scheduleTurnTimer(room, code);
      } else {
        const midGame = room.board.some((c) => c !== EMPTY);
        room.status = midGame ? "paused" : "waiting";
      }
    }
    cb({ ok: true, roomCode: code, seat });
    emitRoom(code);
  });

  socket.on("spectateRoom", (roomCode, cb) => {
    const code = String(roomCode || "")
      .trim()
      .toUpperCase();
    if (typeof cb !== "function") return;
    if (code.length !== 6) {
      cb({ ok: false, error: "room_code_invalid" });
      return;
    }
    const room = rooms.get(code);
    if (!room) {
      cb({ ok: false, error: "room_not_found" });
      return;
    }
    leaveSocket(socket.id);
    room.spectators.add(socket.id);
    socketMeta.set(socket.id, { roomCode: code, role: "spectator" });
    socket.join(code);
    cb({ ok: true, roomCode: code });
    socket.emit("gameState", roomStateForClient(room, socket.id));
  });

  socket.on("leaveRoom", () => {
    leaveSocket(socket.id);
  });

  socket.on("move", (index) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.role === "spectator") return;
    const roomCode = meta.roomCode;
    const room = rooms.get(roomCode);
    if (!room || room.status !== "playing") return;

    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i > 8) return;
    if (room.board[i] !== EMPTY) return;

    const mySym = meta.role === "X" ? "X" : meta.role === "O" ? "O" : null;
    if (!mySym || room.turn !== mySym) return;

    clearTurnTimer(room);
    room.board[i] = mySym;
    room.currentPly.push({ s: mySym, i });
    const result = checkWinner(room.board);
    if (result) {
      room.status = "finished";
      room.winner = result.winner === "draw" ? "draw" : result.winner;
      room.line = result.line;
      room.endReason = "normal";
      incrementScores(room, room.winner);
      finishGameRecord(room, "normal");
    } else {
      room.turn = room.turn === "X" ? "O" : "X";
      scheduleTurnTimer(room, roomCode);
    }
    emitRoom(roomCode);
  });

  socket.on("chat", (raw) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = rooms.get(meta.roomCode);
    if (!room) return;
    let author = "Spectator";
    if (room.players.X === socket.id) author = "X";
    else if (room.players.O === socket.id) author = "O";
    else if (!room.spectators.has(socket.id)) return;
    const text = String(raw ?? "")
      .trim()
      .slice(0, MAX_CHAT_LEN);
    if (!text) return;
    io.to(meta.roomCode).emit("chatMessage", { author, text, t: Date.now() });
  });

  socket.on("resetScores", () => {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.role === "spectator") return;
    const room = rooms.get(meta.roomCode);
    if (!room) return;
    if (room.players.X !== socket.id && room.players.O !== socket.id) return;
    room.scores = newScores();
    room.gameHistory = [];
    emitRoom(meta.roomCode);
  });

  socket.on("playAgain", () => {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.role === "spectator") return;
    const room = rooms.get(meta.roomCode);
    if (!room) return;
    if (room.players.X !== socket.id && room.players.O !== socket.id) return;
    if (room.status !== "finished") return;

    clearTurnTimer(room);
    room.board = newBoard();
    room.turn = "X";
    room.status = room.players.X && room.players.O ? "playing" : "waiting";
    room.winner = undefined;
    room.line = undefined;
    room.endReason = undefined;
    room.currentPly = [];
    if (!room.players.O) room.secrets.O = null;
    emitRoom(meta.roomCode);
    if (room.status === "playing") scheduleTurnTimer(room, meta.roomCode);
  });

  socket.on("disconnect", () => {
    leaveSocket(socket.id);
  });
});

const PORT = Number(process.env.PORT) || 3000;
httpServer.listen(PORT, () => {
  console.log(`Tic-tac-toe server: http://localhost:${PORT}`);
});
