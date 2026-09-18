'use strict';

const { VegasGame } = require('./game');

const MAX_PLAYERS = 6;
const MIN_PLAYERS = 2;

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

class Room {
  constructor(code, hostSocketId) {
    this.code = code;
    this.hostSocketId = hostSocketId;
    this.players = new Map(); // socketId -> { id, name, ready, connected }
    this.game = null;
    this.createdAt = Date.now();
  }

  get playerList() {
    return [...this.players.values()];
  }

  toLobbyState() {
    return {
      code: this.code,
      hostSocketId: this.hostSocketId,
      players: this.playerList.map((p) => ({ id: p.id, name: p.name, ready: p.ready, connected: p.connected })),
      started: !!this.game,
    };
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> Room
  }

  createRoom(socketId, name) {
    let code;
    do { code = makeRoomCode(); } while (this.rooms.has(code));
    const room = new Room(code, socketId);
    room.players.set(socketId, { id: socketId, name: name.slice(0, 20), ready: false, connected: true });
    this.rooms.set(code, room);
    return room;
  }

  joinRoom(code, socketId, name) {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) throw new Error('존재하지 않는 방 코드입니다.');
    if (room.game) throw new Error('이미 시작된 게임입니다.');
    if (room.players.size >= MAX_PLAYERS) throw new Error('방이 가득 찼습니다 (최대 6명).');
    room.players.set(socketId, { id: socketId, name: name.slice(0, 20), ready: false, connected: true });
    return room;
  }

  getRoomByCode(code) {
    return this.rooms.get((code || '').toUpperCase());
  }

  findRoomBySocket(socketId) {
    for (const room of this.rooms.values()) {
      if (room.players.has(socketId)) return room;
    }
    return null;
  }

  setReady(room, socketId, ready) {
    const p = room.players.get(socketId);
    if (!p) return;
    p.ready = ready;
  }

  startGame(room, socketId) {
    if (room.hostSocketId !== socketId) throw new Error('방장만 게임을 시작할 수 있습니다.');
    if (room.game) throw new Error('이미 시작되었습니다.');
    const players = room.playerList;
    if (players.length < MIN_PLAYERS) throw new Error(`최소 ${MIN_PLAYERS}명이 필요합니다.`);
    if (players.length > MAX_PLAYERS) throw new Error(`최대 ${MAX_PLAYERS}명까지 가능합니다.`);
    const notReady = players.filter((p) => p.id !== room.hostSocketId && !p.ready);
    if (notReady.length > 0) throw new Error('모든 플레이어가 준비 완료해야 합니다.');

    const gamePlayers = players.map((p) => ({ id: p.id, name: p.name }));
    // 2~3인 플레이 밸런스를 위한 실제 보드게임의 "더미(중립) 다이스" 변형 규칙:
    // 2인 플레이는 더미 2세트, 3인 플레이는 더미 1세트를 추가한다.
    let dummyCount = 0;
    if (players.length === 2) dummyCount = 2;
    else if (players.length === 3) dummyCount = 1;
    for (let i = 0; i < dummyCount; i++) {
      gamePlayers.push({ id: `dummy-${room.code}-${i}`, name: `더미 ${i + 1}`, isDummy: true });
    }

    room.game = new VegasGame(gamePlayers);
    return room.game;
  }

  removeSocket(socketId) {
    const room = this.findRoomBySocket(socketId);
    if (!room) return null;
    const player = room.players.get(socketId);
    if (!player) return null;
    player.connected = false;
    // Keep the slot for reconnection during an active game; otherwise drop the seat.
    if (!room.game) {
      room.players.delete(socketId);
      if (room.hostSocketId === socketId) {
        const next = room.playerList[0];
        room.hostSocketId = next ? next.id : null;
      }
    }
    const allDisconnected = room.playerList.every((p) => !p.connected);
    if (room.players.size === 0 || allDisconnected) {
      this.rooms.delete(room.code);
      return null;
    }
    return room;
  }
}

module.exports = { RoomManager, MAX_PLAYERS, MIN_PLAYERS };
