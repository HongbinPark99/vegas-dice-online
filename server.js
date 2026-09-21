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

// A "더미" (dummy/bot) player's turn used to resolve invisibly, all in one server tick,
// so viewers only ever saw the result after the fact. To make computer turns look and
// feel exactly like a human's — the same roll-tumble, grouped-dice reveal, and casino
// placement pulse — we drive the roll and the choice as two separate steps on a short
// timer, broadcasting the game state in between just like a real player's actions do.
const DUMMY_ROLL_DELAY_MS = 700; // pause before the computer "rolls", like a person taking a beat
const DUMMY_CHOICE_DELAY_MS = 1600; // time to let the roll/grouping animation be seen before it "chooses"

function broadcastLobby(room) {
  io.to(room.code).emit('lobby_state', room.toLobbyState());
}

function broadcastGame(room) {
  if (!room.game) return;
  io.to(room.code).emit('game_state', room.game.getState());
}

function scheduleDummyTurn(room) {
  const game = room.game;
  if (!game) return;
  const pid = game.currentPlayerId;
  if (!pid || !game.isBotControlled(pid)) return;

  // Edge case: a real player already rolled and was about to choose a value
  // when they disconnected. isDummyTurn() only covers 'awaiting_roll', so
  // without this the game would stall forever waiting on a choice that will
  // never come. Finish the turn for them instead.
  if (game.phase === 'awaiting_choice' && game.currentRoll) {
    setTimeout(() => {
      const liveRoom = manager.getRoomByCode(room.code);
      if (!liveRoom || liveRoom.game !== game) return;
      if (game.phase !== 'awaiting_choice' || game.currentPlayerId !== pid) return;
      try {
        const value = game.pickDummyValue();
        game.chooseValue(pid, value);
      } catch (err) {
        return;
      }
      broadcastGame(liveRoom);
      scheduleDummyTurn(liveRoom);
    }, DUMMY_CHOICE_DELAY_MS);
    return;
  }

  if (!game.isDummyTurn()) return;

  setTimeout(() => {
    const liveRoom = manager.getRoomByCode(room.code);
    if (!liveRoom || liveRoom.game !== game) return; // room gone or game reset since scheduling
    if (game.phase !== 'awaiting_roll' || game.currentPlayerId !== pid) return; // state moved on already
    try {
      game.rollDice(pid);
    } catch (err) {
      return;
    }
    broadcastGame(liveRoom);

    setTimeout(() => {
      const liveRoom2 = manager.getRoomByCode(room.code);
      if (!liveRoom2 || liveRoom2.game !== game) return;
      if (game.phase !== 'awaiting_choice' || game.currentPlayerId !== pid) return;
      try {
        const value = game.pickDummyValue();
        game.chooseValue(pid, value);
      } catch (err) {
        return;
      }
      broadcastGame(liveRoom2);
      scheduleDummyTurn(liveRoom2); // chain into the next turn, if that's a bot's too
    }, DUMMY_CHOICE_DELAY_MS);
  }, DUMMY_ROLL_DELAY_MS);
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
    scheduleDummyTurn(room);
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
    scheduleDummyTurn(room);
  }));

  socket.on('next_round', safeHandler(socket, () => {
    const room = manager.findRoomBySocket(socket.id);
    if (!room || !room.game) throw new Error('게임이 시작되지 않았습니다.');
    room.game.startNextRound();
    broadcastGame(room);
    scheduleDummyTurn(room);
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
      if (room.game) {
        room.game.setAutoPlay(socket.id, true);
      }
      broadcastLobby(room);
      broadcastGame(room);
      scheduleDummyTurn(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Vegas Dice Online server listening on http://localhost:${PORT}`);
});
