"use strict";

const { io } = require("socket.io-client");

const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
const socket = io(SERVER_URL, {
  transports: ["websocket"],
  timeout: 5000
});

function emitWithAck(eventName, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit(eventName, payload, (error, response) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(response);
    });
  });
}

socket.on("connect", async () => {
  console.log(`Connected to ${SERVER_URL}`);
  console.log(`Socket ID: ${socket.id}`);

  try {
    const createRoomResponse = await emitWithAck("create-room", {});
    console.log("create-room response:");
    console.log(JSON.stringify(createRoomResponse, null, 2));

    const moveResponse = await emitWithAck("player-move", {
      roomCode: createRoomResponse.roomCode,
      position: { x: 1, y: 0, z: 2 },
      rotation: { y: 90 }
    });

    console.log("player-move response:");
    console.log(JSON.stringify(moveResponse, null, 2));
  } catch (error) {
    console.error("Socket test failed:", error.message || error);
    process.exitCode = 1;
  } finally {
    socket.disconnect();
  }
});

socket.on("connect_error", (error) => {
  console.error(`Could not connect to ${SERVER_URL}: ${error.message}`);
  process.exit(1);
});

socket.on("disconnect", (reason) => {
  console.log(`Disconnected: ${reason}`);
});
