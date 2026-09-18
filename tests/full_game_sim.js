const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const NAMES = ['Alice', 'Bob', 'Carol', 'Dave'];

function connectPlayer(name) {
  return new Promise((resolve) => {
    const socket = io(URL, { transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
  });
}

async function main() {
  const sockets = [];
  for (const name of NAMES) sockets.push(await connectPlayer(name));

  let roomCode = null;
  const states = {}; // socket -> latest lobby/game state

  sockets.forEach((s, idx) => {
    s.on('error_message', (m) => console.log(`[${NAMES[idx]}] ERROR:`, m));
    s.on('lobby_state', (st) => { states[idx] = { type: 'lobby', st }; });
    s.on('game_state', (st) => { states[idx] = { type: 'game', st }; });
  });

  // host creates room
  sockets[0].emit('create_room', { name: NAMES[0] });
  await new Promise((r) => sockets[0].once('room_joined', (d) => { roomCode = d.code; r(); }));
  console.log('Room code:', roomCode);

  // others join
  for (let i = 1; i < sockets.length; i++) {
    sockets[i].emit('join_room', { code: roomCode, name: NAMES[i] });
    await new Promise((r) => sockets[i].once('room_joined', r));
  }
  await sleep(200);

  // all non-host ready
  for (let i = 1; i < sockets.length; i++) sockets[i].emit('toggle_ready', { ready: true });
  await sleep(200);

  // host starts
  sockets[0].emit('start_game');
  await sleep(300);

  console.log('--- Game started ---');

  let safety = 0;
  while (true) {
    safety++;
    if (safety > 2000) { console.log('SAFETY BREAK - possible infinite loop'); break; }
    const gs = states[0] && states[0].type === 'game' ? states[0].st : null;
    if (!gs) { await sleep(50); continue; }

    if (gs.phase === 'game_over') {
      console.log('=== GAME OVER ===');
      console.log(JSON.stringify(gs.players.map(p => ({ name: p.name, money: p.money })), null, 2));
      console.log('Winner ids:', gs.winnerIds);
      break;
    }

    if (gs.phase === 'round_end') {
      console.log(`--- Round ${gs.lastPayout.round} payout ---`);
      gs.lastPayout.casinos.forEach(c => {
        c.awards.forEach(a => console.log(`  casino ${c.number}: ${a.playerId} won ${a.amount}`));
        c.discarded.forEach(d => console.log(`  casino ${c.number}: DISCARDED ${d}`));
        c.carried.forEach(cv => console.log(`  casino ${c.number}: carried ${cv}`));
      });
      sockets[0].emit('next_round');
      await sleep(300);
      continue;
    }

    const currentIdx = NAMES.indexOf(gsPlayerName(gs, gs.currentPlayerId));
    // Find which local socket index corresponds to currentPlayerId by matching against room join order == socket order
    const actingIdx = sockets.findIndex((s) => s.id === gs.currentPlayerId);
    if (actingIdx === -1) { await sleep(50); continue; }

    if (gs.phase === 'awaiting_roll') {
      sockets[actingIdx].emit('roll_dice');
      await sleep(80);
    } else if (gs.phase === 'awaiting_choice') {
      const myState = states[actingIdx].st;
      const values = myState.availableValues;
      const pick = values[Math.floor(Math.random() * values.length)];
      sockets[actingIdx].emit('choose_value', { value: pick });
      await sleep(80);
    } else {
      await sleep(50);
    }
  }

  sockets.forEach((s) => s.close());
  process.exit(0);
}

function gsPlayerName(gs, id) {
  const p = gs.players.find((pp) => pp.id === id);
  return p ? p.name : id;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(e); process.exit(1); });
