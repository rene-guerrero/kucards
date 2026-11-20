/**
 * The menu backdrop: the felt table, a deck, and a calm loop of cards that glide in from beyond the screen
 * edge onto a pile and slide off the other way (still under Reduce motion, paused in a hidden tab). Card faces and the deck's back use the game's own art (drawFace / drawBack of the card atlas).
 */
import * as THREE from 'three';
import { COLORS, type Card, type Quality, type TableStyle } from '../contracts';
import { symbolSvg } from '../ui/cardArt';
import { FrameLoop } from './frameLoop';
import { COLOR_HEX, drawArena, drawBack, drawFace, makeTexture, playedFace, roundRect, TABLE_STYLE_DEFS, type AtlasFace } from './cardAtlas';

const CARD_W = 0.62;
const CARD_H = CARD_W * 1.5;
const DECK = 4;
const LOOP = 6;
const DECK_X = -0.8;
const DECK_Z = -0.25;
const PILE_X = 0.3;
const PILE_Z = 0.8;
/** the slot of the cycle a colour-changing card is thrown into (every other cycle) */
const WILD = 3;
/** seconds the colour panel takes: the next card waits for it */
const PICK = 1.5;
/** thrown from the bottom, left, top, right of the screen, like the players round the table: where each starts from the pile */
const FROM_X = [0, -1, 0, 1];
const FROM_Z = [1, 0, -1, 0];
/** seconds: between two cards, one card's flight, the full pile at rest, the slide out, off-screen pause */
const GAP = 2.1;
const FLY = 1.9;
const HOLD = 2.2;
const OUT = 2.4;
const T_REST = (LOOP - 1) * GAP + FLY;
const T_OUT = T_REST + HOLD;
const CYCLE = T_OUT + OUT + 0.6;

/** a card texture with the game's own art: the atlas face drawing, or the default "Ku" back when `card` is null */
function faceTexture(face: AtlasFace | null): THREE.CanvasTexture {
  const W = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = W * 1.5;
  const g = c.getContext('2d')!;
  if (face) {
    drawFace(g, face, 0, 0, W);
  } else {
    // the back fills its whole canvas: cut the card's rounded corners out of it
    roundRect(g, 0, 0, W, W * 1.5, (W * 7) / 60);
    g.clip();
    g.drawImage(drawBack('ku', W), 0, 0, W, W * 1.5);
  }
  return makeTexture(c, true);
}

export interface DemoTable {
  deal(hand: Card[], top: Card): Promise<void>;
  setQuality(q: Quality): void;
  dispose(): void;
}

export function createDemoTable(container: HTMLElement, quality: Quality, style: TableStyle = 'teal'): DemoTable {
  const renderer = new THREE.WebGLRenderer({ antialias: quality !== 'low', powerPreference: 'low-power' });
  const setPR = (q: Quality) => renderer.setPixelRatio(Math.min(devicePixelRatio, q === 'high' ? 2 : q === 'medium' ? 1.5 : 1));
  setPR(quality);
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  // the player's chosen table, the same round felt and room as in the game
  const look = TABLE_STYLE_DEFS[style] ?? TABLE_STYLE_DEFS.teal;
  scene.background = new THREE.Color(look.bg);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 50);
  camera.position.set(0, 5.2, 3.6);
  camera.lookAt(0, 0, 0.4);
  const ARENA = 22;
  const feltTex = makeTexture(drawArena(style, quality === 'low' ? 768 : 1536, 4 / ARENA), true);
  const felt = new THREE.Mesh(new THREE.PlaneGeometry(ARENA, ARENA), new THREE.MeshBasicMaterial({ map: feltTex }));
  felt.rotation.x = -Math.PI / 2;
  scene.add(felt);

  const geo = new THREE.PlaneGeometry(CARD_W, CARD_H);
  geo.rotateX(-Math.PI / 2);
  const backTex = faceTexture(null);
  const meshes: THREE.Mesh[] = [];
  const cardMesh = (face: AtlasFace | null) => {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: face ? faceTexture(face) : backTex, transparent: true }));
    scene.add(m);
    meshes.push(m);
    return m;
  };
  // the deck: a still stack of backs, away from the lane the loop's cards travel in
  for (let i = 0; i < DECK; i++) {
    const m = cardMesh(null);
    m.position.set(DECK_X, 0.006 * (i + 1), DECK_Z);
    m.renderOrder = i;
  }

  // The loop is a pure function of the cycle time `t`: cards are thrown in from beyond the four screen
  // edges in turn, one at a time, land on the pile pointing the way they were thrown (each on its own
  // level, always above the ones already there), rest, and the whole pile slides off beyond an edge as one
  // block. They go back to their starting places while off screen. The deck stands clear of both lanes.
  const cards: THREE.Mesh[] = [];
  const turn = new Float32Array(LOOP);
  const jx = new Float32Array(LOOP);
  const jz = new Float32Array(LOOP);
  const dist = [3, 6, 5.3, 6]; // how far from the pile a card is fully outside the view, per edge (sides set by resize)
  let cycle = 0;
  let wildOn = false; // this cycle's slot WILD is the colour-changing card
  let chosen = 0;
  let step = 0; // how far the colour panel got this cycle
  const shuffle = () => {
    for (let i = 0; i < LOOP; i++) {
      turn[i] = (Math.random() - 0.5) * 0.5;
      jx[i] = (Math.random() - 0.5) * 0.07;
      jz[i] = (Math.random() - 0.5) * 0.07;
    }
  };
  shuffle();
  let t = 0;
  const wildFace: AtlasFace = { kind: 'wild', color: null };
  const wildTex = faceTexture(wildFace);
  const tintTex: (THREE.CanvasTexture | undefined)[] = [];
  let wild: THREE.Mesh | null = null;
  const pose = (time: number) => {
    const extra = wildOn ? PICK : 0;
    const out = Math.min(1, Math.max(0, (time - T_OUT - extra) / OUT));
    const exit = cycle % 4;
    const slide = out * out * (3 - 2 * out) * (dist[(exit + 2) % 4] + 0.3);
    for (let i = 0; i < cards.length; i++) {
      const isWild = wildOn && i === WILD && !!wild;
      const m = isWild ? wild! : cards[i];
      if (i === WILD && wild) {
        wild.visible = isWild;
        cards[i].visible = !isWild;
      }
      const u = Math.min(1, Math.max(0, (time - i * GAP - (i > WILD ? extra : 0)) / FLY));
      const k = Math.sin((u * Math.PI) / 2); // fast beyond the edge, settling to rest on the pile
      const r = 1 - k;
      const d = i % 4;
      const far = dist[d] * r;
      m.position.set(
        PILE_X + jx[i] + FROM_X[d] * far - FROM_X[exit] * slide,
        0.006 * (i + 1) + 0.55 * r,
        PILE_Z + jz[i] + FROM_Z[d] * far - FROM_Z[exit] * slide,
      );
      m.rotation.y = turn[i] - (d * Math.PI) / 2 - 0.5 * r;
    }
  };

  // the game's colour diamond (the HUD's markup and styles), display only, over the pile
  const pane = document.createElement('div');
  pane.className = 'color-pane watch';
  pane.setAttribute('aria-hidden', 'true');
  pane.style.cssText = '--cq:116px;z-index:0';
  const diamond = document.createElement('div');
  diamond.className = 'color-diamond';
  diamond.style.pointerEvents = 'none';
  const quads = COLORS.map((c, i) => {
    const q = document.createElement('div');
    q.className = `color-quad ${['q-t', 'q-r', 'q-b', 'q-l'][i]}`;
    q.style.cssText = `--c:${COLOR_HEX[c]};--ca:${COLOR_HEX[c]}d4;cursor:default`;
    q.innerHTML = `<span class="color-sym">${symbolSvg(c, 24, '#fff6e6')}</span>`;
    diamond.append(q);
    return q;
  });
  pane.append(diamond);
  const anchor = new THREE.Vector3();
  const placePane = () => {
    const rect = renderer.domElement.getBoundingClientRect();
    anchor.set(PILE_X, 0, PILE_Z).project(camera);
    pane.style.left = `${Math.round(rect.left + ((anchor.x + 1) / 2) * rect.width)}px`;
    pane.style.top = `${Math.round(rect.top + ((1 - anchor.y) / 2) * rect.height)}px`;
  };
  const closePane = () => {
    pane.remove();
    pane.classList.remove('leaving');
    for (const q of quads) q.classList.remove('pressed');
  };
  /** the colour panel's steps, by the cycle clock: opens once the wild has landed, the colour presses in, the card takes it, it closes */
  const pick = (time: number) => {
    const at = time - (WILD * GAP + FLY);
    if (step === 0 && at >= 0.15) {
      step = 1;
      placePane();
      container.append(pane);
    } else if (step === 1 && at >= 0.65) {
      step = 2;
      quads[chosen].classList.add('pressed');
    } else if (step === 2 && at >= 0.9) {
      step = 3;
      const tex = (tintTex[chosen] ??= faceTexture(playedFace(wildFace, COLORS[chosen])));
      (wild!.material as THREE.MeshBasicMaterial).map = tex;
      pane.classList.add('leaving');
    } else if (step === 3 && at >= 1.15) {
      step = 4;
      closePane();
    }
  };
  /** a new cycle starts with every card off screen: every other one throws the colour-changing card */
  const nextCycle = () => {
    cycle++;
    shuffle();
    wildOn = !!wild && cycle % 2 === 1;
    step = 0;
    chosen = Math.floor(Math.random() * COLORS.length);
    if (wild) (wild.material as THREE.MeshBasicMaterial).map = wildTex;
  };

  const reduced = () => document.documentElement.classList.contains('reduce-motion');
  let last = 0;
  let disposed = false;
  let skip = false;
  let half = quality === 'low'; // weak phones draw every other frame
  const loop = new FrameLoop({
    canRun: () => !disposed && !document.hidden,
    frame: (now) => {
      const still = reduced() || !cards.length;
      if (still) {
        if (step > 0 && step < 4) closePane();
        if (step < 3) wildOn = false; // no panel on a still table: the plain cards
        step = 4;
        pose(T_REST + PICK); // the full pile, at rest
        last = 0;
      } else {
        t += last ? Math.min(0.1, (now - last) / 1000) : 0;
        last = now;
        if (t >= CYCLE + (wildOn ? PICK : 0)) {
          t = 0;
          nextCycle();
        }
        if (wildOn && step < 4) pick(t);
        skip = half && !skip;
        if (skip) return true;
        pose(t);
      }
      renderer.render(scene, camera);
      return !still;
    },
  });
  const wake = () => {
    last = 0;
    loop.kick();
  };
  const resize = () => {
    const w = container.clientWidth || innerWidth;
    const hgt = container.clientHeight || innerHeight;
    renderer.setSize(w, hgt);
    camera.aspect = w / hgt;
    camera.updateProjectionMatrix();
    dist[1] = dist[3] = 2.9 * camera.aspect + 1.2;
    if (pane.isConnected) placePane();
    skip = false;
    if (reduced()) loop.cancel(); // a still table redraws right away
    loop.kick();
  };
  addEventListener('resize', resize);
  document.addEventListener('visibilitychange', wake);
  // the Reduce motion setting toggles a class on <html>
  const watch = new MutationObserver(wake);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  resize();

  return {
    async deal(hand, top) {
      if (cards.length) return;
      [top, ...hand].slice(0, LOOP).forEach((card, i) => {
        const m = cardMesh(card.face);
        m.renderOrder = DECK + i;
        cards.push(m);
      });
      if (cards.length > WILD) {
        wild = cardMesh(null);
        (wild.material as THREE.MeshBasicMaterial).map = wildTex;
        wild.renderOrder = DECK + WILD;
        wild.visible = false;
      }
      pose(0); // all beyond the screen edges
      wake();
    },
    setQuality(q) {
      half = q === 'low';
      setPR(q);
      resize();
    },
    dispose() {
      disposed = true;
      removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', wake);
      watch.disconnect();
      loop.cancel();
      for (const m of meshes) {
        const mat = m.material as THREE.MeshBasicMaterial;
        if (mat.map && mat.map !== backTex && mat.map !== wildTex && !tintTex.includes(mat.map as THREE.CanvasTexture)) mat.map.dispose();
        mat.dispose();
      }
      backTex.dispose();
      wildTex.dispose();
      for (const x of tintTex) x?.dispose();
      closePane();
      geo.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
