/**
 * Phase 1 smoke scene: a felt table, the deck, the first card on the pile and a dealt hand fanned at the
 * bottom, dealt with the Kudominoes FrameLoop + Animator. Phase 2 replaces it with the real card table
 * (cardTable.ts, card atlas, input). Placeholder card faces are drawn on a canvas per card here.
 */
import * as THREE from 'three';
import type { Card, Color, Quality } from '../contracts';
import { FrameLoop } from './frameLoop';
import { Animator, ease } from './tween';

export const COLOR_HEX: Record<Color, string> = { sol: '#ffb627', mar: '#14a3a0', palma: '#4caf50', coral: '#ff6f61' };
const LABEL: Record<string, string> = { skip: '⦸', reverse: '⇄', draw2: '+2', wild: '★', wild4: '+4', swap: '⇅', shield: '⛨', sweep: '≋', mirror: '◐', flip: '◑' };

const CARD_W = 0.62;
const CARD_H = 0.9;

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function faceTexture(card: Card | null): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 186;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff6e6';
  roundRect(g, 0, 0, 128, 186, 16);
  g.fill();
  if (!card) {
    g.fillStyle = '#1b3a46';
    roundRect(g, 8, 8, 112, 170, 11);
    g.fill();
    g.fillStyle = '#ffb627';
    g.font = '900 40px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('Ku', 64, 108);
  } else {
    const col = card.face.color ? COLOR_HEX[card.face.color] : '#26323a';
    g.fillStyle = col;
    roundRect(g, 8, 8, 112, 170, 11);
    g.fill();
    g.fillStyle = '#fff6e6';
    g.beginPath();
    g.arc(64, 93, 38, 0, Math.PI * 2);
    g.fill();
    const txt = card.face.kind === 'number' ? String(card.face.value) : LABEL[card.face.kind];
    g.fillStyle = col;
    g.font = '900 46px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(txt, 64, 95);
    g.fillStyle = '#fff6e6';
    g.font = '800 24px system-ui, sans-serif';
    g.fillText(txt, 26, 30);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export interface DemoTable {
  deal(hand: Card[], top: Card): Promise<void>;
  setQuality(q: Quality): void;
  dispose(): void;
}

export function createDemoTable(container: HTMLElement, quality: Quality): DemoTable {
  const renderer = new THREE.WebGLRenderer({ antialias: quality !== 'low', powerPreference: 'low-power' });
  const setPR = (q: Quality) => renderer.setPixelRatio(Math.min(devicePixelRatio, q === 'high' ? 2 : q === 'medium' ? 1.5 : 1));
  setPR(quality);
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#13232e');
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 50);
  camera.position.set(0, 5.2, 3.6);
  camera.lookAt(0, 0, 0.4);
  const felt = new THREE.Mesh(new THREE.CircleGeometry(4, 48), new THREE.MeshBasicMaterial({ color: '#1e5a66' }));
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
