const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
function connect() {
  return new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'] });
    s.on('connect', () => resolve(s));
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const host = await connect();
  const errors = [];
  host.on('error_message', (m) => errors.push(m));
  host.emit('create_room', { name: 'Solo' });
  const { code } = await new Promise((r) => host.once('room_joined', r));
  console.log('room', code);

  // try to start with only 1 player -> should error
  host.emit('start_game');
  await sleep(200);
  console.log('Expected error (min players):', errors[errors.length - 1]);

  // second player joins but not ready
  const p2 = await connect();
  p2.emit('join_room', { code, name: 'Guest' });
  await new Promise((r) => p2.once('room_joined', r));
  await sleep(200);
  host.emit('start_game');
  await sleep(200);
  console.log('Expected error (not ready):', errors[errors.length - 1]);

  // ready up, then non-host tries to start -> should error (host only)
  p2.emit('toggle_ready', { ready: true });
  await sleep(200);
  const p2errors = [];
  p2.on('error_message', (m) => p2errors.push(m));
  p2.emit('start_game');
  await sleep(200);
  console.log('Expected error (host only):', p2errors[p2errors.length - 1]);

  // host starts for real
  let started = false;
  host.on('game_state', () => { started = true; });
  host.emit('start_game');
  await sleep(300);
  console.log('Game started with 2 players:', started);

  host.close(); p2.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
