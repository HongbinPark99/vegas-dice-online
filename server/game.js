'use strict';

/**
 * Vegas Dice - core game engine (server-authoritative).
 * Faithful adaptation of the "Las Vegas" dice board game mechanics:
 *  - 6 casinos numbered 1-6
 *  - Each casino starts with 1-3 cash bills (10k~90k)
 *  - Each player has 8 dice; each turn you roll all unplaced dice,
 *    pick one face value, and place ALL dice showing that value on
 *    the matching casino. Turn passes to the next player with dice left.
 *  - When every player is out of dice, casinos pay out: most dice at a
 *    casino wins the highest remaining bill there, 2nd most wins the
 *    next bill, etc. A tie at a rank cancels that bill (discarded, no
 *    one gets it) and payout continues to the next rank down.
 *  - Bills nobody could claim (fewer distinct rank-groups than bills)
 *    stay on the casino and roll over into the next round.
 *  - Game is played over 4 rounds; highest total cash wins.
 */

const TOTAL_ROUNDS = 4;
const DICE_PER_PLAYER = 8;
const CASINO_COUNT = 6;

const BILL_DECK_SPEC = [
  [10000, 4], [20000, 4], [30000, 4], [40000, 4], [50000, 4],
  [60000, 3], [70000, 3], [80000, 3], [90000, 3],
];

const PLAYER_COLORS = ['#e0454f', '#3f8efc', '#3fbf6f', '#f2b134', '#a568e0', '#ff8fb1'];
const DUMMY_COLORS = ['#8a8f98', '#5c6470'];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildBillDeck() {
  const deck = [];
  BILL_DECK_SPEC.forEach(([value, count]) => {
    for (let i = 0; i < count; i++) deck.push(value);
  });
  return shuffle(deck);
}

function dealCasinoBills(deck) {
  const bills = [];
  if (deck.length) bills.push(deck.pop());
  if (deck.length) bills.push(deck.pop());
  const sumFirstTwo = bills.reduce((a, b) => a + b, 0);
  if (bills.length === 2 && sumFirstTwo < 50000 && deck.length) {
    bills.push(deck.pop());
  }
  return bills;
}

class VegasGame {
  /**
   * @param {Array<{id:string, name:string, isDummy?:boolean}>} players 2-6 real players,
   *   optionally plus 1-2 "dummy" (bot) players for the 2/3-player balancing variant.
   */
  constructor(players) {
    if (players.length < 2 || players.length > PLAYER_COLORS.length + DUMMY_COLORS.length) {
      throw new Error('플레이어는 2~6명이어야 합니다.');
    }
    const deck = buildBillDeck();
    this.casinos = Array.from({ length: CASINO_COUNT }, (_, i) => ({
      number: i + 1,
      bills: dealCasinoBills(deck),
    }));

    this.turnOrder = shuffle(players.map((p) => p.id));
    this.players = {};
    let realIdx = 0;
    let dummyIdx = 0;
    players.forEach((p) => {
      const isDummy = !!p.isDummy;
      const color = isDummy
        ? DUMMY_COLORS[dummyIdx++ % DUMMY_COLORS.length]
        : PLAYER_COLORS[realIdx++ % PLAYER_COLORS.length];
      this.players[p.id] = {
        id: p.id,
        name: p.name,
        color,
        isDummy,
        money: 0,
        diceRemaining: DICE_PER_PLAYER,
        placed: {}, // casinoNumber -> count placed this round
      };
    });

    this.round = 1;
    this.currentTurnIndex = -1; // will advance to first valid player
    this.currentRoll = null; // array of die values rolled by current player, awaiting choice
    this.phase = 'awaiting_roll'; // 'awaiting_roll' | 'awaiting_choice' | 'round_end' | 'game_over'
    this.log = [];
    this.lastPayout = null; // set at round end: { round, casinos: [{number, awards:[{playerId,amount}], discarded:[amount], carried:[amount]}] }
    this.winnerIds = null;

    this._advanceToNextActivePlayer(true);
  }

  _pushLog(message) {
    this.log.push({ t: Date.now(), message });
    if (this.log.length > 200) this.log.shift();
  }

  _activePlayerIds() {
    return this.turnOrder.filter((id) => this.players[id].diceRemaining > 0);
  }

  _advanceToNextActivePlayer(isFirstCall) {
    const active = this._activePlayerIds();
    if (active.length === 0) {
      this._endRound();
      return;
    }
    if (isFirstCall) {
      this.currentTurnIndex = this.turnOrder.indexOf(active[0]);
    } else {
      let idx = this.currentTurnIndex;
      for (let step = 0; step < this.turnOrder.length; step++) {
        idx = (idx + 1) % this.turnOrder.length;
        const pid = this.turnOrder[idx];
        if (this.players[pid].diceRemaining > 0) {
          this.currentTurnIndex = idx;
          break;
        }
      }
    }
    this.phase = 'awaiting_roll';
    this.currentRoll = null;
  }

  /** True while it's a dummy ("더미") player's turn to roll. The server drives dummy
   * turns on a short timer (see server.js) so every viewer sees the same roll-tumble
   * and dice-choice animation a human's turn would produce, instead of the dummy's
   * move resolving invisibly between broadcasts. */
  isDummyTurn() {
    return !!(
      this.phase === 'awaiting_roll' &&
      this.currentPlayerId &&
      this.players[this.currentPlayerId] &&
      this.players[this.currentPlayerId].isDummy
    );
  }

  /** Picks (without applying) the dummy's move: the face value with the most
   * matching dice in the current roll, ties broken toward the higher casino number. */
  pickDummyValue() {
    const roll = this.currentRoll;
    const avail = this.availableValuesFromRoll();
    let bestValue = avail[0];
    let bestCount = -1;
    avail.forEach((v) => {
      const c = roll.filter((x) => x === v).length;
      if (c > bestCount || (c === bestCount && v > bestValue)) {
        bestCount = c;
        bestValue = v;
      }
    });
    return bestValue;
  }

  get currentPlayerId() {
    if (this.currentTurnIndex < 0) return null;
    return this.turnOrder[this.currentTurnIndex];
  }

  rollDice(playerId) {
    if (this.phase === 'game_over') throw new Error('게임이 이미 종료되었습니다.');
    if (this.currentPlayerId !== playerId) throw new Error('당신의 차례가 아닙니다.');
    if (this.phase !== 'awaiting_roll') throw new Error('지금은 굴릴 수 없습니다.');
    const player = this.players[playerId];
    const roll = [];
    for (let i = 0; i < player.diceRemaining; i++) {
      roll.push(1 + Math.floor(Math.random() * 6));
    }
    this.currentRoll = roll;
    this.phase = 'awaiting_choice';
    this._pushLog(`${player.name}이(가) 주사위 ${roll.length}개를 굴렸습니다: [${roll.join(', ')}]`);
    return roll;
  }

  availableValuesFromRoll() {
    if (!this.currentRoll) return [];
    return [...new Set(this.currentRoll)].sort((a, b) => a - b);
  }

  chooseValue(playerId, value) {
    if (this.phase === 'game_over') throw new Error('게임이 이미 종료되었습니다.');
    if (this.currentPlayerId !== playerId) throw new Error('당신의 차례가 아닙니다.');
    if (this.phase !== 'awaiting_choice') throw new Error('먼저 주사위를 굴려야 합니다.');
    if (!this.currentRoll || !this.currentRoll.includes(value)) {
      throw new Error('굴린 결과에 없는 숫자입니다.');
    }
    const player = this.players[playerId];
    const count = this.currentRoll.filter((v) => v === value).length;
    player.placed[value] = (player.placed[value] || 0) + count;
    player.diceRemaining -= count;
    this._pushLog(`${player.name}이(가) ${value}번 카지노에 주사위 ${count}개를 놓았습니다. (남은 주사위 ${player.diceRemaining}개)`);
    this.currentRoll = null;
    this._advanceToNextActivePlayer(false);
    return { casino: value, count };
  }

  _endRound() {
    const results = [];
    this.casinos.forEach((casino) => {
      const contenders = Object.values(this.players)
        .map((p) => ({ playerId: p.id, count: p.placed[casino.number] || 0 }))
        .filter((c) => c.count > 0);

      const bills = casino.bills.slice().sort((a, b) => b - a);
      const entry = { number: casino.number, awards: [], discarded: [], carried: [] };

      if (contenders.length === 0 || bills.length === 0) {
        entry.carried = bills;
        casino.bills = bills;
        results.push(entry);
        return;
      }

      const groups = new Map();
      contenders.forEach((c) => {
        if (!groups.has(c.count)) groups.set(c.count, []);
        groups.get(c.count).push(c.playerId);
      });
      const countsDesc = [...groups.keys()].sort((a, b) => b - a);

      let billIdx = 0;
      for (const count of countsDesc) {
        if (billIdx >= bills.length) break;
        const group = groups.get(count);
        const bill = bills[billIdx];
        if (group.length === 1) {
          const pid = group[0];
          this.players[pid].money += bill;
          entry.awards.push({ playerId: pid, amount: bill, dice: count });
          this._pushLog(`${this.players[pid].name}이(가) ${casino.number}번 카지노에서 ${bill.toLocaleString()}원을 획득했습니다. (주사위 ${count}개)`);
        } else {
          entry.discarded.push(bill);
          this._pushLog(`${casino.number}번 카지노 ${bill.toLocaleString()}원 지폐는 동점(${group.length}명, 주사위 ${count}개)으로 소멸되었습니다.`);
        }
        billIdx++;
      }
      entry.carried = bills.slice(billIdx);
      casino.bills = entry.carried;
      results.push(entry);
    });

    this.lastPayout = { round: this.round, casinos: results };
    this.phase = 'round_end';
    this.currentRoll = null;

    if (this.round >= TOTAL_ROUNDS) {
      this._finishGame();
    }
  }

  /** Called by the room controller once clients have seen the round-end payout, to start next round. */
  startNextRound() {
    if (this.phase !== 'round_end') throw new Error('라운드가 끝난 상태가 아닙니다.');
    this.round += 1;
    Object.values(this.players).forEach((p) => {
      p.diceRemaining = DICE_PER_PLAYER;
      p.placed = {};
    });
    this._pushLog(`--- ${this.round}라운드 시작 ---`);
    this._advanceToNextActivePlayer(true);
  }

  _finishGame() {
    this.phase = 'game_over';
    const realPlayers = Object.values(this.players).filter((p) => !p.isDummy);
    let best = -Infinity;
    realPlayers.forEach((p) => { if (p.money > best) best = p.money; });
    this.winnerIds = realPlayers.filter((p) => p.money === best).map((p) => p.id);
    this._pushLog(`게임 종료! 최종 승자: ${this.winnerIds.map((id) => this.players[id].name).join(', ')}`);
  }

  getState() {
    return {
      round: this.round,
      totalRounds: TOTAL_ROUNDS,
      phase: this.phase,
      casinos: this.casinos.map((c) => ({ number: c.number, bills: c.bills.slice().sort((a, b) => b - a) })),
      players: this.turnOrder.map((id) => {
        const p = this.players[id];
        return {
          id: p.id,
          name: p.name,
          color: p.color,
          isDummy: !!p.isDummy,
          money: p.money,
          diceRemaining: p.diceRemaining,
          placed: p.placed,
        };
      }),
      currentPlayerId: this.currentPlayerId,
      currentRoll: this.currentRoll,
      availableValues: this.availableValuesFromRoll(),
      lastPayout: this.lastPayout,
      winnerIds: this.winnerIds,
      log: this.log.slice(-30),
    };
  }
}

module.exports = { VegasGame, TOTAL_ROUNDS, DICE_PER_PLAYER, CASINO_COUNT, PLAYER_COLORS };
