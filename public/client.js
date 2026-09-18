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

  function renderCasinoBoard(state) {
    const board = $('#casino-board');
    board.innerHTML = '';
    state.casinos.forEach((casino) => {
      const div = document.createElement('div');
      div.className = 'casino';

      const billsHtml = casino.bills.map((b) => `<div class="bill">${(b / 1000)}k</div>`).join('') || '<div class="bill" style="opacity:.4">없음</div>';

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

      div.innerHTML = `
        <div class="casino-num">${casino.number}</div>
        <div class="casino-bills">${billsHtml}</div>
        <div class="casino-dice">${rows}</div>
      `;
      board.appendChild(div);
    });
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

  function renderActionPanel(state) {
    const isMyTurn = state.currentPlayerId === myId;
    const rollBtn = $('#btn-roll');
    const rollResult = $('#roll-result');
    const choiceButtons = $('#choice-buttons');
    const waitingMsg = $('#waiting-msg');

    hide(rollBtn); hide(rollResult); hide(choiceButtons); hide(waitingMsg);

    if (state.phase === 'round_end' || state.phase === 'game_over') {
      return;
    }

    if (!isMyTurn) {
      waitingMsg.textContent = `${playerName(state.currentPlayerId)}의 차례입니다...`;
      show(waitingMsg);
      if (state.currentRoll) {
        rollResult.innerHTML = state.currentRoll.map((v) => `<div class="roll-die">${v}</div>`).join('');
        show(rollResult);
      }
      return;
    }

    if (state.phase === 'awaiting_roll') {
      show(rollBtn);
    } else if (state.phase === 'awaiting_choice') {
      rollResult.innerHTML = state.currentRoll.map((v) =>
        `<div class="roll-die${state.availableValues.includes(v) ? ' usable' : ''}">${v}</div>`).join('');
      show(rollResult);

      choiceButtons.innerHTML = '';
      state.availableValues.forEach((v) => {
        const count = state.currentRoll.filter((x) => x === v).length;
        const btn = document.createElement('button');
        btn.className = 'choice-btn';
        btn.textContent = `${v}번 카지노에 ${count}개 놓기`;
        btn.addEventListener('click', () => socket.emit('choose_value', { value: v }));
        choiceButtons.appendChild(btn);
      });
      show(choiceButtons);
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
    body.innerHTML = state.lastPayout.casinos.map((c) => {
      const lines = [];
      c.awards.forEach((a) => lines.push(`<div class="payout-line"><span>${playerName(a.playerId)} (🎲${a.dice})</span><span>${fmtMoney(a.amount)}</span></div>`));
      c.discarded.forEach((d) => lines.push(`<div class="payout-line discard"><span>동점 소멸</span><span>${fmtMoney(d)}</span></div>`));
      c.carried.forEach((cv) => lines.push(`<div class="payout-line carry"><span>다음 라운드로 이월</span><span>${fmtMoney(cv)}</span></div>`));
      if (lines.length === 0) lines.push('<div class="payout-line"><span>참가자 없음</span><span>-</span></div>');
      return `<div class="payout-casino"><div class="title">${c.number}번 카지노</div>${lines.join('')}</div>`;
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
