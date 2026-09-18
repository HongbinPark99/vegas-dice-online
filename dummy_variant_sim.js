const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
function connect() {
  return new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'] });
    s.on('connect', () => resolve(s));
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runGame(numRealPlayers) {
  console.log(`\n=== ${numRealPlayers}인 플레이 테스트 (더미 변형 규칙) ===`);
  const names = ['P1', 'P2', 'P3'].slice(0, numRealPlayers);
  const sockets = [];
  for (const n of names) sockets.push(await connect());

  const states = {};
  sockets.forEach((s, idx) => {
    s.on('error_message', (m) => console.log(`[${names[idx]}] ERROR:`, m));
    s.on('game_state', (st) => { states[idx] = st; });
  });

  sockets[0].emit('create_room', { name: names[0] });
  const { code } = await new Promise((r) => sockets[0].once('room_joined', r));
  for (let i = 1; i < sockets.length; i++) {
    sockets[i].emit('join_room', { code, name: names[i] });
    await new Promise((r) => sockets[i].once('room_joined', r));
  }
  await sleep(150);
  for (let i = 1; i < sockets.length; i++) sockets[i].emit('toggle_ready', { ready: true });
  await sleep(150);
  sockets[0].emit('start_game');
  await sleep(300);

  const gs0 = states[0];
  console.log('전체 플레이어(더미 포함):', gs0.players.map((p) => `${p.name}${p.isDummy ? '[더미]' : ''}`).join(', '));

  let safety = 0;
  while (true) {
    safety++;
    if (safety > 3000) { console.log('SAFETY BREAK'); break; }
    const gs = states[0];
    if (!gs) { await sleep(30); continue; }
    if (gs.phase === 'game_over') {
      console.log('최종 결과:', gs.players.map((p) => `${p.name}${p.isDummy ? '[더미]' : ''}: ${p.money}`).join(', '));
      console.log('승자:', gs.winnerIds.map((id) => gs.players.find((p) => p.id === id).name));
      break;
    }
    if (gs.phase === 'round_end') {
      sockets[0].emit('next_round');
      await sleep(200);
      continue;
    }
    const actingIdx = sockets.findIndex((s) => s.id === gs.currentPlayerId);
    if (actingIdx === -1) {
      // should not happen: dummies auto-play server-side, current player should always be a real connected socket
      console.log('WARNING: currentPlayerId does not match any real socket ->', gs.currentPlayerId);
      await sleep(50);
      continue;
    }
    if (gs.phase === 'awaiting_roll') {
      sockets[actingIdx].emit('roll_dice');
      await sleep(60);
    } else if (gs.phase === 'awaiting_choice') {
      const values = states[actingIdx].availableValues;
      const pick = values[Math.floor(Math.random() * values.length)];
      sockets[actingIdx].emit('choose_value', { value: pick });
      await sleep(60);
    } else {
      await sleep(30);
    }
  }
  sockets.forEach((s) => s.close());
}

async function main() {
  await runGame(2);
  await runGame(3);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
