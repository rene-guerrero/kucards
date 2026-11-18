import { describe, expect, it } from 'vitest';
import type { Card, GameEvent, GameMode, MatchState, RuleSettings, Seat } from '../contracts';
import { applyMove, createMatch, legalMoves, startRound, closeWindow, visibleHands } from '../engine/game';
import { buildDeck } from '../engine/cards';
import { RULE_PRESETS } from '../engine/rules';
import { Rng } from '../engine/rng';
import { applyEvent, applySnapshot, emptyMatch } from './mirror';
import { Perspective } from './perspective';
import { isHidden, redactEvents, seatView, snapshotFor, withPlaceholders } from './redact';
import { activeSeatsOf, teamsFor } from './protocol';
import { displayCode, filterCodeChars, normalizeCode } from './identity';

const rulesOf = (mode: GameMode, over: Partial<RuleSettings> = {}): RuleSettings => ({ ...RULE_PRESETS.find((p) => p.id === mode)!.rules, ...over } as RuleSettings);

/** a random game driven by the engine: every batch of events with the state right after it */
function* randomGame(mode: GameMode, players: 2 | 3 | 4, over: Partial<RuleSettings>, seed: number, seating?: 'across' | 'side'): Generator<{ events: GameEvent[]; after: MatchState }> {
  let m = createMatch(rulesOf(mode, over), { mode, players, seating, partnerSide: 'after' }, seed);
  const rng = new Rng(seed ^ 0x5bd1e995);
  for (let round = 0; round < 2 && !m.over; round++) {
    const st = startRound(m);
    m = st.match;
    yield { events: st.events, after: m };
    for (let i = 0; i < 1200 && m.round && !m.round.over; i++) {
      const seats = m.seats.slice();
      const all = seats.flatMap((s) => legalMoves(m, s));
      if (!all.length || (m.round.window && rng.int(4) === 0)) {
        const res = closeWindow(m);
        m = res.match;
        yield { events: res.events, after: m };
        continue;
      }
      const mv = all[rng.int(all.length)];
      const res = applyMove(m, mv);
      m = res.match;
      yield { events: res.events, after: m };
    }
  }
}

describe('redaction', () => {
  it('each seat gets its own hand, counts for the others, never the deck or the rng', () => {
    let k = 0;
    for (const { events, after } of randomGame('action', 4, { sevenZero: true, jumpIn: true }, 17)) {
      if (k++ % 3 && !events.some((e) => e.type === 'deal' || e.type === 'swapHands' || e.type === 'rotateHands' || e.type === 'roundEnd')) continue;
      for (const seat of after.seats) {
        const red = redactEvents(events, seat, after);
        for (const ev of red) {
          if (ev.type === 'draw' && ev.cards) expect(ev.seat).toBe(seat);
          if (ev.type === 'deal') expect(ev.hand!.map((c) => c.id)).toEqual(after.round!.hands[seat].map((c) => c.id));
          if ((ev.type === 'swapHands' || ev.type === 'rotateHands') && ev.cards) expect(ev.cards.map((c) => c.id)).toEqual(after.round!.hands[seat].map((c) => c.id));
          if (ev.type === 'swapHands' && ev.cards) expect([ev.a, ev.b]).toContain(seat);
          if (ev.type === 'window' && ev.window) expect(ev.window.seats.every((s) => s === seat)).toBe(true);
        }
        const v = seatView(after, seat, [], null, null);
        const vm = v.match as MatchState & { round: Record<string, unknown> | null };
        expect(vm.rng).toBe(0);
        if (vm.round && !after.round!.over) {
          const r = vm.round as unknown as MatchState['round'] & { challenge?: unknown; outPoints?: unknown };
          expect(r!.deck).toEqual([]);
          expect(r!.challenge).toBeUndefined();
          expect(r!.outPoints).toBeUndefined();
          r!.hands.forEach((h, s) => expect(h.length).toBe(s === seat ? after.round!.hands[s].length : 0));
          expect(v.handCounts).toEqual(after.round!.hands.map((h) => h.length));
          expect(v.deckCount).toBe(after.round!.deck.length);
        }
        const snap = snapshotFor(after, seat);
        if (!after.round!.over) expect(snap.hands.map((x) => x.seat)).toEqual([seat]);
        else expect(snap.hands.length).toBe(after.seats.length);
      }
    }
  });

  it('Parejas with partnerOpen: partners see each other; without it, only their own hand', () => {
    for (const open of [true, false]) {
      let k = 0;
      for (const { events, after } of randomGame('partners', 4, { partnerOpen: open, partnerPass: true }, 5)) {
        if (k++ % 3 && !events.some((e) => e.type === 'deal' || e.type === 'draw')) continue;
        for (const seat of after.seats) {
          const seen = visibleHands(after, seat);
          expect(seen.length).toBe(open ? 2 : 1);
          for (const ev of redactEvents(events, seat, after)) if (ev.type === 'draw' && ev.cards) expect(seen).toContain(ev.seat);
          const v = seatView(after, seat, [], null, null);
          const r = (v.match as MatchState).round!;
          if (!r.over) r.hands.forEach((h, s) => expect(h.length > 0 && !seen.includes(s as Seat) && after.round!.hands[s].length > 0).toBe(false));
        }
      }
    }
  });

  it('a hidden draw carries no card ids at all', () => {
    for (const { events, after } of randomGame('classic', 3, {}, 23)) {
      const red = redactEvents(events, 0, after);
      const json = JSON.stringify(red.filter((e) => e.type === 'draw' && e.seat !== 0));
      expect(json).not.toContain('"cards"');
    }
  });
});

describe('perspective', () => {
  it('rotates seats so that I am seat 0, keeping the turn order, and maps back', () => {
    for (const seats of [[0, 1, 2, 3], [0, 1, 3], [0, 2]] as Seat[][]) {
      for (const me of seats) {
        const p = new Perspective(me, seats);
        expect(p.seat(me)).toBe(0);
        for (const s of seats) expect(p.server(p.seat(s))).toBe(s);
        // the next seat in turn order stays the next one
        const loc = p.localSeats();
        seats.forEach((s, i) => {
          const nxt = seats[(i + 1) % seats.length];
          const li = loc.indexOf(p.seat(s));
          expect(loc[(li + 1) % loc.length]).toBe(p.seat(nxt));
        });
        const mv = p.moveToServer({ kind: 'play', seat: 0, cardId: 3, target: p.seat(seats[seats.length - 1]) });
        expect(mv.seat).toBe(me);
        expect((mv as { target: Seat }).target).toBe(seats[seats.length - 1]);
      }
    }
  });
});

describe('mirror', () => {
  /** follow a whole game as one seat (events + snapshots) and compare with the truth */
  function follow(mode: GameMode, players: 2 | 3 | 4, over: Partial<RuleSettings>, seed: number, me: Seat, seating?: 'across' | 'side') {
    let mirror: MatchState | null = null;
    let p: Perspective | null = null;
    let checks = 0;
    for (const { events, after } of randomGame(mode, players, over, seed, seating)) {
      if (!p) p = new Perspective(me, after.seats);
      const persp = p;
      if (!mirror || events[0]?.type === 'deal') mirror = mirror ?? emptyMatch(after.rules, mode, persp.localSeats(), persp.teams(after.teams));
      const deck = buildDeck(after.rules);
      const faceOf = (id: number): Card | null => deck.find((c) => c.id === id) ?? null;
      const red = redactEvents(events, me, after).map((e) => persp.event(e));
      const snap0 = snapshotFor(after, me);
      const snap = { ...snap0, counts: persp.perSeat(snap0.counts), hands: snap0.hands.map((x) => ({ seat: persp.seat(x.seat), cards: x.cards })) };
      for (const ev of red) mirror = applyEvent(mirror!, ev, faceOf);
      mirror = applySnapshot(mirror!, snap);
      const r = mirror.round;
      const tr = after.round!;
      if (!r) continue;
      checks++;
      expect(r.hands[0].map((c) => c.id).sort()).toEqual(tr.hands[me].map((c) => c.id).sort());
      for (const s of after.seats) expect(r.hands[persp.seat(s)].length).toBe(tr.hands[s].length);
      expect(r.deck.length).toBe(tr.deck.length);
      expect(r.discard[r.discard.length - 1].id).toBe(tr.discard[tr.discard.length - 1].id);
      expect(r.activeColor).toBe(tr.activeColor);
      expect(r.direction).toBe(tr.direction);
      expect(r.turn).toBe(persp.seat(tr.turn));
      expect(r.pendingDraw).toBe(tr.pendingDraw);
      expect(r.over).toBe(tr.over);
      for (const s of after.seats) expect(mirror.scores[persp.seat(s)]).toBe(after.scores[s]);
      if (!tr.over) for (const s of after.seats) if (persp.seat(s) !== 0 && !visibleHands(after, me).includes(s)) expect(r.hands[persp.seat(s)].every(isHidden)).toBe(true);
    }
    expect(checks).toBeGreaterThan(10);
  }

  it('follows classic, all action (7-0, jump-in) and cyclone games exactly', () => {
    follow('classic', 4, {}, 3, 2);
    follow('action', 3, { sevenZero: true, jumpIn: true, kuCall: true }, 8, 1);
    follow('cyclone', 4, {}, 13, 3);
    follow('action', 2, { stacking: 'any', wild4Challenge: true }, 21, 2);
  });

  it('follows Parejas (Codo a codo) including the partner hand', () => {
    follow('partners', 4, { partnerOpen: true, partnerPass: true, partnerShield: true, 'power.shield': true }, 31, 1, 'side');
  });

  it('withPlaceholders rebuilds full-size hands and deck from a seat view', () => {
    const m = startRound(createMatch(rulesOf('classic'), { mode: 'classic', players: 4 }, 99)).match;
    const v = seatView(m, 2, [], null, null);
    const full = withPlaceholders(v).round!;
    expect(full.hands.map((h) => h.length)).toEqual(m.round!.hands.map((h) => h.length));
    expect(full.deck.length).toBe(m.round!.deck.length);
    expect(full.hands[2].every((c) => !isHidden(c))).toBe(true);
    expect(full.hands[1].every(isHidden)).toBe(true);
  });
});

describe('room helpers and codes', () => {
  it('seats in play and teams', () => {
    expect(activeSeatsOf({ mode: 'classic', playerCount: 2 })).toEqual([0, 2]);
    expect(activeSeatsOf({ mode: 'partners', playerCount: 2 })).toEqual([0, 1, 2, 3]);
    expect(teamsFor('partners', { seating: 'side' })).toEqual([[0, 1], [2, 3]]);
    expect(teamsFor('classic', {})).toBeNull();
  });
  it('codes display as KUCA-XXXX and parse back', () => {
    expect(displayCode('7KQM')).toBe('KUCA-7KQM');
    expect(normalizeCode('kuca-7kqm')).toBe('7KQM');
    expect(normalizeCode('7KQ')).toBe('');
    expect(filterCodeChars('a0o1b')).toBe('AB');
  });
});
