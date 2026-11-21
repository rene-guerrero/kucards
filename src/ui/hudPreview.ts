/**
 * Dev-only preview (`?hud=1`): the HUD, plates (fake boxes), ¡Ku! button, colour picker, target picker,
 * response bar, ¡KU! pop and the summaries with fake data, so they can be checked without the game.
 * Add `&plates=6` for six seats.
 */
import type { AppSettings, GameEvent, Seat, SeatPlate } from '../contracts';
import { character, DEFAULT_LINEUP, ROSTER } from '../roster';
import { AvatarController, humanFace } from './avatarAdapter';
import { h } from './dom';
import { Hud, type HudPlayer } from './hud';
import { t } from './i18n';
import { btn, type Overlay } from './overlay';
import { bubbleFor, SeatPlates } from './plates';
import { buildMatchEnd, buildPause, buildRoundSummary } from './summary';

export function startHudPreview(overlay: Overlay, s: AppSettings): void {
  const six = new URLSearchParams(location.search).get('plates') === '6';
  const seats: Seat[] = six ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, 3];
  const partners = new URLSearchParams(location.search).has('partners');
  const name = s.playerName || t('seat.you');
  const ids = six ? ['carlos', 'rosa', 'elena', 'zorg', 'andres'] : [DEFAULT_LINEUP[1], DEFAULT_LINEUP[2], DEFAULT_LINEUP[3]];
  const players: HudPlayer[] = seats.map((seat, i) => {
    if (seat === 0) return { seat, name, face: humanFace(s.avatarFace ?? 0), count: 7, team: partners ? 0 : undefined };
    const c = character(ids[i - 1] ?? ROSTER[i].id);
    return { seat, name: c.name, face: c.face, count: [7, 1, 12, 4, 9][i - 1], team: partners ? ((seat % 2) as 0 | 1) : undefined };
  });

  const avatars = new AvatarController();
  for (const p of players) avatars.setSeatFace(p.seat, p.face, p.name);
  const plates = new SeatPlates(avatars);
  const names: string[] = [];
  for (const p of players) names[p.seat] = p.name;
  plates.setNames(names);
  plates.setAvatars(s.avatars !== false);

  const hud = new Hud(overlay, () => {
    let close = () => {};
    close = overlay.openModal(
      buildPause({
        audio: { sound: s.sound, voice: s.voice, music: s.music, vibration: s.vibration },
        onAudio: () => {},
        onResume: () => close(),
        onSettings: () => close(),
        onRules: () => close(),
        onQuit: () => close(),
      }),
    );
  });
  hud.avatars = s.avatars !== false;
  hud.setPlayers(players);
  hud.setRound(3);
  hud.setTarget(500);
  hud.setScores(partners ? [{ label: t('team.a'), value: 120, me: true, team: 0 }, { label: t('team.b'), value: 85, team: 1 }] : players.map((p) => ({ label: p.name, value: [120, 85, 230, 40, 10, 0][p.seat], me: p.seat === 0 })));
  hud.setPending(4);
  hud.setKu('armed');
  hud.onKu = () => {
    hud.setKu('shown');
    void hud.kuPop();
    plates.say(0, t('game.ku'), true);
    avatars.onEvent({ type: 'ku', seat: 0 });
  };
  overlay.hudLayer.append(plates.el, hud.el);
  hud.show(true);

  // fake plate boxes round the screen (what the renderer's onPlates would send)
  const layout = () => {
    const W = innerWidth;
    const H = innerHeight;
    const portrait = H > W;
    const d = portrait ? 44 : 50;
    const pos: Record<number, [number, number]> = six
      ? { 0: [W / 2, H - 70], 1: [W - 70, H * 0.62], 2: [W - 70, H * 0.3], 3: [W / 2, 110], 4: [70, H * 0.3], 5: [70, H * 0.62] }
      : { 0: [W / 2, H - 70], 1: [W - (portrait ? 50 : 110), H * 0.45], 2: [W / 2, portrait ? 130 : 110], 3: [portrait ? 50 : 110, H * 0.45] };
    const boxes: SeatPlate[] = players.map((p) => {
      const stack = portrait && (p.seat === 1 || p.seat === 3 || six) && p.seat !== 0;
      const [x, y] = pos[p.seat];
      return {
        seat: p.seat, x, y, w: stack ? 76 : 150, h: stack ? 84 : 52, d, layout: stack ? 'stack' : 'row', scale: 1,
        visible: true, active: p.seat === 2, winner: false, count: p.count ?? 0, team: p.team,
      };
    });
    plates.update(boxes);
  };
  layout();
  addEventListener('resize', layout);

  const fakeEvents: GameEvent[] = [
    { type: 'play', seat: 1, card: { id: 1, face: { kind: 'draw2', color: 'coral', draw: 2 } } },
    { type: 'play', seat: 2, card: { id: 2, face: { kind: 'skip', color: 'mar' } } },
    { type: 'ku', seat: 3 },
    { type: 'play', seat: 2, card: { id: 3, face: { kind: 'reverse', color: 'mar' } } },
    { type: 'shield', seat: 1 },
    { type: 'kuCaught', by: 2, target: 3 },
  ];
  let evI = 0;

  const summary = () => {
    let close = () => {};
    const totals = [120, 85, 230, 40, 10, 0];
    close = overlay.openModal(
      buildRoundSummary(
        {
          roundNo: 3,
          winner: 0,
          points: 57,
          target: 500,
          matchOver: false,
          avatars: s.avatars !== false,
          players: players.map((p) => ({ seat: p.seat, name: p.name, face: p.face, team: p.team, cardsLeft: p.seat === 0 ? 0 : (p.count ?? 0), handPoints: p.seat === 0 ? 0 : 19, prev: totals[p.seat], total: totals[p.seat] + (p.seat === 0 ? 57 : 0) })),
          teams: partners ? [{ name: t('team.a'), prev: 120, total: 177 }, { name: t('team.b'), prev: 85, total: 85 }] : undefined,
        },
        () => close(),
        () => close(),
      ),
    );
  };
  const matchEnd = () => {
    let close = () => {};
    close = overlay.openModal(
      buildMatchEnd(
        {
          winner: 2,
          winnerTeam: partners ? 0 : undefined,
          avatars: s.avatars !== false,
          players: players.map((p) => ({ seat: p.seat, name: p.name, face: p.face, team: p.team, total: [480, 210, 512, 90, 30, 0][p.seat] })),
          teams: partners ? [{ name: t('team.a'), prev: 0, total: 512 }, { name: t('team.b'), prev: 0, total: 300 }] : undefined,
        },
        () => close(),
        () => close(),
      ),
    );
  };

  const out = h('span.pv-out');
  const say = (txt: string) => (out.textContent = txt);
  const bar = h(
    'div.hud-preview-bar',
    btn('Color', async () => say(await hud.pickColor()), 'secondary'),
    btn('Target', async () => say(String(await hud.pickTarget(seats.filter((x) => x !== 0), t('hud.pickSwap')))), 'secondary'),
    btn('Resp', async () => say(await hud.showResponse({ total: 4, canShield: true, canMirror: true, ms: 5000 })), 'secondary'),
    btn('¡KU!', () => void hud.kuPop(players[1].name), 'secondary'),
    btn('Event', () => {
      const ev = fakeEvents[evI++ % fakeEvents.length];
      avatars.onEvent(ev);
      const b = bubbleFor(ev);
      if (b) plates.say(b.seat, b.text, b.strong);
      say(ev.type);
    }, 'secondary'),
    btn('Ku btn', () => hud.setKu('armed'), 'secondary'),
    btn('Sum', summary, 'secondary'),
    btn('End', matchEnd, 'secondary'),
    btn('ES/EN', () => {
      const u = new URL(location.href);
      localStorage.setItem('kucards.settings.v1', JSON.stringify({ ...s, language: s.language === 'es' ? 'en' : 'es' }));
      location.href = u.toString();
    }, 'ghost'),
    out,
  );
  overlay.hudLayer.append(bar);
}
