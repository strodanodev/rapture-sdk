/**
 * The 3D stage behind the game client, ported from Rapture Chess (src/scene/stage.ts): the renderer, the sky dome with
 * its aurora and stars, fog, the key, rim, hemisphere and accent lights, a studio environment for reflections, bloom
 * on what is really hot, and AgX tone mapping. Lighter than the chess stage on purpose: no ambient occlusion or mirror
 * floor, because the cards are the bright thing on screen here, not the set. Shadows are static: the key light and the
 * set never move, so the shadow map renders once per realm and is reused (not on phones). Drifting motes (dust in
 * Valhalla, embers in the Underworld) are animated wholly on the GPU.
 *
 * It runs in a Web Worker on an OffscreenCanvas (worker.ts), so it never touches the DOM: the page sends the size,
 * pixel ratio, pointer type and visibility in.
 *
 * Cost control:
 *   - a frame governor steps the resolution down (1.5x, 1x, 0.75x of CSS pixels) when the average drops under 45 fps
 *     and reports failure if even the lowest step can't hold 24 fps, so the client falls back to the CSS arena;
 *   - behind the battle (mood "battle") it draws every other frame: the camera is still there and the level barely moves;
 *   - a hidden page draws nothing.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { BoardLayout } from './board';

export type Mood = 'menu' | 'battle';
export interface SkyColors { top: number; bottom: number; glow: number; fog: number; fogDensity: number }
export interface StageStats { fps: number; pixelRatio: number; drawCalls: number; triangles: number; frameMs: number }

const RATIOS = [1.5, 1, 0.75];
/** The battle bursts' pool: this many at once, of this many particles each. */
const BURSTS = 10, PER = 48;

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(42, 1, 0.1, 160);
  readonly keyLight = new THREE.DirectionalLight(0xfff1dc, 2.2);
  readonly rimLight = new THREE.SpotLight(0x8fb4ff, 40, 40, Math.PI / 5, 0.6, 1.4);
  readonly hemi = new THREE.HemisphereLight(0x2a2f45, 0x080608, 0.5);
  /**
   * The battle board's own key light: a spot from the player's side, on only in battle, so the board stays readable
   * while the hall round it is dimmed (the rim light, from behind, edges its far side). In the scene from the start,
   * dark: adding a light later would recompile every material.
   */
  readonly boardKey = new THREE.SpotLight(0xffffff, 0, 34, 0.42, 0.55, 1.1);
  /** The board light's strength in battle (the realm sets it with its colour). */
  boardKeyPower = 0;
  /** The rim light's strength, and the share of it that stays on in battle (the realm sets both). */
  rimPower = 40;
  rimBattle = 1;
  readonly floorPlate: THREE.Mesh<THREE.CircleGeometry, THREE.MeshStandardMaterial>;
  private readonly composer: EffectComposer;
  private fxaa: ShaderPass | null = null;
  private readonly bloom: UnrealBloomPass;
  /** Ground-contact shading (desktop only, half resolution): props and units sit in the floor instead of on it. */
  private readonly gtao: GTAOPass | null;
  /** The last pass: a vignette, the realm's tint in the shadows, and fine grain. */
  private readonly grade: ShaderPass;
  private readonly sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly motes: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly shadows: boolean;
  /** A phone or tablet: the stage keeps its extras (shadows, statues) off. */
  readonly coarse: boolean;
  private readonly stars: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly timer = new THREE.Timer();
  private readonly updaters: Array<(dt: number, t: number) => void> = [];
  /** The title camera looks across the arena (statues, pillars, the far rim), not down into the dais. */
  private bursts!: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private burstNext = 0;
  /** The bursts' own canvas over the page (attachFx), its scene, and until when (clock) it has something to draw. */
  private fx: THREE.WebGLRenderer | null = null;
  private readonly fxScene = new THREE.Scene();
  private fxUntil = 0;
  private fxDirty = false;
  private clock = 0;
  /** The battle table's top, where bursts start (the HTML board lies over it). */
  private readonly burstPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.86);
  private readonly ray = new THREE.Raycaster();
  private readonly menuTarget = new THREE.Vector3(0, 3.3, 0);   // aimed lower: the frame was 40% empty sky
  /** In battle the camera aims 1.2 m in front of the table, so the table sits under the HTML board (above mid-screen). */
  private readonly battleTarget = new THREE.Vector3(0, 0.6, 1.2);
  private readonly battleSpot = new THREE.Vector3(0, 11.5, 13.5);
  private ratioStep: number;
  private mood: Mood = 'menu';
  /** The title camera's heading: the realm sets it so the camera faces a statue across the dais (see Realm). */
  menuAngle = 0.6;
  /**
   * Four warm practical lights (braziers, lava) the realm places; always in the scene, so placing them never changes
   * the shader programs (adding lights later would recompile every material, a multi-second stall).
   */
  readonly practicals: THREE.PointLight[] = [];
  private shakeLeft = 0;
  private frame = 0;
  private frames = 0;
  private renderWaiters: Array<() => void> = [];
  private sample = 0;
  private lowStreak = 0;
  private workMs = 0;
  private stats: StageStats = { fps: 0, pixelRatio: 1, drawCalls: 0, triangles: 0, frameMs: 0 };
  private width = 1;
  private height = 1;
  private dpr = 1;
  /** Where the battle board is on screen and how it is laid out, from the page: the realm builds the 3D board to it. */
  board: BoardLayout | null = null;
  /** The realm's board is up under the HTML one (risen, fitted, the camera arrived): the hall dims round it. */
  boardUp = false;
  /** Called when boardUp changes: the page then drops its drawn table mat, or puts it back. */
  onBoard: ((up: boolean) => void) | null = null;
  /** Counts every change to the board's layout or the viewport: the realm rebuilds the board when it moves on. */
  boardVersion = 0;
  private dim = 0;
  private skipped = 0;
  /** The page is hidden: draw nothing. */
  hidden = false;
  /** Called when even the lowest resolution can't hold the frame rate: the client drops back to the CSS arena. */
  onTooSlow: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, opts: { still: boolean; coarse: boolean; width: number; height: number; dpr: number }) {
    this.still = opts.still;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    // count draw calls over the whole frame (every pass), not just the last one
    this.renderer.info.autoReset = false;
    // phones start one step down: a weak GPU shouldn't have to prove itself slow first
    this.ratioStep = opts.coarse ? 1 : 0;
    // one static shadow map: rendered when a realm loads (refreshShadows), never per frame
    this.coarse = opts.coarse;
    this.shadows = !opts.coarse;
    if (this.shadows) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFShadowMap;   // PCFSoft is gone in r18x (three falls back to this anyway)
      this.renderer.shadowMap.autoUpdate = false;
      // render the (empty) map on the first frame too: until a shadow map exists, every material that receives shadows
      // samples a placeholder of the wrong format, WebGL drops the draw ("mismatch between texture format and sampler
      // type"), and the hall is missing while the sky and floor still show
      this.renderer.shadowMap.needsUpdate = true;
      this.keyLight.castShadow = true;
      this.keyLight.shadow.mapSize.set(2048, 2048);
      const c = this.keyLight.shadow.camera;
      c.left = -18; c.right = 18; c.top = 18; c.bottom = -18; c.near = 1; c.far = 60;
      this.keyLight.shadow.bias = -0.0004;
      this.keyLight.shadow.normalBias = 0.03;
    }

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
    this.scene.fog = new THREE.FogExp2(0x05050a, 0.028);
    if (!opts.coarse) for (let i = 0; i < 4; i++) { const l = new THREE.PointLight(0xff9a3c, 0, 10, 2); this.practicals.push(l); this.scene.add(l); }   // phones: no per-pixel extras
    this.scene.background = new THREE.Color(0x05050a);

    this.keyLight.position.set(5, 11, 6);
    this.rimLight.position.set(-6, 8, -9);
    const a0 = new THREE.PointLight(0x38a8ff, 18, 14, 1.8), a1 = new THREE.PointLight(0xff6a2a, 18, 14, 1.8);
    a0.position.set(-5.5, 1.6, 5.5); a1.position.set(5.5, 1.6, -5.5);
    this.boardKey.position.set(4.5, 10.5, 10);
    this.boardKey.target.position.set(0, 0.74, 0);
    this.scene.add(this.keyLight, this.keyLight.target, this.rimLight, this.rimLight.target, this.hemi, a0, a1, this.boardKey, this.boardKey.target);

    // the dais the cards are fought over: a dark polished plate the realm sizes
    this.floorPlate = new THREE.Mesh(new THREE.CircleGeometry(9.05, 64), new THREE.MeshStandardMaterial({ color: 0x0b0b10, roughness: 0.62, metalness: 0.35, envMapIntensity: 0.18 }));
    this.floorPlate.rotation.x = -Math.PI / 2;
    this.floorPlate.position.y = -0.165;
    this.floorPlate.receiveShadow = true;
    this.scene.add(this.floorPlate);

    this.sky = this.skyDome();
    this.stars = this.starfield();
    this.motes = this.moteField(opts.coarse ? 150 : 300);   // sparse: a dense field read as uniform noise over the statues
    this.scene.add(this.sky, this.stars, this.motes);
    this.bursts = this.burstField();
    this.scene.add(this.bursts);

    // anti-aliasing is an FXAA pass after tone mapping (see below), not MSAA on this float target: a multisampled
    // half-float target took the stage's setup from 2 s to 10-14 s on an integrated GPU, past the page's timeout
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.gtao = opts.coarse ? null : new GTAOPass(this.scene, this.camera, 256, 256);
    if (this.gtao) {
      this.gtao.updateGtaoMaterial({ radius: 0.9, distanceFallOff: 1, thickness: 1.2, samples: 12 });
      this.gtao.updatePdMaterial({ samples: 8, radius: 6 });
      this.gtao.blendIntensity = 0.85;
      this.composer.addPass(this.gtao);
    }
    // bloom only on what is really hot (fire, runes, lava): the threshold keeps stone and gold crisp
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.4, 1.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    // FXAA on the tone-mapped image, so edges don't stairstep at 1x (phones too: they start a resolution step down,
    // at 1x of CSS pixels, where the board's rim and recesses would otherwise show their stairs under the crisp HTML)
    this.fxaa = new ShaderPass(FXAAShader);
    this.composer.addPass(this.fxaa);
    // grading after tone mapping, in display space: the shadows take the realm's hue, the edges fall away, a fine grain
    this.grade = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, tint: { value: new THREE.Color(1, 1, 1) }, vig: { value: 0.32 }, grain: { value: 0.025 }, time: { value: 0 }, focus: { value: new THREE.Vector4(0.5, 0.5, 0.5, 0.5) }, dim: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform sampler2D tDiffuse; uniform vec3 tint; uniform vec4 focus; uniform float vig, grain, time, dim; varying vec2 vUv;
        void main(){ vec4 c = texture2D(tDiffuse, vUv);
          float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
          c.rgb = mix(c.rgb, c.rgb * tint, (1.0 - smoothstep(0.0, 0.45, l)) * 0.7);
          vec2 d = (vUv - 0.5) * vec2(1.0, 0.85);
          c.rgb *= mix(1.0 - vig, 1.0, smoothstep(0.78, 0.22, length(d)));
          // in battle the hall falls back round the board (an ellipse round it on screen); the board keeps its light
          c.rgb *= 1.0 - dim * smoothstep(0.95, 1.5, length((vUv - focus.xy) / focus.zw));
          float n = fract(sin(dot(vUv * 731.0 + fract(time) * 17.0, vec2(12.9898, 78.233))) * 43758.5453);
          c.rgb += (n - 0.5) * grain;
          gl_FragColor = c; }`,
    });
    this.composer.addPass(this.grade);

    this.camera.position.set(0, 8.2, 12.6);
    this.setSize(opts.width, opts.height, opts.dpr);
  }
  private readonly still: boolean;

  /** The renderer's GPU, for spotting software rendering (SwiftShader, llvmpipe): those can't run the arena well. */
  gpuName(): string {
    const gl = this.renderer.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  }

  /** The canvas's CSS size and the device pixel ratio, from the page. */
  setSize(width: number, height: number, dpr: number): void {
    this.width = Math.max(1, width); this.height = Math.max(1, height); this.dpr = dpr || 1;
    this.boardVersion++;
    this.resize();
  }

  // ------------------------------------------------------------------ sky
  private skyDome(): THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> {
    return new THREE.Mesh(new THREE.SphereGeometry(80, 48, 24), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(0x05050b) }, bottom: { value: new THREE.Color(0x120d16) }, glow: { value: new THREE.Color(0x3a2a40) }, aurora: { value: 0 }, milky: { value: 0 }, time: { value: 0 } },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 top, bottom, glow; uniform float aurora, milky, time; varying vec3 vP;
        void main(){ vec3 d = normalize(vP); float h = d.y; vec3 c = mix(bottom, top, smoothstep(-0.2, 0.6, h));
        c += glow * pow(max(0.0, 1.0 - abs(h + 0.05) * 4.0), 2.0) * 0.6;
        float a = atan(d.z, d.x);
        float band = sin(a * 3.0 + time * 0.15 + sin(a * 7.0 - time * 0.1) * 0.8) * 0.5 + 0.5;
        float veil = smoothstep(0.25, 0.55, h) * (1.0 - smoothstep(0.75, 0.95, h)) * band;
        // curtains, not a blob: fine vertical rays that drift, brightest at the curtain's lower hem
        veil *= (0.45 + 0.55 * pow(0.5 + 0.5 * sin(a * 140.0 + sin(a * 23.0 + time * 0.3) * 4.0), 2.0)) * mix(1.0, 1.0 - smoothstep(0.3, 0.8, h), 0.55);
        c += aurora * veil * mix(vec3(0.1, 0.9, 0.5), vec3(0.5, 0.2, 0.9), sin(a * 2.0 + time * 0.2) * 0.5 + 0.5) * 0.35;
        // the Milky Way: a tilted band of faint, mottled light
        float mw = exp(-pow(dot(d, normalize(vec3(0.35, 0.55, -0.76))) * 5.0, 2.0)) * smoothstep(-0.02, 0.3, h);
        c += vec3(0.5, 0.56, 0.72) * mw * milky * 0.09 * (0.55 + 0.45 * sin(d.x * 41.0 + d.z * 29.0) * sin(d.y * 33.0 - d.x * 17.0));
        gl_FragColor = vec4(c, 1.0); }`,
    }));
  }

  private starfield(): THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> {
    const n = 900, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    let s = 7;
    const rnd = (): number => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    for (let i = 0; i < n; i++) {
      const th = rnd() * Math.PI * 2, ph = Math.acos(rnd() * 0.9 + 0.05), r = 70;
      pos.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), r * Math.sin(ph) * Math.sin(th)], i * 3);
      const w = 0.4 + rnd() * 0.6;
      col.set([w, w * (0.85 + rnd() * 0.15), w * (0.8 + rnd() * 0.3)], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.3, vertexColors: true, transparent: true, opacity: 0.8, fog: false }));
  }

  /** Motes drifting up through the arena: positions loop in the vertex shader, so a frame costs one draw call. */
  private moteField(n: number): THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> {
    const pos = new Float32Array(n * 3), seed = new Float32Array(n);
    let s = 11;
    const rnd = (): number => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2, r = 2.5 + Math.sqrt(rnd()) * 11;
      pos.set([Math.cos(a) * r, rnd() * 9, Math.sin(a) * r], i * 3);
      seed[i] = rnd();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    return new THREE.Points(geo, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      uniforms: { time: { value: 0 }, rise: { value: 0.2 }, size: { value: 1 }, color: { value: new THREE.Color(0xffffff) }, opacity: { value: 0.6 } },
      vertexShader: `uniform float time, rise, size; attribute float aSeed; varying float vA;
        void main(){ vec3 p = position; float h = 9.0;
          p.y = mod(p.y + time * rise * (0.6 + aSeed * 0.8), h);
          p.x += sin(time * 0.4 + aSeed * 20.0) * 0.45; p.z += cos(time * 0.33 + aSeed * 17.0) * 0.45;
          vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = min(size * (0.35 + aSeed) * (120.0 / -mv.z), 5.0 * size);   // varied, and near motes stay specks, not blobs
          vA = smoothstep(0.0, 1.2, p.y) * (1.0 - smoothstep(h - 3.0, h - 0.3, p.y)) * (0.35 + 0.35 * sin(time * 2.3 + aSeed * 31.0)) * smoothstep(1.5, 5.0, -mv.z); }`,   // none right at the lens
      fragmentShader: `uniform vec3 color; uniform float opacity; varying float vA;
        void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.05, d);
          gl_FragColor = vec4(color * (1.0 + a * 1.5), a * vA * opacity); }`,
    }));
  }

  /** The realm's motes: their colour, how fast they rise, their size and strength (0 hides them). */
  setMotes(color: number, rise: number, size: number, opacity: number): void {
    const u = this.motes.material.uniforms;
    (u.color.value as THREE.Color).set(color); u.rise.value = rise; u.size.value = size; u.opacity.value = opacity;
    this.motes.visible = opacity > 0;
  }

  /** Re-render the static shadow map on the next frame (after a realm or its lighting changes). */
  refreshShadows(): void { if (this.shadows) this.renderer.shadowMap.needsUpdate = true; }

  setSky(c: SkyColors, aurora: number, stars: number): void {
    const u = this.sky.material.uniforms;
    (u.top.value as THREE.Color).set(c.top); (u.bottom.value as THREE.Color).set(c.bottom); (u.glow.value as THREE.Color).set(c.glow);
    u.aurora.value = aurora;
    u.milky.value = stars;
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.set(c.fog); fog.density = c.fogDensity;
    (this.scene.background as THREE.Color).set(c.fog);
    this.stars.material.opacity = stars;
    this.stars.visible = stars > 0;
  }

  /** The realm's grade: the hue its shadows take. */
  setGrade(tint: number): void { (this.grade.uniforms.tint.value as THREE.Color).set(tint); }

  setFloorRadius(r: number): void {
    this.floorPlate.visible = r > 0;
    if (r > 0) { this.floorPlate.geometry.dispose(); this.floorPlate.geometry = new THREE.CircleGeometry(r, 64); }
  }

  // ------------------------------------------------------------------ camera and frames
  setMood(m: Mood): void { this.mood = m; this.resize(); }

  /**
   * The battle camera where it comes to rest, for this viewport: the board is built for this view, not for wherever
   * the camera is on its way there.
   */
  battleCamera(): THREE.PerspectiveCamera {
    const c = new THREE.PerspectiveCamera(this.fovFor('battle'), this.width / this.height, this.camera.near, this.camera.far);
    c.position.copy(this.battleSpot);
    c.lookAt(this.battleTarget);
    c.updateMatrixWorld(true);
    return c;
  }
  /** The camera has reached its battle spot. */
  get arrived(): boolean { return this.mood === 'battle' && this.camera.position.distanceToSquared(this.battleSpot) < 0.01; }
  /** Portrait phones open the field of view so the arena still fills the frame; the title looks down a longer lens. */
  private fovFor(mood: Mood): number { const a = this.width / this.height; return a < 1 ? Math.min(72, 42 / a) : mood === 'menu' ? 29 : 42; }

  /** The ellipse on screen (CSS px) the hall is dimmed round in battle: the board's. */
  setFocus(cx: number, cy: number, rx: number, ry: number): void {
    (this.grade.uniforms.focus.value as THREE.Vector4).set(cx / this.width, 1 - cy / this.height, Math.max(0.01, rx / this.width), Math.max(0.01, ry / this.height));
  }
  quake(): void { this.shakeLeft = 0.3; }

  /**
   * A burst of particles on the table under a point of the HTML board (CSS px): 'hit' sparks that fly and fall,
   * 'death' embers that rise and drift, 'play' a ring thrown flat across the table, 'heal' motes that float up. One
   * pooled cloud animated in its shader (BURSTS slots of PER particles), so a burst costs a buffer write, not a draw.
   */
  burst(x: number, y: number, color: number, kind: 'hit' | 'death' | 'play' | 'heal' | 'spell'): void {
    this.ray.setFromCamera(this.toNdc(x, y), this.camera);
    const at = this.ray.ray.intersectPlane(this.burstPlane, new THREE.Vector3());
    if (!at) return;
    const g = this.bursts.geometry, slot = this.burstNext++ % BURSTS;
    const origin = g.getAttribute('aOrigin') as THREE.BufferAttribute, vel = g.getAttribute('aVel') as THREE.BufferAttribute;
    const birth = g.getAttribute('aBirth') as THREE.BufferAttribute, col = g.getAttribute('aColor') as THREE.BufferAttribute, kd = g.getAttribute('aKind') as THREE.BufferAttribute;
    const c = new THREE.Color(color), k = { hit: 0, spell: 0, death: 1, play: 2, heal: 3 }[kind];
    for (let i = 0; i < PER; i++) {
      const n = slot * PER + i, a = Math.random() * Math.PI * 2, r = Math.random();
      let vx = 0, vy = 0, vz = 0;
      if (k === 0) { const s = 2.2 + r * 4.2; vx = Math.cos(a) * s; vz = Math.sin(a) * s; vy = 1.5 + Math.random() * 4.5; }
      else if (k === 1) { vx = Math.cos(a) * (0.3 + r * 0.9); vz = Math.sin(a) * (0.3 + r * 0.9); vy = 1.2 + Math.random() * 2.2; }
      else if (k === 2) { const s = 3.2 + r * 1.6; vx = Math.cos(a) * s; vz = Math.sin(a) * s; vy = 0.4 + Math.random() * 0.8; }
      else { vx = Math.cos(a) * r * 0.5; vz = Math.sin(a) * r * 0.5; vy = 0.8 + Math.random() * 1.4; }
      origin.setXYZ(n, at.x + (Math.random() - 0.5) * 0.3, at.y, at.z + (Math.random() - 0.5) * 0.3);
      vel.setXYZ(n, vx, vy, vz);
      birth.setX(n, this.clock + Math.random() * 0.06);
      // a spread of tints round the colour, a few white-hot
      const w = Math.random() < 0.18 ? 1 : 0;
      col.setXYZ(n, w ? 1 : c.r * (0.8 + Math.random() * 0.4), w ? 0.95 : c.g * (0.8 + Math.random() * 0.4), w ? 0.85 : c.b * (0.8 + Math.random() * 0.4));
      kd.setX(n, k);
    }
    for (const a of [origin, vel, birth, col, kd]) { a.addUpdateRange(slot * PER * a.itemSize, PER * a.itemSize); a.needsUpdate = true; }
    this.fxUntil = this.clock + 1.9;   // the longest life (embers, 1.7 s) and the spawn jitter
  }

  /**
   * Draw the bursts on a transparent canvas over the page instead of in the scene: the HTML board's stone mat lies
   * over the 3D table and buried them. Pure additive glow (the canvas keeps alpha 0, so its colour adds to the page
   * under it), drawn at a modest resolution and only while a burst is alive: idle, it costs nothing.
   */
  attachFx(canvas: OffscreenCanvas): void {
    if (this.fx) return;
    try {
      this.fx = new THREE.WebGLRenderer({ canvas, alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    } catch { return; }
    this.fx.setClearColor(0x000000, 0);
    this.scene.remove(this.bursts);
    this.fxScene.add(this.bursts);
    const m = this.bursts.material;
    m.blending = THREE.CustomBlending;
    m.blendSrc = THREE.SrcAlphaFactor; m.blendDst = THREE.OneFactor;
    m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor;
    m.uniforms.gain.value = 0.6;   // no bloom or tone mapping over the page: no HDR cores
    m.needsUpdate = true;
    this.resize();
  }

  private burstField(): THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> {
    const n = BURSTS * PER, geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aOrigin', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aVel', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aBirth', new THREE.BufferAttribute(new Float32Array(n).fill(-99), 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aKind', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
    const p = new THREE.Points(geo, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      uniforms: { time: { value: 0 }, gain: { value: 1.2 }, px: { value: 1 } },
      vertexShader: `uniform float time, px; attribute vec3 aOrigin, aVel, aColor; attribute float aBirth, aKind; varying vec3 vC; varying float vA;
        void main(){ float age = time - aBirth;
          float life = aKind < 0.5 ? 0.9 : aKind < 1.5 ? 1.7 : aKind < 2.5 ? 0.7 : 1.5;
          if (age < 0.0 || age > life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vA = 0.0; return; }
          float g = aKind < 0.5 ? 9.0 : aKind < 1.5 ? -0.6 : aKind < 2.5 ? 2.0 : -0.3;   // sparks fall, embers rise
          float drag = aKind > 1.5 && aKind < 2.5 ? exp(-age * 3.0) : 1.0;              // the ring slows as it spreads
          vec3 p = aOrigin + aVel * age * drag - vec3(0.0, g, 0.0) * age * age * 0.5;
          if (aKind > 0.5 && aKind < 1.5) p.xz += vec2(sin(age * 5.0 + aBirth * 40.0), cos(age * 4.0 + aBirth * 31.0)) * 0.12 * age;
          vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
          float k = 1.0 - age / life;
          gl_PointSize = (aKind < 0.5 ? 3.2 : aKind < 1.5 ? 4.0 : aKind < 2.5 ? 3.4 : 4.4) * (0.4 + k) * (140.0 / -mv.z) * px;
          vC = aColor; vA = k * k; }`,
      fragmentShader: `uniform float gain; varying vec3 vC; varying float vA;
        void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vC * gain * (1.0 + a * 2.0), a * vA); }`,   // in the scene, hot cores past the bloom threshold
    }));
    p.frustumCulled = false;
    p.renderOrder = 5;
    return p;
  }
  onUpdate(fn: (dt: number, t: number) => void): void { this.updaters.push(fn); }
  getStats(): StageStats { return { ...this.stats }; }
  get inBattle(): boolean { return this.mood === 'battle'; }
  /** A point on screen (CSS px) to normalised device coordinates. */
  toNdc(x: number, y: number): THREE.Vector2 { return new THREE.Vector2((x / this.width) * 2 - 1, -((y / this.height) * 2 - 1)); }

  private resize(): void {
    const w = this.width, h = this.height;
    const ratio = Math.min(this.dpr, RATIOS[this.ratioStep]);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(w, h);
    (this.fxaa?.material.uniforms.resolution.value as THREE.Vector2 | undefined)?.set(1 / (w * ratio), 1 / (h * ratio));
    this.bloom.resolution.set(w / 2, h / 2);
    // ambient occlusion at half resolution: soft contact shading needs no more, and it halves the cost
    this.gtao?.setSize(Math.max(1, Math.round((w * ratio) / 2)), Math.max(1, Math.round((h * ratio) / 2)));
    this.camera.aspect = w / h;
    // the title looks down the hall through a longer lens, so the statues fill the frame instead of the empty floor
    this.camera.fov = this.fovFor(this.mood);
    // the title screen on a wide screen: slide the picture right, clear of the menu column (as Rapture Chess does)
    const shift = this.mood === 'menu' && this.camera.aspect > 1.25 ? Math.round(w * 0.12) : 0;
    if (shift) this.camera.setViewOffset(w, h, -shift, 0, w, h); else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.stats.pixelRatio = ratio;
    if (this.fx) {
      const r = Math.min(this.dpr, 1.25);
      this.fx.setPixelRatio(r);
      this.fx.setSize(w, h, false);
      this.bursts.material.uniforms.px.value = r;
    }
  }

  /** Menu: a slow, low circle round the dais, looking across the arena. Battle: high over the dais, still. */
  private place(dt: number, t: number): void {
    if (this.mood === 'menu') {
      // a slow, eased sweep of +-10 degrees round the heading, not a full orbit: the statue across the dais stays framed
      // right of the menu column instead of drifting under it. Low (knee height) and looking up, so the statues stand
      // tall against the sky and the floor stays a sliver. r is well inside the statue ring (13-14 m): at 12.6 the
      // camera brushed past a statue and its halo filled the sky.
      const a = this.menuAngle + (this.still ? 0 : Math.sin(t * 0.06) * 0.17);
      const r = 10.5, y = (this.camera.aspect > 1.25 ? 1.7 : 2.4) + (this.still ? 0 : Math.sin(t * 0.05) * 0.15);
      this.camera.position.set(Math.sin(a) * r, y, Math.cos(a) * r);
    } else {
      // steep, so the dais under the HTML table is seen nearly as the table is (it tilts 26deg on screen)
      // a lower, three-quarter view: the arena's statues and spires stand as silhouettes round the table instead of
      // flattening into slabs seen from above. It comes to rest and stays: the board is modelled to line up with the
      // HTML units from exactly here (a drifting camera made the table slide over its own shadow to keep up)
      if (this.camera.position.distanceToSquared(this.battleSpot) < 0.0004) this.camera.position.copy(this.battleSpot);
      else this.camera.position.lerp(this.battleSpot, Math.min(1, dt * 3.5));
    }
    this.camera.lookAt(this.mood === 'menu' ? this.menuTarget : this.battleTarget);
    if (this.shakeLeft > 0) {
      this.shakeLeft -= dt;
      const k = 0.08 * Math.max(0, this.shakeLeft) * 4;
      this.camera.position.x += (Math.random() - 0.5) * k;
      this.camera.position.y += (Math.random() - 0.5) * k;
    }
  }

  /** Step the resolution down when the frame rate can't hold; report when nothing is left to give. */
  /** `drawn`: this tick rendered a frame (behind the battle every other tick is skipped on purpose). */
  private govern(dt: number, drawn: boolean): void {
    if (drawn) this.frames++;
    this.sample += dt;
    if (this.sample < 2) return;
    this.stats.fps = Math.round(this.frames / this.sample);
    this.stats.frameMs = Math.round((this.workMs / Math.max(1, this.frames)) * 100) / 100;
    this.frames = 0; this.sample = 0; this.workMs = 0;
    if (this.hidden) return;
    const target = this.mood === 'battle' ? 28 : 45;   // battle draws every other frame by design
    if (this.stats.fps >= target) { this.lowStreak = 0; return; }
    if (++this.lowStreak < 2) return;
    this.lowStreak = 0;
    if (this.ratioStep < RATIOS.length - 1) { this.ratioStep++; this.resize(); }
    else if (this.stats.fps < 24) this.onTooSlow?.();
  }

  /**
   * Resolves once `n` more frames have been drawn. A newly shown model's first frame can stall for seconds while the
   * GPU compiles its shader variants (the mirror's, the shadow pass's), and until it ends the canvas still holds the
   * frame before, an empty stage: wait for this before letting anyone see the canvas.
   */
  afterFrames(n = 2): Promise<void> {
    return n <= 0 ? Promise.resolve() : new Promise<void>((resolve) => this.renderWaiters.push(resolve)).then(() => this.afterFrames(n - 1));
  }

  start(): void {
    this.renderer.setAnimationLoop(() => {
      this.timer.update();
      const dt = Math.min(0.05, this.timer.getDelta()), t = this.timer.getElapsed();
      if (this.hidden) return;
      // behind the battle the level is dimmed and nearly still: half the frames are plenty
      const skip = this.mood === 'battle' && (this.frame++ & 1) === 1;
      this.govern(dt, !skip);
      if (skip) { this.skipped = dt; return; }
      const step = Math.min(0.1, dt + this.skipped);   // the time since the last drawn frame, so nothing eases at half speed
      this.skipped = 0;
      const t0 = performance.now();
      this.renderer.info.reset();
      this.sky.material.uniforms.time.value = t;
      this.motes.material.uniforms.time.value = t;
      this.bursts.material.uniforms.time.value = t;
      this.clock = t;
      for (const fn of this.updaters) fn(step, t);
      this.place(step, t);
      const ease = Math.min(1, step * 3);
      this.boardKey.intensity += ((this.mood === 'battle' ? this.boardKeyPower : 0) - this.boardKey.intensity) * ease;
      this.rimLight.intensity += (this.rimPower * (this.mood === 'battle' ? this.rimBattle : 1) - this.rimLight.intensity) * ease;
      this.dim += ((this.boardUp ? 0.5 : 0) - this.dim) * ease;
      this.grade.uniforms.dim.value = this.dim;
      this.grade.uniforms.time.value = t;
      this.composer.render(dt);
      // the bursts' overlay: while one lives, and once more after to clear it
      if (this.fx && (t < this.fxUntil || this.fxDirty)) { this.fx.render(this.fxScene, this.camera); this.fxDirty = t < this.fxUntil; }
      this.workMs += performance.now() - t0;
      if (this.renderWaiters.length) for (const w of this.renderWaiters.splice(0)) w();
      const info = this.renderer.info.render;
      this.stats.drawCalls = info.calls;
      this.stats.triangles = info.triangles;
    });
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.fx?.dispose();
    this.composer.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mat of mats) { for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose(); mat.dispose(); }
    });
    this.renderer.dispose();
  }
}
