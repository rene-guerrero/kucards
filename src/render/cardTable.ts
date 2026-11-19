/**
 * The three.js card table (implements TableView). Patterns from Kudominoes' tableView.ts: a camera rig
 * fitted to portrait / landscape, HTML plates projected to CSS px (onPlates), an event queue in
 * handle(), pointer picking, quality levels, pause, dispose.
 *
 * Weak-phone budget:
 *  - every card is one instance of ONE InstancedMesh (one rounded-rect geometry, one shader): faces come
 *    from one atlas (per-instance cell offset), backs from one shared texture, picked in the shader with
 *    gl_FrontFacing. Unknown cards show the back on both sides.
 *  - unlit materials only (no lights, no shadows, no postprocessing); pixel ratio capped by quality.
 *  - the frame loop renders only while something moves and returns false when idle.
 * A full 4-player table draws: felt, direction ring, colour glow, deck edge, pile edge, all cards = 6
 * calls (+1 per particle system / stamp / badge while they show).
 */
import * as THREE from 'three';
import type {
  Card, CardBack, CardFace, Color, Direction, FrameStats, GameEvent, Quality, RestoreState, Seat, SeatPlate, SfxName,
  TableStyle, TableView, TableViewOptions,
} from '../contracts';
import * as A from './cardAtlas';
import { FrameLoop } from './frameLoop';
import * as L from './layout';
import { Particles } from './particles';
import { PerfHud } from './perfHud';
import { Animator, ease, lerp, type Ease } from './tween';

type V3 = THREE.Vector3;
type Q = THREE.Quaternion;

interface QualityCfg {
  dpr: number;
  aa: boolean;
  atlas: number;
  /** min ms between rendered frames while animating (0 = every rAF) */
  frameMs: number;
  maxDt: number;
  particles: number;
  confetti: number;
  felt: number;
  aniso: number;
}

export const QUALITY: Record<Quality, QualityCfg> = {
  low: { dpr: 1, aa: false, atlas: 1024, frameMs: 28, maxDt: 0.1, particles: 60, confetti: 90, felt: 512, aniso: 1 },
  medium: { dpr: 1.5, aa: true, atlas: 1024, frameMs: 0, maxDt: 0.1, particles: 160, confetti: 200, felt: 1024, aniso: 2 },
  high: { dpr: 2, aa: true, atlas: 2048, frameMs: 0, maxDt: 0.05, particles: 300, confetti: 300, felt: 1024, aniso: 4 },
};

const POOL = 220;
const PILE_KEEP = 8;
/** events that undo a previewed (not yet played) human card */
const PREVIEW_UNDO = new Set<GameEvent['type']>(['play', 'draw', 'deal', 'swapHands', 'rotateHands', 'sweep', 'reshuffle', 'roundEnd', 'eliminated']);
const HUD_TOP = L.HUD_TOP;
/** distance of the human hand in front of the camera (world units) */
const HAND_D = 2.4;
/** cards in the human hand before it counts as crowded (a tapped card's neighbours then step aside) */
const HAND_FULL = 7;
/** the direction arrows: see-through, tinted by the colour in play, turning slowly (rad/s) */
const DIR_OPACITY = 0.55;
const DIR_SPIN = 0.22;
/** power effects over the pile */
const FX_GOLD = new THREE.Color('#ffd36b');
const FX_WHITE = new THREE.Color('#ffffff');
const FX_SHIELD = new THREE.Color('#9fe6ff');
/** side of the floor plane carrying the round table and the room around it (world units) */
const ARENA_SIZE = 22;
/** height of a full deck (world units, as tuned in the fan demo) */
const DECK_MAX_H = 0.25;
const DECK_GUESS = 108;
const UP = new THREE.Vector3(0, 1, 0);
const Q_LAY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const Q_FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const AX_X = new THREE.Vector3(1, 0, 0);
const AX_Z = new THREE.Vector3(0, 0, 1);
const tmpQ2 = new THREE.Quaternion();
const CONFETTI: [number, number, number][] = [
  [1, 0.714, 0.153], [0.078, 0.639, 0.627], [0.298, 0.686, 0.314], [1, 0.435, 0.38], [1, 0.965, 0.902],
];
const KU_COLS: [number, number, number][] = [
  [1, 0.714, 0.153], [0.078, 0.639, 0.627], [0.298, 0.686, 0.314], [1, 0.435, 0.38],
];
/** on-screen size of the skip mark (CSS px, min / max): big over the table, small at a seat */
const SKIP_BIG_PX = [150, 320];
const SKIP_SMALL_PX = [46, 70];

/** the skip mark: a white ring with a slash on a soft dark disc, glowing; drawn once, tinted per use */
function drawSkipMark(ctx: CanvasRenderingContext2D, S: number): void {
  const c = S / 2;
  const r = S * 0.33;
  const w = S * 0.1;
  ctx.clearRect(0, 0, S, S);
  const bg = ctx.createRadialGradient(c, c, r * 0.4, c, c, S * 0.48);
  bg.addColorStop(0, 'rgba(0,0,0,0.42)');
  bg.addColorStop(0.75, 'rgba(0,0,0,0.28)');
  bg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, S, S);
  const d = r * Math.SQRT1_2;
  const path = (lw: number, style: string, blur: number) => {
    ctx.save();
    ctx.lineWidth = lw;
    ctx.strokeStyle = style;
    ctx.shadowColor = blur ? 'rgba(255,255,255,0.85)' : 'transparent';
    ctx.shadowBlur = blur;
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(c - d, c - d);
    ctx.lineTo(c + d, c + d);
    ctx.stroke();
    ctx.restore();
  };
  // dark rim for contrast on a bright felt, the glowing white body, then a crisp core
  path(w + S * 0.035, 'rgba(10,14,20,0.55)', 0);
  path(w, '#ffffff', S * 0.07);
  path(w * 0.86, '#ffffff', 0);
  // a thin bright highlight along the ring's upper-left edge
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = S * 0.012;
  ctx.strokeStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(c, c, r + w * 0.62, Math.PI * 1.05, Math.PI * 1.6);
  ctx.stroke();
  ctx.restore();
}

const MARK_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** the penalty mark: "+N" big and bold in a thin glowing ring on a soft dark disc (white; tinted per use) */
function drawPenMark(ctx: CanvasRenderingContext2D, S: number, text: string): void {
  const c = S / 2;
  const r = S * 0.37;
  ctx.clearRect(0, 0, S, S);
  const bg = ctx.createRadialGradient(c, c, r * 0.4, c, c, S * 0.49);
  bg.addColorStop(0, 'rgba(0,0,0,0.45)');
  bg.addColorStop(0.75, 'rgba(0,0,0,0.3)');
  bg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, S, S);
  ctx.save();
  ctx.lineWidth = S * 0.05;
  ctx.strokeStyle = 'rgba(10,14,20,0.55)';
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = S * 0.032;
  ctx.strokeStyle = '#ffffff';
  ctx.shadowColor = 'rgba(255,255,255,0.85)';
  ctx.shadowBlur = S * 0.06;
  ctx.stroke();
  // the number: as big as fits inside the ring
  let px = Math.round(S * (text.length > 2 ? 0.4 : 0.5));
  ctx.font = `900 ${px}px ${MARK_FONT}`;
  const wMax = r * 1.62;
  const tw = ctx.measureText(text).width;
  if (tw > wMax) {
    px = Math.floor((px * wMax) / tw);
    ctx.font = `900 ${px}px ${MARK_FONT}`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const y = c + px * 0.04;
  ctx.shadowBlur = 0;
  ctx.lineJoin = 'round';
  ctx.lineWidth = S * 0.035;
  ctx.strokeStyle = 'rgba(10,14,20,0.6)';
  ctx.strokeText(text, c, y);
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(255,255,255,0.8)';
  ctx.shadowBlur = S * 0.07;
  ctx.fillText(text, c, y);
  ctx.shadowBlur = 0;
  ctx.fillText(text, c, y);
  ctx.restore();
}
/** penalty a card carries when its face has no explicit draw */
const KIND_DRAW: Partial<Record<string, number>> = { draw2: 2, wild4: 4, draw6: 6, draw10: 10 };
const TEAM_TINT = ['#3fe0d0', '#ff7a6b'];
const Q_TMP_X = new THREE.Vector3(1, 0, 0);

const DOME_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const DOME_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec3 vN;
varying vec3 vV;
void main() {
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float a = uOpacity * (0.28 + 0.9 * pow(f, 1.5));
  gl_FragColor = vec4(uColor * a, 1.0);
}`;

const COLOR_LIN: Record<Color, THREE.Color> = {
  sol: new THREE.Color(A.COLOR_GLOW.sol),
  mar: new THREE.Color(A.COLOR_GLOW.mar),
  palma: new THREE.Color(A.COLOR_GLOW.palma),
  coral: new THREE.Color(A.COLOR_GLOW.coral),
};

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpM = new THREE.Matrix4();
const tmpS = new THREE.Vector3();
const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);
const scr = { x: 0, y: 0 };
/** atlas cell offsets (u0, v0) by cell index */
const CELL_UV = (() => {
  const a = new Float32Array(A.ATLAS_CELLS * 2);
  for (let i = 0; i < A.ATLAS_CELLS; i++) {
    const uv = A.cellUv(i);
    a[i * 2] = uv.u0;
    a[i * 2 + 1] = uv.v0;
  }
  return a;
})();

const VERT = /* glsl */ `
attribute vec2 aCell;
attribute vec3 aFx;
varying vec2 vUv;
varying vec2 vCell;
varying vec3 vFx;
void main() {
  vUv = uv;
  vCell = aCell;
  vFx = aFx;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform sampler2D uBack;
uniform vec2 uCell;
uniform vec3 uGlow;
varying vec2 vUv;
varying vec2 vCell;
varying vec3 vFx;
void main() {
  vec3 c;
  if (gl_FrontFacing && vFx.z > 0.5) c = texture2D(uAtlas, vCell + vUv * uCell).rgb;
  else c = texture2D(uBack, gl_FrontFacing ? vUv : vec2(1.0 - vUv.x, vUv.y)).rgb;
  vec2 e = min(vUv, 1.0 - vUv);
  float edge = min(e.x * 0.667, e.y);
  // bevel: the rim darkens a touch, so cards read as objects without lighting
  c *= 0.82 + 0.18 * smoothstep(0.0, 0.03, edge);
  float g = vFx.x;
  c = mix(c, uGlow, (1.0 - smoothstep(0.012, 0.05, edge)) * g);
  c += uGlow * (g * 0.06);
  c *= 1.0 - vFx.y * 0.5;
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

/** the opponents' hands mirrored under the table: same faces / backs, fading with depth below the felt */
const REFL_VERT = /* glsl */ `
attribute vec2 aCell;
attribute float aFace;
varying vec2 vUv;
varying vec2 vCell;
varying float vFace;
varying float vDepth;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vCell = aCell;
  vFace = aFace;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vDepth = -wp.y;
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const REFL_FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform sampler2D uBack;
uniform vec2 uCell;
uniform float uStrength;
uniform float uFade;
uniform sampler2D uFelt;
uniform float uArena;
varying vec2 vUv;
varying vec2 vCell;
varying float vFace;
varying float vDepth;
varying vec3 vWorld;
void main() {
  // the mirror flips the winding, so the sides swap
  bool front = !gl_FrontFacing;
  vec3 c;
  if (front && vFace > 0.5) c = texture2D(uAtlas, vCell + vUv * uCell).rgb;
  else c = texture2D(uBack, front ? vUv : vec2(1.0 - vUv.x, vUv.y)).rgb;
  float a = uStrength * (1.0 - smoothstep(0.0, uFade, vDepth));
  if (a < 0.004) discard;
  // solid, not see-through: blend with the floor seen along this ray (where it meets the felt), so
  // overlapping reflections hide each other like the cards do
  vec3 ray = vWorld - cameraPosition;
  float t = cameraPosition.y / max(1e-4, cameraPosition.y - vWorld.y);
  vec3 hit = cameraPosition + ray * t;
  vec3 floorC = texture2D(uFelt, vec2(hit.x / uArena + 0.5, 0.5 - hit.z / uArena)).rgb;
  gl_FragColor = vec4(mix(floorC, c, a), 1.0);
  #include <colorspace_fragment>
}`;
/** at most this many reflected cards (every opponent's hand together) */
const REFL_MAX = 90;
const MIRROR_Y = new THREE.Matrix4().makeScale(1, -1, 1);

interface CardObj {
  i: number;
  card: Card | null;
  cell: number;
  pos: V3;
  quat: Q;
  s: number;
  sqx: number;
  sqy: number;
  glow: number;
  dim: number;
  vis: boolean;
  token: number;
  fxToken: number;
  jx: number;
  jz: number;
  jyaw: number;
  /** being dragged by the pointer */
  held: boolean;
}

interface Pose {
  pos: V3;
  quat: Q;
  s: number;
}

interface FlyOpts {
  dur?: number;
  arc?: number;
  delay?: number;
  /** extra turns about the world up axis, unwinding over the flight (radians) */
  spin?: number;
  ease?: Ease;
  onStart?: () => void;
}

interface HumanReq {
  playable: Set<number>;
  canDraw: boolean;
  resolve: (v: number | 'draw') => void;
}

const newPose = (): Pose => ({ pos: new THREE.Vector3(), quat: new THREE.Quaternion(), s: 1 });

function faceUpQ(yaw: number, out: Q): Q {
  return out.setFromAxisAngle(UP, yaw).multiply(Q_LAY);
}
function faceDownQ(yaw: number, out: Q): Q {
  return out.setFromAxisAngle(UP, yaw).multiply(Q_LAY).multiply(Q_FLIP);
}
/** a yellow square pyramid, point down, with flat-shaded faces (the scene has no lights) */
function makeDrawCue(): THREE.Mesh {
  const g = new THREE.ConeGeometry(0.26, 0.46, 4, 1).rotateX(Math.PI).toNonIndexed();
  g.computeVertexNormals();
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const col = new Float32Array(pos.count * 3);
  const light = new THREE.Vector3(0.4, 0.8, 0.5).normalize();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    // one shade per triangle from its first vertex normal
    n.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
    const k = 0.55 + 0.45 * Math.max(0, n.dot(light));
    for (let j = 0; j < 3; j++) {
      col[(i + j) * 3] = 1 * k;
      col[(i + j) * 3 + 1] = 0.82 * k;
      col[(i + j) * 3 + 2] = 0.12 * k;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true }));
}
/** rounded-rect card geometry in the XY plane facing +Z, uv 0..1 over the card */
function buildCardGeometry(): THREE.BufferGeometry {
  const w = L.CARD_W;
  const h = L.CARD_H;
  const r = 0.075;
  const s = new THREE.Shape();
  const x0 = -w / 2;
  const y0 = -h / 2;
  s.moveTo(x0 + r, y0);
  s.lineTo(x0 + w - r, y0);
  s.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
  s.lineTo(x0 + w, y0 + h - r);
  s.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
  s.lineTo(x0 + r, y0 + h);
  s.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
  s.lineTo(x0, y0 + r);
  s.quadraticCurveTo(x0, y0, x0 + r, y0);
  const g = new THREE.ShapeGeometry(s, 3);
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) - x0) / w, (pos.getY(i) - y0) / h);
  uv.needsUpdate = true;
  g.deleteAttribute('normal');
  return g;
}

/** world height of one stack layer (about eight cards) */
const STACK_BAND = 0.028;
const STACK_BANDS = 16;
/**
 * A card stack, built once: STACK_BANDS rounded-rect slabs from y=0 upwards (in XZ, W along x, H along z),
 * each slightly staggered and sized unevenly, with a thin dark seam at its foot, baked side shading and
 * a darker foot near the table. Indices run band by band, so `bandIndexCount(n)` draws the lowest n.
 */
function buildStackGeometry(): THREE.BufferGeometry {
  const SEG = 4;
  const P = 4 * (SEG + 1);
  const r = 0.075;
  const ring: number[] = []; // x, z, nx, nz per outline point
  const corners = [
    [1, 1, 0],
    [-1, 1, Math.PI / 2],
    [-1, -1, Math.PI],
    [1, -1, Math.PI * 1.5],
  ];
  for (const [sx, sz, a0] of corners)
    for (let i = 0; i <= SEG; i++) {
      const a = a0 + (i / SEG) * (Math.PI / 2);
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      ring.push(sx * (L.CARD_W / 2 - r) + nx * r, sz * (L.CARD_H / 2 - r) + nz * r, nx, nz);
    }
  const vPerBand = 4 * P + P + 1;
  const pos = new Float32Array(STACK_BANDS * vPerBand * 3);
  const col = new Float32Array(STACK_BANDS * vPerBand * 3);
  const idx: number[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  let v = 0;
  const put = (x: number, y: number, z: number, c: number) => {
    pos[v * 3] = x;
    pos[v * 3 + 1] = y;
    pos[v * 3 + 2] = z;
    col[v * 3] = c;
    col[v * 3 + 1] = c * 0.985;
    col[v * 3 + 2] = c * 0.955;
    v++;
  };
  for (let b = 0; b < STACK_BANDS; b++) {
    const base = v;
    const ox = rnd() * 0.007;
    const oz = rnd() * 0.007;
    const inset = 0.006 + Math.abs(rnd()) * 0.004; // a hair inside the card outline, uneven per layer
    const tint = 0.93 + Math.abs(rnd()) * 0.07;
    const foot = 0.74 + 0.26 * Math.min(1, b / 3); // darker towards the table
    const y0 = b * STACK_BAND;
    const ys = y0 + STACK_BAND * 0.13; // the dark seam's top
    const y1 = y0 + STACK_BAND;
    // rows: seam bottom, seam top (dark) | seam top, band top (white)
    const rows: [number, number][] = [
      [y0, 0.32],
      [ys, 0.4],
      [ys, 0.86],
      [y1, 1],
    ];
    for (const [y, k] of rows)
      for (let i = 0; i < P; i++) {
        const x = ring[i * 4] - ring[i * 4 + 2] * inset + ox;
        const z = ring[i * 4 + 1] - ring[i * 4 + 3] * inset + oz;
        const side = 0.84 + 0.1 * ring[i * 4 + 3] + 0.06 * ring[i * 4 + 2]; // baked light from front-right
        put(x, y, z, k * side * tint * foot);
      }
    for (const row of [0, 2])
      for (let i = 0; i < P; i++) {
        const j = (i + 1) % P;
        const a = base + row * P + i;
        const bb = base + row * P + j;
        const c = a + P;
        const d = bb + P;
        idx.push(a, c, bb, bb, c, d);
      }
    // top cap (only the uppermost drawn one shows, and barely: the deck's top card sits on it)
    const capC = v;
    put(ox, y1, oz, 0.95 * tint);
    for (let i = 0; i < P; i++) put(ring[i * 4] * 0.99 + ox, y1, ring[i * 4 + 1] * 0.99 + oz, 0.95 * tint);
    for (let i = 0; i < P; i++) idx.push(capC, capC + 1 + ((i + 1) % P), capC + 1 + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}
/** indices per stack band (sides + cap) */
const STACK_BAND_IDX = (4 * (4 + 1)) * 6 * 2 + 4 * (4 + 1) * 3;

/** show `h` world units of stack: a whole number of bands, stretched to fit exactly */
function fitStack(m: THREE.Mesh, h: number): void {
  const n = Math.max(1, Math.min(STACK_BANDS, Math.round(h / STACK_BAND)));
  m.geometry.setDrawRange(0, n * STACK_BAND_IDX);
  m.scale.set(1, Math.max(0.001, h) / (n * STACK_BAND), 1);
}

export class CardTable implements TableView {
  private opts: TableViewOptions;
  private container: HTMLElement;
  private quality: Quality;
  private q: QualityCfg;
  private renderer!: THREE.WebGLRenderer;
  private canvas!: HTMLCanvasElement;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  /** the un-pushed camera all layout is computed with */
  private layoutCam = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  private anim = new Animator();
  private speedMul = 1;
  private reduced = false;
  private tableStyle: TableStyle = 'teal';
  private cardBack: CardBack = 'ku';
  private seats: Seat[] = [0, 1, 2, 3];

  // textures / materials / meshes
  private faceMap = new A.FaceMap();
  private atlasCanvas!: A.AtlasCanvas;
  private atlasTex!: THREE.CanvasTexture;
  private backTex!: THREE.CanvasTexture;
  private cardGeo!: THREE.BufferGeometry;
  private cardMat!: THREE.ShaderMaterial;
  private cards!: THREE.InstancedMesh;
  /** the opponents' hands reflected in the floor (one more instanced draw) */
  private refl!: THREE.InstancedMesh;
  private reflCell!: THREE.InstancedBufferAttribute;
  private reflFace!: THREE.InstancedBufferAttribute;
  private aCell!: THREE.InstancedBufferAttribute;
  private aFx!: THREE.InstancedBufferAttribute;
  private felt!: THREE.Mesh;
  private feltTex: THREE.CanvasTexture | null = null;
  private feltKey = '';
  /** the deck's stack geometry; the pile's shares its buffers (own draw range) */
  private boxGeo!: THREE.BufferGeometry;
  private pileGeo!: THREE.BufferGeometry;
  private boxMat!: THREE.MeshBasicMaterial;
  private deckBox!: THREE.Mesh;
  /** a faint mirror of the deck stack under the floor */
  private deckRefl!: THREE.Mesh;
  private pileBox!: THREE.Mesh;
  private glowRing!: THREE.Mesh;
  /** the bouncing yellow pyramid over the deck when the human has no play and must draw */
  private drawCue!: THREE.Mesh;
  private cueT = 0;
  /** a flat triangle on the felt, out from the table centre, pointing at whoever's turn it is */
  private turnArrow!: THREE.Mesh;
  private arrowYaw = 0;
  private arrowTarget = 0;
  private glowTex!: THREE.CanvasTexture;
  private dirRing!: THREE.Mesh;
  private dirTex!: THREE.CanvasTexture;
  private stamp!: THREE.Sprite;
  private stampCanvas!: HTMLCanvasElement;
  private stampTex!: THREE.CanvasTexture;
  private badge!: THREE.Sprite;
  private badgeCanvas!: HTMLCanvasElement;
  private badgeTex!: THREE.CanvasTexture;
  private dust!: Particles;
  private confetti!: Particles;
  /** "+N" over the victim of an open penalty window */
  private penBadge!: THREE.Sprite;
  private penCanvas!: HTMLCanvasElement;
  private penTex!: THREE.CanvasTexture;
  private penTok = 0;
  private penSeat: Seat | null = null;
  /** shield bubble */
  private dome!: THREE.Mesh;
  private domeMat!: THREE.ShaderMaterial;
  private domeTok = 0;
  /** mirror flash */
  private flash!: THREE.Sprite;
  private flashTex!: THREE.CanvasTexture;
  /** the big skip mark over the table centre, and the small ones that fly to each skipped seat */
  private skipBig!: THREE.Sprite;
  private skipTok = 0;
  /** the round / match win celebration (a new one, or a reset, stops the old) */
  private winTok = 0;
  /** the big "+N" penalty mark: pops over the table centre (growing as penalties stack), then flies to the victim */
  private penBig!: THREE.Sprite;
  private penMarkCanvas!: HTMLCanvasElement;
  private penMarkTex!: THREE.CanvasTexture;
  private penMarkTok = 0;
  private penMarkTotal = 0;
  private penMarkPop: Promise<void> | null = null;
  private skipStamps: THREE.Sprite[] = [];
  private skipTex!: THREE.CanvasTexture;

  // card state
  private pool: CardObj[] = [];
  private free: CardObj[] = [];
  private hands: CardObj[][] = [[], [], [], [], [], []];
  private pile: CardObj[] = [];
  private deckTop!: CardObj;
  private deckCount = DECK_GUESS;
  private discardCount = 0;
  private faces = new Map<number, CardFace>();
  private activeColor: Color | null = null;
  /** colours picked for played wild-type cards, by card id (the pile keeps showing them) */
  private chosen = new Map<number, Color>();
  private direction: Direction = 1;
  private stackTotal = 0;
  private eliminated = [false, false, false, false, false, false];
  private winner: Seat | null = null;
  private turnSeat: Seat | null = null;
  private plateScale = [1, 1, 1, 1, 1, 1];
  /** plate x offset in px (kuCaught shake) */
  private plateShake = [0, 0, 0, 0, 0, 0];
  /** open hands by seat: the sorted faces to show, or null (face down) */
  private openCards: (Card[] | null)[] = [null, null, null, null, null, null];
  private openSig = ['', '', '', '', '', ''];
  private teams: [Seat[], Seat[]] | null = null;
  private teamsExplicit = false;
  // what the last events said (for the cyclone / response visuals)
  private lastPlayKind = '';
  private lastPlayDraw = 0;
  private streamDraw = false;
  private skipAllDone = new Set<number>();
  private windowVictim: Seat | null = null;
  private platesOn = false;
  private platePulse = 0;

  // layout
  private W = 1;
  private H = 1;
  private portrait = true;
  private dims: L.TableDims = L.tableDims(true);
  private fan: L.FanLayout = L.fanLayout(0, { W: 1, H: 1 });
  private deckPos = new THREE.Vector3(-0.6, 0, 0.05);
  /** the deck's turn about the vertical (radians), from the tuned layout */
  private deckYaw = 0;
  private pilePos = new THREE.Vector3(0.6, 0, 0.05);
  private push = 0;
  private pushTarget = new THREE.Vector3();
  private viewProj = new THREE.Matrix4();

  // queue / loop
  private queue: Promise<void> = Promise.resolve();
  private busy = 0;
  private gen = 0;
  private reqGen = 0;
  private req: HumanReq | null = null;
  private needsSettle = false;
  private paused = false;
  private disposed = false;
  private lastT = 0;
  private lastRender = 0;
  private heartbeat = 0;
  private loop = new FrameLoop({
    frame: (now) => this.loopFrame(now),
    canRun: () => !this.paused && !this.disposed,
    onError: (e, n) => {
      if (n === 1 || n % 60 === 0) console.error(`[render] frame failed (${n}x)`, e);
    },
    onFatal: (e) => this.opts.onError?.(e),
  });
  private fstat = { prev: 0, skip: 0, start: 0, sum: 0, n: 0 };
  private fstatOut: FrameStats = { avgFrameMs: 0, frames: 0, quality: 'medium' };
  private perf: PerfHud | null = null;
  private resizeObs: ResizeObserver | null = null;
  private plateSig = '';
  private plates: SeatPlate[] = [];

  // input
  private ptr = {
    id: -1, x0: 0, y0: 0, x: 0, y: 0, idx: -1, deck: false, dragging: false, t: 0,
    kind: '' as '' | 'hand' | 'open' | 'deck', slid: false, touch: false, wasPeek: false,
  };

  constructor(opts: TableViewOptions) {
    this.opts = opts;
    this.container = opts.container;
    this.quality = opts.quality;
    this.q = QUALITY[opts.quality] ?? QUALITY.medium;
    this.reduced = !!opts.reducedMotion;
    this.speedMul = Math.max(0.1, opts.speed ?? 1);
    this.tableStyle = opts.tableStyle && A.TABLE_STYLE_DEFS[opts.tableStyle] ? opts.tableStyle : 'teal';
    this.cardBack = opts.cardBack ?? 'ku';
    if (opts.seats?.length) this.seats = opts.seats.slice();
    this.applySpeed();
    if (import.meta.env.DEV && /[?&]perf=1/.test(location.search)) this.perf = new PerfHud(this.container);

    this.createRenderer();
    this.buildScene();
    this.applyQualityKnobs();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.onResize());
      this.resizeObs.observe(this.container);
    }
    window.addEventListener('resize', this.onResize);
    this.heartbeat = window.setInterval(this.checkAwake, 1000);
    this.onResize();
    try {
      this.renderer.compile(this.scene, this.camera);
    } catch {
      /* best effort */
    }
    this.reset();
  }

  // ───────────────────────── setup ─────────────────────────

  private pixelRatio(): number {
    return Math.min(this.q.dpr, window.devicePixelRatio || 1);
  }

  private createRenderer(): void {
    const old = this.renderer;
    const r = new THREE.WebGLRenderer({ antialias: this.q.aa, powerPreference: 'default', alpha: false, stencil: false });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping;
    r.setClearColor(A.TABLE_STYLE_DEFS[this.tableStyle].bg, 1);
    r.setPixelRatio(this.pixelRatio());
    const c = r.domElement;
    c.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;';
    c.addEventListener('webglcontextlost', (e) => e.preventDefault());
    if (old) {
      this.detachInput();
      old.dispose();
      old.forceContextLoss();
      old.domElement.replaceWith(c);
      r.setSize(this.W, this.H, false);
    } else {
      this.container.appendChild(c);
    }
    this.renderer = r;
    this.canvas = c;
    this.attachInput();
  }

  private buildScene(): void {
    const S = A.TABLE_STYLE_DEFS[this.tableStyle];
    this.scene.background = null;
    // felt
    this.felt = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.felt.renderOrder = -10;
    // no depth: the reflections drawn after it sit below it and must still show
    (this.felt.material as THREE.MeshBasicMaterial).depthWrite = false;
    this.scene.add(this.felt);
    // rings
    this.glowTex = A.makeTexture(A.drawGlowRing(128), false);
    this.glowRing = new THREE.Mesh(
      new THREE.PlaneGeometry(2.1, 2.1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: this.glowTex, transparent: true, depthWrite: false, opacity: 0.9, color: 0xffffff }),
    );
    this.glowRing.position.set(this.pilePos.x, 0.003, this.pilePos.z);
    this.glowRing.renderOrder = -5;
    this.glowRing.visible = false;
    this.scene.add(this.glowRing);
    this.drawCue = makeDrawCue();
    this.drawCue.visible = false;
    this.scene.add(this.drawCue);
    {
      // a glowing rounded arrowhead (one small quad, its own small texture), warm white;
      // the tip on +Z; turned about the vertical to point at a seat
      this.turnArrow = new THREE.Mesh(
        new THREE.PlaneGeometry(0.72, 0.72).rotateX(-Math.PI / 2).rotateY(Math.PI),
        new THREE.MeshBasicMaterial({ map: A.makeTexture(A.drawTurnMarker(128), true), color: 0xfff0d2, transparent: true, opacity: 0.92, depthWrite: false }),
      );
      this.turnArrow.userData.t = 0;
      this.turnArrow.renderOrder = -4;
      this.turnArrow.visible = false;
      this.scene.add(this.turnArrow);
    }
    this.dirTex = A.makeTexture(A.drawDirRing(512), true);
    this.dirRing = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: this.dirTex, transparent: true, depthWrite: false, opacity: DIR_OPACITY }),
    );
    this.dirRing.position.set(0, 0.002, 0.05);
    this.dirRing.renderOrder = -6;
    this.scene.add(this.dirRing);
    // deck / pile edges (one shared box geometry + material)
    this.boxGeo = buildStackGeometry();
    this.pileGeo = new THREE.BufferGeometry();
    this.pileGeo.setAttribute('position', this.boxGeo.attributes.position);
    this.pileGeo.setAttribute('color', this.boxGeo.attributes.color);
    this.pileGeo.setIndex(this.boxGeo.index);
    this.boxMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.deckBox = new THREE.Mesh(this.boxGeo, this.boxMat);
    this.pileBox = new THREE.Mesh(this.pileGeo, this.boxMat);
    this.scene.add(this.deckBox, this.pileBox);
    // a short mirror that fades out just below the felt (not a second, see-through stack)
    this.deckRefl = new THREE.Mesh(
      this.boxGeo,
      new THREE.ShaderMaterial({
        vertexShader: /* glsl */ `
          attribute vec3 color;
          varying vec3 vColor;
          varying float vDepth;
          void main() {
            vColor = color;
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vDepth = -wp.y;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */ `
          varying vec3 vColor;
          varying float vDepth;
          void main() {
            float a = 0.3 * (1.0 - smoothstep(0.0, 0.12, vDepth));
            if (a < 0.004) discard;
            gl_FragColor = vec4(vColor, a);
            #include <colorspace_fragment>
          }`,
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.deckRefl.renderOrder = -8;
    this.scene.add(this.deckRefl);
    // cards
    this.cardGeo = buildCardGeometry();
    this.atlasCanvas = A.drawAtlas(this.q.atlas, this.faceMap);
    this.atlasTex = A.makeTexture(this.atlasCanvas.canvas, true);
    this.backTex = A.makeTexture(A.drawBack(this.cardBack, 256), true);
    this.cardMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uAtlas: { value: this.atlasTex },
        uBack: { value: this.backTex },
        uCell: { value: new THREE.Vector2(A.CELL_SU, A.CELL_SV) },
        uGlow: { value: new THREE.Color('#ffe17a') },
      },
      side: THREE.DoubleSide,
    });
    this.aCell = new THREE.InstancedBufferAttribute(new Float32Array(POOL * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.aFx = new THREE.InstancedBufferAttribute(new Float32Array(POOL * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.cardGeo.setAttribute('aCell', this.aCell);
    this.cardGeo.setAttribute('aFx', this.aFx);
    this.cards = new THREE.InstancedMesh(this.cardGeo, this.cardMat, POOL);
    this.cards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cards.frustumCulled = false;
    this.scene.add(this.cards);
    {
      const geo = buildCardGeometry();
      this.reflCell = new THREE.InstancedBufferAttribute(new Float32Array(REFL_MAX * 2), 2).setUsage(THREE.DynamicDrawUsage);
      this.reflFace = new THREE.InstancedBufferAttribute(new Float32Array(REFL_MAX), 1).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aCell', this.reflCell);
      geo.setAttribute('aFace', this.reflFace);
      const u = this.cardMat.uniforms;
      const mat = new THREE.ShaderMaterial({
        vertexShader: REFL_VERT,
        fragmentShader: REFL_FRAG,
        // shared uniform objects: an atlas / back rebuild reaches the reflection too
        uniforms: {
          uAtlas: u.uAtlas, uBack: u.uBack, uCell: u.uCell, uStrength: { value: 0.55 }, uFade: { value: 1.3 },
          uFelt: { value: this.feltTex }, uArena: { value: ARENA_SIZE },
        },
        side: THREE.DoubleSide,
      });
      this.refl = new THREE.InstancedMesh(geo, mat, REFL_MAX);
      this.refl.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.refl.frustumCulled = false;
      // over the floor, under everything standing on it
      this.refl.renderOrder = -8;
      this.refl.count = 0;
      this.scene.add(this.refl);
    }
    for (let i = 0; i < POOL; i++) {
      const o: CardObj = {
        i, card: null, cell: 0, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), s: 1, sqx: 1, sqy: 1, glow: 0, dim: 0,
        vis: false, token: 0, fxToken: 0, jx: 0, jz: 0, jyaw: 0, held: false,
      };
      this.pool.push(o);
    }
    for (let i = POOL - 1; i >= 1; i--) this.free.push(this.pool[i]);
    this.deckTop = this.pool[0];
    // stamp + badge sprites
    this.stampCanvas = document.createElement('canvas');
    this.stampCanvas.width = this.stampCanvas.height = 128;
    this.stampTex = A.makeTexture(this.stampCanvas, false);
    this.stamp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.stampTex, depthTest: false, depthWrite: false, transparent: true }));
    this.stamp.renderOrder = 20;
    this.stamp.visible = false;
    this.badgeCanvas = document.createElement('canvas');
    this.badgeCanvas.width = 128;
    this.badgeCanvas.height = 72;
    this.badgeTex = A.makeTexture(this.badgeCanvas, false);
    this.badge = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.badgeTex, depthTest: false, depthWrite: false, transparent: true }));
    this.badge.renderOrder = 21;
    this.badge.visible = false;
    this.scene.add(this.stamp, this.badge);
    // particles
    this.dust = new Particles(300, { atten: true, shape: 'soft' });
    this.dust.gravity = -1.2;
    this.dust.drag = 3;
    this.dust.floorY = 0;
    this.confetti = new Particles(300, { atten: true, shape: 'confetti' });
    this.confetti.gravity = -4;
    this.confetti.drag = 1.6;
    this.confetti.wobble = 2;
    this.confetti.floorY = 0.01;
    this.confetti.killOnFloor = true;
    this.dust.points.renderOrder = 15;
    this.confetti.points.renderOrder = 16;
    this.scene.add(this.dust.points, this.confetti.points);
    // penalty window badge
    this.penCanvas = document.createElement('canvas');
    this.penCanvas.width = 128;
    this.penCanvas.height = 72;
    this.penTex = A.makeTexture(this.penCanvas, false);
    this.penBadge = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.penTex, depthTest: false, depthWrite: false, transparent: true }));
    this.penBadge.renderOrder = 22;
    this.penBadge.visible = false;
    // shield dome: a fresnel hemisphere, additive
    this.domeMat = new THREE.ShaderMaterial({
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      uniforms: { uColor: { value: new THREE.Color('#9fe6ff') }, uOpacity: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2), this.domeMat);
    this.dome.renderOrder = 18;
    this.dome.visible = false;
    // mirror flash
    this.flashTex = A.makeTexture(A.drawFlash(128), false);
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.flashTex, depthTest: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending }));
    this.flash.renderOrder = 23;
    this.flash.visible = false;
    // skip marks share one pre-drawn texture (256 px: the big one fills ~a third of a phone screen);
    // they draw over the additive flash, which glows behind them
    const sc = document.createElement('canvas');
    sc.width = sc.height = 256;
    drawSkipMark(sc.getContext('2d')!, 256);
    this.skipTex = A.makeTexture(sc, false);
    const skipMat = new THREE.SpriteMaterial({ map: this.skipTex, depthTest: false, depthWrite: false, transparent: true });
    for (let i = 0; i < 6; i++) {
      const sp = new THREE.Sprite(skipMat.clone());
      sp.renderOrder = 24;
      sp.visible = false;
      if (i === 0) this.skipBig = sp;
      else this.skipStamps.push(sp);
      this.scene.add(sp);
    }
    skipMat.dispose();
    // the "+N" penalty mark: its own canvas, redrawn only when the total changes
    this.penMarkCanvas = document.createElement('canvas');
    this.penMarkCanvas.width = this.penMarkCanvas.height = 256;
    this.penMarkTex = A.makeTexture(this.penMarkCanvas, false);
    this.penBig = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.penMarkTex, depthTest: false, depthWrite: false, transparent: true }));
    this.penBig.renderOrder = 24;
    this.penBig.visible = false;
    this.scene.add(this.penBig);
    this.scene.add(this.penBadge, this.dome, this.flash);
    this.scene.add(this.camera);
    void S;
  }

  private applyQualityKnobs(): void {
    const q = this.q;
    this.dust.limit = q.particles;
    this.confetti.limit = q.confetti;
    this.atlasTex.anisotropy = q.aniso;
    this.backTex.anisotropy = q.aniso;
    this.syncFelt(true);
  }

  private syncFelt(force = false): void {
    // a round table with no rim on a big floor plane that fades into the background
    const d = this.dims;
    const S = ARENA_SIZE;
    const R = this.portrait ? d.B + 0.4 : d.A + 0.4;
    const tints: A.FeltTint[] = [];
    if (this.teams) {
      this.teams.forEach((team, ti) => {
        for (const st of team) {
          if (!this.seats.includes(st)) continue;
          // the human's glow sits at their edge, the others' behind their fans
          const an = st === 0 ? { x: 0, z: d.B - 0.55 } : this.anchorOf(st);
          tints.push({ u: an.x / S + 0.5, v: an.z / S + 0.5, r: 1.5 / S, color: TEAM_TINT[ti] });
        }
      });
    }
    const px = Math.round(this.q.felt * 1.5);
    const key = `${this.tableStyle}:${R.toFixed(2)}:${px}:${tints.map((t) => t.color + t.u.toFixed(2) + t.v.toFixed(2)).join()}`;
    this.felt.scale.set(S, 1, S);
    if (!force && key === this.feltKey) return;
    this.feltKey = key;
    const c = A.drawArena(this.tableStyle, px, R / S, tints);
    const old = this.feltTex;
    this.feltTex = A.makeTexture(c, true);
    this.feltTex.anisotropy = this.q.aniso;
    const m = this.felt.material as THREE.MeshBasicMaterial;
    m.map = this.feltTex;
    m.needsUpdate = true;
    if (this.refl) (this.refl.material as THREE.ShaderMaterial).uniforms.uFelt.value = this.feltTex;
    old?.dispose();
    this.renderer.setClearColor(A.TABLE_STYLE_DEFS[this.tableStyle].bg, 1);
  }


  // ───────────────────────── layout ─────────────────────────

  private onResize = (): void => {
    if (this.disposed) return;
    const W = Math.max(1, this.container.clientWidth || window.innerWidth);
    const H = Math.max(1, this.container.clientHeight || window.innerHeight);
    if (W === this.W && H === this.H && this.fan.cw > 0 && this.feltKey) {
      return;
    }
    this.W = W;
    this.H = H;
    this.renderer.setSize(W, H, false);
    this.computeLayout();
    // idle: snap; mid-animation: retarget everything now (in-flight tweens of the old layout are dropped)
    if (this.busy === 0 && !this.anim.active) this.snapAll();
    else void this.settleAll(0.2);
    this.kick();
  };

  private computeLayout(): void {
    const W = this.W;
    const H = this.H;
    this.portrait = H > W * 1.05;
    this.dims = L.tableDims(this.portrait);
    this.fan = L.fanLayout(this.hands[0].length, { W, H });
    // deck and pile where the fan demo put them
    const tune = L.tableTune(this.portrait);
    this.deckPos.set(tune.deck.x, 0, tune.deck.z);
    this.deckYaw = THREE.MathUtils.degToRad(tune.deck.yaw);
    this.pilePos.set(tune.pile.x, 0, tune.pile.z);
    this.glowRing.position.set(this.pilePos.x, 0.003, this.pilePos.z);
    if (this.turnArrow) this.aimTurnArrow();
    const R = this.portrait ? Math.min(1.75, this.dims.A - 0.2) : 1.6;
    this.dirRing.scale.set(R * 2 * this.ringScaleSign(), 1, R * 2);
    // camera: the tilt, distance and fov tuned in the fan demo (pulled back on narrower screens)
    const cam = this.layoutCam;
    const tc = L.tableCamera(W, H, this.portrait);
    cam.fov = tc.fov;
    cam.aspect = W / H;
    cam.updateProjectionMatrix();
    const tilt = tc.tilt;

    const dir = new THREE.Vector3(0, Math.cos(tilt), Math.sin(tilt));
    const place = (dist: number, tz: number) => {
      cam.position.set(0, 0, tz).addScaledVector(dir, dist);
      cam.lookAt(0, 0, tz);
      cam.updateMatrixWorld(true);
      this.viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    };
    this.fitSig = this.fitSigNow();
    place(tc.dist, 0);
    this.syncFelt();
    this.camera.fov = cam.fov;
    this.camera.aspect = cam.aspect;
    this.camera.near = cam.near;
    this.camera.far = cam.far;
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(cam.position);
    this.camera.quaternion.copy(cam.quaternion);
    this.camera.updateMatrixWorld(true);
    // particles: sizes in world units
    const uScale = (H * this.pixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    this.dust.material.uniforms.uScale.value = uScale;
    this.confetti.material.uniforms.uScale.value = uScale;
    this.updateDeckVisual();
    this.platesDirty();
  }

  /** world units per CSS px at `depth` in front of the layout camera */
  private worldPerPx(depth: number): number {
    return (2 * depth * Math.tan(THREE.MathUtils.degToRad(this.layoutCam.fov) / 2)) / this.H;
  }

  /** the point `depth` in front of the layout camera under screen px (x, y) */
  private pxToWorld(x: number, y: number, depth: number, out: V3): V3 {
    const cam = this.layoutCam;
    tmpV.set((x / this.W) * 2 - 1, -((y / this.H) * 2 - 1), 0.5).unproject(cam).sub(cam.position).normalize();
    const fwd = tmpV2.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const t = depth / Math.max(1e-4, tmpV.dot(fwd));
    return out.copy(cam.position).addScaledVector(tmpV, t);
  }

  private toScreen(v: V3, out: { x: number; y: number }): void {
    L.projectCss(this.viewProj.elements, v.x, v.y, v.z, this.W, this.H, out);
  }

  // ───────────────────────── poses ─────────────────────────

  private liftPx(o: CardObj): number {
    const r = this.req;
    if (!r || !o.card) return 0;
    return r.playable.has(o.card.id) ? this.fan.ch * 0.17 : 0;
  }

  private focusMemo: { key: string; fan: L.FanLayout | null } = { key: '', fan: null };

  /**
   * The human fan with the tapped card in focus: that card rises a little and stands upright at the top of
   * the arc, and the others take the arc's places around it (the fan turns towards it). In a crowded hand
   * (more than HAND_FULL cards) its neighbours also step aside so the cards near it can be read.
   */
  private focusFan(): L.FanLayout {
    const f = this.fan;
    const n = f.slots.length;
    const pk = n === this.hands[0].length ? this.peekIdx(0) : -1;
    if (pk < 0 || n < 2) return f;
    const key = `${n}|${pk}|${f.cw}|${f.slots[0].x}|${f.slots[0].y}`;
    if (this.focusMemo.key === key && this.focusMemo.fan) return this.focusMemo.fan;
    const oneRow = f.slots.every((sl) => sl.row === f.slots[0].row);
    const mid = (n - 1) / 2;
    // y and turn of the arc at a fractional slot position, carried on past the ends
    const at = (t: number) => {
      const a = Math.max(0, Math.min(n - 2, Math.floor(t)));
      const k = t - a;
      const sa = f.slots[a];
      const sb = f.slots[a + 1];
      return { y: sa.y + (sb.y - sa.y) * k, rot: sa.rot + (sb.rot - sa.rot) * k };
    };
    const crowded = n > HAND_FULL;
    const pr = f.slots[pk].row;
    const slots = f.slots.map((sl, i) => {
      const d = i - pk;
      if (sl.row !== pr) return sl;
      const arc = oneRow ? at(mid + d) : { y: sl.y, rot: sl.rot };
      const fall = Math.max(0, 1 - (Math.abs(d) - 1) * 0.25);
      const dx = d === 0 ? 0 : Math.sign(d) * f.cw * (crowded ? 0.38 : 0.06) * fall;
      return { ...sl, x: sl.x + dx, y: arc.y - (d === 0 ? f.ch * 0.16 : 0), rot: d === 0 ? 0 : arc.rot };
    });
    const fan = { ...f, slots };
    this.focusMemo = { key, fan };
    return fan;
  }

  private handPose(seat: number, idx: number, n: number, out: Pose, o?: CardObj): Pose {
    if (seat === 0) {
      if (n !== this.fan.slots.length) this.fan = L.fanLayout(n, { W: this.W, H: this.H });
      // a tapped card turns the fan towards it (focusFan); otherwise the plain fan
      const f = n === this.hands[0].length ? this.focusFan() : this.fan;
      const sl = f.slots[Math.min(idx, f.slots.length - 1)];
      if (!sl) return this.deckTopPose(out);
      const depth = HAND_D - sl.z * 0.004;
      this.pxToWorld(sl.x, sl.y - (o ? this.liftPx(o) : 0), depth, out.pos);
      out.quat.copy(this.layoutCam.quaternion).multiply(tmpQ.setFromAxisAngle(tmpV.set(0, 0, 1), -sl.rot));
      out.s = (f.cw * this.worldPerPx(HAND_D)) / L.CARD_W;
      return out;
    }
    const f = this.handFor(seat, n);
    const p = f.poses[Math.min(idx, f.poses.length - 1)];
    if (!p) return this.deckTopPose(out);
    out.pos.set(p.x, p.y, p.z);
    out.s = f.s;
    // the tuned pose's full rotation (layout seatHand), else rotY(yaw) * rotX(lean) * rotZ(-roll)
    if (p.q) out.quat.set(p.q[0], p.q[1], p.q[2], p.q[3]);
    else out.quat.setFromAxisAngle(UP, p.yaw).multiply(tmpQ.setFromAxisAngle(AX_X, p.lean)).multiply(tmpQ2.setFromAxisAngle(AX_Z, -p.roll));
    if (!this.openCards[seat]) return out;
    const pk = n === this.hands[seat].length ? this.peekIdx(seat) : -1;
    if (pk >= 0 && f.poses.length > 1) {
      if (idx === pk) {
        // the peeked card only slides up out of the fan, along its own up direction: same turn, same size
        tmpV.set(0, 1, 0).applyQuaternion(out.quat);
        out.pos.addScaledVector(tmpV, L.CARD_H * f.s * 0.15);
      } else {
        // every card on each side slides the same small step, so neighbours keep their spacing and never cross
        const a = f.poses[Math.max(0, pk - 1)];
        const b = f.poses[Math.min(f.poses.length - 1, pk + 1)];
        const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        if (len > 1e-4) {
          const k = (Math.sign(idx - pk) * L.CARD_W * f.s * 0.12) / len;
          out.pos.x += (b.x - a.x) * k;
          out.pos.y += (b.y - a.y) * k;
          out.pos.z += (b.z - a.z) * k;
        }
      }
    }
    return out;
  }

  private handMemo: { key: string; hand: L.SeatHand | null }[] = [0, 1, 2, 3, 4, 5].map(() => ({ key: '', hand: null }));

  /** a seat's hand with n cards (layout seatHand), memoised per layout */
  private handFor(seat: number, n: number): L.SeatHand {
    const side = this.sideOf(seat);
    const open = !!this.openCards[seat];
    const m = this.handMemo[seat];
    const key = `${side}:${n}:${+open}:${this.dims.A.toFixed(3)}:${this.dims.B.toFixed(3)}:${+this.portrait}`;
    if (m.key !== key || !m.hand) {
      m.key = key;
      m.hand = L.seatHand(n, side, open, this.dims, this.portrait);
    }
    return m.hand;
  }

  /** the seats whose open (bigger) hand the camera framing makes room for: the human's partner, open hands */
  private openable(seat: number): boolean {
    return !!this.openCards[seat] || !!this.teams?.find((t) => t.includes(0))?.includes(seat as Seat);
  }
  private fitSig = '';
  private fitSigNow(): string {
    return this.seats.map((s) => `${s}${this.sideOf(s)}${+this.openable(s)}`).join(',');
  }
  /** the hands the camera was framed for changed (teams, an open hand): frame again; true when it did */
  private refit(): boolean {
    if (this.W <= 1 || this.fitSig === this.fitSigNow()) return false;
    this.computeLayout();
    return true;
  }

  private isOpen(seat: number): boolean {
    return seat !== 0 && !!this.openCards[seat];
  }

  // ───── seat arrangement (Parejas side seating puts the partner in a lower corner) ─────

  private sides: Record<number, L.SeatSide> = { ...L.SEAT_SIDE };

  private sideOf(seat: number): L.SeatSide {
    return this.sides[seat] ?? L.SEAT_SIDE[seat];
  }

  private partnerSeat(): number {
    for (const s of this.seats) {
      const sd = this.sides[s];
      if (sd === 'lowerLeft' || sd === 'lowerRight') return s;
    }
    return -1;
  }

  /** recompute the seat sides from seats + teams; true when they changed */
  private updateArrangement(): boolean {
    const next = L.seatSides(this.seats, this.teams);
    const changed = this.seats.some((s) => next[s] !== this.sides[s]);
    this.sides = next;
    if (changed) {
      this.sideMode = this.partnerSeat() >= 0;
      if (this.W > 1) this.computeLayout();
      this.dirRing.scale.x = Math.abs(this.dirRing.scale.x) * this.ringScaleSign();
    }
    return changed;
  }

  /** where a seat's cards sit on the table (the partner corner uses its real fan centre) */
  private anchorOf(seat: number): L.Anchor {
    const side = this.sideOf(seat);
    if (side !== 'bottom' && this.W > 1) {
      // effects at a seat: the felt under the middle of its row
      const f = this.handFor(seat, Math.max(1, this.hands[seat].length));
      return { x: f.cx, z: f.cz, yaw: 0 };
    }
    return L.seatAnchor(side, this.dims);
  }

  /** direction ring x sign so its chevrons follow play on screen */
  private ringScaleSign(direction: Direction = this.direction): number {
    const pts = this.seats.map((s) => L.seatAnchor(this.sideOf(s), this.dims));
    return L.ringSign(L.turnSpin(pts), direction);
  }

  /** Codo a codo (the partner on a side edge): a lower, more cinematic camera */
  private sideMode = false;
  // ───── card peek ─────

  private peek: { seat: number; o: CardObj } | null = null;

  private peekIdx(seat: number): number {
    const p = this.peek;
    if (!p || p.seat !== seat) return -1;
    return this.hands[seat].indexOf(p.o);
  }

  private setPeek(seat: number, o: CardObj | null): void {
    const prev = this.peek;
    if ((prev?.o ?? null) === o && (!o || prev?.seat === seat)) return;
    this.peek = o ? { seat, o } : null;
    const dur = this.reduced ? 0 : 0.12;
    if (prev && prev.seat !== seat) void this.relayout(prev.seat, dur);
    if (o || prev) void this.relayout(o ? seat : prev!.seat, dur);
    this.kick();
  }

  private deckH(): number {
    // a full deck (about 108 cards) stands 0.25 high, as in the fan demo
    return this.deckCount > 0 ? Math.min(DECK_MAX_H, 0.012 + this.deckCount * ((DECK_MAX_H - 0.012) / 108)) : 0;
  }
  private pileH(): number {
    const under = Math.max(0, this.discardCount - this.pile.length);
    return under > 0 ? Math.min(0.2, under * 0.0028) : 0;
  }

  private deckTopPose(out: Pose): Pose {
    out.pos.set(this.deckPos.x, this.deckH() + 0.004, this.deckPos.z);
    faceDownQ(this.deckYaw, out.quat);
    out.s = 1;
    return out;
  }

  private pilePose(k: number, o: CardObj, out: Pose): Pose {
    out.pos.set(this.pilePos.x + o.jx, this.pileH() + 0.008 + k * 0.0045, this.pilePos.z + o.jz);
    faceUpQ(o.jyaw, out.quat);
    out.s = 1;
    return out;
  }

  /** a world point for effects at a seat (seat 0: just above the hand) */
  private seatPoint(seat: number, out: V3): V3 {
    if (seat === 0) return this.pxToWorld(this.W / 2, this.fan.top + this.fan.ch * 0.25, HAND_D * 1.6, out);
    const a = this.anchorOf(seat);
    return out.set(a.x, 0.25, a.z);
  }

  private updateDeckVisual(): void {
    const h = this.deckH();
    this.deckBox.visible = h > 0.002;
    fitStack(this.deckBox, h);
    this.deckBox.position.set(this.deckPos.x, 0, this.deckPos.z);
    this.deckBox.rotation.y = this.deckYaw;
    // its reflection: the same stack mirrored below the felt
    this.deckRefl.visible = this.deckBox.visible;
    this.deckRefl.position.copy(this.deckBox.position);
    this.deckRefl.rotation.copy(this.deckBox.rotation);
    this.deckRefl.scale.set(this.deckBox.scale.x, -this.deckBox.scale.y, this.deckBox.scale.z);
    const ph = this.pileH();
    this.pileBox.visible = ph > 0.002;
    fitStack(this.pileBox, ph);
    this.pileBox.position.set(this.pilePos.x, 0, this.pilePos.z);
    const top = this.deckTop;
    top.vis = this.deckCount > 0;
    if (top.token === 0 || !this.anim.active) {
      const p = this.deckTopPose(this.scratch);
      top.pos.copy(p.pos);
      top.quat.copy(p.quat);
      top.s = 1;
    } else top.pos.y = h + 0.004;
  }
  private scratch = newPose();

  private setDeckCount(n: number): void {
    this.deckCount = Math.max(0, n);
    this.updateDeckVisual();
  }

  // ───────────────────────── card objects ─────────────────────────

  private alloc(): CardObj | null {
    const o = this.free.pop();
    if (!o) return null;
    o.card = null;
    o.cell = 0;
    o.s = 1;
    o.sqx = o.sqy = 1;
    o.glow = o.dim = 0;
    o.vis = false;
    o.held = false;
    o.token++;
    o.fxToken++;
    o.jx = o.jz = o.jyaw = 0;
    return o;
  }

  private release(o: CardObj): void {
    if (o === this.deckTop) return;
    o.vis = false;
    o.card = null;
    o.held = false;
    o.token++;
    o.fxToken++;
    if (!this.free.includes(o)) this.free.push(o);
  }

  /** `chosen`: the colour picked for a played wild-type card (the pile shows it as the card's field) */
  private setFace(o: CardObj, card: Card | null, chosen?: Color | null): void {
    o.card = card;
    if (!card) return;
    this.faces.set(card.id, card.face);
    const face = A.playedFace(card.face, chosen);
    const r = this.faceMap.index(face);
    if (r.added) {
      A.drawCell(this.atlasCanvas.canvas.getContext('2d')!, this.atlasCanvas.size, r.i, face);
      this.atlasTex.needsUpdate = true;
    }
    o.cell = r.i;
  }

  private remember(card: Card | undefined | null): void {
    if (card) this.faces.set(card.id, card.face);
  }

  private clearTable(): void {
    for (const o of this.pool) if (o !== this.deckTop) this.release(o);
    this.free.length = 0;
    for (let i = POOL - 1; i >= 1; i--) this.free.push(this.pool[i]);
    for (const h of this.hands) h.length = 0;
    this.pile.length = 0;
    this.preview = null;
    this.deckTop.token++;
    this.deckTop.glow = 0;
    this.discardCount = 0;
    this.stackTotal = 0;
    this.badge.visible = false;
    this.stamp.visible = false;
    this.winner = null;
    this.eliminated.fill(false);
    this.plateScale.fill(1);
    this.plateShake.fill(0);
    this.peek = null;
    this.openCards.fill(null);

    this.openSig.fill('');
    this.penTok++;
    this.penBadge.visible = false;
    this.penSeat = null;
    this.windowVictim = null;
    this.domeTok++;
    this.dome.visible = false;
    this.flash.visible = false;
    for (const sp of this.skipStamps) sp.visible = false;
    this.skipBig.visible = false;
    this.skipTok++;
    this.winTok++;
    this.penBig.visible = false;
    this.penMarkTok++;
    this.penMarkTotal = 0;
    this.penMarkPop = null;
    this.lastPlayKind = '';
    this.lastPlayDraw = 0;
    this.streamDraw = false;
    this.skipAllDone.clear();
    this.dust.clear();
    this.confetti.clear();
  }

  private fly(o: CardObj, to: Pose, opt: FlyOpts = {}): Promise<void> {
    const tok = ++o.token;
    const p1 = to.pos.clone();
    const q1 = to.quat.clone();
    const s1 = to.s;
    const p0 = new THREE.Vector3();
    const q0 = new THREE.Quaternion();
    let s0 = 1;
    const arc = opt.arc ?? 0;
    const spin = this.reduced ? 0 : opt.spin ?? 0;
    return this.anim.tween(
      opt.dur ?? 0.35,
      (k, raw) => {
        if (o.token !== tok) return;
        o.pos.lerpVectors(p0, p1, k);
        if (arc) o.pos.y += Math.sin(Math.PI * raw) * arc;
        o.quat.slerpQuaternions(q0, q1, k);
        if (spin) o.quat.premultiply(tmpQ.setFromAxisAngle(UP, spin * (1 - k)));
        o.s = lerp(s0, s1, k);
      },
      opt.ease ?? ease.outCubic,
      opt.delay ?? 0,
      () => {
        p0.copy(o.pos);
        q0.copy(o.quat);
        s0 = o.s;
        o.vis = true;
        opt.onStart?.();
      },
    );
  }

  private snap(o: CardObj, p: Pose): void {
    o.token++;
    o.pos.copy(p.pos);
    o.quat.copy(p.quat);
    o.s = p.s;
    o.vis = true;
  }

  private tweenFx(o: CardObj, glow: number, dim: number, dur = 0.15): void {
    const tok = ++o.fxToken;
    const g0 = o.glow;
    const d0 = o.dim;
    if (g0 === glow && d0 === dim) return;
    void this.anim.tween(dur, (k) => {
      if (o.fxToken !== tok) return;
      o.glow = lerp(g0, glow, k);
      o.dim = lerp(d0, dim, k);
    });
  }

  private relayout(seat: number, dur: number, opt: FlyOpts = {}): Promise<void> {
    const h = this.hands[seat];
    if (!h) return Promise.resolve();
    const n = h.length;
    if (seat === 0) {
      this.fan = L.fanLayout(n, { W: this.W, H: this.H });
      // the human hand grew a row: the partner corner moves up with it
    }
    const jobs: Promise<void>[] = [];
    const pose = newPose();
    for (let i = 0; i < n; i++) {
      const o = h[i];
      if (o.held) continue;
      this.handPose(seat, i, n, pose, o);
      if (dur <= 0) this.snap(o, pose);
      else jobs.push(this.fly(o, pose, { dur, ...opt, delay: (opt.delay ?? 0) }));
    }
    this.platesDirty();
    return Promise.all(jobs).then(() => undefined);
  }

  private relayoutPile(dur: number): Promise<void> {
    const jobs: Promise<void>[] = [];
    const pose = newPose();
    this.pile.forEach((o, k) => {
      this.pilePose(k, o, pose);
      if (dur <= 0) this.snap(o, pose);
      else jobs.push(this.fly(o, pose, { dur }));
    });
    return Promise.all(jobs).then(() => undefined);
  }

  private snapAll(): void {
    for (const s of this.seats) void this.relayout(s, 0);
    void this.relayoutPile(0);
    this.updateDeckVisual();
    this.platesDirty();
  }

  private settleAll(dur: number): Promise<void> {
    const jobs: Promise<void>[] = this.seats.map((s) => this.relayout(s, dur));
    jobs.push(this.relayoutPile(dur));
    this.updateDeckVisual();
    return Promise.all(jobs).then(() => undefined);
  }

  /** insert a known card into a face-up hand (the human's or an open one) at its sorted position */
  private insertSorted(o: CardObj, seat = 0): void {
    const h = this.hands[seat];
    if (!o.card) {
      h.push(o);
      return;
    }
    let i = 0;
    while (i < h.length && h[i].card && L.cardOrder(h[i].card!, o.card) <= 0) i++;
    h.splice(i, 0, o);
  }

  /**
   * How a card lies on the pile. Thrown by a player, it lands pointing the way it was thrown (from the
   * right it points left, from the left right, from the top down, yours up) give or take a little, and
   * slides a touch past the middle; without a thrower, a small random turn.
   */
  private pileJitter(o: CardObj, seat: number | null = null): void {
    if (seat === null || this.W <= 1) {
      o.jx = (Math.random() - 0.5) * 0.12;
      o.jz = (Math.random() - 0.5) * 0.12;
      o.jyaw = (Math.random() - 0.5) * 0.5;
      return;
    }
    const a = seat === 0 ? L.seatAnchor('bottom', this.dims) : this.anchorOf(seat);
    const yaw = Math.atan2(a.x - this.pilePos.x, a.z - this.pilePos.z);
    // along the throw (away from the thrower) a little, and a little to either side
    const along = 0.02 + Math.random() * 0.07;
    const across = (Math.random() - 0.5) * 0.08;
    const sx = Math.sin(yaw);
    const cz = Math.cos(yaw);
    o.jx = -sx * along + cz * across;
    o.jz = -cz * along - sx * across;
    o.jyaw = yaw + (Math.random() - 0.5) * 0.6;
  }

  /** keep only the top PILE_KEEP card meshes; older ones become pile height */
  private trimPile(): void {
    while (this.pile.length > PILE_KEEP) this.release(this.pile.shift()!);
    this.updateDeckVisual();
  }

  // ───────────────────────── effects ─────────────────────────

  private sfx(n: SfxName): void {
    try {
      this.opts.onSfx?.(n);
    } catch {
      /* ignore */
    }
  }

  private sfxAt(n: SfxName, delay: number): void {
    if (delay <= 0) return this.sfx(n);
    void this.anim.tween(1e-4, () => {}, ease.linear, delay, () => this.sfx(n));
  }

  private puff(p: V3, n: number, col: [number, number, number] = [1, 0.96, 0.88]): void {
    const cnt = this.reduced ? Math.ceil(n / 2) : n;
    for (let i = 0; i < cnt; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.6 + Math.random() * 0.9;
      this.dust.spawn(p.x + Math.cos(a) * 0.3, p.y + 0.03, p.z + Math.sin(a) * 0.4, Math.cos(a) * sp, 0.3 + Math.random() * 0.5, Math.sin(a) * sp, col[0], col[1], col[2], 0.09 + Math.random() * 0.06, 0.35 + Math.random() * 0.2);
    }
  }

  private confettiBurst(p: V3, n: number, power = 1): void {
    const cnt = Math.round((this.reduced ? 0.35 : 1) * n);
    for (let i = 0; i < cnt; i++) {
      const c = CONFETTI[i % CONFETTI.length];
      const a = Math.random() * Math.PI * 2;
      const sp = (0.8 + Math.random() * 2.2) * power;
      this.confetti.spawn(p.x, p.y + 0.1, p.z, Math.cos(a) * sp, (2.5 + Math.random() * 2.5) * power, Math.sin(a) * sp, c[0], c[1], c[2], 0.1 + Math.random() * 0.06, 1.2 + Math.random() * 0.8, (Math.random() - 0.5) * 16);
    }
  }

  // ───── power effects: the pile ring (glowRing), the flash sprite and dust; no extra meshes ─────

  private fxP = new THREE.Vector3();
  private fxQ = new THREE.Vector3();
  private fxC = new THREE.Color();
  private ringTok = 0;
  private flashTok = 0;
  /** the reverse flourish drives the direction arrows itself */
  private dirFx = false;
  private dirTok = 0;
  /** the human card dropped by drag (it is already out of the fan) */
  private dropped: CardObj | null = null;
  /** the human's colour-changing card already on the pile (previewPlay) while the colour is being picked */
  private preview: { o: CardObj; id: number } | null = null;

  /** the colour in play (white when none), brightened a little */
  private fxColor(out = this.fxC, white = 0.25): THREE.Color {
    out.copy(this.activeColor ? COLOR_LIN[this.activeColor] : FX_WHITE);
    return out.lerp(FX_WHITE, white);
  }

  /** the ring round the pile scales s0 → s1 (×2.1 units) and fades in and out */
  private pileRing(col: THREE.Color, s0: number, s1: number, dur: number, peak = 0.9, e: (t: number) => number = ease.outCubic): Promise<void> {
    const r = this.glowRing;
    const m = r.material as THREE.MeshBasicMaterial;
    const tok = ++this.ringTok;
    m.color.copy(col);
    r.visible = true;
    const red = this.reduced;
    return this.anim.tween(red ? 0.25 : dur, (k, raw) => {
      if (tok !== this.ringTok) return;
      r.scale.setScalar(red ? s1 : lerp(s0, s1, k));
      m.opacity = peak * (red ? Math.sin(Math.PI * raw) : Math.min(1, raw * 6) * (1 - raw * raw));
      if (raw >= 1) r.visible = false;
    }, red ? ease.linear : e);
  }

  /** the additive flash sprite blooms at p (world size) and fades */
  private flashAt(p: V3, size: number, col: THREE.Color, dur = 0.35): void {
    const f = this.flash;
    const fm = f.material;
    const tok = ++this.flashTok;
    f.position.copy(p);
    fm.color.copy(col);
    f.visible = true;
    void this.anim.tween(dur, (k) => {
      if (tok !== this.flashTok) return;
      fm.opacity = 1 - k;
      f.scale.setScalar(size * (this.reduced ? 1 : lerp(0.4, 1.4, k)));
      fm.rotation = k * 0.6;
      if (k >= 1) f.visible = false;
    }, ease.outQuad);
  }

  /** a sparkle comet along a quadratic arc a → b bending through c (a dust trail; nothing allocated per frame) */
  private comet(a: V3, c: V3, b: V3, col: THREE.Color, dur: number, delay = 0, e: (t: number) => number = ease.inOutQuad): Promise<void> {
    if (this.reduced) return Promise.resolve();
    const ax = a.x, ay = a.y, az = a.z, cx = c.x, cy = c.y, cz = c.z, bx = b.x, by = b.y, bz = b.z;
    const cr = col.r, cg = col.g, cb = col.b;
    const rate = this.quality === 'low' ? 1 : 2;
    return this.anim.tween(dur, (k) => {
      const u = 1 - k;
      const x = u * u * ax + 2 * u * k * cx + k * k * bx;
      const y = u * u * ay + 2 * u * k * cy + k * k * by;
      const z = u * u * az + 2 * u * k * cz + k * k * bz;
      for (let i = 0; i < rate; i++) {
        const j = Math.random();
        this.dust.spawn(x + (j - 0.5) * 0.06, y, z + (Math.random() - 0.5) * 0.06, (j - 0.5) * 0.4, 0.15 + j * 0.3, (Math.random() - 0.5) * 0.4, cr, cg, cb, 0.07 + j * 0.06, 0.3 + j * 0.25);
      }
    }, e, delay);
  }

  /** dust thrown out of a flat ring round p (radius r0), tinted */
  private sparkRing(p: V3, r0: number, n: number, col: THREE.Color, speed = 1.6, up = 0.5): void {
    const cnt = Math.round(n * (this.reduced ? 0.4 : 1) * (this.quality === 'low' ? 0.5 : 1));
    for (let i = 0; i < cnt; i++) {
      const a = (i / cnt) * Math.PI * 2 + Math.random() * 0.3;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const sp = speed * (0.7 + Math.random() * 0.6);
      this.dust.spawn(p.x + c * r0, p.y + 0.04, p.z + s * r0, c * sp, up * (0.5 + Math.random()), s * sp, col.r, col.g, col.b, 0.08 + Math.random() * 0.05, 0.45 + Math.random() * 0.25);
    }
  }

  /** a point high over the pile, for arcs */
  private overPile(out: V3, y = 0.25): V3 {
    return out.set(this.pilePos.x, y, this.pilePos.z);
  }

  /**
   * skip / Salto total: a big "no entry" mark in the colour in play pops over the table centre, holds, then
   * small marks split off it and fly (shrinking) to each skipped seat, which shakes as its mark lands.
   * `big = false` (a seat Salto total missed) skips the pop: one small mark flies from the centre.
   */
  private async skipMark(seats: number[], big = true): Promise<void> {
    if (!seats.length) return;
    const tok = ++this.skipTok;
    const red = this.reduced;
    const low = this.quality === 'low';
    const col = this.fxColor(new THREE.Color(), 0.12);
    const c = this.overPile(new THREE.Vector3(), 0.5);
    const bigS = this.bigMarkSize(c);
    const smallPx = Math.min(SKIP_SMALL_PX[1], Math.max(SKIP_SMALL_PX[0], Math.min(this.W, this.H) * 0.15));
    this.sfx('pass');
    if (big) {
      void this.pileRing(col, 1.6, 0.45, 0.24, 1, ease.inCubic);
      const sp = this.skipBig;
      const m = sp.material;
      m.color.copy(col);
      m.opacity = 0;
      m.rotation = 0;
      sp.position.copy(c);
      sp.scale.setScalar(bigS * (red ? 1 : 0.3));
      sp.visible = true;
      this.flashAt(c, bigS * 1.7, col, red ? 0.3 : 0.55);
      await this.anim.tween(red ? 0.14 : 0.3, (k, raw) => {
        if (tok !== this.skipTok) return;
        m.opacity = Math.min(1, raw * 2.5);
        sp.scale.setScalar(bigS * (red ? 1 : lerp(0.3, 1, k)));
        m.rotation = red ? 0 : (1 - k) * -0.7;
      }, red ? ease.linear : ease.outBack);
      // hold, breathing a little
      await this.anim.tween(red ? 0.4 : 0.32, (_k, raw) => {
        if (tok !== this.skipTok) return;
        if (!red) sp.scale.setScalar(bigS * (1 + 0.04 * Math.sin(raw * Math.PI)));
      }, ease.linear);
      if (tok !== this.skipTok) return;
      if (red) {
        // reduced motion: the mark fades where it is; the seats just get a nudge
        for (const s of seats) void this.shakeSeat(s as Seat, 0.03);
        await this.anim.tween(0.2, (k) => {
          if (tok !== this.skipTok) return;
          m.opacity = 1 - k;
          if (k >= 1) sp.visible = false;
        });
        return;
      }
      sp.visible = false;
    }
    // the small marks fly from the centre to each seat (they start as the big mark, so it seems to split)
    const s0 = big ? bigS : bigS * 0.45;
    const fly = red ? 0.2 : 0.4;
    const gap = 0.06;
    const n = Math.min(seats.length, this.skipStamps.length);
    const lands: Promise<void>[] = [];
    for (let i = 0; i < n; i++) {
      const seat = seats[i];
      const sp = this.skipStamps[i];
      const m = sp.material;
      const to = this.platePoint(seat, new THREE.Vector3(), 6);
      const s1 = this.worldPerPx(to.distanceTo(this.layoutCam.position)) * smallPx;
      const ax = c.x, ay = c.y, az = c.z, bx = to.x, by = to.y, bz = to.z;
      const mx = (ax + bx) / 2, my = Math.max(ay, by) + 0.5, mz = (az + bz) / 2;
      const spin = (i % 2 ? 1 : -1) * 0.5;
      m.color.copy(col);
      m.opacity = big ? 1 : 0;
      m.rotation = 0;
      sp.position.copy(c);
      sp.scale.setScalar(s0);
      sp.visible = true;
      lands.push(
        this.anim
          .tween(fly, (k, raw) => {
            if (tok !== this.skipTok) return;
            const u = 1 - k;
            sp.position.set(u * u * ax + 2 * u * k * mx + k * k * bx, u * u * ay + 2 * u * k * my + k * k * by, u * u * az + 2 * u * k * mz + k * k * bz);
            sp.scale.setScalar(lerp(s0, s1, ease.outCubic(raw)));
            m.rotation = spin * Math.sin(Math.PI * raw);
            if (!big) m.opacity = Math.min(1, raw * 4);
          }, ease.inOutCubic, i * gap)
          .then(() => {
            if (tok !== this.skipTok) return;
            void this.shakeSeat(seat as Seat, 0.05);
            if (!low) this.sparkRing(to, 0.05, 10, col, 0.8, 0.6);
            // a little landing pop, then it fades
            return this.anim.tween(0.42, (_k, raw) => {
              if (tok !== this.skipTok) return;
              sp.scale.setScalar(s1 * (1 + 0.18 * Math.sin(Math.PI * Math.min(1, raw * 2.5))));
              m.opacity = raw < 0.55 ? 1 : 1 - (raw - 0.55) / 0.45;
              if (raw >= 1) sp.visible = false;
            }, ease.linear);
          }),
      );
    }
    // the next event may start once the marks have landed (the fades run on)
    await this.anim.wait(fly + (n - 1) * gap + 0.05);
    void Promise.all(lands);
  }

  /** a +N play: a shockwave ring, a bloom and sparks bursting up off the pile */
  private fxDraw(pen: number): void {
    const col = this.fxColor(this.fxC, 0.15);
    void this.pileRing(col, 0.5, 2.3, 0.5, 1, ease.outCubic);
    const p = this.overPile(this.fxP, 0.12);
    this.flashAt(p, 1 + Math.min(10, pen) * 0.12, col, 0.4);
    if (this.reduced) return;
    this.sparkRing(p, 0.25, 10 + Math.min(10, pen) * 3, col, 1.4 + pen * 0.08, 2.2);
  }

  /** the big centre marks' size (world units) at c */
  private bigMarkSize(c: V3): number {
    return this.worldPerPx(c.distanceTo(this.layoutCam.position)) * Math.min(SKIP_BIG_PX[1], Math.max(SKIP_BIG_PX[0], Math.min(this.W, this.H) * 0.46));
  }

  /**
   * +N: the big penalty mark pops over the table centre in the colour in play and waits there for its victim
   * (penMarkFly). A stacked penalty bumps the same mark with the grown total. Resolves after the pop and a hold.
   */
  private penMarkUp(total: number): Promise<void> {
    const sp = this.penBig;
    if (total <= 0) return Promise.resolve();
    if (sp.visible && total === this.penMarkTotal) return this.penMarkPop ?? Promise.resolve();
    const tok = ++this.penMarkTok;
    const red = this.reduced;
    const grow = sp.visible && this.penMarkTotal > 0;
    drawPenMark(this.penMarkCanvas.getContext('2d')!, 256, `+${total}`);
    this.penMarkTex.needsUpdate = true;
    this.penMarkTotal = total;
    const m = sp.material;
    m.color.copy(this.fxColor(this.fxC, 0.12));
    const c = this.overPile(sp.position, 0.5);
    const S = this.bigMarkSize(c);
    this.flashAt(c, S * (grow ? 1.4 : 1.7), m.color, red ? 0.3 : 0.5);
    if (!grow) {
      m.opacity = 0;
      sp.scale.setScalar(S * (red ? 1 : 0.3));
    }
    sp.visible = true;
    const run = async () => {
      // a fresh mark pops and turns in; a stacked one thumps up with its new total
      await this.anim.tween(red ? 0.14 : grow ? 0.26 : 0.3, (k, raw) => {
        if (tok !== this.penMarkTok) return;
        m.opacity = grow ? 1 : Math.min(1, raw * 2.5);
        sp.scale.setScalar(S * (red ? 1 : grow ? lerp(1.3, 1, k) : lerp(0.3, 1, k)));
        m.rotation = red || grow ? 0 : (1 - k) * 0.7;
      }, red ? ease.linear : ease.outBack);
      await this.anim.tween(red ? 0.4 : 0.3, (_k, raw) => {
        if (tok !== this.penMarkTok) return;
        if (!red) sp.scale.setScalar(S * (1 + 0.04 * Math.sin(raw * Math.PI)));
      }, ease.linear);
    };
    const p = run();
    this.penMarkPop = p;
    return p;
  }

  /** the waiting +N mark shrinks and flies to the seat that must draw, landing where its plate badge shows */
  private async penMarkFly(seat: Seat): Promise<void> {
    if (!this.penMarkTotal) return;
    if (this.penMarkPop) await this.penMarkPop;
    const sp = this.penBig;
    if (!this.penMarkTotal || !sp.visible) return;
    const tok = ++this.penMarkTok;
    this.penMarkPop = null;
    this.penMarkTotal = 0;
    const m = sp.material;
    // the stack counter by the pile keeps the total while the victim decides
    if (this.stackTotal > 0) this.showBadge(this.stackTotal, false);
    if (this.reduced) {
      await this.anim.tween(0.2, (k) => {
        if (tok !== this.penMarkTok) return;
        m.opacity = 1 - k;
        if (k >= 1) sp.visible = false;
      });
      return;
    }
    const to = this.platePoint(seat, new THREE.Vector3(), 26);
    const s0 = sp.scale.x;
    const s1 = this.penSize(to) * 0.95;
    const ax = sp.position.x, ay = sp.position.y, az = sp.position.z, bx = to.x, by = to.y, bz = to.z;
    const mx = (ax + bx) / 2, my = Math.max(ay, by) + 0.5, mz = (az + bz) / 2;
    if (this.quality !== 'low') void this.comet(sp.position, this.fxQ.set(mx, my, mz), to, m.color, 0.4, 0.02, ease.inOutCubic);
    this.sfx('charge');
    await this.anim.tween(0.4, (k, raw) => {
      if (tok !== this.penMarkTok) return;
      const u = 1 - k;
      sp.position.set(u * u * ax + 2 * u * k * mx + k * k * bx, u * u * ay + 2 * u * k * my + k * k * by, u * u * az + 2 * u * k * mz + k * k * bz);
      sp.scale.setScalar(lerp(s0, s1, ease.outCubic(raw)));
      m.rotation = 0.35 * Math.sin(Math.PI * raw);
    }, ease.inOutCubic);
    if (tok !== this.penMarkTok) return;
    void this.shakeSeat(seat, 0.05);
    if (this.quality !== 'low') this.sparkRing(to, 0.05, 12, m.color, 0.9, 0.6);
    // land with a thump, then fade (the plate badge, if a response window opens, takes over here)
    void this.anim.tween(0.36, (_k, raw) => {
      if (tok !== this.penMarkTok) return;
      sp.scale.setScalar(s1 * (1 + 0.2 * Math.sin(Math.PI * Math.min(1, raw * 2.5))));
      m.opacity = raw < 0.45 ? 1 : 1 - (raw - 0.45) / 0.55;
      if (raw >= 1) sp.visible = false;
    }, ease.linear);
    await this.anim.wait(0.1);
  }

  /** the penalty is gone (shield, round over): a waiting +N mark fades where it is */
  private penMarkOff(): void {
    const sp = this.penBig;
    if (!this.penMarkTotal) return;
    const tok = ++this.penMarkTok;
    this.penMarkPop = null;
    this.penMarkTotal = 0;
    const m = sp.material;
    const o0 = m.opacity;
    void this.anim.tween(0.2, (k) => {
      if (tok !== this.penMarkTok) return;
      m.opacity = o0 * (1 - k);
      if (k >= 1) sp.visible = false;
    });
  }

  /** a wild colour pick (and "draw until the colour"): a two-armed swirl in the new colour */
  private fxSwirl(big: boolean): void {
    const col = this.fxColor(this.fxC, 0.2);
    void this.pileRing(col, 0.6, big ? 2 : 1.6, big ? 0.7 : 0.5, 0.85, ease.outQuad);
    if (this.reduced) return;
    const px = this.pilePos.x, pz = this.pilePos.z;
    const cr = col.r, cg = col.g, cb = col.b;
    const turns = big ? 2 : 1.25;
    const rate = this.quality === 'low' ? 1 : 2;
    void this.anim.tween(big ? 0.75 : 0.55, (k) => {
      for (let arm = 0; arm < 2; arm++) {
        const a = k * turns * Math.PI * 2 + arm * Math.PI;
        const rr = lerp(0.15, big ? 1.5 : 1.2, k);
        const c = Math.cos(a), s = Math.sin(a);
        for (let i = 0; i < rate; i++) this.dust.spawn(px + c * rr, 0.08 + Math.random() * 0.05, pz + s * rr, -s * 1.2, 0.35 + Math.random() * 0.3, c * 1.2, cr, cg, cb, 0.08 + Math.random() * 0.05, 0.4 + Math.random() * 0.2);
      }
    }, ease.outQuad);
  }

  /** two seats trade: two comets cross over the pile, a bloom where they meet */
  private fxCross(a: Seat, b: Seat): void {
    const col = this.fxColor(this.fxC, 0.3);
    const pa = this.seatPoint(a, new THREE.Vector3());
    const pb = this.seatPoint(b, new THREE.Vector3());
    if (a !== 0) pa.y = 0.6;
    if (b !== 0) pb.y = 0.6;
    const side = new THREE.Vector3(pb.z - pa.z, 0, pa.x - pb.x).normalize();
    const c1 = this.overPile(new THREE.Vector3(), 1).addScaledVector(side, 0.9);
    const c2 = this.overPile(new THREE.Vector3(), 1).addScaledVector(side, -0.9);
    void this.comet(pa, c1, pb, col, 0.6);
    void this.comet(pb, c2, pa, col, 0.6);
    void this.pileRing(col, 0.8, 1.5, 0.5, 0.7);
    void this.anim.wait(this.reduced ? 0 : 0.3).then(() => this.flashAt(this.overPile(this.fxP, 0.7), 1.3, col, 0.35));
  }

  /** the hands go round: a comet from each live seat to the next, bending round the pile */
  private fxRotate(direction: Direction): void {
    const col = this.fxColor(this.fxC, 0.3);
    void this.pileRing(col, 1.6, 0.7, 0.6, 0.8, ease.inOutQuad);
    if (this.reduced) return;
    const live = this.seats.filter((s) => !this.eliminated[s]);
    const p = this.overPile(new THREE.Vector3());
    live.forEach((s, i) => {
      const t = live[(i + direction + live.length) % live.length];
      const pa = this.seatPoint(s, new THREE.Vector3());
      const pb = this.seatPoint(t, new THREE.Vector3());
      if (s !== 0) pa.y = 0.55;
      if (t !== 0) pb.y = 0.55;
      // bend outward, away from the pile, so the comets swirl round it
      const mid = new THREE.Vector3().lerpVectors(pa, pb, 0.5);
      mid.sub(p).setY(0).multiplyScalar(0.6).add(mid).setY(0.9);
      void this.comet(pa, mid, pb, col, 0.7, i * 0.04);
    });
  }

  /** a stamp pops over a seat (skip / shield / caught / out) */
  private async stampAt(seat: number, kind: A.StampKind, hold = 0.35): Promise<void> {
    A.drawStamp(this.stampCanvas.getContext('2d')!, 128, kind);
    this.stampTex.needsUpdate = true;
    const p = this.seatPoint(seat, new THREE.Vector3());
    if (seat !== 0) p.y = 0.6;
    this.stamp.position.copy(p);
    const dist = p.distanceTo(this.layoutCam.position);
    const size = this.worldPerPx(dist) * Math.min(96, Math.max(64, this.W * 0.16));
    const m = this.stamp.material;
    this.stamp.visible = true;
    await this.anim.tween(this.reduced ? 0.12 : 0.28, (k) => {
      this.stamp.scale.setScalar(size * (this.reduced ? 1 : lerp(2.2, 1, k)));
      m.opacity = k;
      m.rotation = this.reduced ? 0 : (1 - k) * 0.5;
    }, ease.outBack);
    await this.anim.wait(hold);
    await this.anim.tween(0.2, (k) => {
      m.opacity = 1 - k;
      this.stamp.scale.setScalar(size * (1 + 0.15 * k));
    });
    this.stamp.visible = false;
  }

  private shakeSeat(seat: number, amp = 0.06): Promise<void> {
    const h = this.hands[seat];
    const base = h.map((o) => o.pos.clone());
    const toks = h.map((o) => ++o.token);
    return this.anim.tween(0.4, (k, raw) => {
      const off = Math.sin(raw * Math.PI * 7) * amp * (1 - raw);
      h.forEach((o, i) => {
        if (o.token !== toks[i] || !base[i]) return;
        o.pos.copy(base[i]);
        if (seat === 0) o.pos.addScaledVector(tmpV.set(1, 0, 0).applyQuaternion(this.layoutCam.quaternion), off * 0.3);
        else o.pos.x += off;
      });
    });
  }

  /** the colour in play tints the direction arrows (no glow round the pile) */
  private setActiveColor(c: Color | null | undefined, instant = false): void {
    if (!c) return;
    const m = this.dirRing.material as THREE.MeshBasicMaterial;
    const to = COLOR_LIN[c];
    this.activeColor = c;
    this.glowRing.visible = false;
    if (instant) {
      m.color.copy(to);
      return;
    }
    const from = m.color.clone();
    void this.anim.tween(0.5, (k) => m.color.lerpColors(from, to, k), ease.outQuad);
  }

  private showBadge(total: number, pop = true): void {
    this.stackTotal = total;
    if (total <= 0) {
      this.badge.visible = false;
      this.penMarkOff();
      return;
    }
    A.drawBadge(this.badgeCanvas.getContext('2d')!, 128, 72, `+${total}`);
    this.badgeTex.needsUpdate = true;
    const p = tmpV.set((this.deckPos.x + this.pilePos.x) / 2, 0.45, this.pilePos.z - 0.8);
    this.badge.position.copy(p);
    const k0 = this.worldPerPx(p.distanceTo(this.layoutCam.position));
    const w = Math.max(56, Math.min(84, this.W * 0.16)) * k0;
    this.badge.visible = true;
    if (!pop) {
      this.badge.scale.set(w, w * 0.5625, 1);
      return;
    }
    // the count bursts up off the pile into its place
    const x1 = p.x, y1 = p.y, z1 = p.z;
    const x0 = this.pilePos.x, z0 = this.pilePos.z;
    void this.anim.tween(this.reduced ? 0.1 : 0.4, (k) => {
      const s = this.reduced ? 1 : lerp(0.3, 1, k);
      this.badge.scale.set(w * s, w * 0.5625 * s, 1);
      if (!this.reduced) this.badge.position.set(lerp(x0, x1, k), lerp(0.1, y1, k), lerp(z0, z1, k));
    }, ease.outBack);
  }

  // ───────────────────────── events ─────────────────────────

  handle(event: GameEvent): Promise<void> {
    const g = this.gen;
    const run = async () => {
      if (this.disposed || g !== this.gen) return;
      this.busy++;
      try {
        await this.doHandle(event, g);
      } catch (e) {
        console.error('[render] event failed', event.type, e);
      } finally {
        this.busy--;
      }
      if (this.needsSettle && !this.disposed && g === this.gen) {
        this.needsSettle = false;
        await this.settleAll(0.25);
      }
      this.platesDirty();
    };
    this.queue = this.queue.then(run, run);
    this.kick();
    return this.queue;
  }

  private live(g: number): boolean {
    return g === this.gen && !this.disposed;
  }

  private async doHandle(ev: GameEvent, g: number): Promise<void> {
    // a previewed card that is not what got played (timer, server or a reset decided otherwise) goes back to the hand
    if (this.preview && PREVIEW_UNDO.has(ev.type) && !(ev.type === 'play' && ev.card.id === this.preview.id)) this.undoPreview(0.25);
    switch (ev.type) {
      case 'deal':
        return this.onDeal(ev, g);
      case 'play':
        return this.onPlay(ev.seat, ev.card, ev.color, g);
      case 'draw':
        return this.onDraw(ev.seat, ev.count, ev.cards, ev.reason, g);
      case 'skip':
        if (this.lastPlayKind === 'skipAll') {
          // Salto total: the play already marked the seats; send a small mark to any seat it missed
          if (this.skipAllDone.has(ev.seat)) return;
          this.skipAllDone.add(ev.seat);
          return this.skipMark([ev.seat], false);
        }
        return this.skipMark([ev.seat]);
      case 'reverse':
        return this.onReverse(ev.direction);
      case 'stack':
        // the big +N mark (already popping from the play) shows the grown total; the counter by the pile
        // appears once the mark flies off to its victim
        this.stackTotal = ev.total;
        this.badge.visible = false;
        return this.penMarkUp(ev.total);
      case 'window':
        return this.onWindow(ev.window);
      case 'shield':
        return this.onShield(this.windowVictim ?? ev.seat);
      case 'mirror':
        return this.onMirror(ev.from, ev.to, ev.total);
      case 'swapHands':
        return this.onSwap(ev.a, ev.b, (ev as { cards?: Card[] }).cards, g);
      case 'rotateHands':
        return this.onRotate(ev.direction, (ev as { cards?: Card[] }).cards, g);
      case 'sweep':
        return this.onSweep(ev.seat, ev.cardIds, g);
      case 'ku':
        return this.onKu(ev.seat);
      case 'kuCaught':
        return this.onKuCaught(ev.target);
      case 'eliminated':
        return this.onEliminated(ev.seat, g);
      case 'reshuffle':
        return this.onReshuffle(ev.count, g);
      case 'roundEnd':
        return this.onRoundEnd(ev.winner);
      case 'matchEnd': {
        const won = ev.winnerTeam != null ? ev.winnerTeam === 0 : ev.winner === 0;
        this.sfx(won ? 'winMatch' : 'loseMatch');
        return this.celebrate(ev.winner ?? this.winner ?? 0, true);
      }
      case 'turn':
        this.setTurn(ev.seat);
        // a pending penalty stays over the pile while it can still be stacked: the +N mark only flies to
        // whoever finally draws it (onDraw)
        return;
      case 'flip':
      default:
        return;
    }
  }

  private async onDeal(ev: Extract<GameEvent, { type: 'deal' }>, g: number): Promise<void> {
    this.anim.finishAll();
    this.clearTable();
    this.chosen.clear();
    this.platesOn = true;
    const hand0 = L.sortHand(((ev as { hand?: Card[] }).hand ?? []).slice());
    for (const c of hand0) this.remember(c);
    this.remember(ev.firstCard);
    const seats = this.seats.filter((s) => (ev.counts[s] ?? 0) > 0 || s === 0);
    const counts = this.seats.map((s) => ev.counts[s] ?? 0);
    const total = counts.reduce((a, b) => a + b, 0);
    const deckAfter = (ev as { deck?: number }).deck ?? Math.max(20, DECK_GUESS - total - 1);
    this.setDeckCount(deckAfter + total + 1);
    this.direction = 1;
    this.dirRing.scale.x = Math.abs(this.dirRing.scale.x) * this.ringScaleSign(1);
    this.sfx('shuffle');
    // hop the deck once (shuffle tell)
    await this.deckHop(1);
    if (!this.live(g)) return;
    this.fan = L.fanLayout(ev.counts[0] ?? 0, { W: this.W, H: this.H });
    const max = Math.max(0, ...counts);
    const order: { s: number; r: number }[] = [];
    const start = Math.max(0, this.seats.indexOf(ev.starter));
    for (let r = 0; r < max; r++)
      for (let j = 0; j < this.seats.length; j++) {
        const s = this.seats[(start + 1 + j) % this.seats.length];
        if (r < (ev.counts[s] ?? 0)) order.push({ s, r });
      }
    const step = Math.min(0.07, (this.reduced ? 0.7 : 1.5) / Math.max(1, order.length));
    const jobs: Promise<void>[] = [];
    const pose = newPose();
    const prev = newPose();
    order.forEach(({ s, r }, k) => {
      const o = this.alloc();
      if (!o) return;
      const top = this.deckTopPose(pose);
      o.pos.copy(top.pos);
      o.quat.copy(top.quat);
      o.s = 1;
      if (s === 0 && hand0[r]) this.setFace(o, hand0[r]);
      this.hands[s].push(o);
      this.handPose(s, r, ev.counts[s] ?? 0, pose, o);
      // the side of the fan this card lies on top of: away from the card dealt before it
      // (first card: from the camera for the human, from the table's centre for an opponent)
      const n = new THREE.Vector3(0, 0, 1).applyQuaternion(pose.quat);
      const d =
        r > 0
          ? this.handPose(s, r - 1, ev.counts[s] ?? 0, prev).pos.negate().add(pose.pos)
          : s === 0
            ? prev.pos.copy(this.layoutCam.position).sub(pose.pos)
            : prev.pos.copy(pose.pos).negate();
      const side = n.dot(d);
      n.multiplyScalar((side < 0 ? -1 : 1) * L.CARD_H * pose.s * 0.45);
      jobs.push(
        this.dealFly(o, pose, n, {
          dur: 0.46,
          arc: s === 0 ? 0.2 : 0.45,
          delay: k * step,
          onStart: () => {
            this.setDeckCount(this.deckCount - 1);
            this.platesDirty();
            if (k % 3 === 0) this.sfx('deal');
          },
        }),
      );
    });
    await Promise.all(jobs);
    if (!this.live(g)) return;
    // first card onto the pile
    const o = this.alloc();
    if (o) {
      this.deckTopPose(pose);
      o.pos.copy(pose.pos);
      o.quat.copy(pose.quat);
      o.s = 1;
      this.setFace(o, ev.firstCard);
      this.pileJitter(o);
      this.pile.push(o);
      this.discardCount = 1;
      this.pilePose(0, o, pose);
      await this.fly(o, pose, { dur: 0.4, arc: 0.6, onStart: () => this.setDeckCount(this.deckCount - 1) });
      if (!this.live(g)) return;
      this.land(o, false);
      this.lastPlayKind = ev.firstCard.face.kind;
      this.lastPlayDraw = 0;
    }
    this.setActiveColor(ev.activeColor);
    this.platesDirty();
  }

  /**
   * A deal flight that never cuts through the hand: the card arcs to a point `off` in front of its slot
   * (on the side it lies on top of), already turned to its final orientation, then drops straight
   * into the slot along its own facing.
   */
  private dealFly(o: CardObj, to: Pose, off: V3, opt: FlyOpts): Promise<void> {
    const tok = ++o.token;
    const p1 = to.pos.clone();
    const q1 = to.quat.clone();
    const s1 = to.s;
    const pa = p1.clone().add(off);
    const p0 = new THREE.Vector3();
    const q0 = new THREE.Quaternion();
    let s0 = 1;
    const arc = opt.arc ?? 0;
    const SPLIT = 0.68;
    return this.anim.tween(
      opt.dur ?? 0.45,
      (_k, raw) => {
        if (o.token !== tok) return;
        if (raw < SPLIT) {
          const t = raw / SPLIT;
          const k = 1 - (1 - t) * (1 - t);
          o.pos.lerpVectors(p0, pa, k);
          o.pos.y += Math.sin(Math.PI * t) * arc;
          o.quat.slerpQuaternions(q0, q1, Math.min(1, k * 1.15));
          o.s = lerp(s0, s1, k);
        } else {
          const t = (raw - SPLIT) / (1 - SPLIT);
          o.pos.lerpVectors(pa, p1, 1 - (1 - t) * (1 - t) * (1 - t));
          o.quat.copy(q1);
          o.s = s1;
        }
      },
      (x) => x,
      opt.delay ?? 0,
      () => {
        p0.copy(o.pos);
        q0.copy(o.quat);
        s0 = o.s;
        o.vis = true;
        opt.onStart?.();
      },
    );
  }

  private land(o: CardObj, slam: boolean, big = false): void {
    this.sfx(big ? 'thump' : slam ? 'slam' : 'clack');
    this.puff(o.pos, slam ? 16 : 9);
    const tok = ++o.fxToken;
    const amp = this.reduced ? 0.04 : slam ? 0.16 : 0.1;
    void this.anim.tween(0.22, (_k, raw) => {
      if (o.fxToken !== tok) return;
      const b = Math.sin(Math.PI * raw) * (1 - raw * 0.3);
      o.sqx = 1 + amp * b;
      o.sqy = 1 - amp * 0.7 * b;
    });
  }

  private async deckHop(times: number): Promise<void> {
    const o = this.deckTop;
    for (let t = 0; t < times; t++) {
      const y0 = this.deckH() + 0.004;
      const tok = ++o.token;
      await this.anim.tween(this.reduced ? 0.12 : 0.22, (_k, raw) => {
        if (o.token !== tok) return;
        o.pos.y = y0 + Math.sin(Math.PI * raw) * 0.18;
        o.quat.copy(faceDownQ(this.deckYaw + Math.sin(Math.PI * raw) * 0.25, tmpQ));
      });
    }
  }

  /**
   * The human's colour-changing card goes from the hand onto the pile before the colour is asked; resolves when it
   * has landed (face up, still black). The play event that follows only applies the colour and effects.
   */
  previewPlay(cardId: number): Promise<void> {
    const g = this.gen;
    const run = async () => {
      if (!this.live(g) || this.preview) return;
      const h = this.hands[0];
      const idx = h.findIndex((o) => o.card?.id === cardId);
      if (idx < 0) return;
      const o = h.splice(idx, 1)[0];
      const dragged = this.dropped === o;
      this.dropped = null;
      this.preview = { o, id: cardId };
      o.held = false;
      o.fxToken++;
      o.glow = 0;
      o.dim = 0;
      this.pileJitter(o, 0);
      this.pile.push(o);
      this.discardCount++;
      void this.relayout(0, 0.3, { delay: 0.1 });
      await this.flyToPile(0, o, true, dragged, h.length === 0, g);
      if (!this.live(g) || this.preview?.o !== o) return;
      this.land(o, false);
      this.platesDirty();
    };
    this.queue = this.queue.then(run, run);
    this.kick();
    return this.queue;
  }

  /** put a previewed card back into the human hand (no play followed) */
  cancelPreview(): void {
    const run = () => {
      if (this.preview) this.undoPreview(0.3);
    };
    this.queue = this.queue.then(run, run);
    this.kick();
  }

  private undoPreview(dur: number): void {
    const p = this.preview;
    this.preview = null;
    if (!p) return;
    const i = this.pile.indexOf(p.o);
    if (i < 0) return;
    this.pile.splice(i, 1);
    this.discardCount = Math.max(0, this.discardCount - 1);
    this.insertSorted(p.o, 0);
    void this.relayout(0, dur);
    this.platesDirty();
  }

  private async onPlay(seat: Seat, card: Card, color: Color | undefined, g: number): Promise<void> {
    this.remember(card);
    // already on the pile (previewPlay): only the colour and the effects are left
    const pre = this.preview && seat === 0 && this.preview.id === card.id ? this.preview.o : null;
    this.preview = null;
    const h = this.hands[seat];
    let idx = -1;
    if (!pre && seat === 0) idx = h.findIndex((o) => o.card?.id === card.id);
    if (!pre && idx < 0) idx = h.findIndex((o) => o.card?.id === card.id);
    if (!pre && idx < 0 && h.length) idx = seat === 0 ? h.findIndex((o) => !o.card) : Math.floor(h.length / 2);
    if (!pre && idx < 0 && h.length) idx = h.length - 1;
    let o: CardObj | null = pre ?? (idx >= 0 ? h.splice(idx, 1)[0] : null);
    // the winning card: the hand's last one
    const last = !!o && h.length === 0;
    const dragged = !!o && this.dropped === o;
    this.dropped = null;
    const inHand = !!o;
    if (!o) {
      o = this.alloc();
      if (!o) return;
      this.seatPoint(seat, o.pos);
      faceDownQ(0, o.quat);
      o.s = seat === 0 ? 1 : L.oppScale(this.portrait);
    }
    o.held = false;
    o.fxToken++;
    o.glow = 0;
    o.dim = 0;
    this.setFace(o, card);
    if (color && card.face.color === null) this.chosen.set(card.id, color);
    const pen = card.face.draw ?? KIND_DRAW[card.face.kind] ?? 0;
    this.lastPlayKind = card.face.kind;
    this.lastPlayDraw = pen;
    this.streamDraw = card.face.kind === 'wildColor';
    this.skipAllDone.clear();
    const slam = pen > 0 || h.length <= 1;
    if (!pre) {
      this.pileJitter(o, seat);
      this.pile.push(o);
      this.discardCount++;
      void this.relayout(seat, 0.3, { delay: 0.1 });
      await this.flyToPile(seat, o, inHand, dragged, last, g);
      if (!this.live(g)) return;
    }
    this.land(o, slam, pen >= 4);
    if (o.card === card && this.chosen.has(card.id)) this.setFace(o, card, this.chosen.get(card.id));
    this.trimPile();
    this.setActiveColor(color ?? card.face.color);
    this.platesDirty();
    if (pen > 0) {
      this.fxDraw(pen);
      // the big +N mark pops now (a stack event that follows confirms or grows the total)
      void this.penMarkUp(this.stackTotal > 0 ? this.stackTotal + pen : pen);
    } else if (card.face.kind === 'wildColor' || card.face.kind === 'wild') this.fxSwirl(card.face.kind === 'wildColor');
    if (card.face.kind === 'skipAll') {
      const others = this.seats.filter((x) => x !== seat && !this.eliminated[x]);
      for (const x of others) this.skipAllDone.add(x);
      await this.skipMark(others);
      return;
    }
    await this.anim.wait(0.08);
  }

  /** lift out of the fan, then a quick arc onto the pile top (the winning card spins); o is already on this.pile */
  private async flyToPile(seat: Seat, o: CardObj, inHand: boolean, dragged: boolean, last: boolean, g: number): Promise<void> {
    const pose = this.pilePose(this.pile.length - 1, o, newPose());
    // 1) the card lifts out of its fan first (along its own up, away from its neighbours; opponents also lean
    //    towards the table centre), so it never cuts through the cards beside it
    if (inHand && !dragged && !this.reduced) {
      const lift = newPose();
      lift.pos.copy(o.pos);
      lift.quat.copy(o.quat);
      lift.s = o.s;
      const up = tmpV.set(0, 1, 0).applyQuaternion(o.quat);
      if (seat === 0) {
        lift.pos.addScaledVector(up, this.fan.ch * this.worldPerPx(HAND_D) * 0.32);
        lift.pos.addScaledVector(tmpV2.set(0, 0, 1).applyQuaternion(this.layoutCam.quaternion), 0.04);
      } else {
        lift.pos.addScaledVector(up, L.CARD_H * o.s * 0.45);
        const dx = this.pilePos.x - o.pos.x;
        const dz = this.pilePos.z - o.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        lift.pos.x += (dx / d) * 0.2;
        lift.pos.z += (dz / d) * 0.2;
        lift.pos.y += 0.1;
      }
      await this.fly(o, lift, { dur: 0.12, ease: ease.outQuad });
      if (!this.live(g)) return;
    }
    // 2) a quick, clean arc onto the pile with a small natural turn and a little variety;
    //    only the winning card gets the big spinning flight
    const r1 = Math.random();
    const r2 = Math.random();
    const opt: FlyOpts = last
      ? { dur: 0.62, arc: seat === 0 ? 0.7 : 1.1, spin: (r1 < 0.5 ? -1 : 1) * Math.PI * 2.5, ease: ease.inOutQuad }
      : { dur: 0.34 + r1 * 0.08, arc: (seat === 0 ? 0.26 : 0.4) * (0.8 + r2 * 0.45), spin: (r1 - 0.5) * 0.7, ease: ease.inOutQuad };
    if (last) this.tweenFx(o, 1, 0, 0.2);
    await this.fly(o, pose, opt);
    if (!this.live(g)) return;
    if (last) this.tweenFx(o, 0, 0, 0.5);
  }

  private async onDraw(seat: Seat, count: number, cards: Card[] | undefined, reason: string, g: number): Promise<void> {
    if (reason === 'penalty' || reason === 'catch') {
      if (this.penMarkTotal) await this.penMarkFly(seat);
      this.showBadge(0);
      this.hidePenBadge();
    }
    const open = this.isOpen(seat);
    // open hand: faces come from the event, else from the open list the controller already sent
    let pending: Card[] = [];
    if (open && !cards) {
      const shown = new Set(this.hands[seat].map((o) => o.card?.id));
      pending = this.openCards[seat]!.filter((c) => !shown.has(c.id));
    }
    // the ku rim goes when the last card is no longer the last
    for (const o of this.hands[seat]) if (o.glow > 0 && seat !== 0) this.tweenFx(o, 0, 0, 0.2);
    // "draw until the colour" (wildColor) streams card by card
    const stream = this.streamDraw;
    // the stream ends when the chosen colour arrives (or at the next play)
    if (stream && cards?.some((c) => c.face.color === this.activeColor)) this.streamDraw = false;
    const n = Math.max(0, Math.min(count, this.free.length));
    const news: CardObj[] = [];
    const pose = newPose();
    for (let j = 0; j < n; j++) {
      const o = this.alloc();
      if (!o) break;
      this.deckTopPose(pose);
      o.pos.copy(pose.pos);
      o.quat.copy(pose.quat);
      o.s = 1;
      o.vis = false;
      const c = seat === 0 || open ? cards?.[j] ?? (open ? pending[j] : undefined) : undefined;
      if (c) this.setFace(o, c);
      else if (cards?.[j]) this.remember(cards[j]);
      if (seat === 0 || open) this.insertSorted(o, seat);
      else this.hands[seat].push(o);
      news.push(o);
    }
    const h = this.hands[seat];
    if (seat === 0) this.fan = L.fanLayout(h.length, { W: this.W, H: this.H });
    const jobs: Promise<void>[] = [];
    const step = stream ? (this.reduced ? 0.12 : 0.24) : this.reduced ? 0.06 : n > 4 ? 0.09 : 0.14;
    const catchArc = reason === 'catch' ? 0.5 : 0;
    // existing cards make room first
    for (let i = 0; i < h.length; i++) {
      const o = h[i];
      if (news.includes(o) || o.held) continue;
      this.handPose(seat, i, h.length, pose, o);
      jobs.push(this.fly(o, pose, { dur: 0.25 }));
    }
    news.forEach((o, j) => {
      const i = h.indexOf(o);
      this.handPose(seat, i, h.length, pose, o);
      // slide off the deck sideways first, then up to the hand (flipping face up for seat 0)
      const slide = newPose();
      slide.pos.copy(this.deckTopPose(slide).pos);
      slide.pos.x += (seat === 3 ? -1 : 1) * 0.35;
      slide.pos.y += 0.06;
      const delay = j * step;
      jobs.push(
        this.fly(o, slide, {
          dur: 0.12,
          delay,
          ease: ease.outQuad,
          onStart: () => {
            this.setDeckCount(this.deckCount - 1);
            this.platesDirty();
            if (stream || j % 2 === 0) this.sfx('draw');
          },
        }).then(() => {
          if (!this.live(g)) return undefined;
          // the target is taken now: the layout may have changed (resize, more cards) since the draw began
          const k = h.indexOf(o);
          if (k < 0) return undefined;
          const to = this.handPose(seat, k, h.length, newPose(), o);
          if (seat === 0) return this.fly(o, to, { dur: 0.38, arc: 0.15 + catchArc, ease: ease.outCubic });
          // an opponent's fan: come in on the side this card lies on top of, then drop straight into the
          // slot along its own facing, so it never passes through the cards already held
          const nb = k > 0 ? k - 1 : k + 1 < h.length ? k + 1 : -1;
          const nrm = new THREE.Vector3(0, 0, 1).applyQuaternion(to.quat);
          const away = nb >= 0 ? this.handPose(seat, nb, h.length, newPose()).pos.negate().add(to.pos) : to.pos.clone().negate();
          nrm.multiplyScalar((nrm.dot(away) < 0 ? -1 : 1) * L.CARD_H * to.s * 0.45);
          return this.dealFly(o, to, nrm, { dur: 0.42, arc: 0.35 + catchArc });
        }),
      );
    });
    await Promise.all(jobs);
    if (!this.live(g)) return;
    if (seat === 0 && this.req) this.applyPickFx();
    this.platesDirty();
  }

  private async onReverse(direction: Direction): Promise<void> {
    this.sfx('select');
    this.direction = direction;
    const r = this.dirRing;
    const m = r.material as THREE.MeshBasicMaterial;
    const B = 2 * (this.portrait ? Math.min(1.75, this.dims.A - 0.2) : 1.6);
    // mirror signs of the ring (which way the arrows point) and the spin that follows them (the opposite sign)
    const mOld = Math.sign(r.scale.x) || 1;
    const mNew = this.ringScaleSign(direction);
    const sOld = -mOld;
    const sNew = -mNew;
    if (this.reduced) {
      // a plain fade through the swap
      let flipped = false;
      await this.anim.tween(0.3, (k) => {
        if (!flipped && k > 0.5) {
          flipped = true;
          r.scale.x = B * mNew;
        }
        m.opacity = DIR_OPACITY * Math.abs(Math.cos(Math.PI * k));
      });
      m.opacity = DIR_OPACITY;
      return;
    }
    // the arrows swell and brighten, whirl the old way and slow to a stop, turn over,
    // spin up the new way trailing a shimmer, then settle back to the slow turn
    this.dirFx = true;
    const tok = ++this.dirTok;
    const col = this.fxColor(this.fxC, 0.45);
    const cr = col.r, cg = col.g, cb = col.b;
    this.flashAt(this.fxP.set(r.position.x, 0.12, r.position.z), B * 0.5, col, 0.6);
    const T = 1.4;
    const peak = 7;
    const rate = this.quality === 'low' ? 1 : this.quality === 'high' ? 3 : 2;
    const cx = r.position.x, cz = r.position.z;
    let last = 0;
    const done = this.anim.tween(T, (_k, raw) => {
      if (tok !== this.dirTok) return;
      const dt = (raw - last) * T;
      last = raw;
      let v: number;
      let sx: number;
      if (raw < 0.42) {
        const u = raw / 0.42;
        v = sOld * (DIR_SPIN + peak * Math.sin(Math.PI * u)) * (1 - u);
        sx = mOld;
      } else if (raw < 0.56) {
        const u = (raw - 0.42) / 0.14;
        v = 0;
        sx = lerp(mOld, mNew, (1 - Math.cos(Math.PI * u)) / 2);
      } else {
        const u = (raw - 0.56) / 0.44;
        v = sNew * (DIR_SPIN + peak * 0.75 * Math.sin(Math.PI * u) * (1 - u * 0.3));
        sx = mNew;
      }
      r.rotation.y += v * dt;
      const sw = 1 + 0.16 * Math.sin(Math.PI * raw);
      r.scale.set(B * sw * sx, 1, B * sw);
      m.opacity = DIR_OPACITY + (0.95 - DIR_OPACITY) * Math.sin(Math.PI * Math.min(1, raw * 1.15));
      // shimmer: sparks shed along the arrows, swept the way they turn
      const av = Math.abs(v);
      if (av < 0.5 || raw > 0.95) return;
      const dir = Math.sign(v);
      for (let i = 0; i < rate; i++) {
        const a = Math.random() * Math.PI * 2;
        const rad = B * 0.5 * (0.74 + Math.random() * 0.14) * sw;
        const c = Math.cos(a), s = Math.sin(a);
        const sp = 0.15 + av * rad * 0.35;
        this.dust.spawn(cx + c * rad, 0.04, cz + s * rad, dir * s * sp, 0.15 + Math.random() * 0.25, -dir * c * sp, cr, cg, cb, 0.07 + Math.random() * 0.05, 0.45 + Math.random() * 0.25);
      }
    }, ease.linear).then(() => {
      if (tok !== this.dirTok) return;
      r.scale.set(B * mNew, 1, B);
      m.opacity = DIR_OPACITY;
      this.dirFx = false;
    });
    // play may go on once the arrows have turned over; the settle runs on
    await this.anim.wait(0.85);
    void done;
  }


  /** a world point just above a seat's HTML plate (falls back to the seat point when plates are off) */
  private platePoint(seat: number, out: V3, abovePx = 0): V3 {
    const p = this.plates.find((x) => x.seat === seat && x.visible);
    if (!p) {
      this.seatPoint(seat, out);
      if (seat !== 0) out.y = 0.7;
      return out;
    }
    const depth = seat === 0 ? HAND_D * 1.4 : this.layoutCam.position.distanceTo(this.seatPoint(seat, tmpV2)) * 0.8;
    return this.pxToWorld(p.x, Math.max(HUD_TOP + 20, p.y - p.h / 2 - abovePx), depth, out);
  }

  private penSize(p: V3): number {
    return this.worldPerPx(p.distanceTo(this.layoutCam.position)) * Math.max(52, Math.min(76, this.W * 0.15));
  }

  /** "+N" over the victim's plate, pulsing while the response window is open */
  private showPenBadge(seat: Seat, total: number, pop = true): void {
    if (total <= 0) return;
    A.drawBadge(this.penCanvas.getContext('2d')!, 128, 72, `+${total}`, '#e8402e');
    this.penTex.needsUpdate = true;
    const b = this.penBadge;
    this.platePoint(seat, b.position, 26);
    const w = this.penSize(b.position);
    b.visible = true;
    this.penSeat = seat;
    const m = b.material;
    m.opacity = 1;
    m.rotation = 0;
    const tok = ++this.penTok;
    const set = (k: number) => b.scale.set(w * k, w * 0.5625 * k, 1);
    set(1);
    if (this.reduced) return;
    // pop, then pulse for a while (the loop goes idle afterwards even if the window stays open)
    void this.anim.tween(6, (_k, raw) => {
      if (tok !== this.penTok) return;
      const t = raw * 6;
      const popK = pop && t < 0.3 ? lerp(1.7, 1, ease.outBack(t / 0.3)) : 1;
      set(popK * (1 + 0.1 * Math.sin(t * Math.PI * 3.2) * Math.min(1, (6 - t) * 2)));
    }, ease.linear);
  }

  private hidePenBadge(): void {
    if (!this.penBadge.visible) return;
    const tok = ++this.penTok;
    const b = this.penBadge;
    const m = b.material;
    const s0 = b.scale.clone();
    this.penSeat = null;
    void this.anim.tween(0.18, (k) => {
      if (tok !== this.penTok) return;
      m.opacity = 1 - k;
      b.scale.copy(s0).multiplyScalar(1 + 0.3 * k);
      if (k >= 1) b.visible = false;
    });
  }

  private async onWindow(w: { reason: string; victim?: Seat; seats: Seat[] } | null): Promise<void> {
    if (w && w.reason === 'penalty' && w.victim !== undefined) {
      this.windowVictim = w.victim;
      const total = this.stackTotal > 0 ? this.stackTotal : this.lastPlayDraw;
      if (total > 0) {
        // the big +N mark stays over the pile (the victim may still stack); it flies when someone draws
        if (this.stackTotal !== total) this.showBadge(total, false);
        this.showPenBadge(w.victim, total);
      }
      return this.anim.wait(0.15);
    }
    this.windowVictim = null;
    if (!w) this.hidePenBadge();
  }

  /** a translucent shield dome pops over the victim's seat */
  private async onShield(seat: Seat): Promise<void> {
    this.sfx('shield');
    this.showBadge(0);
    this.hidePenBadge();
    this.windowVictim = null;
    const d = this.dome;
    const m = this.domeMat;
    let r: number;
    if (seat === 0) {
      this.pxToWorld(this.W / 2, this.fan.top + this.fan.ch * 0.55, HAND_D * 1.25, d.position);
      r = this.worldPerPx(HAND_D * 1.25) * Math.min(this.W * 0.42, 220);
      d.quaternion.copy(this.layoutCam.quaternion).multiply(tmpQ.setFromAxisAngle(Q_TMP_X, Math.PI / 2));
    } else {
      const an = this.anchorOf(seat);
      d.position.set(an.x, 0, an.z);
      d.quaternion.identity();
      r = this.isOpen(seat) ? 1.3 : 1.05;
    }
    d.visible = true;
    // the dome lands with a bloom at its crown and a ring of sparks round its rim
    this.flashAt(this.fxP.copy(d.position).addScaledVector(tmpV.set(0, 1, 0).applyQuaternion(d.quaternion), r * 0.6), r * 1.8, FX_SHIELD, 0.4);
    if (seat !== 0) this.sparkRing(d.position, r * 0.95, 22, FX_SHIELD, 0.9, 0.8);
    const tok = ++this.domeTok;
    const k0 = this.reduced ? 1 : 0.2;
    await this.anim.tween(this.reduced ? 0.15 : 0.32, (k) => {
      if (tok !== this.domeTok) return;
      d.scale.setScalar(r * lerp(k0, 1, k));
      m.uniforms.uOpacity.value = 0.9 * k;
    }, this.reduced ? ease.linear : ease.outBack);
    await this.anim.tween(0.5, (_k, raw) => {
      if (tok !== this.domeTok) return;
      m.uniforms.uOpacity.value = 0.9 - 0.25 * Math.sin(Math.PI * raw);
    }, ease.linear);
    await this.anim.tween(0.3, (k) => {
      if (tok !== this.domeTok) return;
      m.uniforms.uOpacity.value = 0.9 * (1 - k);
      if (!this.reduced) d.scale.setScalar(r * (1 + 0.12 * k));
    });
    if (tok === this.domeTok) d.visible = false;
  }

  /** mirror: a flash at the victim, then the +N badge flies back to whoever played the penalty */
  private async onMirror(from: Seat, to: Seat, total: number): Promise<void> {
    this.sfx('mirror');
    this.showBadge(total, false);
    const b = this.penBadge;
    if (!b.visible || this.penSeat !== from) this.showPenBadge(from, total, false);
    ++this.penTok; // stop the pulse; we drive the badge now
    A.drawBadge(this.penCanvas.getContext('2d')!, 128, 72, `+${total}`, '#e8402e');
    this.penTex.needsUpdate = true;
    b.material.opacity = 1;
    const p0 = this.platePoint(from, new THREE.Vector3(), 26);
    const p1 = this.platePoint(to, new THREE.Vector3(), 26);
    const w0 = this.penSize(p0);
    const w1 = this.penSize(p1);
    this.flashAt(p0, w0 * 2.2, FX_WHITE, this.reduced ? 0.2 : 0.35);
    if (this.reduced) {
      b.position.copy(p1);
      b.scale.set(w1, w1 * 0.5625, 1);
      this.penSeat = to;
      return this.anim.wait(0.25);
    }
    await this.anim.wait(0.12);
    // a red sparkle trail follows the badge home
    const mid = this.fxQ.lerpVectors(p0, p1, 0.5);
    mid.y += 1.2;
    void this.comet(p0, mid, p1, this.fxC.set('#ff6a55'), 0.5, 0, ease.inOutCubic);
    await this.anim.tween(0.5, (k, raw) => {
      b.position.lerpVectors(p0, p1, k);
      b.position.y += Math.sin(Math.PI * raw) * 0.6;
      const w = lerp(w0, w1, k) * (1 + 0.35 * Math.sin(Math.PI * raw));
      b.scale.set(w, w * 0.5625, 1);
      b.material.rotation = Math.sin(Math.PI * 2 * raw) * 0.25;
    }, ease.inOutCubic);
    b.material.rotation = 0;
    this.penSeat = to;
    this.windowVictim = null;
  }

  /** missed ¡Ku!: the offender's plate shakes (the two catch cards follow as a draw event) */
  private async onKuCaught(target: Seat): Promise<void> {
    this.sfx('slam');
    void this.shakeSeat(target, 0.08);
    const amp = this.reduced ? 3 : 9;
    void this.anim.tween(0.55, (_k, raw) => {
      this.plateShake[target] = raw >= 1 ? 0 : Math.sin(raw * Math.PI * 9) * amp * (1 - raw);
    }, ease.linear);
    void this.stampAt(target, 'caught', 0.35);
    await this.anim.wait(0.35);
  }
  private async moveHands(next: CardObj[][], cardsFor0: Card[] | undefined, g: number): Promise<void> {
    const old = this.hands.map((h) => h.slice());
    for (const s of this.seats) this.hands[s] = next[s] ?? [];
    // cards leaving the human become anonymous; cards arriving get the faces when the caller knows them
    for (const s of this.seats) if (s !== 0 && !this.isOpen(s)) for (const o of this.hands[s]) if (o.card) o.card = null;
    if (cardsFor0) {
      const sorted = L.sortHand(cardsFor0);
      const h = this.hands[0];
      while (h.length < sorted.length) {
        const o = this.alloc();
        if (!o) break;
        this.seatPoint(0, o.pos);
        h.push(o);
      }
      while (h.length > sorted.length) this.release(h.pop()!);
      h.forEach((o, i) => this.setFace(o, sorted[i]));
    }
    for (const o of this.hands[0]) {
      o.glow = 0;
      o.dim = 0;
    }
    this.sfx('shuffle');
    for (const s of this.seats) if (this.isOpen(s)) this.sortOpen(s);
    const jobs = this.seats.map((s, i) => this.relayout(s, this.reduced ? 0.3 : 0.75, { arc: this.reduced ? 0 : 0.6 + 0.35 * (i % 2), ease: ease.inOutCubic }));
    await Promise.all(jobs);
    if (!this.live(g)) return;
    this.platesDirty();
  }

  private onSwap(a: Seat, b: Seat, cards: Card[] | undefined, g: number): Promise<void> {
    const next = this.hands.map((h) => h.slice());
    next[a] = this.hands[b].slice();
    next[b] = this.hands[a].slice();
    this.fxCross(a, b);
    return this.moveHands(next, a === 0 || b === 0 ? cards : undefined, g);
  }

  private onRotate(direction: Direction, cards: Card[] | undefined, g: number): Promise<void> {
    const live = this.seats.filter((s) => !this.eliminated[s]);
    const next = this.hands.map((h) => h.slice());
    live.forEach((s, i) => {
      const to = live[(i + direction + live.length) % live.length];
      next[to] = this.hands[s].slice();
    });
    this.fxRotate(direction);
    return this.moveHands(next, cards, g);
  }

  private async onSweep(seat: Seat, ids: number[], g: number): Promise<void> {
    const h = this.hands[seat];
    const taken: CardObj[] = [];
    for (const id of ids) {
      let i = h.findIndex((o) => o.card?.id === id);
      if (i < 0) i = h.findIndex((o) => !o.card);
      if (i < 0) i = h.length - 1;
      if (i < 0) break;
      const o = h.splice(i, 1)[0];
      const f = this.faces.get(id);
      if (f) this.setFace(o, { id, face: f });
      o.fxToken++;
      o.glow = 0;
      o.dim = 0;
      taken.push(o);
    }
    void this.relayout(seat, 0.3);
    if (!taken.length) return;
    // the pile ring pulls in, like a broom gathering
    void this.pileRing(this.fxColor(), 2.3, 0.55, 0.55, 0.8, ease.inQuad);
    // 1) the swept cards fan out of the hand, face up
    const n = taken.length;
    const pose = newPose();
    if (!this.reduced) {
      const fanJobs: Promise<void>[] = [];
      const wpp = this.worldPerPx(HAND_D * 1.2);
      const cwPx = Math.min(64, this.W * 0.14);
      taken.forEach((o, j) => {
        const t = n > 1 ? j / (n - 1) - 0.5 : 0;
        if (seat === 0) {
          const spread = Math.min(this.W * 0.6, cwPx * 0.7 * n);
          this.pxToWorld(this.W / 2 + t * spread, this.fan.top - cwPx * 0.9, HAND_D * 1.2 - j * 0.004, pose.pos);
          pose.quat.copy(this.layoutCam.quaternion).multiply(tmpQ.setFromAxisAngle(tmpV.set(0, 0, 1), -t * 0.6));
          pose.s = (cwPx * wpp) / L.CARD_W;
        } else {
          const an = this.anchorOf(seat);
          const spread = Math.min(2.2, 0.32 * n);
          pose.pos.set(an.x * 0.8 + t * spread, 0.55 - Math.abs(t) * 0.12 + j * 0.004, an.z * 0.8);
          pose.quat.setFromAxisAngle(Q_TMP_X, -Math.PI / 2 + 0.7).premultiply(tmpQ.setFromAxisAngle(UP, -t * 0.5));
          pose.s = 0.8;
        }
        fanJobs.push(this.fly(o, pose, { dur: 0.3, delay: j * 0.04, ease: ease.outCubic, onStart: () => j === 0 && this.sfx('shuffle') }));
      });
      await Promise.all(fanJobs);
      if (!this.live(g)) return;
      await this.anim.wait(0.18);
    }
    // 2) they slide under the sweep card on the pile
    for (const o of taken) {
      this.pileJitter(o);
      this.pile.splice(Math.max(0, this.pile.length - 1), 0, o);
      this.discardCount++;
    }
    const jobs: Promise<void>[] = [];
    taken.forEach((o, j) => {
      this.pilePose(this.pile.indexOf(o), o, pose);
      jobs.push(this.fly(o, pose, { dur: 0.32, arc: 0.12, delay: j * 0.06, ease: ease.inOutQuad, onStart: () => j % 2 === 0 && this.sfxAt('deal', 0.2) }));
    });
    const top = this.pile[this.pile.length - 1];
    if (top && !taken.includes(top)) jobs.push(this.fly(top, this.pilePose(this.pile.length - 1, top, newPose()), { dur: 0.3 }));
    await Promise.all(jobs);
    if (!this.live(g)) return;
    this.puff(this.pilePos, 10);
    this.flashAt(this.overPile(this.fxP, 0.15), 1.2, this.fxColor(), 0.35);
    this.sfx('clack');
    this.trimPile();
    await this.relayoutPile(0.15);
    this.platesDirty();
  }
  private async onKu(seat: Seat): Promise<void> {
    this.sfx('ku');
    const low = this.quality === 'low';
    const p = this.seatPoint(seat, new THREE.Vector3());
    // gold rim on the last card (the shader glow colour is gold): a bright pulse that settles
    const h = this.hands[seat];
    if (h.length === 1) {
      const o = h[0];
      const tok = ++o.fxToken;
      void this.anim.tween(1.1, (_k, raw) => {
        if (o.fxToken !== tok) return;
        o.glow = 0.75 + 0.25 * Math.cos(raw * Math.PI * 4);
      }, ease.linear);
    }
    // radial burst of card-coloured sparks on the table (flat ring), plus a little confetti
    const n = Math.round((low ? 14 : 34) * (this.reduced ? 0.5 : 1));
    const c = seat === 0 ? this.pxToTable(this.W / 2, this.fan.top - 10, new THREE.Vector3()) : p;
    for (let i = 0; i < n; i++) {
      const col = KU_COLS[i % 4];
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.2;
      const sp = 2.2 + Math.random() * 1.2;
      this.dust.spawn(c.x, Math.max(0.15, c.y), c.z, Math.cos(a) * sp, 0.4 + Math.random() * 0.6, Math.sin(a) * sp, col[0], col[1], col[2], 0.1 + Math.random() * 0.05, 0.55 + Math.random() * 0.2);
    }
    this.confettiBurst(p, low ? 24 : 50, seat === 0 ? 0.8 : 1);
    this.platePulse++;
    const pulse = this.platePulse;
    void this.anim.tween(0.9, (_k, raw) => {
      if (pulse !== this.platePulse) return;
      this.plateScale[seat] = 1 + 0.28 * Math.sin(Math.PI * raw) * (raw < 0.5 ? 1 : 1 - (raw - 0.5) * 0.6);
      if (raw >= 1) this.plateScale[seat] = 1;
    });
    if (this.reduced || low) return this.anim.wait(0.5);
    // short camera push-in towards the seat
    this.pushTarget.copy(seat === 0 ? this.pxToWorld(this.W / 2, this.fan.top, 4, tmpV) : p);
    await this.anim.tween(0.25, (k) => (this.push = k), ease.outCubic);
    await this.anim.wait(0.2);
    await this.anim.tween(0.35, (k) => (this.push = 1 - k), ease.inOutQuad);
    this.push = 0;
  }
  private async onEliminated(seat: Seat, g: number): Promise<void> {
    this.eliminated[seat] = true;
    this.sfx('loseHand');
    void this.stampAt(seat, 'out', 0.5);
    const h = this.hands[seat].splice(0);
    const pose = this.deckTopPose(newPose());
    await Promise.all(
      h.map((o, j) => {
        o.card = null;
        return this.fly(o, pose, { dur: 0.45, arc: 0.5, delay: j * 0.03, onStart: () => this.setDeckCount(this.deckCount + 1) }).then(() => this.release(o));
      }),
    );
    if (!this.live(g)) return;
    this.platesDirty();
  }

  private async onReshuffle(count: number, g: number): Promise<void> {
    this.sfx('shuffle');
    const top = this.pile.pop();
    const back = this.pile.splice(0);
    this.discardCount = top ? 1 : 0;
    if (top) this.pile.push(top);
    this.updateDeckVisual();
    const pose = newPose();
    const jobs = back.map((o, j) => {
      this.deckTopPose(pose);
      pose.pos.x += (j % 2 ? 1 : -1) * 0.25;
      return this.fly(o, pose, { dur: 0.35, arc: 0.45 + (j % 2) * 0.2, delay: j * 0.05, spin: this.reduced ? 0 : (j % 2 ? 1 : -1) * Math.PI }).then(() => {
        this.deckTopPose(pose);
        return this.fly(o, pose, { dur: 0.12 }).then(() => this.release(o));
      });
    });
    await Promise.all(jobs);
    if (!this.live(g)) return;
    this.setDeckCount(count);
    if (top) await this.relayoutPile(0.2);
    await this.deckHop(this.reduced ? 1 : 2);
  }

  private async onRoundEnd(winner: Seat): Promise<void> {
    this.winner = winner;
    this.showBadge(0);
    this.platesDirty();
    const won = this.teams ? !!this.teams.find((t) => t.includes(0))?.includes(winner) : winner === 0;
    this.sfx(won ? 'winHand' : 'loseHand');
    this.hidePenBadge();
    await this.celebrate(winner, false);
  }

  /**
   * the win: the last card bursts on the pile (gold bloom, shockwave, a ring of sparks in the four colours),
   * gold light streams from the pile to the winner's plate, which flares and pulses, while confetti in the
   * four colours is tossed up and flutters down, fading; a short camera push and settle. A match win is
   * bigger and longer (more rays, three plate beats, a second confetti wave and a rain over the table).
   * Reduced motion: two soft glows and the plate's highlight only.
   */
  private async celebrate(winner: Seat, match: boolean): Promise<void> {
    const tok = ++this.winTok;
    const red = this.reduced;
    const low = this.quality === 'low';
    const pp = this.overPile(new THREE.Vector3(), 0.14);
    const tp = this.platePoint(winner, new THREE.Vector3(), 0);
    if (red) {
      this.flashAt(pp, match ? 2.6 : 2.1, FX_GOLD, 0.5);
      void this.anim.wait(0.35).then(() => tok === this.winTok && this.flashAt(tp, match ? 1.8 : 1.4, FX_GOLD, 0.6));
      return this.anim.wait(match ? 1 : 0.7);
    }
    // 1) the last card bursts on the pile; its rim glows gold and settles
    const top = this.pile[this.pile.length - 1];
    if (top) {
      const ft = ++top.fxToken;
      void this.anim.tween(match ? 1.6 : 1.1, (_k, raw) => {
        if (top.fxToken !== ft) return;
        top.glow = (1 - raw) * (0.65 + 0.35 * Math.cos(raw * Math.PI * 5));
      }, ease.linear);
    }
    this.flashAt(pp, match ? 3.4 : 2.6, FX_GOLD, match ? 0.7 : 0.5);
    void this.pileRing(FX_GOLD, 0.4, match ? 3 : 2.4, match ? 0.8 : 0.6, 1, ease.outCubic);
    const nb = Math.round((low ? 16 : 34) * (match ? 1.4 : 1));
    for (let i = 0; i < nb; i++) {
      const cc = KU_COLS[i % 4];
      const a = (i / nb) * Math.PI * 2 + Math.random() * 0.2;
      const sp = 2 + Math.random() * 1.4;
      this.dust.spawn(pp.x, 0.16, pp.z, Math.cos(a) * sp, 0.5 + Math.random() * 0.7, Math.sin(a) * sp, cc[0], cc[1], cc[2], 0.1 + Math.random() * 0.05, 0.5 + Math.random() * 0.25);
    }
    // 2) a warm sweep: gold streams fan out from the pile and converge on the winner's plate
    const rays = low ? 3 : match ? 7 : 5;
    const side = this.fxQ.set(tp.z - pp.z, 0, pp.x - tp.x).normalize();
    const mid = new THREE.Vector3();
    const rayDur = match ? 0.6 : 0.5;
    for (let i = 0; i < rays; i++) {
      const t = rays > 1 ? i / (rays - 1) - 0.5 : 0;
      mid.lerpVectors(pp, tp, 0.5).addScaledVector(side, t * 1.8).setY(Math.max(pp.y, tp.y) + 0.8);
      void this.comet(pp, mid, tp, FX_GOLD, rayDur, Math.abs(t) * 0.12, ease.inOutQuad);
    }
    // 3) the rays arrive: the plate flares and pulses (one beat for a round, three for the match)
    void this.anim.wait(rayDur * 0.9).then(() => {
      if (tok !== this.winTok) return;
      this.flashAt(tp, match ? 2 : 1.5, FX_GOLD, 0.6);
      if (!low) this.sparkRing(tp, 0.1, match ? 22 : 14, FX_GOLD, 1.1, 0.9);
      const pulse = ++this.platePulse;
      const beats = match ? 3 : 1;
      const amp = match ? 0.3 : 0.26;
      void this.anim.tween(match ? 2.4 : 0.9, (_k, raw) => {
        if (pulse !== this.platePulse) return;
        const f = raw * beats - Math.floor(raw * beats);
        this.plateScale[winner] = raw >= 1 ? 1 : 1 + amp * Math.sin(Math.PI * f) * (1 - raw * 0.45);
      }, ease.linear);
    });
    // 4) confetti in the four colours: tossed up off the pile over a moment (not one spray), then it
    //    flutters down on drag and wobble and fades before it lands; the match adds a rain over the table
    const toss = Math.round(this.q.confetti * (match ? 0.5 : 0.35));
    let tossed = 0;
    void this.anim.tween(match ? 1.1 : 0.4, (k) => {
      if (tok !== this.winTok) return;
      const want = Math.round(k * toss);
      for (; tossed < want; tossed++) {
        const cc = KU_COLS[tossed % 4];
        const a = Math.random() * Math.PI * 2;
        const h = (0.4 + Math.random() * 1.4) * (match ? 1.15 : 1);
        this.confetti.spawn(pp.x + Math.cos(a) * 0.2, pp.y, pp.z + Math.sin(a) * 0.2, Math.cos(a) * h, 4.6 + Math.random() * 2, Math.sin(a) * h, cc[0], cc[1], cc[2], 0.11 + Math.random() * 0.05, 1.5 + Math.random() * 0.6, (Math.random() - 0.5) * 12);
      }
    }, ease.linear);
    if (match) {
      const rain = Math.round(this.q.confetti * 0.4);
      const skyY = Math.max(2.2, this.layoutCam.position.y * 0.38);
      let rained = 0;
      void this.anim.tween(1.6, (k) => {
        if (tok !== this.winTok) return;
        const want = Math.round(k * rain);
        for (; rained < want; rained++) {
          const cc = KU_COLS[rained % 4];
          const a = Math.random() * Math.PI * 2;
          const r = Math.sqrt(Math.random()) * 2.8;
          this.confetti.spawn(pp.x + Math.cos(a) * r, skyY, pp.z + Math.sin(a) * r, (Math.random() - 0.5) * 0.6, -0.4, (Math.random() - 0.5) * 0.6, cc[0], cc[1], cc[2], 0.11 + Math.random() * 0.05, 1.8 + Math.random() * 0.7, (Math.random() - 0.5) * 10);
        }
      }, ease.linear, 0.35);
    }
    // 5) a short camera push towards the pile (the match: towards the winner) and a soft settle
    if (low) return this.anim.wait(match ? 1.4 : 0.9);
    this.pushTarget.copy(match ? tp : pp);
    const depth = match ? 1 : 0.6;
    await this.anim.tween(0.3, (k) => tok === this.winTok && (this.push = depth * k), ease.outCubic);
    await this.anim.wait(match ? 0.6 : 0.15);
    if (tok !== this.winTok) return;
    await this.anim.tween(match ? 0.7 : 0.5, (k) => tok === this.winTok && (this.push = depth * (1 - k)), ease.inOutQuad);
    if (tok === this.winTok) this.push = 0;
  }

  private pxToTable(x: number, y: number, out: V3): V3 {
    const cam = this.layoutCam;
    tmpV.set((x / this.W) * 2 - 1, -((y / this.H) * 2 - 1), 0.5).unproject(cam).sub(cam.position).normalize();
    const t = tmpV.y < -1e-4 ? -cam.position.y / tmpV.y : 5;
    return out.copy(cam.position).addScaledVector(tmpV, t);
  }

  // ───────────────────────── human pick ─────────────────────────

  requestHumanPick(playable: number[], canDraw: boolean): Promise<number | 'draw'> {
    const gen = ++this.reqGen;
    return new Promise((resolve) => {
      const start = () => {
        if (gen !== this.reqGen || this.disposed) return;
        this.req = { playable: new Set(playable), canDraw, resolve };
        this.applyPickFx();
      };
      void this.queue.then(start, start);
    });
  }

  cancelHumanPick(): void {
    this.reqGen++;
    if (this.req) {
      this.req = null;
      this.clearPickFx(-1);
    }
  }

  /** the pile's top centre in viewport CSS px (anchors the colour pane); null before the first layout */
  pileScreenPoint(): { x: number; y: number } | null {
    if (!this.W || !this.H) return null;
    const out = { x: 0, y: 0 };
    this.toScreen(tmpV.set(this.pilePos.x, this.pileH(), this.pilePos.z), out);
    const r = this.container.getBoundingClientRect();
    return { x: out.x + r.left, y: out.y + r.top };
  }

  private applyPickFx(): void {
    const r = this.req;
    if (!r) return;
    // no play at all: only the pyramid over the deck says "draw" (no dimmed hand, no deck glow)
    const mustDraw = r.canDraw && r.playable.size === 0;
    for (const o of this.hands[0]) {
      const ok = !!o.card && r.playable.has(o.card.id);
      this.tweenFx(o, ok ? 1 : 0, ok || mustDraw ? 0 : 1);
    }
    this.tweenFx(this.deckTop, r.canDraw && !mustDraw ? 1 : 0, 0);
    this.drawCue.visible = mustDraw;
    this.cueT = 0;
    void this.relayout(0, 0.18);
    this.kick();
  }

  private clearPickFx(keep: number): void {
    for (const o of this.hands[0]) if (!o.card || o.card.id !== keep) this.tweenFx(o, 0, 0);
    this.tweenFx(this.deckTop, 0, 0);
    this.drawCue.visible = false;
    const h = this.hands[0];
    const pose = newPose();
    for (let i = 0; i < h.length; i++) {
      const o = h[i];
      if (o.held || (o.card && o.card.id === keep)) continue;
      this.handPose(0, i, h.length, pose, o);
      void this.fly(o, pose, { dur: 0.18 });
    }
    this.kick();
  }

  private resolvePick(v: number | 'draw'): void {
    const r = this.req;
    if (!r) return;
    if (this.peek?.seat === 0) this.peek = null;
    this.req = null;
    this.reqGen++;
    this.sfx('select');
    if (typeof v === 'number') {
      const o = this.hands[0].find((x) => x.card?.id === v);
      if (o) {
        this.tweenFx(o, 0.6, 0);
        if (o.held) this.dropped = o;
        else {
          // a little pop forward so the pick reads before the throw
          const p = o.pos.clone().addScaledVector(tmpV.set(0, 1, 0.3).applyQuaternion(this.layoutCam.quaternion), this.fan.ch * this.worldPerPx(HAND_D) * 0.12);
          void this.fly(o, { pos: p, quat: o.quat.clone(), s: o.s }, { dur: 0.1 });
        }
        o.held = false;
      }
      this.clearPickFx(v);
    } else this.clearPickFx(-1);
    try {
      r.resolve(v);
    } catch (e) {
      console.error('[render] pick resolve failed', e);
    }
  }

  private shakeCard(o: CardObj): void {
    const idx = this.hands[0].indexOf(o);
    if (idx < 0) return;
    const base = this.handPose(0, idx, this.hands[0].length, newPose(), o);
    const tok = ++o.token;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.layoutCam.quaternion);
    const amp = this.fan.cw * this.worldPerPx(HAND_D) * 0.08;
    void this.anim.tween(0.32, (_k, raw) => {
      if (o.token !== tok) return;
      const w = Math.sin(raw * Math.PI * 6) * (1 - raw);
      o.pos.copy(base.pos).addScaledVector(right, w * amp);
      o.quat.copy(base.quat).multiply(tmpQ.setFromAxisAngle(tmpV.set(0, 0, 1), w * 0.08));
    });
    this.kick();
  }

  // ───────────────────────── input ─────────────────────────

  private attachInput(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', this.onDown);
    c.addEventListener('pointermove', this.onMove);
    c.addEventListener('pointerup', this.onUp);
    c.addEventListener('pointercancel', this.onCancel);
    c.addEventListener('pointerleave', this.onLeave);
  }

  private detachInput(): void {
    const c = this.canvas;
    if (!c) return;
    c.removeEventListener('pointerdown', this.onDown);
    c.removeEventListener('pointermove', this.onMove);
    c.removeEventListener('pointerup', this.onUp);
    c.removeEventListener('pointercancel', this.onCancel);
    c.removeEventListener('pointerleave', this.onLeave);
  }

  private localXY(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / Math.max(1, r.width)) * this.W, y: ((e.clientY - r.top) / Math.max(1, r.height)) * this.H };
  }

  private lifts: number[] = [];
  private hitHand(x: number, y: number): number {
    const h = this.hands[0];
    if (this.fan.slots.length !== h.length) this.fan = L.fanLayout(h.length, { W: this.W, H: this.H });
    this.lifts.length = h.length;
    for (let i = 0; i < h.length; i++) this.lifts[i] = this.liftPx(h[i]);
    return L.hitFan(this.focusFan(), x, y, this.lifts);
  }

  private hitDeck(x: number, y: number): boolean {
    if (this.deckCount <= 0) return false;
    this.toScreen(tmpV.set(this.deckPos.x, this.deckH(), this.deckPos.z), scr);
    const cx = scr.x;
    const cy = scr.y;
    this.toScreen(tmpV.set(this.deckPos.x, this.deckH(), this.deckPos.z - L.CARD_H / 2), scr);
    const r = Math.max(28, Math.abs(cy - scr.y) * 1.3);
    return Math.abs(x - cx) < r * 0.85 && Math.abs(y - cy) < r;
  }

  /** own hand hit (on the fan as drawn, the focused card included) */
  private hitHandPeek(x: number, y: number): number {
    return this.hitHand(x, y);
  }

  private quadPts = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private quadPx = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];

  /** the topmost open-hand (partner) card under screen px (x, y), projecting its current pose */
  private hitOpen(x: number, y: number): { seat: number; o: CardObj } | null {
    let best: { seat: number; o: CardObj } | null = null;
    let bestY = -Infinity;
    const cam = this.camera;
    for (const s of this.seats) {
      if (!this.isOpen(s)) continue;
      const h = this.hands[s];
      for (let i = 0; i < h.length; i++) {
        const o = h[i];
        // each card stands in front of its left neighbour; a peeked card is in front of all
        const rank = this.peek?.o === o ? 1e9 : s * 1000 + i;
        if (!o.vis || !o.card || rank <= bestY) continue;
        const hw = (L.CARD_W / 2) * o.s;
        const hh = (L.CARD_H / 2) * o.s;
        const c = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
        for (let k = 0; k < 4; k++) {
          const v = this.quadPts[k].set(c[k][0], c[k][1], 0).applyQuaternion(o.quat).add(o.pos);
          const pr = v.project(cam);
          this.quadPx[k].x = (pr.x * 0.5 + 0.5) * this.W;
          this.quadPx[k].y = (1 - (pr.y * 0.5 + 0.5)) * this.H;
        }
        let pos = 0;
        let neg = 0;
        for (let k = 0; k < 4; k++) {
          const a = this.quadPx[k];
          const b = this.quadPx[(k + 1) % 4];
          const cr = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
          if (cr > 0) pos++;
          else if (cr < 0) neg++;
        }
        if (pos === 0 || neg === 0) {
          best = { seat: s, o };
          bestY = rank;
        }
      }
    }
    return best;
  }

  private onDown = (e: PointerEvent): void => {
    if (this.ptr.id !== -1) return;
    const { x, y } = this.localXY(e);
    const touch = e.pointerType !== 'mouse';
    const idx = this.hitHandPeek(x, y);
    let kind: '' | 'hand' | 'open' | 'deck' = '';
    let wasPeek = false;
    if (idx >= 0) {
      kind = 'hand';
    } else {
      const op = this.hitOpen(x, y);
      if (op) {
        kind = 'open';
        wasPeek = this.peek?.o === op.o;
        this.setPeek(op.seat, op.o);
      } else if (this.req && this.hitDeck(x, y)) kind = 'deck';
    }
    if (!kind) {
      // a tap on the table lets go of the focused card
      this.setPeek(0, null);
      return;
    }
    this.ptr = { id: e.pointerId, x0: x, y0: y, x, y, idx, deck: kind === 'deck', dragging: false, t: performance.now(), kind, slid: false, touch, wasPeek };
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  private onMove = (e: PointerEvent): void => {
    const p = this.ptr;
    if (e.pointerId !== p.id) return;
    const { x, y } = this.localXY(e);
    p.x = x;
    p.y = y;
    const dxAbs = Math.abs(x - p.x0);
    if (p.kind === 'open') {
      if (!p.slid && Math.hypot(x - p.x0, y - p.y0) > 10) p.slid = true;
      if (p.slid) {
        const op = this.hitOpen(x, y);
        if (op) this.setPeek(op.seat, op.o);
      }
      return;
    }
    if (p.kind !== 'hand') return;
    const o = this.hands[0][p.idx];
    if (!p.dragging && !p.slid) {
      const up = p.y0 - y;
      // any card can be dragged on your turn; only a playable one is played when dropped
      if (up > 14 && up > dxAbs && o && o.card && this.req) {
        p.dragging = true;
        this.peek = null;
        o.held = true;
        o.token++;
      } else if (dxAbs > 10) p.slid = true;
    }
    if (p.dragging) {
      if (!o) return;
      this.pxToWorld(x, y - this.fan.ch * 0.3, HAND_D * 0.92, o.pos);
      o.quat.copy(this.layoutCam.quaternion);
      this.kick();
      return;
    }
    if (p.slid) {
      // sliding along the fan moves the peek to the card under the finger
      const i = this.hitHandPeek(x, y);
      if (i >= 0) {
        p.idx = i;
        this.setPeek(0, this.hands[0][i]);
      }
    }
  };

  private onUp = (e: PointerEvent): void => {
    const p = this.ptr;
    if (e.pointerId !== p.id) return;
    this.ptr.id = -1;
    const { x, y } = this.localXY(e);
    const moved = Math.hypot(x - p.x0, y - p.y0);
    const r = this.req;
    if (p.kind === 'deck') {
      if (r && moved < 18 && this.hitDeck(x, y)) {
        if (r.canDraw) this.resolvePick('draw');
        else {
          this.sfx('invalid');
          void this.deckHop(1);
          this.kick();
        }
      }
      return;
    }
    if (p.kind === 'open') {
      // partner cards are never playable: a tap toggles the peek, a slide just ends it
      if (p.slid || p.wasPeek) this.setPeek(0, null);
      return;
    }
    const o = this.hands[0][p.idx];
    if (!o) return;
    const ok = !!r && !!o.card && r.playable.has(o.card.id);
    if (p.dragging) {
      const far = p.y0 - y > Math.max(50, this.fan.ch * 0.6);
      if (far && ok) return this.resolvePick(o.card!.id);
      o.held = false;
      if (far) {
        this.sfx('invalid');
        this.shakeCard(o);
      }
      void this.relayout(0, 0.2);
      this.kick();
      return;
    }
    if (p.slid) return;
    // a tap only focuses the card (tap it again to let go); playing takes a drag
    if (moved < 16) this.setPeek(0, this.peek?.seat === 0 && this.peek.o === o ? null : o);
  };

  private onCancel = (e: PointerEvent): void => {
    if (e.pointerId !== this.ptr.id) return;
    const o = this.hands[0][this.ptr.idx];
    this.ptr.id = -1;
    if (o && o.held) {
      o.held = false;
      void this.relayout(0, 0.2);
    }
    this.kick();
  };

  private onLeave = (_e: PointerEvent): void => {
    // the focus stays when the mouse leaves (no hover behaviour)
  };
  // ───────────────────────── plates ─────────────────────────

  private platesDirty(): void {
    this.emitPlates();
  }

  private emitPlates(): void {
    const cb = this.opts.onPlates;
    if (!cb || this.disposed) return;
    const list: L.PlateSeat[] = this.seats.map((s) => {
      const side = this.sideOf(s);
      const n = this.hands[s].length;
      return {
        seat: s, side, count: n, hand: side === 'bottom' ? null : this.handFor(s, Math.max(1, n)),
        active: this.turnSeat === s, winner: this.winner === s, scale: this.plateScale[s], visible: this.platesOn,
      };
    });
    // the deck / pile on screen
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const [x, z] of [[this.deckPos.x - 0.4, -0.55], [this.pilePos.x + 0.4, -0.55], [this.deckPos.x - 0.4, 0.6], [this.pilePos.x + 0.4, 0.6]]) {
      this.toScreen(tmpV.set(x, 0.1, z), scr);
      x0 = Math.min(x0, scr.x);
      x1 = Math.max(x1, scr.x);
      y0 = Math.min(y0, scr.y);
      y1 = Math.max(y1, scr.y);
    }
    const pile: L.Box = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
    const out = L.layoutPlates(this.W, this.H, this.portrait, (x, y, z, o) => L.projectCss(this.viewProj.elements, x, y, z, this.W, this.H, o), list, this.hands[0].length, pile).plates;
    for (const p of out) {
      const sh = this.plateShake[p.seat];
      if (sh) {
        p.x += sh;
        if (p.bubble) p.bubble.x += sh;
      }
    }
    const sig = out.map((p) => `${p.seat}:${p.x.toFixed(1)}:${p.y.toFixed(1)}:${p.w}:${p.scale.toFixed(3)}:${+p.visible}${+p.active}${+p.winner}:${p.count}`).join('|');
    if (sig === this.plateSig) return;
    this.plateSig = sig;
    this.plates = out;
    try {
      cb(out);
    } catch (e) {
      console.error('[render] onPlates failed', e);
    }
  }

  /** the last plate boxes sent (dev / tests) */
  get platesNow(): readonly SeatPlate[] {
    return this.plates;
  }

  // ───────────────────────── loop ─────────────────────────

  /** the direction arrows turn slowly while a round is on (not with reduced motion) */
  private spinning(): boolean {
    return this.platesOn && !this.reduced && !this.paused;
  }

  private arrowMoving(): boolean {
    return this.turnArrow.visible && Math.abs(this.arrowTarget - this.arrowYaw) > 0.002;
  }

  private kick(): void {
    this.loop.kick();
  }

  private checkAwake = (): void => {
    if (this.paused || this.disposed || this.loop.scheduled) return;
    if (!this.anim.active && this.busy === 0 && !this.dust.busy && !this.confetti.busy) return;
    this.lastT = 0;
    this.kick();
  };

  private loopFrame(now: number): boolean {
    const hard = this.anim.active || this.dust.busy || this.confetti.busy || this.ptr.dragging || this.push > 0 || this.drawCue.visible || this.arrowMoving() || this.spinning();
    const woke = this.lastT === 0;
    const minGap = hard ? this.q.frameMs : 0;
    if (!woke && minGap > 0 && now - this.lastRender < minGap && now >= this.lastRender) return true;
    let dt = woke ? 1 / 60 : (now - this.lastT) / 1000;
    const maxDt = this.loop.fromTimer ? 0.5 : this.q.maxDt;
    if (dt > maxDt) dt = maxDt;
    if (dt < 0) dt = 0;
    this.lastT = now;
    this.lastRender = now;
    const w0 = this.perf ? performance.now() : 0;
    this.update(dt);
    this.renderer.render(this.scene, this.camera);
    if (this.perf) this.perf.frame(now, performance.now() - w0, this.renderer, this.quality, [this.scene], this.q.aa);
    if (this.opts.onFrameStats) this.sampleFrame(now, hard && !woke);
    const more = this.anim.active || this.dust.busy || this.confetti.busy || this.ptr.dragging || this.push > 0 || this.drawCue.visible || this.arrowMoving() || this.spinning();
    if (!more) this.lastT = 0;
    return more;
  }

  private sampleFrame(now: number, active: boolean): void {
    const s = this.fstat;
    if (!active || s.prev === 0 || now - s.prev > 250) {
      s.prev = active ? now : 0;
      s.skip = 3;
      s.start = now;
      s.sum = 0;
      s.n = 0;
      return;
    }
    const d = now - s.prev;
    s.prev = now;
    if (s.skip > 0) {
      s.skip--;
      s.start = now;
      return;
    }
    s.sum += d;
    s.n++;
    if (now - s.start >= 1000) {
      const o = this.fstatOut;
      o.avgFrameMs = s.sum / s.n;
      o.frames = s.n;
      o.quality = this.quality;
      s.start = now;
      s.sum = 0;
      s.n = 0;
      try {
        this.opts.onFrameStats?.(o);
      } catch {
        /* ignore */
      }
    }
  }

  private update(dt: number): void {
    if (this.spinning() && !this.dirFx) this.dirRing.rotation.y += dt * DIR_SPIN * -Math.sign(this.dirRing.scale.x || 1); // along the way the arrows point (mirrored ring: minus)
    if (this.turnArrow.visible) {
      this.arrowYaw += (this.arrowTarget - this.arrowYaw) * Math.min(1, dt * (this.reduced ? 60 : 9));
      const r = this.portrait ? 0.95 : 1.05;
      this.turnArrow.position.set(this.pilePos.x + Math.sin(this.arrowYaw) * r, 0.006, this.pilePos.z + Math.cos(this.arrowYaw) * r);
      this.turnArrow.rotation.y = this.arrowYaw;
      if (!this.reduced) {
        // a gentle breath: a touch larger and brighter, about every two seconds
        const k = Math.sin((this.turnArrow.userData.t = (this.turnArrow.userData.t + dt * 3.1) % (Math.PI * 2)));
        this.turnArrow.scale.setScalar(1 + 0.07 * k);
        (this.turnArrow.material as THREE.MeshBasicMaterial).opacity = 0.84 + 0.14 * k;
      }
    }
    if (this.drawCue.visible) {
      // hop over the deck: a bounce (fast up, ease down) and a slow spin
      this.cueT += dt;
      const hop = Math.abs(Math.sin(this.cueT * 3.2));
      this.drawCue.position.set(this.deckPos.x, this.deckH() + 0.5 + hop * 0.28, this.deckPos.z);
      this.drawCue.rotation.y = this.cueT * 1.4;
    }
    this.anim.update(dt);
    if (this.needsSettle && this.busy === 0 && !this.anim.active) {
      this.needsSettle = false;
      void this.settleAll(0.25);
    }
    const sdt = dt * this.anim.speed;
    this.dust.update(sdt);
    this.confetti.update(sdt);
    // camera push-in (¡Ku!)
    this.camera.position.copy(this.layoutCam.position);
    if (this.push > 0) this.camera.position.lerp(this.pushTarget, 0.12 * this.push);
    this.camera.updateMatrixWorld();
    // plates follow a pulse
    if (this.plateScale.some((v) => v !== 1) || this.plateShake.some((v) => v !== 0)) this.emitPlates();

    this.writeInstances();
  }

  private writeInstances(): void {
    const cells = this.aCell.array as Float32Array;
    const fx = this.aFx.array as Float32Array;
    const mesh = this.cards;
    for (let i = 0; i < POOL; i++) {
      const o = this.pool[i];
      if (!o.vis) {
        mesh.setMatrixAt(i, ZERO_M);
        continue;
      }
      tmpS.set(o.s * o.sqx, o.s * o.sqy, o.s);
      tmpM.compose(o.pos, o.quat, tmpS);
      mesh.setMatrixAt(i, tmpM);
      cells[i * 2] = CELL_UV[o.cell * 2];
      cells[i * 2 + 1] = CELL_UV[o.cell * 2 + 1];
      fx[i * 3] = o.glow;
      fx[i * 3 + 1] = o.dim;
      fx[i * 3 + 2] = o.card ? 1 : 0;
    }
    // camera push-in (Ku): the human hand lives in front of the un-pushed camera, so it rides along
    if (this.push > 0) {
      const dv = tmpV2.subVectors(this.camera.position, this.layoutCam.position);
      for (const o of this.hands[0]) {
        if (!o.vis) continue;
        tmpS.set(o.s * o.sqx, o.s * o.sqy, o.s);
        tmpM.compose(tmpV.copy(o.pos).add(dv), o.quat, tmpS);
        mesh.setMatrixAt(o.i, tmpM);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.aCell.needsUpdate = true;
    this.aFx.needsUpdate = true;
    this.writeReflections();
  }

  /** mirror every opponent's hand card under the felt */
  private writeReflections(): void {
    const r = this.refl;
    const rc = this.reflCell.array as Float32Array;
    const rf = this.reflFace.array as Float32Array;
    let k = 0;
    for (let s = 1; s < this.hands.length && k < REFL_MAX; s++) {
      for (const o of this.hands[s]) {
        if (!o.vis || k >= REFL_MAX) continue;
        tmpS.set(o.s * o.sqx, o.s * o.sqy, o.s);
        tmpM.compose(o.pos, o.quat, tmpS).premultiply(MIRROR_Y);
        r.setMatrixAt(k, tmpM);
        rc[k * 2] = CELL_UV[o.cell * 2];
        rc[k * 2 + 1] = CELL_UV[o.cell * 2 + 1];
        rf[k] = o.card ? 1 : 0;
        k++;
      }
    }
    r.count = k;
    r.instanceMatrix.needsUpdate = true;
    this.reflCell.needsUpdate = true;
    this.reflFace.needsUpdate = true;
  }

  // ───────────────────────── public API ─────────────────────────

  setTurn(seat: Seat | null): void {
    this.turnSeat = seat;
    this.aimTurnArrow();
    this.emitPlates();
  }

  /** point the turn triangle at the current seat (it glides there in update) */
  private aimTurnArrow(): void {
    const seat = this.turnSeat;
    this.turnArrow.visible = seat !== null && this.platesOn;
    if (seat === null) return;
    const a = this.anchorOf(seat);
    const target = Math.atan2(a.x - this.pilePos.x, a.z - this.pilePos.z);
    if (!this.turnArrow.userData.aimed) {
      this.arrowYaw = target;
      this.turnArrow.userData.aimed = true;
    }
    // the shortest way round
    let d = target - this.arrowYaw;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    this.arrowTarget = this.arrowYaw + d;
    this.kick();
  }

  reset(): void {
    this.gen++;
    this.anim.finishAll();
    this.cancelHumanPick();
    this.clearTable();
    this.chosen.clear();
    this.platesOn = false;
    this.turnSeat = null;
    this.turnArrow.visible = false;
    this.turnArrow.userData.aimed = false;
    this.push = 0;
    this.direction = 1;
    this.dirRing.scale.x = Math.abs(this.dirRing.scale.x) * this.ringScaleSign(1);
    this.glowRing.visible = false;
    this.activeColor = null;
    this.setDeckCount(DECK_GUESS);
    this.fan = L.fanLayout(0, { W: this.W, H: this.H });
    this.emitPlates();
    this.kick();
  }

  async restore(state: RestoreState): Promise<void> {
    this.gen++;
    this.anim.finishAll();
    this.cancelHumanPick();
    const g = this.gen;
    const prev = this.queue;
    const run = async () => {
      if (!this.live(g)) return;
      this.clearTable();
      const R = state.round;
      if (state.seats?.length) this.seats = state.seats.slice();
      this.platesOn = true;
      for (const s of this.seats) {
        const cards = s === 0 ? L.sortHand(R.hands[s] ?? []) : R.hands[s] ?? [];
        for (const c of cards) {
          const o = this.alloc();
          if (!o) break;
          if (s === 0) this.setFace(o, c);
          else this.remember(c);
          this.hands[s].push(o);
        }
        this.eliminated[s] = !!R.eliminated?.[s];
      }
      for (const c of R.discard) this.remember(c);
      this.discardCount = R.discard.length;
      const topId = R.discard[R.discard.length - 1]?.id;
      for (const c of R.discard.slice(-PILE_KEEP)) {
        const o = this.alloc();
        if (!o) break;
        this.setFace(o, c, this.chosen.get(c.id) ?? (c.id === topId ? R.activeColor : null));
        this.pileJitter(o);
        this.pile.push(o);
      }
      this.deckCount = R.deck.length;
      this.direction = R.direction;
      this.updateArrangement();
      this.dirRing.scale.x = Math.abs(this.dirRing.scale.x) * this.ringScaleSign(R.direction);
      this.setActiveColor(R.activeColor, true);
      this.showBadge(R.pendingDraw, false);
      this.turnSeat = R.turn;
      this.turnArrow.userData.aimed = false;
      this.fan = L.fanLayout(this.hands[0].length, { W: this.W, H: this.H });
      this.snapAll();
      this.aimTurnArrow();
      this.emitPlates();
      this.kick();
    };
    this.queue = prev.then(run, run);
    this.kick();
    return this.queue;
  }

  /** extension: put exactly these cards in the human hand (after a swap / rotate whose faces arrive late) */
  setHand(cards: Card[]): void {
    const sorted = L.sortHand(cards);
    const h = this.hands[0];
    while (h.length < sorted.length) {
      const o = this.alloc();
      if (!o) break;
      this.deckTopPose(this.scratch);
      o.pos.copy(this.scratch.pos);
      o.quat.copy(this.scratch.quat);
      h.push(o);
    }
    while (h.length > sorted.length) this.release(h.pop()!);
    h.forEach((o, i) => this.setFace(o, sorted[i]));
    void this.relayout(0, 0.3);
    if (this.req) this.applyPickFx();
    this.kick();
  }

  /**
   * Show a seat's hand face up (Parejas: the partner's cards), or null to turn it face down again. Called
   * after every change to that hand: it diffs by card id, keeps the cards the fan already shows, gives
   * faces to the others in sorted order and only relayouts when the order or the open state changed.
   * Runs in the event queue so it never fights an event animation.
   */
  setOpenHand(seat: Seat, cards: Card[] | null): void {
    if (seat === 0) return;
    const list = cards ? cards.slice() : null;
    const job = () => {
      if (!this.disposed) this.applyOpen(seat, list);
    };
    this.queue = this.queue.then(job, job);
    this.kick();
  }

  private applyOpen(seat: Seat, cards: Card[] | null): void {
    const h = this.hands[seat];
    const was = this.isOpen(seat);
    if (!cards) {
      if (!was) return;
      this.openCards[seat] = null;
      this.openSig[seat] = '';
      for (const o of h) o.card = null;
      void this.relayout(seat, this.reduced ? 0.2 : 0.4, { arc: this.reduced ? 0 : 0.2 });
      this.platesDirty();
      this.kick();
      return;
    }
    if (!this.teams && !this.teamsExplicit && this.seats.length === 4) {
      // no setTeams from the app: an open hand is the human's partner
      this.teams = [[0, seat], this.seats.filter((s) => s !== 0 && s !== seat)];
      this.applyArrangement();
    }
    const sorted = L.sortHand(cards);
    for (const c of sorted) this.remember(c);
    this.openCards[seat] = sorted;
    const want = new Map(sorted.map((c) => [c.id, c]));
    // keep the faces already shown, then hand the rest out in sorted order
    const used = new Set<number>();
    const loose: CardObj[] = [];
    for (const o of h) {
      const id = o.card?.id;
      if (id !== undefined && want.has(id) && !used.has(id)) used.add(id);
      else loose.push(o);
    }
    const rest = sorted.filter((c) => !used.has(c.id));
    loose.forEach((o, i) => {
      if (rest[i]) this.setFace(o, rest[i]);
      else o.card = null;
    });
    this.sortOpen(seat);
    // an open hand the camera framing did not expect: frame again and move everything to the new view
    if (this.refit()) void this.settleAll(0.3);
    const sig = h.map((o) => o.card?.id ?? -1).join(',');
    if (was && sig === this.openSig[seat]) return;
    this.openSig[seat] = sig;
    void this.relayout(seat, was ? 0.25 : this.reduced ? 0.2 : 0.42, { arc: was || this.reduced ? 0 : 0.25, ease: ease.inOutCubic });
    this.platesDirty();
    this.kick();
  }

  /** order an open hand: known faces sorted by colour then value, unknown ones last */
  private sortOpen(seat: number): void {
    this.hands[seat].sort((a, b) => (a.card && b.card ? L.cardOrder(a.card, b.card) : a.card ? -1 : b.card ? 1 : 0));
  }

  /** extension: Parejas teams (team A teal, team B coral glow on the felt behind each seat); null = none */
  setTeams(teams: [Seat[], Seat[]] | null): void {
    this.teams = teams ? [teams[0].slice(), teams[1].slice()] : null;
    this.teamsExplicit = true;
    this.applyArrangement();
  }

  /** seats / teams changed: move fans, plates, ring and the felt tint to the new arrangement */
  private applyArrangement(): void {
    let changed = this.updateArrangement();
    changed = this.refit() || changed;
    this.syncFelt();
    if (changed) {
      if (this.busy === 0 && !this.anim.active) this.snapAll();
      else void this.settleAll(0.3);
    }
    this.platesDirty();
    this.kick();
  }

  /** extension: card faces by id (e.g. the match's deck) so swept / revealed opponent cards show faces */
  setDeck(cards: readonly Card[]): void {
    for (const c of cards) this.faces.set(c.id, c.face);
  }

  setQuality(q: Quality): void {
    if (q === this.quality || !QUALITY[q]) return;
    const prev = this.q;
    this.quality = q;
    this.q = QUALITY[q];
    if (prev.aa !== this.q.aa) this.createRenderer();
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(this.W, this.H, false);
    if (prev.atlas !== this.q.atlas) {
      this.atlasCanvas = A.drawAtlas(this.q.atlas, this.faceMap);
      const old = this.atlasTex;
      this.atlasTex = A.makeTexture(this.atlasCanvas.canvas, true);
      this.cardMat.uniforms.uAtlas.value = this.atlasTex;
      old.dispose();
    }
    this.applyQualityKnobs();
    this.computeLayout();
    this.snapAll();
    this.lastT = 0;
    this.kick();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) {
      this.lastT = 0;
      this.kick();
    } else this.loop.cancel();
  }

  private applySpeed(): void {
    this.anim.speed = this.speedMul * (this.reduced ? 1.35 : 1);
  }

  setSpeed(x: number): void {
    this.speedMul = Math.max(0.1, Number.isFinite(x) ? x : 1);
    this.applySpeed();
  }

  setReducedMotion(r: boolean): void {
    this.reduced = r;
    this.applySpeed();
  }

  setTableStyle(s: TableStyle): void {
    if (!A.TABLE_STYLE_DEFS[s]) return;
    this.tableStyle = s;
    this.syncFelt(true);
    this.kick();
  }

  setCardBack(b: CardBack): void {
    this.cardBack = b;
    this.backTex.image = A.drawBack(b, 256);
    this.backTex.needsUpdate = true;
    this.kick();
  }

  /** dev: is a frame pending? (idle check in the harness) */
  get frameScheduled(): boolean {
    return this.loop.scheduled;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gen++;
    this.reqGen++;
    this.req = null;
    this.loop.cancel();
    window.clearInterval(this.heartbeat);
    window.removeEventListener('resize', this.onResize);
    this.resizeObs?.disconnect();
    this.detachInput();
    this.anim.clear();
    this.cardGeo.dispose();
    this.cardMat.dispose();
    this.cards.dispose();
    this.atlasTex.dispose();
    this.backTex.dispose();
    this.felt.geometry.dispose();
    (this.felt.material as THREE.Material).dispose();
    this.feltTex?.dispose();
    this.refl.geometry.dispose();
    (this.refl.material as THREE.Material).dispose();
    this.turnArrow.geometry.dispose();
    (this.turnArrow.material as THREE.MeshBasicMaterial).map?.dispose();
    (this.turnArrow.material as THREE.Material).dispose();
    this.drawCue.geometry.dispose();
    (this.drawCue.material as THREE.Material).dispose();
    this.glowRing.geometry.dispose();
    (this.glowRing.material as THREE.Material).dispose();
    this.glowTex.dispose();
    this.dirRing.geometry.dispose();
    (this.dirRing.material as THREE.Material).dispose();
    this.dirTex.dispose();
    this.boxGeo.dispose();
    this.pileGeo.dispose();
    this.boxMat.dispose();
    (this.deckRefl.material as THREE.Material).dispose();
    this.stamp.material.dispose();
    this.stampTex.dispose();
    this.badge.material.dispose();
    this.badgeTex.dispose();
    this.penBadge.material.dispose();
    this.penTex.dispose();
    this.dome.geometry.dispose();
    this.domeMat.dispose();
    this.flash.material.dispose();
    this.flashTex.dispose();
    for (const sp of this.skipStamps) sp.material.dispose();
    this.skipBig.material.dispose();
    this.skipTex.dispose();
    this.penBig.material.dispose();
    this.penMarkTex.dispose();

    this.dust.dispose();
    this.confetti.dispose();
    this.perf?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
