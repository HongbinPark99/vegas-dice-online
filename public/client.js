(() => {
  const socket = io();

  let myId = null;
  let myRoomCode = null;
  let lastLobbyState = null;
  let lastGameState = null;
  let seenRoundEndFor = null; // round number for which the overlay has already been shown & dismissed

  // ---------- helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const show = (el) => el.classList.remove('hidden');
  const hide = (el) => el.classList.add('hidden');

  // ---------- dice pip rendering ----------
  const PIP_MAP = {
    1: [5],
    2: [1, 9],
    3: [1, 5, 9],
    4: [1, 3, 7, 9],
    5: [1, 3, 5, 7, 9],
    6: [1, 3, 4, 6, 7, 9],
  };
  function dieFaceHtml(value, extraClass) {
    const on = new Set(PIP_MAP[value] || []);
    let cells = '';
    for (let i = 1; i <= 9; i++) cells += `<span class="pip${on.has(i) ? ' on' : ''}"></span>`;
    return `<div class="die-pip${extraClass ? ' ' + extraClass : ''}"><div class="pip-grid">${cells}</div></div>`;
  }
  function groupDice(roll) {
    const counts = {};
    roll.forEach((v) => { counts[v] = (counts[v] || 0) + 1; });
    return Object.keys(counts)
      .map(Number)
      .sort((a, b) => counts[b] - counts[a] || b - a)
      .map((v) => ({ value: v, count: counts[v] }));
  }

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    show(el);
    clearTimeout(toast._t);
    toast._t = setTimeout(() => hide(el), 3500);
  }

  function switchScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => hide(s));
    show($(id));
  }

  function fmtMoney(n) {
    return n.toLocaleString() + '원';
  }

  // ---------- landing ----------
  $('#btn-create').addEventListener('click', () => {
    const name = $('#input-name').value.trim();
    if (!name) return toast('닉네임을 입력해주세요.');
    socket.emit('create_room', { name });
  });

  $('#btn-join').addEventListener('click', () => {
    const name = $('#input-name').value.trim();
    const code = $('#input-code').value.trim();
    if (!name) return toast('닉네임을 입력해주세요.');
    if (!code) return toast('방 코드를 입력해주세요.');
    socket.emit('join_room', { name, code });
  });

  // ---------- lobby ----------
  $('#btn-ready').addEventListener('click', () => {
    const amReady = $('#btn-ready').dataset.ready === '1';
    socket.emit('toggle_ready', { ready: !amReady });
  });

  $('#btn-start').addEventListener('click', () => {
    socket.emit('start_game');
  });

  function renderLobby(state) {
    lastLobbyState = state;
    myRoomCode = state.code;
    $('#lobby-code').textContent = state.code;

    const list = $('#lobby-players');
    list.innerHTML = '';
    state.players.forEach((p) => {
      const li = document.createElement('li');
      const isHost = p.id === state.hostSocketId;
      const isMe = p.id === myId;
      li.innerHTML = `<span>${p.name}${isMe ? ' (나)' : ''}${isHost ? '<span class="tag-host">방장</span>' : ''}</span>
        <span class="${p.ready || isHost ? 'tag-ready' : 'tag-wait'}">${isHost ? '방장' : (p.ready ? '준비 완료' : '대기중')}</span>`;
      list.appendChild(li);
    });

    const me = state.players.find((p) => p.id === myId);
    const amHost = state.hostSocketId === myId;
    if (me && !amHost) {
      show($('#btn-ready'));
      $('#btn-ready').dataset.ready = me.ready ? '1' : '0';
      $('#btn-ready').textContent = me.ready ? '준비 취소' : '준비 완료';
    } else {
      hide($('#btn-ready'));
    }
    if (amHost) {
      show($('#btn-start'));
    } else {
      hide($('#btn-start'));
    }

    if (!state.started) switchScreen('#screen-lobby');
  }

  // ---------- game ----------
  $('#btn-roll').addEventListener('click', () => socket.emit('roll_dice'));
  $('#btn-leave').addEventListener('click', () => location.reload());
  $('#btn-next-round').addEventListener('click', () => {
    socket.emit('next_round');
    hide($('#overlay-round'));
  });
  $('#btn-back-lobby').addEventListener('click', () => location.reload());

  $('#btn-chat-send').addEventListener('click', sendChat);
  $('#input-chat').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
  function sendChat() {
    const input = $('#input-chat');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat_message', { text });
    input.value = '';
  }

  function playerName(id) {
    if (!lastGameState) return id;
    const p = lastGameState.players.find((pp) => pp.id === id);
    return p ? p.name : id;
  }
  function playerColor(id) {
    if (!lastGameState) return '#fff';
    const p = lastGameState.players.find((pp) => pp.id === id);
    return p ? p.color : '#fff';
  }

  let prevPlacedTotals = null; // casino number -> total dice placed there (for placement pulse)
  let dealAnimatedRound = null; // last round number whose initial bill-deal animation already played

  function renderCasinoBoard(state) {
    const board = $('#casino-board');
    board.innerHTML = '';

    const isFreshRound = dealAnimatedRound !== state.round &&
      state.casinos.every((c) => state.players.every((p) => !(p.placed && p.placed[c.number])));
    if (isFreshRound) dealAnimatedRound = state.round;

    const newPlacedTotals = {};

    state.casinos.forEach((casino, ci) => {
      const div = document.createElement('div');
      div.className = 'casino';

      const billsHtml = casino.bills
        .map((b, bi) => `<div class="bill${isFreshRound ? ' deal' : ''}" style="animation-delay:${ci * 45 + bi * 90}ms">${(b / 1000)}k</div>`)
        .join('') || '<div class="bill empty">없음</div>';

      // dice placed on this casino, grouped by player
      const rows = state.players
        .map((p) => ({ p, count: p.placed[casino.number] || 0 }))
        .filter((r) => r.count > 0)
        .map((r) => `<div class="casino-dice-row">
            <span class="dot" style="background:${r.p.color}"></span>
            <span>${r.p.name}${r.p.isDummy ? ' 🤖' : ''}</span>
            <span class="die-mini">${r.count}</span>
          </div>`)
        .join('');

      const total = state.players.reduce((sum, p) => sum + (p.placed[casino.number] || 0), 0);
      newPlacedTotals[casino.number] = total;
      if (prevPlacedTotals && prevPlacedTotals[casino.number] !== undefined && total > prevPlacedTotals[casino.number]) {
        div.classList.add('pulse');
        setTimeout(() => div.classList.remove('pulse'), 900);
      }

      div.innerHTML = `
        <div class="casino-num">${casino.number}</div>
        <div class="casino-bills">${billsHtml}</div>
        <div class="casino-dice">${rows}</div>
      `;
      board.appendChild(div);
    });

    prevPlacedTotals = newPlacedTotals;
  }

  function renderPlayers(state) {
    const panel = $('#players-panel');
    panel.innerHTML = '';
    state.players.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'player-row' + (p.id === state.currentPlayerId ? ' active' : '');
      row.innerHTML = `
        <span class="player-swatch" style="background:${p.color}"></span>
        <span class="player-name">${p.name}${p.id === myId ? ' (나)' : ''}${p.isDummy ? ' 🤖' : ''}</span>
        <span class="player-dice">🎲${p.diceRemaining}</span>
        <span class="player-money">${fmtMoney(p.money)}</span>
      `;
      panel.appendChild(row);
    });
  }

  let lastRollFingerprint = null;
  let rollRevealTimer = null;
  let rollTumbleInterval = null;

  // Render the final, grouped-by-value dice result (pip faces clustered, biggest group starred).
  function renderDiceTray(container, state, isMyTurn) {
    const groups = groupDice(state.currentRoll);
    const maxCount = Math.max(...groups.map((g) => g.count));
    container.innerHTML = `<div class="dice-tray">${groups
      .map((g, i) => {
        const usable = state.availableValues.includes(g.value);
        const isBest = g.count === maxCount;
        const clickable = isMyTurn && usable;
        return `<div class="dice-group${clickable ? ' clickable' : ''}${isBest ? ' best' : ''}"
                     data-value="${g.value}" style="animation-delay:${i * 70}ms">
            ${isBest ? '<span class="best-badge">★</span>' : ''}
            <div class="dice-group-dice">${Array.from({ length: g.count }).map(() => dieFaceHtml(g.value)).join('')}</div>
            <div class="dice-group-label">${g.value}번 카지노 <span class="count-badge">×${g.count}</span></div>
          </div>`;
      })
      .join('')}</div>`;
    if (isMyTurn) {
      container.querySelectorAll('.dice-group.clickable').forEach((el) => {
        el.addEventListener('click', () => socket.emit('choose_value', { value: Number(el.dataset.value) }));
      });
    }
  }

  // Briefly show a tumbling placeholder before revealing the actual (already-server-decided) roll.
  function playRollAnimation(container, state, isMyTurn) {
    clearTimeout(rollRevealTimer);
    clearInterval(rollTumbleInterval);
    const n = state.currentRoll.length;
    const renderTumbleFrame = () => {
      container.innerHTML = `<div class="dice-tray tumbling">${Array.from({ length: n })
        .map(() => dieFaceHtml(1 + Math.floor(Math.random() * 6)))
        .join('')}</div>`;
    };
    renderTumbleFrame();
    let ticks = 0;
    rollTumbleInterval = setInterval(() => {
      ticks++;
      renderTumbleFrame();
      if (ticks >= 4) clearInterval(rollTumbleInterval);
    }, 110);
    rollRevealTimer = setTimeout(() => {
      clearInterval(rollTumbleInterval);
      renderDiceTray(container, state, isMyTurn);
    }, 520);
  }

  function renderActionPanel(state) {
    const isMyTurn = state.currentPlayerId === myId;
    const rollBtn = $('#btn-roll');
    const rollResult = $('#roll-result');
    const waitingMsg = $('#waiting-msg');

    hide(rollBtn); hide(rollResult); hide(waitingMsg);

    if (state.phase === 'round_end' || state.phase === 'game_over') {
      clearTimeout(rollRevealTimer);
      clearInterval(rollTumbleInterval);
      lastRollFingerprint = null;
      return;
    }

    if (!isMyTurn) {
      waitingMsg.textContent = `${playerName(state.currentPlayerId)}의 차례입니다...`;
      show(waitingMsg);
    }

    if (state.phase === 'awaiting_roll') {
      if (isMyTurn) show(rollBtn);
      lastRollFingerprint = null;
      return;
    }

    if (state.phase === 'awaiting_choice' && state.currentRoll) {
      show(rollResult);
      const fp = `${state.round}|${state.currentPlayerId}|${state.currentRoll.join(',')}`;
      if (fp !== lastRollFingerprint) {
        lastRollFingerprint = fp;
        playRollAnimation(rollResult, state, isMyTurn);
      } else if (!rollResult.querySelector('.dice-group')) {
        renderDiceTray(rollResult, state, isMyTurn);
      }
    }
  }

  function renderLog(state) {
    const list = $('#log-list');
    list.innerHTML = state.log.map((l) => `<div>${l.message}</div>`).join('');
    list.scrollTop = list.scrollHeight;
  }

  function renderRoundEndOverlay(state) {
    if (state.phase !== 'round_end' || !state.lastPayout) return;
    if (seenRoundEndFor === state.lastPayout.round) return; // already shown+handled this round
    seenRoundEndFor = state.lastPayout.round;

    $('#overlay-round-title').textContent = `${state.lastPayout.round}라운드 결과`;
    const body = $('#overlay-round-body');
    body.innerHTML = state.lastPayout.casinos.map((c, ci) => {
      const lines = [];
      let li = 0;
      c.awards.forEach((a) => {
        lines.push(`<div class="payout-line" style="animation-delay:${li * 90}ms"><span>${playerName(a.playerId)} (🎲${a.dice})</span><span class="amount-chip">${fmtMoney(a.amount)}</span></div>`);
        li++;
      });
      c.discarded.forEach((d) => {
        lines.push(`<div class="payout-line discard" style="animation-delay:${li * 90}ms"><span>동점 소멸</span><span class="amount-chip">${fmtMoney(d)}</span></div>`);
        li++;
      });
      c.carried.forEach((cv) => {
        lines.push(`<div class="payout-line carry" style="animation-delay:${li * 90}ms"><span>다음 라운드로 이월</span><span class="amount-chip">${fmtMoney(cv)}</span></div>`);
        li++;
      });
      if (lines.length === 0) lines.push('<div class="payout-line" style="opacity:1"><span>참가자 없음</span><span>-</span></div>');
      return `<div class="payout-casino" style="animation-delay:${ci * 80}ms"><div class="title">${c.number}번 카지노</div>${lines.join('')}</div>`;
    }).join('');

    if (state.round >= state.totalRounds) {
      // game_over will handle final overlay instead
      return;
    }
    show($('#overlay-round'));
  }

  function renderFinalOverlay(state) {
    if (state.phase !== 'game_over') return;
    hide($('#overlay-round'));
    const body = $('#overlay-final-body');
    const sorted = [...state.players].sort((a, b) => b.money - a.money);
    body.innerHTML = sorted.map((p) => `
      <div class="final-row${state.winnerIds.includes(p.id) ? ' winner' : ''}">
        <span>${state.winnerIds.includes(p.id) ? '🏆 ' : ''}${p.name}${p.id === myId ? ' (나)' : ''}</span>
        <span>${fmtMoney(p.money)}</span>
      </div>`).join('');
    show($('#overlay-final'));
  }

  function renderGame(state) {
    lastGameState = state;
    switchScreen('#screen-game');
    $('#round-num').textContent = state.round;
    $('#round-total').textContent = state.totalRounds;

    const turnEl = $('#turn-indicator');
    if (state.phase === 'game_over') {
      turnEl.textContent = '게임 종료';
    } else if (state.currentPlayerId === myId) {
      turnEl.textContent = '👉 내 차례입니다!';
    } else {
      turnEl.textContent = `${playerName(state.currentPlayerId)}의 차례`;
    }

    renderCasinoBoard(state);
    renderPlayers(state);
    renderActionPanel(state);
    renderLog(state);
    renderRoundEndOverlay(state);
    renderFinalOverlay(state);
  }

  // ---------- socket events ----------
  socket.on('connect', () => { myId = socket.id; });

  socket.on('room_joined', ({ code, you }) => {
    myId = you;
    myRoomCode = code;
  });

  socket.on('lobby_state', (state) => renderLobby(state));

  socket.on('game_state', (state) => renderGame(state));

  socket.on('chat_message', ({ name, text }) => {
    const list = $('#chat-list');
    const div = document.createElement('div');
    div.innerHTML = `<b>${name}:</b> ${text.replace(/</g, '&lt;')}`;
    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
  });

  socket.on('error_message', (msg) => toast(msg));
})();
