/**
 * End-to-end test against a running `wrangler dev` (Node 22+: global WebSocket and fetch).
 *
 *   npx wrangler dev --port 8787 --var KUCA_TURN_TIMEOUT_MS:1500 --var KUCA_WINDOW_MS:400 \
 *     --var KUCA_GRACE_MS:800 --var KUCA_NEXT_ROUND_MS:600 --var KUCA_CPU_SPEED:0.03
 *   node test/integration.mjs            (KUCA_URL overrides http://127.0.0.1:8787)
 *
 * Every message every client receives is checked for leaks: during a round a client may only see the
 * cards in its own hand (plus its partner's in Parejas with partnerOpen) and the cards played to the
 * pile; any other card arrives without an id (hidden). Once a round ends every hand is public.
 */
const BASE = process.env.KUCA_URL ?? 'http://127.0.0.1:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');
const V = 2;
const TURN = new Set(['play', 'draw', 'pass', 'acceptPenalty', 'respond', 'challenge']);

let failures = 0;
const ok = (cond, what) => {
  if (!cond) {
    failures++;
    console.error('  FAIL', what);
    throw new Error(what);
  }
  console.log('  ok  ', what);
};

/** every card-shaped object in a value */
function cards(x, acc = []) {
  if (Array.isArray(x)) x.forEach((v) => cards(v, acc));
  else if (x && typeof x === 'object') {
    if (typeof x.id === 'number' && x.face && typeof x.face.kind === 'string') acc.push(x);
    for (const v of Object.values(x)) cards(v, acc);
  }
  return acc;
}

class Client {
  constructor(name, pid, code) {
    Object.assign(this, { name, pid, code });
    this.msgs = [];
    this.seat = null;
    this.seen = new Set(); // seats whose hands I may see
    this.known = new Set(); // card ids I may know this round
    this.autoplay = true;
    this.leaks = [];
    this.waiters = [];
    this.room = null;
    this.turn = null;
    this.rounds = 0;
    this.draws = { mine: 0, others: 0 };
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_BASE}/api/rooms/${this.code}/ws?pid=${this.pid}`, { headers: { Origin: 'http://localhost:5174' } });
      this.ws = ws;
      ws.onopen = () => {
        this.send({ t: 'hello', v: V, playerId: this.pid, name: this.name, face: 2 });
        resolve();
      };
      ws.onerror = (e) => reject(e);
      ws.onmessage = (e) => this.onMsg(JSON.parse(e.data));
      ws.onclose = () => (this.closed = true);
    });
  }
  close() {
    this.ws.close(1000, 'bye');
  }
  send(m) {
    this.ws.send(JSON.stringify(m));
  }
  check(value, where) {
    for (const c of cards(value)) if (c.id >= 0 && !this.known.has(c.id)) this.leaks.push(`${where}: card ${c.id} (${c.face.kind})`);
  }
  onMsg(m) {
    this.msgs.push(m);
    switch (m.t) {
      case 'welcome': {
        this.room = m.room;
        this.seat = m.you.seat;
        const v = m.view;
        if (v) {
          const r = v.match.round;
          if (v.match.rng !== 0) this.leaks.push('view rng');
          if (r) {
            this.known = new Set(r.discard.map((c) => c.id));
            r.hands.forEach((h, s) => {
              if (h.length) {
                if (s !== v.seat && !r.over && !(m.room.mode === 'partners' && m.room.rules.partnerOpen !== false)) this.leaks.push(`view hand of ${s}`);
                h.forEach((c) => this.known.add(c.id));
              }
            });
            if (r.deck.length) this.leaks.push('view deck');
            if (r.challenge !== undefined) this.leaks.push('view challenge');
          }
        }
        break;
      }
      case 'room':
        this.room = m.room;
        break;
      case 'events': {
        const evs = m.events;
        if (evs[0]?.type === 'deal') this.known = new Set();
        for (const ev of evs) {
          if (ev.type === 'play') this.known.add(ev.card.id);
          if (ev.type === 'deal') this.known.add(ev.firstCard.id);
          if (ev.type === 'sweep') ev.cardIds.forEach((id) => this.known.add(id));
          if (ev.type === 'draw') this.draws[ev.seat === this.seat ? 'mine' : 'others']++;
          if (ev.type === 'draw' && ev.cards && ev.seat !== this.seat && !m.snap.hands.some((x) => x.seat === ev.seat)) this.leaks.push(`draw of ${ev.seat} showed cards`);
          if (ev.type === 'draw' && ev.seat === this.seat && !ev.cards) this.leaks.push('my own draw was hidden');
        }
        // what the snapshot says I may see (every hand once the round is over)
        const over = evs.some((e) => e.type === 'roundEnd');
        if (!over) for (const x of m.snap.hands) if (x.seat !== this.seat && !this.partnerOpen()) this.leaks.push(`snapshot hand of ${x.seat}`);
        for (const x of m.snap.hands) x.cards.forEach((c) => this.known.add(c.id));
        if (over) this.rounds++;
        this.check(evs, 'events');
        break;
      }
      case 'turn':
        this.turn = m;
        for (const mv of m.legal) if (mv.seat !== this.seat) this.leaks.push('legal move of another seat');
        this.maybeAct(m);
        break;
    }
    for (const w of this.waiters.slice()) if (w.pred(m)) (this.waiters.splice(this.waiters.indexOf(w), 1), w.resolve(m));
  }
  partnerOpen() {
    return this.room?.mode === 'partners' && this.room.rules.partnerOpen !== false;
  }
  maybeAct(m) {
    if (!m.legal.length || !this.autoplay) return;
    const turnMoves = m.legal.filter((x) => TURN.has(x.kind));
    const pool = m.seat === this.seat && turnMoves.length ? turnMoves : m.legal.filter((x) => Math.random() < 0.3);
    if (!pool.length) return;
    const mv = pool[Math.floor(Math.random() * pool.length)];
    setTimeout(() => this.send({ t: 'move', move: mv }), 10);
  }
  waitFor(pred, ms = 20000, what = 'message') {
    const hit = this.msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return this.next(pred, ms, what);
  }
  /** wait for a future message only */
  next(pred, ms, what) {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) (this.waiters.splice(i, 1), reject(new Error(`${this.name}: timeout waiting for ${what}`)));
      }, ms ?? 20000);
    });
  }
}

const api = async (path, init) => {
  const r = await fetch(`${BASE}${path}`, { ...init, headers: { Origin: 'https://rene-guerrero.github.io', ...(init?.headers ?? {}) } });
  return { status: r.status, body: await r.json(), cors: r.headers.get('access-control-allow-origin') };
};
const rid = (p) => `${p}-${Math.random().toString(36).slice(2, 10)}`;

async function classicTest() {
  console.log('\n== classic: 2 humans + 2 CPUs ==');
  const A = rid('ana');
  const created = await api(`/api/rooms?pid=${A}`, { method: 'POST' });
  ok(created.status === 201 && /^[23456789A-HJ-NP-Z]{4}$/.test(created.body.code), `room created KUCA-${created.body.code}`);
  ok(created.cors === 'https://rene-guerrero.github.io', 'CORS header for the Pages origin');
  const code = created.body.code;
  const info = await api(`/api/rooms/kuca-${code.toLowerCase()}`);
  ok(info.body.exists && info.body.phase === 'lobby' && info.body.freeSeats === 4, 'room info (KUCA- prefix accepted): lobby, 4 free seats');
  ok((await api('/api/rooms/ZZZZ')).body.exists === false, 'unknown room does not exist');

  const a = new Client('Ana', A, code);
  const b = new Client('Beto', rid('beto'), code);
  await a.connect();
  const wa = await a.waitFor((m) => m.t === 'welcome', 5000, 'welcome');
  ok(wa.you.isHost && wa.you.seat === 0, 'creator is host in seat 0');
  await b.connect();
  const wb = await b.waitFor((m) => m.t === 'welcome', 5000, 'welcome');
  ok(!wb.you.isHost && wb.you.seat === 1, 'second player auto-seated in seat 1');
  b.send({ t: 'start' });
  await b.waitFor((m) => m.t === 'error' && m.code === 'not_host', 5000, 'not_host');
  ok(true, 'non-host cannot start');
  a.send({ t: 'setRules', rules: { ...a.room.rules, target: 0, jumpIn: true } });
  await a.waitFor((m) => m.t === 'room' && m.room.rules.target === 0, 5000, 'rules');
  a.send({ t: 'phrase', id: 'hello' });
  a.send({ t: 'phrase', id: 'hello' });
  await b.waitFor((m) => m.t === 'phrase' && m.seat === 0, 5000, 'phrase');
  await a.waitFor((m) => m.t === 'error' && m.code === 'rate_limited', 5000, 'rate_limited');
  ok(true, 'phrases relayed and rate-limited');

  a.autoplay = false;
  a.send({ t: 'start' });
  const rs = await a.waitFor((m) => m.t === 'room' && m.room.phase === 'playing', 5000, 'playing');
  ok(rs.room.seats[2].kind === 'cpu' && rs.room.seats[3].kind === 'cpu', `CPUs auto-filled (${rs.room.seats[2].characterId}, ${rs.room.seats[3].characterId})`);
  const myTurn = await a.waitFor((m) => m.t === 'turn' && m.seat === 0 && m.legal.some((x) => TURN.has(x.kind)), 30000, 'a turn of A');
  b.send({ t: 'move', move: { kind: 'draw', seat: b.seat } });
  await b.waitFor((m) => m.t === 'error' && m.code === 'too_late', 5000, 'too_late');
  ok(true, 'a move out of turn is refused (too_late)');
  a.send({ t: 'move', move: { kind: 'play', seat: 0, cardId: 9999 } });
  await a.waitFor((m) => m.t === 'error' && m.code === 'bad_move', 5000, 'bad_move');
  ok(myTurn.deadline > Date.now() - 5000, 'illegal move refused; the turn has a deadline');
  // turn timeout: A does not answer; the server's CPU plays for A
  const cov = await a.next((m) => m.t === 'covered' && m.seat === 0 && m.reason === 'timeout', 30000, 'timeout cover');
  ok(!!cov, 'turn timeout → CPU covered A (reason timeout)');
  a.autoplay = true;
  if (a.turn) a.maybeAct(a.turn);

  // disconnect: B drops, A sees it, then a CPU covers after the grace period
  b.close();
  await a.next((m) => m.t === 'room' && m.room.seats[1].connected === false, 5000, 'B disconnected');
  ok(true, 'A sees B disconnected');
  await a.next((m) => m.t === 'room' && m.room.seats[1].cpuCovering === true, 5000, 'B covered');
  ok(true, 'B covered by a CPU after the grace period');
  const b2 = new Client('Beto', b.pid, code);
  await b2.connect();
  const w2 = await b2.waitFor((m) => m.t === 'welcome', 5000, 'welcome again');
  if (w2.view) {
    const r = w2.view.match.round;
    ok(w2.you.seat === 1 && w2.view.seat === 1, 'reconnect: same seat, private view');
    ok(!r || r.over || r.hands.every((h, s) => s === 1 || h.length === 0), 'reconnect view hides other hands');
  } else ok(w2.room.phase === 'finished', 'reconnect after the match ended');
  ok(w2.room.seats[1].connected && !w2.room.seats[1].cpuCovering, 'reconnect: connected, no longer covered');

  const end = await a.waitFor((m) => m.t === 'events' && m.events.some((e) => e.type === 'matchEnd'), 180000, 'matchEnd');
  await a.waitFor((m) => m.t === 'room' && m.room.phase === 'finished', 5000, 'finished');
  ok(!!end, `match finished after ${a.rounds} round(s); draws seen: mine ${a.draws.mine}, others ${a.draws.others}`);
  ok(a.leaks.length === 0 && b.leaks.length === 0 && b2.leaks.length === 0, `no leaks over the whole match (${[...a.leaks, ...b.leaks, ...b2.leaks].slice(0, 5).join('; ') || 'none'})`);

  a.send({ t: 'rematch' });
  const re = await a.next((m) => m.t === 'room' && m.room.phase === 'playing', 5000, 'rematch');
  ok(re.room.seats[0].playerId === A && re.room.seats[1].playerId === b.pid && re.room.code === code, 'rematch: same room, same seats');
  await a.next((m) => m.t === 'events' && m.events[0]?.type === 'deal', 10000, 'rematch deal');
  ok(true, 'rematch dealt a new round');
  a.send({ t: 'leave' });
  await b2.next((m) => m.t === 'room' && m.room.hostId === b.pid && m.room.seats[0].kind === 'cpu', 5000, 'host passes');
  ok(true, 'host leaves: host passes to B, a CPU takes the seat');
  b2.close();
}

async function partnersTest() {
  console.log('\n== Parejas (partners see each other) + Pura acción power cards ==');
  const C = rid('caro');
  const code = (await api(`/api/rooms?pid=${C}`, { method: 'POST' })).body.code;
  const c = new Client('Caro', C, code);
  const d = new Client('Dani', rid('dani'), code);
  await c.connect();
  await c.waitFor((m) => m.t === 'welcome', 5000, 'welcome');
  c.send({ t: 'setMode', mode: 'partners', playerCount: 4 });
  await c.waitFor((m) => m.t === 'room' && m.room.mode === 'partners', 5000, 'mode');
  c.send({ t: 'setRules', rules: { ...c.room.rules, target: 0, partnerOpen: true, partnerShield: true, 'power.shield': true, 'power.mirror': true, 'power.swap': true, kuCall: true } });
  await c.waitFor((m) => m.t === 'room' && m.room.rules['power.shield'] === true, 5000, 'rules');
  await d.connect();
  await d.waitFor((m) => m.t === 'welcome', 5000, 'welcome');
  d.send({ t: 'sit', seat: 2 });
  await c.waitFor((m) => m.t === 'room' && m.room.seats[2].kind === 'human', 5000, 'D in seat 2');
  d.seat = 2;
  c.send({ t: 'start' });
  const deal = await c.waitFor((m) => m.t === 'events' && m.events[0]?.type === 'deal', 10000, 'deal');
  ok(deal.snap.hands.map((x) => x.seat).sort().join() === '0,2', 'partners: my snapshot holds my hand and my partner’s');
  await c.waitFor((m) => m.t === 'events' && m.events.some((e) => e.type === 'matchEnd'), 180000, 'matchEnd');
  ok(true, `Parejas match finished (${c.rounds} round(s))`);
  ok(c.leaks.length === 0 && d.leaks.length === 0, `Parejas: no leaks (${[...c.leaks, ...d.leaks].slice(0, 5).join('; ') || 'none'})`);
  c.close();
  d.close();
}

try {
  await classicTest();
  await partnersTest();
} catch (e) {
  failures++;
  console.error(e);
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL INTEGRATION CHECKS PASSED');
process.exit(failures ? 1 : 0);
