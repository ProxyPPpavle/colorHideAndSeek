"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const ROOM_CODE_LENGTH = 4;
const rooms = new Map();
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

function getPublicRoom(roomCode) {
  const room = rooms.get(roomCode);

  return {
    roomCode,
    players: Array.from(room.players)
  };
}

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on("create-room", (payload = {}, callback) => {
    const roomCode = generateRoomCode();

    rooms.set(roomCode, {
      hostId: socket.id,
      players: new Set([socket.id])
    });

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

    room.players.add(socket.id);
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
    socket.to(roomCode).emit("player-joined", {
      roomCode,
      playerId: socket.id,
      players: Array.from(room.players)
    });

    console.log(`Socket ${socket.id} joined room: ${roomCode}`);
  });

  socket.on("player-move", (payload = {}, callback) => {
    const roomCode = normalizeRoomCode(payload.roomCode);
    const room = rooms.get(roomCode);

    if (!room || !room.players.has(socket.id)) {
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

    const move = {
      roomCode,
      playerId: socket.id,
      position: payload.position || null,
      rotation: payload.rotation || null,
      timestamp: Date.now()
    };

    socket.to(roomCode).emit("player-move", move);

    if (typeof callback === "function") {
      callback({ ok: true, move });
    }
  });

  socket.on("disconnect", () => {
    for (const [roomCode, room] of rooms.entries()) {
      if (!room.players.has(socket.id)) {
        continue;
      }

      room.players.delete(socket.id);
      socket.to(roomCode).emit("player-left", {
        roomCode,
        playerId: socket.id,
        players: Array.from(room.players)
      });

      if (room.players.size === 0) {
        rooms.delete(roomCode);
        console.log(`Room removed: ${roomCode}`);
      } else if (room.hostId === socket.id) {
        room.hostId = room.players.values().next().value;
      }
    }

    console.log(`Socket disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Game Orchestrator listening on port ${PORT}`);
});
