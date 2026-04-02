import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
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

function randomRoomCode() {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

function newBoard() {
  return [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY];
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

/** @type {Map<string, { board: (string|null)[], turn: 'X'|'O', status: 'waiting'|'playing'|'finished', players: { X: string|null, O: string|null }, winner?: string|null, line?: number[]|null }>} */
const rooms = new Map();

/** socket.id -> roomCode */
const socketRoom = new Map();

function roomStateForClient(room, socketId) {
  const sym = room.players.X === socketId ? "X" : room.players.O === socketId ? "O" : null;
  return {
    roomCode: room.code,
    board: room.board,
    turn: room.turn,
    status: room.status,
    yourSymbol: sym,
    winner: room.winner ?? null,
    winningLine: room.line ?? null,
    playersConnected: (room.players.X ? 1 : 0) + (room.players.O ? 1 : 0),
  };
}

function emitRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const socketId of [room.players.X, room.players.O]) {
    if (!socketId) continue;
    const s = io.sockets.sockets.get(socketId);
    if (s) {
      s.emit("gameState", roomStateForClient(room, socketId));
    }
  }
}

function deleteRoom(roomCode) {
  rooms.delete(roomCode);
}

function leaveRoom(socketId) {
  const roomCode = socketRoom.get(socketId);
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  socketRoom.delete(socketId);
  if (!room) return;

  if (room.players.X === socketId) room.players.X = null;
  if (room.players.O === socketId) room.players.O = null;

  if (room.status === "playing" && (room.players.X || room.players.O)) {
    room.status = "finished";
    const remaining = room.players.X || room.players.O;
    room.winner = remaining === room.players.X ? "X" : "O";
    room.line = null;
    emitRoom(roomCode);
  }

  if (!room.players.X && !room.players.O) {
    deleteRoom(roomCode);
  } else {
    emitRoom(roomCode);
  }
}

io.on("connection", (socket) => {
  socket.on("createRoom", (cb) => {
    leaveRoom(socket.id);
    let code = randomRoomCode();
    while (rooms.has(code)) code = randomRoomCode();
    const room = {
      code,
      board: newBoard(),
      turn: "X",
      status: "waiting",
      players: { X: socket.id, O: null },
    };
    rooms.set(code, room);
    socketRoom.set(socket.id, code);
    socket.join(code);
    if (typeof cb === "function") cb({ ok: true, roomCode: code });
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
    if (room.players.X === socket.id) {
      cb({ ok: true, roomCode: code });
      socket.emit("gameState", roomStateForClient(room, socket.id));
      return;
    }
    leaveRoom(socket.id);
    room.players.O = socket.id;
    room.status = "playing";
    socketRoom.set(socket.id, code);
    socket.join(code);
    cb({ ok: true, roomCode: code });
    emitRoom(code);
  });

  socket.on("move", (index) => {
    const roomCode = socketRoom.get(socket.id);
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room || room.status !== "playing") return;

    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i > 8) return;
    if (room.board[i] !== EMPTY) return;

    const mySym = room.players.X === socket.id ? "X" : room.players.O === socket.id ? "O" : null;
    if (!mySym || room.turn !== mySym) return;

    room.board[i] = mySym;
    const result = checkWinner(room.board);
    if (result) {
      room.status = "finished";
      room.winner = result.winner === "draw" ? "draw" : result.winner;
      room.line = result.line;
    } else {
      room.turn = room.turn === "X" ? "O" : "X";
    }
    emitRoom(roomCode);
  });

  socket.on("playAgain", () => {
    const roomCode = socketRoom.get(socket.id);
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    if (room.players.X !== socket.id && room.players.O !== socket.id) return;

    room.board = newBoard();
    room.turn = "X";
    room.status = room.players.X && room.players.O ? "playing" : "waiting";
    room.winner = undefined;
    room.line = undefined;
    emitRoom(roomCode);
  });

  socket.on("disconnect", () => {
    leaveRoom(socket.id);
  });
});

const PORT = Number(process.env.PORT) || 3000;
httpServer.listen(PORT, () => {
  console.log(`Tic-tac-toe server: http://localhost:${PORT}`);
});
