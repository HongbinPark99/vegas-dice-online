'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager } = require('./server/rooms');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

app.use(express.static(path.join(__dirname, 'public')));

const manager = new RoomManager();

function broadcastLobby(room) {
  io.to(room.code).emit('lobby_state', room.toLobbyState());
}

function broadcastGame(room) {
  if (!room.game) return;
  io.to(room.code).emit('game_state', room.game.getState());
}

function safeHandler(socket, handler) {
  return (payload) => {
    try {
      handler(payload);
    } catch (err) {
      socket.emit('error_message', err.message || '알 수 없는 오류가 발생했습니다.');
    }
  };
}

io.on('connection', (socket) => {
  socket.data.name = null;
  socket.data.roomCode = null;

  socket.on('create_room', safeHandler(socket, ({ name }) => {
    if (!name || !name.trim()) throw new Error('닉네임을 입력해주세요.');
    const room = manager.createRoom(socket.id, name.trim());
    socket.data.name = name.trim();
    socket.data.roomCode = room.code;
    socket.join(room.code);
    socket.emit('room_joined', { code: room.code, you: socket.id });
    broadcastLobby(room);
  }));

  socket.on('join_room', safeHandler(socket, ({ code, name }) => {
    if (!name || !name.trim()) throw new Error('닉네임을 입력해주세요.');
    if (!code || !code.trim()) throw new Error('방 코드를 입력해주세요.');
    const room = manager.joinRoom(code.trim(), socket.id, name.trim());
    socket.data.name = name.trim();
    socket.data.roomCode = room.code;
    socket.join(room.code);
    socket.emit('room_joined', { code: room.code, you: socket.id });
    broadcastLobby(room);
  }));

  socket.on('toggle_ready', safeHandler(socket, ({ ready }) => {
    const room = manager.findRoomBySocket(socket.id);
    if (!room) throw new Error('방에 참가하지 않은 상태입니다.');
    manager.setReady(room, socket.id, !!ready);
    broadcastLobby(room);
  }));

  socket.on('start_game', safeHandler(socket, () => {
    const room = manager.findRoomBySocket(socket.id);
    if (!room) throw new Error('방에 참가하지 않은 상태입니다.');
    manager.startGame(room, socket.id);
    broadcastLobby(room);
    broadcastGame(room);
  }));

  socket.on('roll_dice', safeHandler(socket, () => {
    const room = manager.findRoomBySocket(socket.id);
    if (!room || !room.game) throw new Error('게임이 시작되지 않았습니다.');
    room.game.rollDice(socket.id);
    broadcastGame(room);
  }));

  socket.on('choose_value', safeHandler(socket, ({ value }) => {
    const room = manager.findRoomBySocket(socket.id);
    if (!room || !room.game) throw new Error('게임이 시작되지 않았습니다.');
    room.game.chooseValue(socket.id, Number(value));
    broadcastGame(room);
  }));

  socket.on('next_round', safeHandler(socket, () => {
    const room = manager.findRoomBySocket(socket.id);
    if (!room || !room.game) throw new Error('게임이 시작되지 않았습니다.');
    room.game.startNextRound();
    broadcastGame(room);
  }));

  socket.on('chat_message', safeHandler(socket, ({ text }) => {
    const room = manager.findRoomBySocket(socket.id);
    if (!room) return;
    const clean = (text || '').toString().slice(0, 300);
    if (!clean.trim()) return;
    io.to(room.code).emit('chat_message', { name: socket.data.name || '???', text: clean, t: Date.now() });
  }));

  socket.on('disconnect', () => {
    const room = manager.removeSocket(socket.id);
    if (room) {
      broadcastLobby(room);
      broadcastGame(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Vegas Dice Online server listening on http://localhost:${PORT}`);
});
