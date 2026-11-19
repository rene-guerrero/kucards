/**
 * Phase 1 smoke scene: a felt table, the deck, the first card on the pile and a dealt hand fanned at the
 * bottom, dealt with the Kudominoes FrameLoop + Animator. Phase 2 replaces it with the real card table
 * (cardTable.ts, card atlas, input). Card faces and the deck's back use the game's own art (drawFace / drawBack of the card atlas).
 */
import * as THREE from 'three';
import type { Card, Quality, TableStyle } from '../contracts';
import { FrameLoop } from './frameLoop';
import { drawArena, drawBack, drawFace, makeTexture, roundRect, TABLE_STYLE_DEFS } from './cardAtlas';
import { Animator, ease } from './tween';

const CARD_W = 0.62;
const CARD_H = CARD_W * 1.5;

/** a card texture with the game's own art: the atlas face drawing, or the default "Ku" back when `card` is null */
function faceTexture(card: Card | null): THREE.CanvasTexture {
  const W = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = W * 1.5;
  const g = c.getContext('2d')!;
  if (card) {
    drawFace(g, card.face, 0, 0, W);
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
  const cardMesh = (card: Card | null) => {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: card ? faceTexture(card) : backTex, transparent: true }));
    scene.add(m);
    meshes.push(m);
    return m;
  };
  for (let i = 0; i < 6; i++) cardMesh(null).position.set(-0.55, 0.005 * i, 0);

  const anim = new Animator();
  let last = 0;
  let disposed = false;
  const loop = new FrameLoop({
    canRun: () => !disposed,
    frame: (now) => {
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      anim.update(dt);
      renderer.render(scene, camera);
      return anim.active;
    },
  });
  const resize = () => {
    const w = container.clientWidth || innerWidth;
    const hgt = container.clientHeight || innerHeight;
    renderer.setSize(w, hgt);
    camera.aspect = w / hgt;
    camera.updateProjectionMatrix();
    loop.kick();
  };
  addEventListener('resize', resize);
  resize();

  return {
    async deal(hand, top) {
      const pile = cardMesh(top);
      pile.position.set(-0.55, 0.05, 0);
      loop.kick();
      await anim.tween(0.35, (k) => pile.position.set(-0.55 + 1.1 * k, 0.05 + Math.sin(k * Math.PI) * 0.5, 0), ease.outCubic);
      const n = hand.length;
      const jobs = hand.map((card, i) => {
        const m = cardMesh(card);
        const a = (i - (n - 1) / 2) * 0.12; // fan angle
        const tx = Math.sin(a) * 3.2;
        const tz = 2.25 - Math.cos(a) * 0.5 + 0.5;
        m.position.set(-0.55, 0.05, 0);
        return anim.tween(0.4, (k) => {
          m.position.set(-0.55 + (tx + 0.55) * k, 0.06 + i * 0.002 + Math.sin(k * Math.PI) * 0.4, tz * k);
          m.rotation.y = -a * k;
        }, ease.outCubic, i * 0.07);
      });
      loop.kick();
      await Promise.all(jobs);
    },
    setQuality(q) {
      setPR(q);
      resize();
    },
    dispose() {
      disposed = true;
      removeEventListener('resize', resize);
      for (const m of meshes) {
        const mat = m.material as THREE.MeshBasicMaterial;
        if (mat.map && mat.map !== backTex) mat.map.dispose();
        mat.dispose();
      }
      backTex.dispose();
      geo.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
