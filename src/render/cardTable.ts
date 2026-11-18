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
  fountain: number;
}

export const QUALITY: Record<Quality, QualityCfg> = {
  low: { dpr: 1, aa: false, atlas: 1024, frameMs: 28, maxDt: 0.1, particles: 60, confetti: 90, felt: 512, aniso: 1, fountain: 10 },
  medium: { dpr: 1.5, aa: true, atlas: 1024, frameMs: 0, maxDt: 0.1, particles: 160, confetti: 200, felt: 1024, aniso: 2, fountain: 18 },
  high: { dpr: 2, aa: true, atlas: 2048, frameMs: 0, maxDt: 0.05, particles: 300, confetti: 300, felt: 1024, aniso: 4, fountain: 26 },
};

const POOL = 220;
const PILE_KEEP = 8;
const HUD_TOP = 56;
/** distance of the human hand in front of the camera (world units) */
const HAND_D = 2.4;
const DECK_GUESS = 108;
const UP = new THREE.Vector3(0, 1, 0);
const Q_LAY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const Q_FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const CONFETTI: [number, number, number][] = [
  [1, 0.714, 0.153], [0.078, 0.639, 0.627], [0.298, 0.686, 0.314], [1, 0.435, 0.38], [1, 0.965, 0.902],
];
const KU_COLS: [number, number, number][] = [
  [1, 0.714, 0.153], [0.078, 0.639, 0.627], [0.298, 0.686, 0.314], [1, 0.435, 0.38],
];
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
  sol: new THREE.Color(A.COLOR_HEX.sol),
  mar: new THREE.Color(A.COLOR_HEX.mar),
  palma: new THREE.Color(A.COLOR_HEX.palma),
  coral: new THREE.Color(A.COLOR_HEX.coral),
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
  private aCell!: THREE.InstancedBufferAttribute;
  private aFx!: THREE.InstancedBufferAttribute;
  private felt!: THREE.Mesh;
  private feltTex: THREE.CanvasTexture | null = null;
  private feltKey = '';
  private edgeTex!: THREE.CanvasTexture;
  private boxGeo!: THREE.BoxGeometry;
  private boxMat!: THREE.MeshBasicMaterial;
  private deckBox!: THREE.Mesh;
  private pileBox!: THREE.Mesh;
  private glowRing!: THREE.Mesh;
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
  /** quick skip stamps (Salto total: one per skipped seat) */
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
    this.dirTex = A.makeTexture(A.drawDirRing(512), true);
    this.dirRing = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: this.dirTex, transparent: true, depthWrite: false, opacity: 0.28 }),
    );
    this.dirRing.position.set(0, 0.002, 0.05);
    this.dirRing.renderOrder = -6;
    this.scene.add(this.dirRing);
    // deck / pile edges (one shared box geometry + material)
    this.edgeTex = A.makeTexture(A.drawEdge(64), false);
    this.edgeTex.wrapS = this.edgeTex.wrapT = THREE.RepeatWrapping;
    this.boxGeo = new THREE.BoxGeometry(L.CARD_W * 0.97, 1, L.CARD_H * 0.97);
    this.boxMat = new THREE.MeshBasicMaterial({ map: this.edgeTex });
    this.deckBox = new THREE.Mesh(this.boxGeo, this.boxMat);
    this.pileBox = new THREE.Mesh(this.boxGeo, this.boxMat);
    this.scene.add(this.deckBox, this.pileBox);
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
    // skip stamps share one pre-drawn texture
    const sc = document.createElement('canvas');
    sc.width = sc.height = 128;
    A.drawStamp(sc.getContext('2d')!, 128, 'skip');
    this.skipTex = A.makeTexture(sc, false);
    const skipMat = new THREE.SpriteMaterial({ map: this.skipTex, depthTest: false, depthWrite: false, transparent: true });
    for (let i = 0; i < 5; i++) {
      const sp = new THREE.Sprite(skipMat.clone());
      sp.renderOrder = 20;
      sp.visible = false;
      this.skipStamps.push(sp);
      this.scene.add(sp);
    }
    skipMat.dispose();
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
    const d = this.dims;
    const w = 2 * d.A + 0.3;
    const h = 2 * d.B + 0.3;
    const tints: A.FeltTint[] = [];
    if (this.teams) {
      this.teams.forEach((team, ti) => {
        for (const st of team) {
          if (!this.seats.includes(st)) continue;
          // the human's glow sits at their corner / edge, the others' behind their fans
          const an = st === 0 ? { x: 0, z: d.B - 0.55 } : this.anchorOf(st);
          tints.push({ u: an.x / w + 0.5, v: an.z / h + 0.5, r: 1.5 / Math.min(w, h), color: TEAM_TINT[ti] });
        }
      });
    }
    const key = `${this.tableStyle}:${w.toFixed(2)}:${h.toFixed(2)}:${this.q.felt}:${tints.map((t) => t.color + t.u.toFixed(2) + t.v.toFixed(2)).join()}`;
    this.felt.scale.set(w, 1, h);
    if (!force && key === this.feltKey) return;
    this.feltKey = key;
    const c = A.drawFelt(this.tableStyle, w / h, this.q.felt, tints);
    const old = this.feltTex;
    this.feltTex = A.makeTexture(c, true);
    this.feltTex.anisotropy = this.q.aniso;
    const m = this.felt.material as THREE.MeshBasicMaterial;
    m.map = this.feltTex;
    m.needsUpdate = true;
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
    const fan7 = L.fanLayout(7, { W, H });
    const sep = this.portrait ? 0.58 : 0.66;
    this.deckPos.set(-sep, 0, 0.05);
    this.pilePos.set(sep, 0, 0.05);
    this.glowRing.position.set(this.pilePos.x, 0.003, this.pilePos.z);
    const R = this.portrait ? Math.min(1.75, this.dims.A - 0.2) : 1.6;
    this.dirRing.scale.set(R * 2 * this.ringScaleSign(), 1, R * 2);
    // camera: fixed tilt, distance searched so the felt fits between the HUD and the bottom edge
    const cam = this.layoutCam;
    cam.fov = this.portrait ? 42 : 36;
    cam.aspect = W / H;
    cam.updateProjectionMatrix();
    // Codo a codo: a lower camera so the side fans lie flat but read well
    const tilt = this.portrait ? 0.4 : this.sideMode ? 0.66 : 0.56;

    const dir = tmpV2.set(0, Math.cos(tilt), Math.sin(tilt));
    const top = HUD_TOP * 0.55;
    // the human hand covers the felt's near edge; keep the centre above the hand
    const bottom = H + (H - fan7.top) * (this.portrait ? 0.35 : -0.3);
    let tz = 0.35;
    const place = (dist: number) => {
      cam.position.set(0, 0, tz).addScaledVector(dir, dist);
      cam.lookAt(0, 0, tz);
      cam.updateMatrixWorld(true);
      this.viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    };
    const bbox = { x0: 0, x1: 0, y0: 0, y1: 0 };
    const pts = [[0, 0], [0, 0], [0, 0], [0, 0]];
    const measure = () => {
      bbox.x0 = bbox.y0 = Infinity;
      bbox.x1 = bbox.y1 = -Infinity;
      for (const [x, z] of pts) {
        L.projectCss(this.viewProj.elements, x, 0, z, W, H, scr);
        bbox.x0 = Math.min(bbox.x0, scr.x);
        bbox.x1 = Math.max(bbox.x1, scr.x);
        bbox.y0 = Math.min(bbox.y0, scr.y);
        bbox.y1 = Math.max(bbox.y1, scr.y);
      }
    };
    let dist = 10;
    /** fit the felt for the current dims; returns the leftover space (px) across and down */
    const fit = (): { sx: number; sy: number } => {
      const ex = this.dims.A + 0.15;
      const ez = this.dims.B + 0.15;
      pts[0] = [-ex, -ez];
      pts[1] = [ex, -ez];
      pts[2] = [-ex, ez];
      pts[3] = [ex, ez];
      tz = 0.35;
      for (let iter = 0; iter < 4; iter++) {
        let lo = 2;
        let hi = 80;
        for (let k = 0; k < 26; k++) {
          const mid = (lo + hi) / 2;
          place(mid);
          measure();
          const fits = bbox.x1 - bbox.x0 <= W - 8 && bbox.y1 - bbox.y0 <= bottom - top;
          if (fits) hi = mid;
          else lo = mid;
        }
        dist = hi;
        place(dist);
        measure();
        const cy = (bbox.y0 + bbox.y1) / 2;
        const want = (top + bottom) / 2;
        const unitsPerPx = (2 * ez) / Math.max(1, bbox.y1 - bbox.y0);
        tz += (cy - want) * unitsPerPx * 0.9;
      }
      place(dist);
      measure();
      return { sx: W - 8 - (bbox.x1 - bbox.x0), sy: bottom - top - (bbox.y1 - bbox.y0) };
    };
    // stretch the felt along the free direction so it fills the screen (tall phones: a deeper table)
    for (let k = 0; k < 30; k++) {
      const f = fit();
      if (f.sy > 24 && this.dims.B < 5) this.dims.B += 0.12;
      else if (f.sx > 24 && this.dims.A < 6.5) this.dims.A += 0.12;
      else break;
    }
    place(dist);
    this.refreshPartnerArea();
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

  private handPose(seat: number, idx: number, n: number, out: Pose, o?: CardObj): Pose {
    if (seat === 0) {
      const f = n === this.fan.slots.length ? this.fan : (this.fan = L.fanLayout(n, { W: this.W, H: this.H }));
      const sl = f.slots[Math.min(idx, f.slots.length - 1)];
      if (!sl) return this.deckTopPose(out);
      let depth = HAND_D - sl.z * 0.004;
      // peek: the card comes forward and up, its neighbours in the row ease apart
      let dx = 0;
      let lift = 0;
      let rot = sl.rot;
      let sMul = 1;
      const pk = n === this.hands[0].length ? this.peekIdx(0) : -1;
      if (pk >= 0) {
        const sp = f.slots[pk];
        if (idx === pk) {
          lift = f.ch * 0.3;
          depth = HAND_D - 0.3;
          rot *= 0.3;
          sMul = 1.06;
        } else if (sp && sp.row === sl.row) {
          const d = idx - pk;
          dx = Math.sign(d) * f.cw * 0.2 * Math.max(0, 1 - (Math.abs(d) - 1) * 0.45);
        }
      }
      this.pxToWorld(sl.x + dx, sl.y - (o ? this.liftPx(o) : 0) - lift, depth, out.pos);
      out.quat.copy(this.layoutCam.quaternion).multiply(tmpQ.setFromAxisAngle(tmpV.set(0, 0, 1), -rot));
      out.s = ((f.cw * this.worldPerPx(HAND_D)) / L.CARD_W) * sMul;
      return out;
    }
    const side = this.sideOf(seat);
    const partnerSide = side === 'lowerLeft' || side === 'lowerRight';
    if (partnerSide || this.openCards[seat]) {
      const f = partnerSide ? this.partnerFanFor(seat, n) : this.openFanFor(seat, n);
      const p = f.poses[Math.min(idx, f.poses.length - 1)];
      if (!p) return this.deckTopPose(out);
      out.pos.set(p.x, p.y, p.z);
      out.s = f.s;
      if (partnerSide) {
        // flat on the table, upright for the viewer, turned a touch along the arc
        if (this.openCards[seat]) faceUpQ(p.yaw ?? 0, out.quat);
        else return faceDownQ(p.yaw ?? 0, out.quat), out;
      } else {
        out.quat.setFromAxisAngle(Q_TMP_X, -Math.PI / 2 + f.tilt);
        if (!this.openCards[seat]) {
          out.quat.multiply(Q_FLIP);
          return out;
        }
      }
      const pk = n === this.hands[seat].length ? this.peekIdx(seat) : -1;
      if (pk >= 0 && f.poses.length > 1) {
        if (idx === pk) {
          // straight at the camera, nearer and bigger
          tmpV.copy(this.layoutCam.position).sub(out.pos).normalize();
          out.pos.addScaledVector(tmpV, 1.1);
          out.quat.copy(this.layoutCam.quaternion);
          out.s *= 1.15;
        } else if (Math.abs(idx - pk) <= 2) {
          const a = f.poses[Math.max(0, pk - 1)];
          const b = f.poses[Math.min(f.poses.length - 1, pk + 1)];
          const q = f.poses[pk];
          const near = Math.hypot(p.x - q.x, p.z - q.z) <= Math.max(f.step * 2.2, 0.01);
          const len = Math.hypot(b.x - a.x, b.z - a.z);
          if (near && len > 1e-4) {
            const k = (Math.sign(idx - pk) * L.CARD_W * f.s * (Math.abs(idx - pk) === 1 ? 0.2 : 0.1)) / len;
            out.pos.x += (b.x - a.x) * k;
            out.pos.z += (b.z - a.z) * k;
          }
        }
      }
      return out;
    }
    const poses = L.oppFan(n, side, this.dims, this.fanScratch);
    const p = poses[Math.min(idx, poses.length - 1)];
    if (!p) return this.deckTopPose(out);
    out.pos.set(p.x, p.y, p.z);
    faceDownQ(p.yaw, out.quat);
    out.s = L.OPP_SCALE;
    return out;
  }
  private fanScratch: L.TablePose[] = [];
  private openMemo = { key: '', fan: null as L.OpenFan | null };

  /** the open (face-up) fan of a seat with n cards, memoised per layout */
  private openFanFor(seat: number, n: number): L.OpenFan {
    const key = `${seat}:${n}:${this.dims.A.toFixed(3)}:${this.dims.B.toFixed(3)}:${this.portrait}`;
    if (this.openMemo.key !== key || !this.openMemo.fan) {
      // tilt the faces towards the camera (its tilt from vertical is 0.4 portrait / 0.56 landscape)
      this.openMemo = { key, fan: L.openFan(n, this.sideOf(seat), this.dims, this.portrait ? 0.42 : 0.5, L.openScale(this.portrait)) };
    }
    return this.openMemo.fan!;
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

      this.openMemo.key = '';
      this.partnerMemo.key = '';
      this.refreshPartnerArea();
      this.dirRing.scale.x = Math.abs(this.dirRing.scale.x) * this.ringScaleSign();
    }
    return changed;
  }

  /** where a seat's cards sit on the table (the partner corner uses its real fan centre) */
  private anchorOf(seat: number): L.Anchor {
    const side = this.sideOf(seat);
    if (side === 'lowerLeft' || side === 'lowerRight') {
      const f = this.partnerFanFor(seat, Math.max(1, this.hands[seat].length));
      return { x: f.cx, z: f.cz, yaw: 0 };
    }
    return L.seatAnchor(side, this.dims);
  }

  /** opponent fan length limit, or undefined for the default */
  private oppMaxLen(_seat: number): number | undefined {
    return undefined;
  }

  /** direction ring x sign so its chevrons follow play on screen */
  private ringScaleSign(direction: Direction = this.direction): number {
    const pts = this.seats.map((s) => L.seatAnchor(this.sideOf(s), this.dims));
    return L.ringSign(L.turnSpin(pts), direction);
  }

  /** Codo a codo (the partner on a side edge): a lower, more cinematic camera */
  private sideMode = false;
  private partnerZ = 1.5;
  private partnerZFar = -1.5;
  private partnerMemo = { key: '', fan: null as L.OpenFan | null };

  /** the lowest z the partner fan may reach (just above the human hand); true when it moved */
  private refreshPartnerArea(): boolean {
    const ps = this.partnerSeat();
    if (ps < 0 || this.W <= 1) return false;
    const left = this.sideOf(ps) === 'lowerLeft';
    const hf = L.fanLayout(7, { W: this.W, H: this.H });
    const p = this.pxToTable(this.W / 2 + (left ? -1 : 1) * this.W * 0.2, hf.top - 6, tmpV2);
    const z = Math.round(Math.min(this.dims.B, p.z + 0.15) * 50) / 50;
    // the far end leaves a slot under the HUD for the partner's plate (it never covers a card)
    const pd = L.plateDiameter(this.W, this.H);
    const pf = this.pxToTable(left ? this.W * 0.1 : this.W * 0.9, HUD_TOP + pd + 20, tmpV2);
    const zf = Math.round((pf.z + (L.CARD_H * L.partnerScale(this.portrait)) / 2) * 50) / 50;
    if (z === this.partnerZ && zf === this.partnerZFar) return false;
    this.partnerZ = z;
    this.partnerZFar = zf;
    this.partnerMemo.key = '';
    return true;
  }

  private partnerFanFor(seat: number, n: number): L.OpenFan {
    const side = this.sideOf(seat) === 'lowerRight' ? 'lowerRight' : 'lowerLeft';
    const key = `${seat}:${side}:${n}:${this.dims.A.toFixed(3)}:${this.dims.B.toFixed(3)}:${this.partnerZ}:${this.partnerZFar}:${this.portrait}`;
    if (this.partnerMemo.key !== key || !this.partnerMemo.fan) {
      this.partnerMemo = { key, fan: L.partnerFan(n, side, this.dims, this.partnerZ, L.partnerScale(this.portrait), this.partnerZFar) };
    }
    return this.partnerMemo.fan!;
  }
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
    return this.deckCount > 0 ? Math.min(0.42, 0.012 + this.deckCount * 0.0035) : 0;
  }
  private pileH(): number {
    const under = Math.max(0, this.discardCount - this.pile.length);
    return under > 0 ? Math.min(0.2, under * 0.0028) : 0;
  }

  private deckTopPose(out: Pose): Pose {
    out.pos.set(this.deckPos.x, this.deckH() + 0.004, this.deckPos.z);
    faceDownQ(0, out.quat);
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
    this.deckBox.scale.set(1, Math.max(0.001, h), 1);
    this.deckBox.position.set(this.deckPos.x, h / 2, this.deckPos.z);
    this.edgeTex.repeat.set(1, 1);
    const ph = this.pileH();
    this.pileBox.visible = ph > 0.002;
    this.pileBox.scale.set(1, Math.max(0.001, ph), 1);
    this.pileBox.position.set(this.pilePos.x, ph / 2, this.pilePos.z);
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

  private setFace(o: CardObj, card: Card | null): void {
    o.card = card;
    if (!card) return;
    this.faces.set(card.id, card.face);
    const r = this.faceMap.index(card.face);
    if (r.added) {
      A.drawCell(this.atlasCanvas.canvas.getContext('2d')!, this.atlasCanvas.size, r.i, card.face);
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
      if (this.refreshPartnerArea()) void this.relayout(this.partnerSeat(), Math.max(dur, 0.2));
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

  private pileJitter(o: CardObj): void {
    o.jx = (Math.random() - 0.5) * 0.12;
    o.jz = (Math.random() - 0.5) * 0.12;
    o.jyaw = (Math.random() - 0.5) * 0.5;
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

  private setActiveColor(c: Color | null | undefined, instant = false): void {
    if (!c) return;
    const m = this.glowRing.material as THREE.MeshBasicMaterial;
    const to = COLOR_LIN[c];
    this.activeColor = c;
    this.glowRing.visible = true;
    if (instant) {
      m.color.copy(to);
      m.opacity = 0.9;
      return;
    }
    const from = m.color.clone();
    void this.anim.tween(0.35, (k) => {
      m.color.lerpColors(from, to, k);
      m.opacity = 0.9 * (0.6 + 0.4 * Math.sin(Math.PI * Math.min(1, k * 1.5)) + 0.0) + 0.0;
      this.glowRing.scale.setScalar(1 + 0.25 * Math.sin(Math.PI * k));
    }, ease.outQuad);
  }

  private showBadge(total: number, pop = true): void {
    this.stackTotal = total;
    if (total <= 0) {
      this.badge.visible = false;
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
    void this.anim.tween(this.reduced ? 0.1 : 0.32, (k) => {
      const s = this.reduced ? 1 : lerp(1.8, 1, k);
      this.badge.scale.set(w * s, w * 0.5625 * s, 1);
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
    switch (ev.type) {
      case 'deal':
        return this.onDeal(ev, g);
      case 'play':
        return this.onPlay(ev.seat, ev.card, ev.color, g);
      case 'draw':
        return this.onDraw(ev.seat, ev.count, ev.cards, ev.reason, g);
      case 'skip':
        if (this.lastPlayKind === 'skipAll') {
          // Salto total: the play already stamped the seats; stamp any seat it missed
          if (this.skipAllDone.has(ev.seat)) return;
          this.skipAllDone.add(ev.seat);
          return this.quickSkip([ev.seat]);
        }
        this.sfx('pass');
        void this.shakeSeat(ev.seat, 0.05);
        return this.stampAt(ev.seat, 'skip', 0.3);
      case 'reverse':
        return this.onReverse(ev.direction);
      case 'stack':
        this.sfx('charge');
        this.showBadge(ev.total);
        return this.anim.wait(0.3);
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
        this.confettiBurst(this.seatPoint(ev.winner ?? 0, new THREE.Vector3()), 120, 1.2);
        return this.anim.wait(0.6);
      }
      case 'turn':
        this.setTurn(ev.seat);
        return;
      case 'flip':
      default:
        return;
    }
  }

  private async onDeal(ev: Extract<GameEvent, { type: 'deal' }>, g: number): Promise<void> {
    this.anim.finishAll();
    this.clearTable();
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
      jobs.push(
        this.fly(o, pose, {
          dur: 0.42,
          arc: s === 0 ? 0.2 : 0.45,
          delay: k * step,
          ease: ease.outCubic,
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
        o.quat.copy(faceDownQ(Math.sin(Math.PI * raw) * 0.25, tmpQ));
      });
    }
  }

  private async onPlay(seat: Seat, card: Card, color: Color | undefined, g: number): Promise<void> {
    this.remember(card);
    const h = this.hands[seat];
    let idx = -1;
    if (seat === 0) idx = h.findIndex((o) => o.card?.id === card.id);
    if (idx < 0) idx = h.findIndex((o) => o.card?.id === card.id);
    if (idx < 0 && h.length) idx = seat === 0 ? h.findIndex((o) => !o.card) : Math.floor(h.length / 2);
    if (idx < 0 && h.length) idx = h.length - 1;
    let o: CardObj | null = idx >= 0 ? h.splice(idx, 1)[0] : null;
    if (!o) {
      o = this.alloc();
      if (!o) return;
      this.seatPoint(seat, o.pos);
      faceDownQ(0, o.quat);
      o.s = seat === 0 ? 1 : L.OPP_SCALE;
    }
    o.held = false;
    o.fxToken++;
    o.glow = 0;
    o.dim = 0;
    this.setFace(o, card);
    this.pileJitter(o);
    this.pile.push(o);
    this.discardCount++;
    const pose = this.pilePose(this.pile.length - 1, o, newPose());
    const pen = card.face.draw ?? KIND_DRAW[card.face.kind] ?? 0;
    this.lastPlayKind = card.face.kind;
    this.lastPlayDraw = pen;
    this.streamDraw = card.face.kind === 'wildColor';
    this.skipAllDone.clear();
    const slam = pen > 0 || h.length <= 1;
    void this.relayout(seat, 0.3, { delay: 0.05 });
    const spin = (Math.random() < 0.5 ? -1 : 1) * Math.PI * 2 * (seat === 0 ? 1 : 1.25);
    await this.fly(o, pose, { dur: 0.5, arc: seat === 0 ? 0.5 : 0.9, spin, ease: ease.inOutQuad });
    if (!this.live(g)) return;
    this.land(o, slam, pen >= 4);
    this.trimPile();
    this.setActiveColor(color ?? card.face.color);
    this.platesDirty();
    if (card.face.kind === 'skipAll') {
      const others = this.seats.filter((x) => x !== seat && !this.eliminated[x]);
      for (const x of others) this.skipAllDone.add(x);
      await this.quickSkip(others);
      return;
    }
    await this.anim.wait(0.08);
  }

  private async onDraw(seat: Seat, count: number, cards: Card[] | undefined, reason: string, g: number): Promise<void> {
    if (reason === 'penalty' || reason === 'catch') {
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
          return this.fly(o, to, { dur: 0.38, arc: (seat === 0 ? 0.15 : 0.35) + catchArc, ease: ease.outCubic });
        }),
      );
    });
    await Promise.all(jobs);
    if (!this.live(g)) return;
    if (seat === 0 && this.refreshPartnerArea()) void this.relayout(this.partnerSeat(), 0.25);
    if (seat === 0 && this.req) this.applyPickFx();
    this.platesDirty();
  }

  private async onReverse(direction: Direction): Promise<void> {
    this.sfx('select');
    this.direction = direction;
    const r = this.dirRing;
    const sx = Math.abs(r.scale.x);
    const want = sx * this.ringScaleSign(direction);
    const m = r.material as THREE.MeshBasicMaterial;
    if (this.reduced) {
      r.scale.x = want;
      await this.anim.tween(0.3, (k) => (m.opacity = 0.28 + 0.4 * Math.sin(Math.PI * k)));
      return;
    }
    let flipped = false;
    await this.anim.tween(0.6, (k) => {
      r.rotation.y = k * Math.PI;
      if (!flipped && k > 0.5) {
        flipped = true;
        r.scale.x = want;
      }
      m.opacity = 0.28 + 0.45 * Math.sin(Math.PI * k);
      const b = 1 + 0.1 * Math.sin(Math.PI * k);
      r.scale.z = sx * b;
      r.scale.x = (r.scale.x < 0 ? -sx : sx) * b;
    }, ease.inOutCubic);
    r.rotation.y = 0;
    r.scale.set(want, 1, sx);
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
        if (this.stackTotal !== total) this.showBadge(total);
        this.showPenBadge(w.victim, total);
        this.sfx('charge');
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
    // flash
    const f = this.flash;
    const fm = f.material;
    f.position.copy(p0);
    f.visible = true;
    const fw = w0 * 2.2;
    void this.anim.tween(this.reduced ? 0.2 : 0.35, (k) => {
      fm.opacity = 1 - k;
      f.scale.setScalar(fw * (this.reduced ? 1 : lerp(0.4, 1.4, k)));
      fm.rotation = k * 0.6;
      if (k >= 1) f.visible = false;
    }, ease.outQuad);
    if (this.reduced) {
      b.position.copy(p1);
      b.scale.set(w1, w1 * 0.5625, 1);
      this.penSeat = to;
      return this.anim.wait(0.25);
    }
    await this.anim.wait(0.12);
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

  /** Salto total: a stamp on every skipped seat, popping in sequence and fading together */
  private async quickSkip(seats: number[]): Promise<void> {
    if (!seats.length) return;
    const gap = this.reduced ? 0.08 : 0.16;
    const pops: Promise<void>[] = [];
    seats.slice(0, this.skipStamps.length).forEach((seat, i) => {
      const sp = this.skipStamps[i];
      const p = this.seatPoint(seat, new THREE.Vector3());
      if (seat !== 0) p.y = 0.6;
      sp.position.copy(p);
      const size = this.worldPerPx(p.distanceTo(this.layoutCam.position)) * Math.min(84, Math.max(56, this.W * 0.14));
      const m = sp.material;
      m.opacity = 0;
      sp.scale.setScalar(size);
      sp.visible = true;
      pops.push(
        this.anim
          .tween(this.reduced ? 0.12 : 0.24, (k) => {
            m.opacity = k;
            sp.scale.setScalar(size * (this.reduced ? 1 : lerp(2, 1, k)));
            m.rotation = this.reduced ? 0 : (1 - k) * 0.5;
          }, ease.outBack, i * gap, () => {
            this.sfx('pass');
            if (seat !== 0) void this.shakeSeat(seat as Seat, 0.04);
          })
          .then(() => this.anim.wait(0.45 + (seats.length - 1 - i) * gap))
          .then(() =>
            this.anim.tween(0.2, (k) => {
              m.opacity = 1 - k;
              if (k >= 1) sp.visible = false;
            }),
          ),
      );
    });
    // the next event may start once the last stamp has popped
    await this.anim.wait(seats.length * gap + 0.25);
    void Promise.all(pops);
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
    return this.moveHands(next, a === 0 || b === 0 ? cards : undefined, g);
  }

  private onRotate(direction: Direction, cards: Card[] | undefined, g: number): Promise<void> {
    const live = this.seats.filter((s) => !this.eliminated[s]);
    const next = this.hands.map((h) => h.slice());
    live.forEach((s, i) => {
      const to = live[(i + direction + live.length) % live.length];
      next[to] = this.hands[s].slice();
    });
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
    const p = this.seatPoint(winner, new THREE.Vector3());
    if (winner === 0) p.copy(this.pxToTable(this.W / 2, this.H * 0.62, new THREE.Vector3()));
    this.confettiBurst(p, 90, 1);
    // card fountain
    const n = this.reduced ? Math.min(6, this.q.fountain) : this.q.fountain;
    const base = this.faceMap.faces;
    const jobs: Promise<void>[] = [];
    for (let j = 0; j < n; j++) {
      const o = this.alloc();
      if (!o) break;
      const face = base[Math.floor(Math.random() * Math.min(base.length, 72))];
      this.setFace(o, { id: -1 - j, face });
      o.pos.copy(p);
      faceUpQ(Math.random() * 6.28, o.quat);
      o.s = 0.01;
      const vx = (Math.random() - 0.5) * 3.2;
      const vz = (Math.random() - 0.5) * 2.4;
      const vy = 4.2 + Math.random() * 2.2;
      const spinAx = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      const spinV = (Math.random() < 0.5 ? -1 : 1) * (5 + Math.random() * 6);
      const q0 = o.quat.clone();
      const dur = 1.5;
      const p0 = p.clone();
      const tok = o.token;
      jobs.push(
        this.anim.tween(dur, (_k, raw) => {
          if (o.token !== tok) return;
          const t = raw * dur;
          o.pos.set(p0.x + vx * t, Math.max(0.02, p0.y + vy * t - 4.9 * t * t), p0.z + vz * t);
          o.quat.copy(q0).premultiply(tmpQ.setFromAxisAngle(spinAx, spinV * t));
          o.s = raw < 0.1 ? raw * 10 * 0.8 : raw > 0.75 ? 0.8 * (1 - (raw - 0.75) * 4) : 0.8;
        }, ease.linear, j * 0.035, () => (o.vis = true)).then(() => this.release(o)),
      );
    }
    await this.anim.wait(0.5);
    void Promise.all(jobs);
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

  private applyPickFx(): void {
    const r = this.req;
    if (!r) return;
    for (const o of this.hands[0]) {
      const ok = !!o.card && r.playable.has(o.card.id);
      this.tweenFx(o, ok ? 1 : 0, ok ? 0 : 1);
    }
    this.tweenFx(this.deckTop, r.canDraw ? 1 : 0, 0);
    void this.relayout(0, 0.18);
    this.kick();
  }

  private clearPickFx(keep: number): void {
    for (const o of this.hands[0]) if (!o.card || o.card.id !== keep) this.tweenFx(o, 0, 0);
    this.tweenFx(this.deckTop, 0, 0);
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
        if (!o.held) {
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
    return L.hitFan(this.fan, x, y, this.lifts);
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

  /** own hand hit, sticky on the peeked card (it is raised, so test its raised rect first) */
  private hitHandPeek(x: number, y: number): number {
    const pk = this.peekIdx(0);
    if (pk >= 0 && this.fan.slots.length === this.hands[0].length) {
      const s = this.fan.slots[pk];
      const o = this.hands[0][pk];
      const lift = this.liftPx(o) + this.fan.ch * 0.3;
      if (L.inSlot({ ...s, rot: s.rot * 0.3 }, this.fan.cw * 1.2, this.fan.ch * 1.15, x, y, lift)) return pk;
    }
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
      for (const o of this.hands[s]) {
        if (!o.vis || !o.card || o.pos.y <= bestY) continue;
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
          bestY = o.pos.y;
        }
      }
    }
    return best;
  }

  /** mouse hover: peek whatever card is under the cursor */
  private hover(x: number, y: number): void {
    const i = this.hitHandPeek(x, y);
    if (i >= 0) return this.setPeek(0, this.hands[0][i]);
    const op = this.hitOpen(x, y);
    if (op) return this.setPeek(op.seat, op.o);
    this.setPeek(0, null);
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
      this.setPeek(0, this.hands[0][idx]);
    } else {
      const op = this.hitOpen(x, y);
      if (op) {
        kind = 'open';
        wasPeek = this.peek?.o === op.o;
        this.setPeek(op.seat, op.o);
      } else if (this.req && this.hitDeck(x, y)) kind = 'deck';
    }
    if (!kind) {
      if (touch) this.setPeek(0, null);
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
    if (e.pointerId !== p.id) {
      if (p.id === -1 && e.pointerType === 'mouse' && e.buttons === 0) {
        const { x, y } = this.localXY(e);
        this.hover(x, y);
      }
      return;
    }
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
      if (up > 14 && up > dxAbs && o && o.card && this.req && this.req.playable.has(o.card.id)) {
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
      if (p.touch && (p.slid || p.wasPeek)) this.setPeek(0, null);
      return;
    }
    const o = this.hands[0][p.idx];
    if (!o) return;
    const ok = !!r && !!o.card && r.playable.has(o.card.id);
    if (p.dragging) {
      if (p.y0 - y > Math.max(50, this.fan.ch * 0.6) && ok) this.resolvePick(o.card!.id);
      else {
        o.held = false;
        void this.relayout(0, 0.2);
        this.kick();
      }
      if (p.touch) this.setPeek(0, null);
      return;
    }
    if (p.slid) {
      if (p.touch) this.setPeek(0, null);
      return;
    }
    if (moved < 16 && r) {
      if (ok) return this.resolvePick(o.card!.id);
      this.sfx('invalid');
      this.shakeCard(o);
    }
    if (p.touch) this.setPeek(0, null);
  };

  private onCancel = (e: PointerEvent): void => {
    if (e.pointerId !== this.ptr.id) return;
    const o = this.hands[0][this.ptr.idx];
    this.ptr.id = -1;
    if (o && o.held) {
      o.held = false;
      void this.relayout(0, 0.2);
    }
    this.setPeek(0, null);
    this.kick();
  };

  private onLeave = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && this.ptr.id === -1) this.setPeek(0, null);
  };
  // ───────────────────────── plates ─────────────────────────

  private platesDirty(): void {
    this.emitPlates();
  }

  private emitPlates(): void {
    const cb = this.opts.onPlates;
    if (!cb || this.disposed) return;
    const hf = L.fanLayout(Math.max(7, this.hands[0].length), { W: this.W, H: this.H });
    const ps = this.partnerSeat();
    const env: L.PlateEnv = {
      W: this.W, H: this.H, hudTop: HUD_TOP, handTop: hf.top, handLeft: L.fanLeft(hf), portrait: this.portrait,
      humanRight: ps >= 0 && this.sideOf(ps) === 'lowerLeft',
      topPlateSide: ps < 0 ? undefined : this.sideOf(ps) === 'lowerLeft' ? 'right' : 'left',
      sidePlateBelow: ps >= 0 && !this.portrait,
    };
    const out: SeatPlate[] = [];
    const fanBoxes: L.Box[] = [];
    for (const s of this.seats) {
      const side = this.sideOf(s);
      const n = this.hands[s].length;
      let ax = 0;
      let ay = 0;
      let hx = 0;
      let hy = 0;
      const pside = side === 'lowerLeft' || side === 'lowerRight';
      if (side !== 'bottom' && (pside || this.isOpen(s))) {
        const f = pside ? this.partnerFanFor(s, Math.max(1, n)) : this.openFanFor(s, Math.max(1, n));
        // screen bbox of the fan's table rectangle (all four corners: perspective widens the near side)
        let x0 = Infinity;
        let x1 = -Infinity;
        let y0 = Infinity;
        let y1 = -Infinity;
        for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          this.toScreen(tmpV.set(f.cx + sx * f.hx, 0.02, f.cz + sz * f.hz), scr);
          x0 = Math.min(x0, scr.x);
          x1 = Math.max(x1, scr.x);
          y0 = Math.min(y0, scr.y);
          y1 = Math.max(y1, scr.y);
        }
        ax = (x0 + x1) / 2;
        ay = (y0 + y1) / 2;
        hx = (x1 - x0) / 2;
        hy = (y1 - y0) / 2 + 4;
      } else if (side !== 'bottom') {
        const a = this.anchorOf(s);
        this.toScreen(tmpV.set(a.x, 0, a.z), scr);
        ax = scr.x;
        ay = scr.y;
        const len = Math.max(L.oppFanLen(Math.max(n, 1), side, this.dims, this.oppMaxLen(s)), L.CARD_W * L.OPP_SCALE) / 2;
        const across = (L.CARD_H * L.OPP_SCALE) / 2;
        const along = side === 'top';
        const dx = along ? len : across;
        const dz = along ? across : len;
        this.toScreen(tmpV.set(a.x - dx, 0, a.z - dz), scr);
        const x0 = scr.x;
        const y0 = scr.y;
        this.toScreen(tmpV.set(a.x + dx, 0, a.z + dz), scr);
        hx = Math.abs(scr.x - x0) / 2;
        hy = Math.abs(scr.y - y0) / 2;
      }
      if (side !== 'bottom' && n > 0) fanBoxes.push({ x: ax, y: ay, w: 2 * hx, h: 2 * hy, seat: s });
      out.push(
        L.plateBox(
          { seat: s, side, ax, ay, halfX: hx, halfY: hy, count: n, active: this.turnSeat === s, winner: this.winner === s, scale: this.plateScale[s], visible: this.platesOn },
          env,
        ),
      );
    }
    // plates never sit on each other or on the deck / pile
    {
      let bx0 = Infinity;
      let bx1 = -Infinity;
      let by0 = Infinity;
      let by1 = -Infinity;
      for (const [x, z] of [[this.deckPos.x - 0.4, -0.55], [this.pilePos.x + 0.4, -0.55], [this.deckPos.x - 0.4, 0.6], [this.pilePos.x + 0.4, 0.6]]) {
        this.toScreen(tmpV.set(x, 0.1, z), scr);
        bx0 = Math.min(bx0, scr.x);
        bx1 = Math.max(bx1, scr.x);
        by0 = Math.min(by0, scr.y);
        by1 = Math.max(by1, scr.y);
      }
      L.separatePlates(out, [{ x: (bx0 + bx1) / 2, y: (by0 + by1) / 2, w: bx1 - bx0, h: by1 - by0 }, ...fanBoxes], this.W, this.H, HUD_TOP, 6,
        // side seating: the partner's slot first, then the side opponent, the top seat last
        ps >= 0 ? [0, ps, ...this.seats.filter((x) => x !== 0 && x !== ps && this.sideOf(x) !== 'top'), ...this.seats.filter((x) => this.sideOf(x) === 'top')] : undefined);
    }
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
    const hard = this.anim.active || this.dust.busy || this.confetti.busy || this.ptr.dragging || this.push > 0;
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
    const more = this.anim.active || this.dust.busy || this.confetti.busy || this.ptr.dragging || this.push > 0;
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
  }

  // ───────────────────────── public API ─────────────────────────

  setTurn(seat: Seat | null): void {
    this.turnSeat = seat;
    this.emitPlates();
  }

  reset(): void {
    this.gen++;
    this.anim.finishAll();
    this.cancelHumanPick();
    this.clearTable();
    this.platesOn = false;
    this.turnSeat = null;
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
      for (const c of R.discard.slice(-PILE_KEEP)) {
        const o = this.alloc();
        if (!o) break;
        this.setFace(o, c);
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
      this.fan = L.fanLayout(this.hands[0].length, { W: this.W, H: this.H });
      this.snapAll();
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
    const changed = this.updateArrangement();
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
    this.glowRing.geometry.dispose();
    (this.glowRing.material as THREE.Material).dispose();
    this.glowTex.dispose();
    this.dirRing.geometry.dispose();
    (this.dirRing.material as THREE.Material).dispose();
    this.dirTex.dispose();
    this.boxGeo.dispose();
    this.boxMat.dispose();
    this.edgeTex.dispose();
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
    this.skipTex.dispose();

    this.dust.dispose();
    this.confetti.dispose();
    this.perf?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
