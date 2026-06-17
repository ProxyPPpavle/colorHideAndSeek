"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const BLIND_TIME_MS = 30000;
const TAG_DISTANCE = 2.25;
const GAME_STATE_TICK_MS = 250;
const rooms = new Map();
const palette = ["#35c48f", "#4f8cff", "#ffcc4d", "#ff6b6b", "#b36bff", "#ff8f3d"];
const publicFiles = new Map([
  ["/", { filePath: path.join(__dirname, "index.html"), contentType: "text/html; charset=utf-8" }],
  ["/index.html", { filePath: path.join(__dirname, "index.html"), contentType: "text/html; charset=utf-8" }]
]);

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (requestUrl.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const publicFile = publicFiles.get(requestUrl.pathname);

  if (!publicFile) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "NOT_FOUND" }));
    return;
  }

  fs.readFile(publicFile.filePath, (error, fileContent) => {
    if (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "INDEX_NOT_AVAILABLE" }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": publicFile.contentType,
      "Cache-Control": "no-cache"
    });
    res.end(fileContent);
  });
});

const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"]
  }
});

function generateRoomCode() {
  let code;

  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));

  return code;
}

function normalizeRoomCode(roomCode) {
  return String(roomCode || "").trim();
}

function createPlayer(socketId, room) {
  return {
    id: socketId,
    color: palette[room.players.size % palette.length],
    position: { x: 0, y: 1, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    role: "lobby",
    isBlind: false,
    isCaught: false,
    lastSeen: Date.now()
  };
}

function getPlayers(room) {
  return Array.from(room.players.values()).map((player) => ({
    id: player.id,
    playerId: player.id,
    color: player.color,
    position: player.position,
    rotation: player.rotation,
    role: player.role,
    isBlind: player.isBlind,
    isCaught: player.isCaught
  }));
}

function getPublicRoom(roomCode) {
  const room = rooms.get(roomCode);
  const now = Date.now();

  return {
    roomCode,
    hostId: room.hostId,
    status: room.status,
    blindRemainingMs: Math.max(0, room.blindUntil - now),
    players: getPlayers(room)
  };
}

function emitGameState(roomCode) {
  const room = rooms.get(roomCode);

  if (!room) {
    return;
  }

  io.to(roomCode).emit("game-state", {
    roomCode,
    room: getPublicRoom(roomCode)
  });
}

function getDistance(a, b) {
  const dx = (a?.x || 0) - (b?.x || 0);
  const dy = (a?.y || 0) - (b?.y || 0);
  const dz = (a?.z || 0) - (b?.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function updateBlindStates(room) {
  if (room.status !== "playing") {
    return;
  }

  const isBlind = Date.now() < room.blindUntil;

  for (const player of room.players.values()) {
    if (player.role === "seeker") {
      player.isBlind = isBlind;
    }
  }
}

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on("create-room", (payload = {}, callback) => {
    const roomCode = generateRoomCode();
    const room = {
      hostId: socket.id,
      status: "lobby",
      blindUntil: 0,
      players: new Map()
    };

    room.players.set(socket.id, createPlayer(socket.id, room));
    rooms.set(roomCode, room);
    socket.join(roomCode);

    const response = {
      ok: true,
      roomCode,
      playerId: socket.id,
      room: getPublicRoom(roomCode)
    };

    if (typeof callback === "function") {
      callback(response);
    }

    socket.emit("room-created", response);
    emitGameState(roomCode);
    console.log(`Room created: ${roomCode} by ${socket.id}`);
  });

  socket.on("join-room", (payload = {}, callback) => {
    const roomCode = normalizeRoomCode(payload.roomCode);
    const room = rooms.get(roomCode);

    if (!room) {
      const response = {
        ok: false,
        error: "ROOM_NOT_FOUND",
        message: "Room does not exist."
      };

      if (typeof callback === "function") {
        callback(response);
      }

      socket.emit("join-room-error", response);
      return;
    }

    room.players.set(socket.id, createPlayer(socket.id, room));
    socket.join(roomCode);

    const response = {
      ok: true,
      roomCode,
      playerId: socket.id,
      room: getPublicRoom(roomCode)
    };

    if (typeof callback === "function") {
      callback(response);
    }

    socket.emit("room-joined", response);
    io.to(roomCode).emit("player-joined", {
      roomCode,
      playerId: socket.id,
      room: getPublicRoom(roomCode)
    });
    emitGameState(roomCode);

    console.log(`Socket ${socket.id} joined room: ${roomCode}`);
  });

  socket.on("start-game", (payload = {}, callback) => {
    const roomCode = normalizeRoomCode(payload.roomCode);
    const room = rooms.get(roomCode);

    if (!room || room.hostId !== socket.id) {
      const response = { ok: false, error: "NOT_HOST", message: "Only the host can start the game." };
      if (typeof callback === "function") callback(response);
      return;
    }

    const playerIds = Array.from(room.players.keys());
    const seekerId = playerIds[Math.floor(Math.random() * playerIds.length)];

    room.status = "playing";
    room.blindUntil = Date.now() + BLIND_TIME_MS;

    for (const player of room.players.values()) {
      player.role = player.id === seekerId ? "seeker" : "hider";
      player.isBlind = player.id === seekerId;
      player.isCaught = false;
    }

    const response = {
      ok: true,
      seekerId,
      room: getPublicRoom(roomCode)
    };

    if (typeof callback === "function") {
      callback(response);
    }

    io.to(roomCode).emit("game-started", response);
    emitGameState(roomCode);
  });

  socket.on("player-move", (payload = {}, callback) => {
    const roomCode = normalizeRoomCode(payload.roomCode);
    const room = rooms.get(roomCode);
    const player = room?.players.get(socket.id);

    if (!room || !player) {
      const response = {
        ok: false,
        error: "NOT_IN_ROOM",
        message: "Player is not in this room."
      };

      if (typeof callback === "function") {
        callback(response);
      }

      return;
    }

    if (payload.position) {
      player.position = payload.position;
    }

    if (payload.rotation) {
      player.rotation = payload.rotation;
    }

    player.lastSeen = Date.now();

    const update = {
      roomCode,
      playerId: socket.id,
      id: socket.id,
      color: player.color,
      position: player.position,
      rotation: player.rotation,
      role: player.role,
      isBlind: player.isBlind,
      isCaught: player.isCaught,
      timestamp: Date.now()
    };

    io.to(roomCode).emit("player-update", update);

    if (typeof callback === "function") {
      callback({ ok: true, move: update });
    }
  });

  socket.on("tag-player", (payload = {}, callback) => {
    const roomCode = normalizeRoomCode(payload.roomCode);
    const targetId = String(payload.targetId || "");
    const room = rooms.get(roomCode);
    const seeker = room?.players.get(socket.id);
    const target = room?.players.get(targetId);

    if (!room || !seeker || !target || room.status !== "playing") {
      const response = { ok: false, error: "INVALID_TAG", message: "Tag is not valid right now." };
      if (typeof callback === "function") callback(response);
      return;
    }

    if (seeker.role !== "seeker" || seeker.isBlind || target.role !== "hider" || target.isCaught) {
      const response = { ok: false, error: "TAG_REJECTED", message: "That player cannot be tagged." };
      if (typeof callback === "function") callback(response);
      return;
    }

    if (getDistance(seeker.position, target.position) > TAG_DISTANCE) {
      const response = { ok: false, error: "TOO_FAR", message: "Target is too far away." };
      if (typeof callback === "function") callback(response);
      return;
    }

    target.isCaught = true;
    target.role = "spectator";

    const response = {
      ok: true,
      roomCode,
      targetId,
      seekerId: socket.id,
      room: getPublicRoom(roomCode)
    };

    if (typeof callback === "function") {
      callback(response);
    }

    io.to(roomCode).emit("player-tagged", response);
    emitGameState(roomCode);
  });

  socket.on("disconnect", () => {
    for (const [roomCode, room] of rooms.entries()) {
      if (!room.players.has(socket.id)) {
        continue;
      }

      room.players.delete(socket.id);
      io.to(roomCode).emit("player-left", {
        roomCode,
        playerId: socket.id,
        room: room.players.size > 0 ? getPublicRoom(roomCode) : null
      });

      if (room.players.size === 0) {
        rooms.delete(roomCode);
        console.log(`Room removed: ${roomCode}`);
      } else if (room.hostId === socket.id) {
        room.hostId = room.players.keys().next().value;
        emitGameState(roomCode);
      }
    }

    console.log(`Socket disconnected: ${socket.id}`);
  });
});

setInterval(() => {
  for (const [roomCode, room] of rooms.entries()) {
    updateBlindStates(room);

    if (room.status === "playing") {
      emitGameState(roomCode);
    }
  }
}, GAME_STATE_TICK_MS);

server.listen(PORT, () => {
  console.log(`Game Orchestrator listening on port ${PORT}`);
});
