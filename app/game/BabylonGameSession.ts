import type { AssetContainer } from '@babylonjs/core/assetContainer';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Constants } from '@babylonjs/core/Engines/constants';
import { Engine } from '@babylonjs/core/Engines/engine';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration';
import { Material } from '@babylonjs/core/Materials/material';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { CreateDisc } from '@babylonjs/core/Meshes/Builders/discBuilder';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import '@babylonjs/core/Meshes/instancedMesh';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Scene } from '@babylonjs/core/scene';
import '@babylonjs/loaders/glTF/glTFFileLoader';
import '@babylonjs/loaders/glTF/2.0/glTFLoader';
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_unlit';
import { AutorooAudio } from './audio';
import { BoosterVisuals } from './boosterVisuals';
import {
  MODEL_CONFIGS,
  MODEL_URLS,
  PLAYER_CAR_COLOR,
  type ModelConfig,
  type ModelKey,
} from './assets';
import {
  FIXED_DT,
  LANE_X,
  RENDER_POOL_LIMITS,
  ROAD_SIDEWALK_WIDTH_M,
  ROAD_TILE_LENGTH_M,
  TRAFFIC_RENDER_AHEAD_M,
  activeLanes,
  hasLane,
} from './constants';
import type {
  GameEvent,
  LaneIndex,
  RunPhase,
  RunSnapshot,
  TrafficVehicle,
  VehicleKind,
} from './contracts';
import { laneMaskAt, roadModuleAt, visualRoadProfileAt } from './generator';
import { InputBuffer, isGameKey, type DrivingControl } from './input';
import {
  PLAYER_FLIP_PIVOT_Y_M,
  laneChangeAnimationPose,
} from './laneChangeAnimation';
import {
  NIGHT_PALETTE,
  STREETLIGHT_POOL_SIZE,
  STREETLIGHT_SPACING_M,
  firstStreetlightStation,
  isNightWindowMaterialName,
  isStreetlightVisible,
  streetlightPlacement,
  streetlightPoolSlot,
  streetlightSide,
  type StreetlightSide,
} from './nightEnvironment';
import {
  BUILDING_KEYS,
  BUILDING_STATION_POOL_SIZE,
  BUILDING_STATION_SPACING_M,
  firstRoadsideBuildingStation,
  isRoadsideBuildingVisible,
  roadsideBuildingModelKey,
  roadsideBuildingPlacement,
  roadsideBuildingPoolSlot,
  type BuildingModelKey,
  type RoadSide,
} from './sceneryLayout';
import { AutorooSimulation } from './simulation';
import { shouldPublishRunSnapshot } from './snapshotPublication';
import { AdaptiveRenderQuality } from './renderQuality';
import { chaseCameraFraming } from './cameraFraming';
import { CrashAnimation } from './crashAnimation';
import { makeBoosterState } from './boosters';
import { LandingPoofVisuals, landingPoofCarPose } from './landingPoofVisuals';

interface SessionCallbacks {
  readonly onReady: () => void;
  readonly onLoadProgress: (progress: number) => void;
  readonly onSnapshot: (snapshot: RunSnapshot) => void;
  readonly onEvent: (event: GameEvent) => void;
  readonly onCrashAnimationComplete: () => void;
}

interface VisualEntry {
  readonly holder: TransformNode;
  readonly animationPivot: TransformNode | null;
  readonly shadow: Mesh | null;
  readonly kind: VehicleKind | 'scenery';
  /** Model-specific lift that places its lowest tyre on the road surface. */
  readonly groundY: number;
  enabled: boolean;
}

interface SceneryEntry extends VisualEntry {
  readonly modelKey: BuildingModelKey;
  readonly side: RoadSide;
  absoluteStation: number | null;
}

interface StreetlightEntry {
  readonly root: TransformNode;
  readonly side: StreetlightSide;
  absoluteStation: number | null;
}

interface DynamicRoadMesh {
  readonly mesh: Mesh;
  readonly positions: Float32Array;
}

interface RoadTile {
  readonly surface: DynamicRoadMesh;
  readonly shoulders: DynamicRoadMesh;
  readonly markings: DynamicRoadMesh;
  absoluteIndex: number | null;
}

interface FallbackPlayerVisual {
  readonly holder: TransformNode;
  readonly animationPivot: TransformNode;
}

const ROAD_SAMPLE_INTERVAL_M = 2;
const ROAD_SECTION_COUNT = ROAD_TILE_LENGTH_M / ROAD_SAMPLE_INTERVAL_M + 1;
const ROAD_HALF_WIDTH_MAX_M = 7.2;
const DASHES_PER_TILE = 4;
const DASH_LENGTH_M = 4.8;
const DASH_WIDTH_M = 0.13;

function writeVertex(
  positions: Float32Array,
  vertexIndex: number,
  x: number,
  z: number,
): void {
  const offset = vertexIndex * 3;
  positions[offset] = x;
  positions[offset + 1] = 0;
  positions[offset + 2] = z;
}

function writeQuad(
  positions: Float32Array,
  firstVertex: number,
  leftX: number,
  rightX: number,
  startZ: number,
  endZ: number,
): void {
  writeVertex(positions, firstVertex, leftX, startZ);
  writeVertex(positions, firstVertex + 1, rightX, startZ);
  writeVertex(positions, firstVertex + 2, leftX, endZ);
  writeVertex(positions, firstVertex + 3, rightX, endZ);
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function makeMaterial(
  scene: Scene,
  name: string,
  hex: string,
  alpha = 1,
): StandardMaterial {
  const result = new StandardMaterial(name, scene);
  result.diffuseColor = Color3.FromHexString(hex);
  result.specularColor = Color3.Black();
  result.alpha = alpha;
  return result;
}

function materialAlbedo(material: Material): Color3 {
  if (material instanceof PBRMaterial) return material.albedoColor;
  if (material instanceof StandardMaterial) return material.diffuseColor;
  return Color3.White();
}

function setVisible(entry: VisualEntry, visible: boolean): void {
  if (entry.enabled === visible) return;
  entry.enabled = visible;
  entry.holder.setEnabled(visible);
  entry.shadow?.setEnabled(visible);
}

export class BabylonGameSession {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly camera: FreeCamera;
  private readonly simulation: AutorooSimulation;
  private readonly input = new InputBuffer();
  private readonly audio = new AutorooAudio();
  private readonly boosterVisuals: BoosterVisuals;
  private readonly callbacks: SessionCallbacks;
  private readonly containers = new Map<ModelKey, AssetContainer>();
  private readonly roadTiles: RoadTile[] = [];
  private readonly sedanPool: VisualEntry[] = [];
  private readonly suvPool: VisualEntry[] = [];
  private readonly busPool: VisualEntry[] = [];
  private readonly sceneryPool: (SceneryEntry | null)[] = [];
  private readonly streetlightPool: StreetlightEntry[] = [];
  private readonly transitionSigns: TransformNode[] = [];
  private readonly gateLights: TransformNode[] = [];
  private playerVisual: VisualEntry | null = null;
  private fallbackPlayer: FallbackPlayerVisual;
  private countdownLight: TransformNode;
  private accumulatorS = 0;
  private lastPublishedTick = -6;
  private lastPublishedPhase: RunPhase | null = null;
  private disposed = false;
  private ready = false;
  private presentationDirty = true;
  private startSpaceHeld = false;
  private muted = false;
  private readonly renderQuality: AdaptiveRenderQuality;
  private touchDriving = false;
  private viewportWidth = 1;
  private viewportHeight = 1;
  private resizeObserver: ResizeObserver | null = null;
  private readonly target = new Vector3();
  private readonly crashAnimation = new CrashAnimation();
  private readonly inactiveBoosterVisuals = makeBoosterState();
  private readonly landingPoofs: LandingPoofVisuals;

  private readonly onKeyDown = (event: KeyboardEvent) => {
    // Consume the menu shortcut until release, including repeats after starting.
    if (event.code === 'Space' && this.startSpaceHeld) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement === this.canvas;
    const phase = this.simulation.phaseName;
    const target = event.target;
    const activatesFocusedControl =
      (event.code === 'Enter' || event.code === 'Space') &&
      target instanceof Element &&
      target !== this.canvas &&
      target.closest(
        'button, a, input, select, textarea, [role="button"], [role="dialog"], [contenteditable]:not([contenteditable="false"])',
      ) !== null;
    if (activatesFocusedControl) return;
    if (event.code === 'Space' && phase === 'ready') {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      event.preventDefault();
      if (this.ready && !event.repeat) {
        this.startSpaceHeld = true;
        this.start();
      }
      return;
    }
    if (
      isGameKey(event.code) &&
      (active || phase === 'running' || phase === 'paused')
    ) {
      event.preventDefault();
    }
    const action = this.input.keyDown(event.code, event.repeat);
    if (action === 'pause' && !event.repeat) {
      if (phase === 'running') this.setPaused(true);
      else if (phase === 'paused') this.setPaused(false);
    }
    if (action === 'restart' && phase === 'game-over') this.restart();
    if (phase === 'running' && isGameKey(event.code)) void this.audio.wake();
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    if (event.code === 'Space') this.startSpaceHeld = false;
    this.input.keyUp(event.code);
  };

  private readonly onBlur = () => {
    this.startSpaceHeld = false;
    this.input.clear();
    this.audio.stopCrashSound();
    if (this.simulation.phaseName === 'running') this.setPaused(true);
  };

  private readonly onVisibility = () => {
    if (document.visibilityState === 'hidden') this.onBlur();
    else this.presentationDirty = true;
  };

  private readonly onPageShow = () => {
    this.presentationDirty = true;
  };

  private readonly onResize = () => {
    this.presentationDirty = true;
    this.viewportWidth = this.canvas.clientWidth;
    this.viewportHeight = this.canvas.clientHeight;
    if (
      this.renderQuality.resize({
        width: this.viewportWidth,
        height: this.viewportHeight,
        devicePixelRatio: window.devicePixelRatio,
      })
    )
      this.engine.setHardwareScalingLevel(
        this.renderQuality.hardwareScalingLevel,
      );
    this.engine.resize();
  };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    callbacks: SessionCallbacks,
    seed = 0xa770_2026,
  ) {
    this.callbacks = callbacks;
    this.viewportWidth = canvas.clientWidth;
    this.viewportHeight = canvas.clientHeight;
    this.renderQuality = new AdaptiveRenderQuality({
      width: this.viewportWidth,
      height: this.viewportHeight,
      devicePixelRatio: window.devicePixelRatio,
    });
    this.engine = new Engine(canvas, true, {
      preserveDrawingBuffer: false,
      stencil: false,
      antialias: true,
      adaptToDeviceRatio: false,
      powerPreference: 'high-performance',
    });
    this.engine.setHardwareScalingLevel(
      this.renderQuality.hardwareScalingLevel,
    );
    this.engine.onContextRestoredObservable.add(() => {
      this.presentationDirty = true;
    });
    this.scene = new Scene(this.engine);
    const horizonColor = Color3.FromHexString(NIGHT_PALETTE.skyHorizon);
    this.scene.clearColor = new Color4(
      horizonColor.r,
      horizonColor.g,
      horizonColor.b,
      1,
    );
    this.scene.fogMode = Scene.FOGMODE_LINEAR;
    this.scene.fogStart = 160;
    this.scene.fogEnd = 280;
    this.scene.fogColor = Color3.FromHexString(NIGHT_PALETTE.fog);
    this.scene.ambientColor = new Color3(0.23, 0.22, 0.26);
    this.scene.skipPointerMovePicking = true;
    const grade = this.scene.imageProcessingConfiguration;
    grade.toneMappingEnabled = true;
    grade.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    grade.exposure = 1.55;
    grade.contrast = 1.12;

    this.camera = new FreeCamera(
      'chase-camera',
      new Vector3(0, 9.8, -17),
      this.scene,
    );
    this.camera.fov = 0.78;
    this.camera.minZ = 0.2;
    this.camera.maxZ = 280;
    this.target.set(0, 1.25, 27);
    this.camera.setTarget(this.target);

    const sky = new HemisphericLight(
      'blue-hour-sky-light',
      new Vector3(0.1, 1, 0.15),
      this.scene,
    );
    sky.intensity = 0.82;
    sky.diffuse = new Color3(0.62, 0.7, 0.88);
    sky.groundColor = new Color3(0.38, 0.29, 0.18);
    const sun = new DirectionalLight(
      'blue-hour-moon-key',
      new Vector3(-0.42, -1, 0.48),
      this.scene,
    );
    sun.position.set(35, 48, -26);
    sun.intensity = 0.64;
    sun.diffuse = Color3.FromHexString('#ffddab');

    this.simulation = new AutorooSimulation(seed);
    this.boosterVisuals = new BoosterVisuals(this.scene);
    this.landingPoofs = new LandingPoofVisuals(this.scene);
    this.buildNightSky();
    this.buildGround();
    this.buildStreetlights();
    this.fallbackPlayer = this.buildFallbackPlayer();
    this.countdownLight = this.buildCountdownLight();
    this.buildTransitionSigns();
    this.buildGateLights();
    this.attachInput();
    this.callbacks.onSnapshot(this.simulation.snapshot());

    this.engine.runRenderLoop(() => this.frame());
    void this.loadModels();
  }

  start(): void {
    this.presentationDirty = true;
    this.crashAnimation.reset();
    this.landingPoofs.reset();
    this.simulation.start();
    this.input.clear();
    this.accumulatorS = 0;
    this.audio.setGameplayActive(true, true);
    void this.audio.wake();
    this.canvas.focus({ preventScroll: true });
    this.publish(true);
  }

  restart(): void {
    this.presentationDirty = true;
    this.crashAnimation.reset();
    this.landingPoofs.reset();
    this.simulation.restart();
    this.input.clear();
    this.accumulatorS = 0;
    this.audio.setGameplayActive(true, true);
    void this.audio.wake();
    this.canvas.focus({ preventScroll: true });
    this.publish(true);
  }

  setPaused(paused: boolean): void {
    this.presentationDirty = true;
    this.simulation.setPaused(paused);
    this.input.clear();
    this.audio.setGameplayActive(this.simulation.phaseName === 'running');
    if (this.simulation.phaseName === 'running') void this.audio.wake();
    else this.audio.updateEngine(this.simulation.renderPlayer.speedMps, false);
    this.publish(true);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.audio.setMuted(muted);
  }

  setTouchDriving(enabled: boolean): void {
    this.presentationDirty = true;
    this.touchDriving = enabled;
  }

  controlDown(control: DrivingControl, source: string): void {
    if (this.simulation.phaseName !== 'running') return;
    this.input.press(control, source);
    void this.audio.wake();
  }

  controlUp(source: string): void {
    this.input.release(source);
  }

  snapshot(): RunSnapshot {
    return this.simulation.snapshot();
  }

  isReady(): boolean {
    return this.ready;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.clear();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('pageshow', this.onPageShow);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas.removeEventListener('pointerdown', this.focusCanvas);
    this.resizeObserver?.disconnect();
    this.audio.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }

  private readonly focusCanvas = () => {
    this.canvas.focus({ preventScroll: true });
    if (this.simulation.phaseName === 'running') void this.audio.wake();
  };

  private attachInput(): void {
    this.canvas.tabIndex = 0;
    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('pageshow', this.onPageShow);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.canvas.addEventListener('pointerdown', this.focusCanvas);
    this.resizeObserver = new ResizeObserver(this.onResize);
    this.resizeObserver.observe(this.canvas);
  }

  private buildNightSky(): void {
    const height = 256;
    const texture = new DynamicTexture(
      'autoroo-night-gradient',
      { width: 4, height },
      this.scene,
      false,
    );
    const context = texture.getContext() as unknown as CanvasRenderingContext2D;
    // Babylon samples the uploaded canvas upside-down on the inside of this
    // dome, so the canvas bottom is the zenith and the top is the horizon.
    const gradient = context.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, NIGHT_PALETTE.skyTop);
    gradient.addColorStop(0.5, '#182744');
    gradient.addColorStop(0.8, '#243755');
    gradient.addColorStop(1, NIGHT_PALETTE.skyHorizon);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 4, height);
    texture.update();

    const material = new StandardMaterial('night-sky-dome-mat', this.scene);
    material.emissiveTexture = texture;
    material.diffuseColor = Color3.Black();
    material.specularColor = Color3.Black();
    material.disableLighting = true;
    material.fogEnabled = false;
    material.freeze();

    const dome = CreateSphere(
      'night-sky-dome',
      {
        diameter: 548,
        segments: 12,
        sideOrientation: Mesh.BACKSIDE,
      },
      this.scene,
    );
    dome.material = material;
    dome.infiniteDistance = true;
    dome.isPickable = false;
    dome.applyFog = false;
  }

  private buildStreetlights(): void {
    const iron = makeMaterial(this.scene, 'streetlight-iron', '#15191f');
    const lampHead = makeMaterial(
      this.scene,
      'streetlight-warm-head',
      NIGHT_PALETTE.lampWarm,
    );
    lampHead.emissiveColor = new Color3(1.5, 0.86, 0.34);

    const poolTexture = new DynamicTexture(
      'streetlight-pool-texture',
      { width: 128, height: 128 },
      this.scene,
      true,
    );
    const context =
      poolTexture.getContext() as unknown as CanvasRenderingContext2D;
    const gradient = context.createRadialGradient(64, 64, 2, 64, 64, 62);
    gradient.addColorStop(0, 'rgba(255,196,120,0.72)');
    gradient.addColorStop(0.22, 'rgba(255,175,100,0.45)');
    gradient.addColorStop(0.55, 'rgba(255,150,78,0.18)');
    gradient.addColorStop(1, 'rgba(255,140,60,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
    poolTexture.update(false);
    poolTexture.hasAlpha = true;

    const poolMaterial = new StandardMaterial(
      'streetlight-pavement-pool',
      this.scene,
    );
    poolMaterial.emissiveColor = new Color3(0.62, 0.4, 0.17);
    poolMaterial.emissiveTexture = poolTexture;
    poolMaterial.opacityTexture = poolTexture;
    poolMaterial.alphaMode = Constants.ALPHA_ADD;
    poolMaterial.diffuseColor = Color3.Black();
    poolMaterial.specularColor = Color3.Black();
    poolMaterial.disableLighting = true;
    poolMaterial.disableDepthWrite = true;

    // Four off-camera source meshes feed every pooled fixture. Babylon batches
    // each source with its instances, so the avenue adds four geometry groups
    // rather than four fresh uploads and draw groups per lamp.
    const poleSource = CreateCylinder(
      'streetlight-pole-source',
      { height: 5.2, diameter: 0.16, tessellation: 8 },
      this.scene,
    );
    poleSource.position.y = -1_000;
    poleSource.material = iron;
    poleSource.isPickable = false;
    poleSource.receiveShadows = false;
    const armSource = CreateBox(
      'streetlight-arm-source',
      { width: 1.4, height: 0.09, depth: 0.09 },
      this.scene,
    );
    armSource.position.y = -1_000;
    armSource.material = iron;
    armSource.isPickable = false;
    armSource.receiveShadows = false;
    const headSource = CreateBox(
      'streetlight-head-source',
      { width: 0.55, height: 0.12, depth: 0.26 },
      this.scene,
    );
    headSource.position.y = -1_000;
    headSource.material = lampHead;
    headSource.isPickable = false;
    headSource.receiveShadows = false;
    const poolSource = CreateGround(
      'streetlight-pool-source',
      { width: 10, height: 10, subdivisions: 1 },
      this.scene,
    );
    poolSource.position.y = -1_000;
    poolSource.material = poolMaterial;
    poolSource.isPickable = false;
    poolSource.receiveShadows = false;

    for (let slot = 0; slot < STREETLIGHT_POOL_SIZE; slot += 1) {
      const side = streetlightSide(slot);
      const root = new TransformNode(`streetlight-${slot}`, this.scene);
      const pole = poleSource.createInstance(`streetlight-pole-${slot}`);
      pole.position.y = 2.6;
      pole.parent = root;
      pole.isPickable = false;

      const arm = armSource.createInstance(`streetlight-arm-${slot}`);
      arm.position.set(-side * 0.6, 5.15, 0);
      arm.parent = root;
      arm.isPickable = false;

      const head = headSource.createInstance(`streetlight-head-${slot}`);
      head.position.set(-side * 1.25, 5.08, 0);
      head.parent = root;
      head.isPickable = false;

      const pool = poolSource.createInstance(`streetlight-pool-${slot}`);
      pool.position.set(-side * 2.1, 0.11, 0);
      pool.parent = root;
      pool.isPickable = false;

      root.setEnabled(false);
      this.streetlightPool.push({ root, side, absoluteStation: null });
    }
    iron.freeze();
    lampHead.freeze();
    poolMaterial.freeze();
  }

  private createDynamicRoadMesh(
    name: string,
    positions: Float32Array,
    indices: Uint16Array,
    material: Material,
  ): DynamicRoadMesh {
    const mesh = new Mesh(name, this.scene);
    const normals = new Float32Array(positions.length);
    for (let offset = 1; offset < normals.length; offset += 3)
      normals[offset] = 1;
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.normals = normals;
    vertexData.indices = indices;
    vertexData.applyToMesh(mesh, true);
    mesh.material = material;
    mesh.isPickable = false;
    mesh.receiveShadows = false;
    return { mesh, positions };
  }

  private createRoadSurface(
    tileIndex: number,
    material: Material,
  ): DynamicRoadMesh {
    const positions = new Float32Array(ROAD_SECTION_COUNT * 2 * 3);
    for (let section = 0; section < ROAD_SECTION_COUNT; section += 1) {
      const z = -ROAD_TILE_LENGTH_M / 2 + section * ROAD_SAMPLE_INTERVAL_M;
      writeVertex(positions, section * 2, -ROAD_HALF_WIDTH_MAX_M, z);
      writeVertex(positions, section * 2 + 1, ROAD_HALF_WIDTH_MAX_M, z);
    }
    const indices = new Uint16Array((ROAD_SECTION_COUNT - 1) * 6);
    for (let section = 0; section < ROAD_SECTION_COUNT - 1; section += 1) {
      const vertex = section * 2;
      const offset = section * 6;
      indices.set(
        [vertex + 1, vertex + 3, vertex + 2, vertex, vertex + 1, vertex + 2],
        offset,
      );
    }
    return this.createDynamicRoadMesh(
      `road-surface-${tileIndex}`,
      positions,
      indices,
      material,
    );
  }

  private createRoadShoulders(
    tileIndex: number,
    material: Material,
  ): DynamicRoadMesh {
    const positions = new Float32Array(ROAD_SECTION_COUNT * 4 * 3);
    for (let section = 0; section < ROAD_SECTION_COUNT; section += 1) {
      const z = -ROAD_TILE_LENGTH_M / 2 + section * ROAD_SAMPLE_INTERVAL_M;
      const vertex = section * 4;
      writeVertex(
        positions,
        vertex,
        -ROAD_HALF_WIDTH_MAX_M - ROAD_SIDEWALK_WIDTH_M,
        z,
      );
      writeVertex(positions, vertex + 1, -ROAD_HALF_WIDTH_MAX_M, z);
      writeVertex(positions, vertex + 2, ROAD_HALF_WIDTH_MAX_M, z);
      writeVertex(
        positions,
        vertex + 3,
        ROAD_HALF_WIDTH_MAX_M + ROAD_SIDEWALK_WIDTH_M,
        z,
      );
    }
    const indices = new Uint16Array((ROAD_SECTION_COUNT - 1) * 12);
    for (let section = 0; section < ROAD_SECTION_COUNT - 1; section += 1) {
      const vertex = section * 4;
      const next = vertex + 4;
      const offset = section * 12;
      indices.set(
        [
          vertex + 1,
          next + 1,
          next,
          vertex,
          vertex + 1,
          next,
          vertex + 3,
          next + 3,
          next + 2,
          vertex + 2,
          vertex + 3,
          next + 2,
        ],
        offset,
      );
    }
    return this.createDynamicRoadMesh(
      `road-shoulders-${tileIndex}`,
      positions,
      indices,
      material,
    );
  }

  private createRoadMarkings(
    tileIndex: number,
    material: Material,
  ): DynamicRoadMesh {
    const quadCount = 3 * DASHES_PER_TILE;
    const positions = new Float32Array(quadCount * 4 * 3);
    const indices = new Uint16Array(quadCount * 6);
    for (let boundary = 0; boundary < 3; boundary += 1) {
      const centerX = -3.6 + boundary * 3.6;
      for (let dash = 0; dash < DASHES_PER_TILE; dash += 1) {
        const quad = boundary * DASHES_PER_TILE + dash;
        const centerZ = -15 + dash * 10;
        writeQuad(
          positions,
          quad * 4,
          centerX - DASH_WIDTH_M / 2,
          centerX + DASH_WIDTH_M / 2,
          centerZ - DASH_LENGTH_M / 2,
          centerZ + DASH_LENGTH_M / 2,
        );
        const vertex = quad * 4;
        indices.set(
          [vertex + 1, vertex + 3, vertex + 2, vertex, vertex + 1, vertex + 2],
          quad * 6,
        );
      }
    }
    return this.createDynamicRoadMesh(
      `road-markings-${tileIndex}`,
      positions,
      indices,
      material,
    );
  }

  private buildGround(): void {
    const groundMaterial = makeMaterial(
      this.scene,
      'urban-ground-mat',
      NIGHT_PALETTE.ground,
    );
    const roadMaterial = makeMaterial(
      this.scene,
      'road-mat',
      NIGHT_PALETTE.road,
    );
    const shoulderMaterial = makeMaterial(
      this.scene,
      'sidewalk-mat',
      NIGHT_PALETTE.pavement,
    );
    const paintMaterial = makeMaterial(
      this.scene,
      'paint-mat',
      NIGHT_PALETTE.roadPaint,
    );
    groundMaterial.freeze();
    roadMaterial.freeze();
    shoulderMaterial.freeze();
    paintMaterial.freeze();

    const ground = CreateGround(
      'recycled-city-ground',
      { width: 130, height: 650 },
      this.scene,
    );
    ground.position.z = 230;
    ground.material = groundMaterial;
    ground.freezeWorldMatrix();

    for (
      let tileIndex = 0;
      tileIndex < RENDER_POOL_LIMITS.roadTiles;
      tileIndex += 1
    ) {
      const surface = this.createRoadSurface(tileIndex, roadMaterial);
      const shoulders = this.createRoadShoulders(tileIndex, shoulderMaterial);
      const markings = this.createRoadMarkings(tileIndex, paintMaterial);
      surface.mesh.position.y = 0.04;
      shoulders.mesh.position.y = 0.085;
      markings.mesh.position.y = 0.095;
      this.roadTiles.push({
        surface,
        shoulders,
        markings,
        absoluteIndex: null,
      });
    }
  }

  private buildFallbackPlayer(): FallbackPlayerVisual {
    const holder = new TransformNode('fallback-player', this.scene);
    const animationPivot = new TransformNode(
      'fallback-player-animation-pivot',
      this.scene,
    );
    animationPivot.parent = holder;
    animationPivot.position.y = PLAYER_FLIP_PIVOT_Y_M;
    const blue = makeMaterial(this.scene, 'fallback-blue', PLAYER_CAR_COLOR);
    const trim = makeMaterial(this.scene, 'fallback-trim', '#172b3a');
    const body = CreateBox(
      'fallback-player-body',
      { width: 1.9, height: 0.65, depth: 4.05 },
      this.scene,
    );
    body.position.y = 0.58 - PLAYER_FLIP_PIVOT_Y_M;
    body.material = blue;
    body.parent = animationPivot;
    const cabin = CreateBox(
      'fallback-player-cabin',
      { width: 1.5, height: 0.58, depth: 1.85 },
      this.scene,
    );
    cabin.position.set(0, 1.18 - PLAYER_FLIP_PIVOT_Y_M, -0.1);
    cabin.material = trim;
    cabin.parent = animationPivot;
    return { holder, animationPivot };
  }

  private buildCountdownLight(): TransformNode {
    const root = new TransformNode('start-countdown-light', this.scene);
    const dark = makeMaterial(this.scene, 'countdown-dark', '#173044');
    const red = makeMaterial(this.scene, 'countdown-red', '#ff5f57');
    const yellow = makeMaterial(this.scene, 'countdown-yellow', '#f6d94f');
    const green = makeMaterial(this.scene, 'countdown-green', '#63d474');
    red.emissiveColor = new Color3(0.9, 0.05, 0.03);
    yellow.emissiveColor = new Color3(0.8, 0.58, 0.12);
    green.emissiveColor = new Color3(0.2, 0.8, 0.34);
    const pole = CreateBox(
      'countdown-pole',
      { width: 0.24, height: 5, depth: 0.24 },
      this.scene,
    );
    pole.position.y = 2.5;
    pole.material = dark;
    pole.parent = root;
    const housing = CreateBox(
      'countdown-housing',
      { width: 1.45, height: 3.6, depth: 0.72 },
      this.scene,
    );
    housing.position.y = 5.35;
    housing.material = dark;
    housing.parent = root;
    for (const [index, material] of [red, yellow, green].entries()) {
      const lamp = CreateSphere(
        `countdown-lamp-${index}`,
        { diameter: 0.72, segments: 12 },
        this.scene,
      );
      lamp.position.set(0, 6.45 - index * 1.08, -0.38);
      lamp.material = material;
      lamp.parent = root;
    }
    root.position.set(-8.7, 0, 23);
    return root;
  }

  private buildTransitionSigns(): void {
    const poleMaterial = makeMaterial(this.scene, 'merge-pole-mat', '#263d4e');
    const signMaterial = makeMaterial(this.scene, 'merge-sign-mat', '#f6d94f');
    const lightMaterial = makeMaterial(
      this.scene,
      'warning-light-mat',
      '#ff5f57',
    );
    lightMaterial.emissiveColor = Color3.FromHexString('#ff302f');
    for (let index = 0; index < 4; index += 1) {
      const root = new TransformNode(`merge-sign-${index}`, this.scene);
      const pole = CreateBox(
        `merge-pole-${index}`,
        { width: 0.14, height: 2.7, depth: 0.14 },
        this.scene,
      );
      pole.position.y = 1.35;
      pole.material = poleMaterial;
      pole.parent = root;
      const sign = CreateBox(
        `merge-board-${index}`,
        { width: 1.35, height: 1.35, depth: 0.14 },
        this.scene,
      );
      sign.position.y = 3.05;
      sign.rotation.z = Math.PI / 4;
      sign.material = signMaterial;
      sign.parent = root;
      const light = CreateSphere(
        `merge-light-${index}`,
        { diameter: 0.28, segments: 8 },
        this.scene,
      );
      light.position.set(0, 3.92, -0.12);
      light.material = lightMaterial;
      light.parent = root;
      root.setEnabled(false);
      this.transitionSigns.push(root);
    }
  }

  private buildGateLights(): void {
    const housing = makeMaterial(this.scene, 'gate-light-housing', '#172b3a');
    const warning = makeMaterial(this.scene, 'gate-light-red', '#ff443d');
    warning.emissiveColor = Color3.FromHexString('#ff312c');
    for (let index = 0; index < 2; index += 1) {
      const root = new TransformNode(`gate-warning-${index}`, this.scene);
      const pole = CreateBox(
        `gate-warning-pole-${index}`,
        { width: 0.18, height: 4.8, depth: 0.18 },
        this.scene,
      );
      pole.position.y = 2.4;
      pole.material = housing;
      pole.parent = root;
      const lamp = CreateSphere(
        `gate-warning-lamp-${index}`,
        { diameter: 0.6, segments: 10 },
        this.scene,
      );
      lamp.position.y = 5;
      lamp.material = warning;
      lamp.parent = root;
      root.setEnabled(false);
      this.gateLights.push(root);
    }
  }

  private async loadModels(): Promise<void> {
    const entries = Object.entries(MODEL_URLS) as [ModelKey, string][];
    let completed = 0;
    await Promise.all(
      entries.map(async ([key, url]) => {
        try {
          const container = await LoadAssetContainerAsync(url, this.scene);
          if (this.disposed) {
            container.dispose();
            return;
          }
          this.prepareContainerMaterials(container, MODEL_CONFIGS[key]);
          this.containers.set(key, container);
        } catch (error) {
          console.warn(`[Autoroo] Could not load ${url}`, error);
        } finally {
          completed += 1;
          this.callbacks.onLoadProgress(completed / entries.length);
        }
      }),
    );
    if (this.disposed) return;
    this.buildModelPools();
    this.ready = true;
    this.presentationDirty = true;
    this.callbacks.onReady();
  }

  private prepareContainerMaterials(
    container: AssetContainer,
    config: ModelConfig,
  ): void {
    if (config.bodyMaterials && config.color) {
      this.prepareVehicleMaterials(container, config);
      return;
    }
    if (BUILDING_KEYS.includes(config.key as BuildingModelKey)) {
      this.applyNightWindowGlow(container, config.key);
      for (const material of container.materials) material.freeze();
    }
  }

  /**
   * Mirrors Curbside Rush's inexpensive vehicle treatment once on each source
   * container. Every pooled instance keeps sharing this one material set, so
   * the clearer paint/glass highlights add neither draw calls nor per-car
   * material allocations.
   */
  private prepareVehicleMaterials(
    container: AssetContainer,
    config: ModelConfig,
  ): void {
    const paint = Color3.FromHexString(config.color ?? '#ffffff');
    const bodyNames = new Set(config.bodyMaterials ?? []);
    const glassNames = new Set(config.glassMaterials ?? []);
    const glass = Color3.FromHexString('#292b2d');
    const converted = new Map<Material, StandardMaterial>();
    const headlight = new Color3(0.5, 0.46, 0.3);
    const taillight = new Color3(0.32, 0.03, 0.02);
    for (const mesh of container.meshes) {
      if (!(mesh instanceof Mesh)) continue;
      const source = mesh.material;
      if (!source) continue;
      let material = converted.get(source);
      if (!material) {
        material =
          source instanceof StandardMaterial
            ? source
            : new StandardMaterial(
                `autoroo-${config.key}-${source.name}`,
                this.scene,
              );
        if (source instanceof PBRMaterial)
          material.diffuseTexture = source.albedoTexture;
        material.diffuseColor = glassNames.has(source.name)
          ? glass.clone()
          : bodyNames.has(source.name)
            ? paint.clone()
            : materialAlbedo(source).clone();
        material.alpha = source.alpha;
        material.backFaceCulling = source.backFaceCulling;

        if (
          /window|glass|windscreen|windshield/i.test(source.name) ||
          glassNames.has(source.name)
        ) {
          material.specularColor = new Color3(0.36, 0.36, 0.36);
          material.specularPower = 72;
        } else if (
          /black|wheel|tire|tyre|rubber/i.test(source.name) ||
          source.name === '1A1A1A'
        ) {
          material.specularColor = new Color3(0.05, 0.05, 0.05);
          material.specularPower = 22;
        } else {
          material.specularColor = new Color3(0.22, 0.22, 0.22);
          material.specularPower = 44;
        }

        if (glassNames.has(source.name))
          material.emissiveColor = Color3.Black();
        else if (config.headlightMaterials?.includes(source.name))
          material.emissiveColor = headlight.clone();
        else if (config.taillightMaterials?.includes(source.name))
          material.emissiveColor = taillight.clone();
        else if (source instanceof PBRMaterial)
          material.emissiveColor = source.emissiveColor.clone();
        if (bodyNames.has(source.name) && !glassNames.has(source.name)) {
          material.emissiveColor = material.emissiveColor.add(
            paint.scale(0.06),
          );
        }

        converted.set(source, material);
      }
      mesh.material = material;
    }
    for (const material of converted.values()) material.freeze();
  }

  private applyNightWindowGlow(
    container: AssetContainer,
    modelKey: ModelKey,
  ): void {
    const warm = new Color3(1, 0.82, 0.62);
    const darkPane = new Color3(0.05, 0.045, 0.04);
    const neutralFrame = new Color3(0.25, 0.24, 0.22);
    for (const material of container.materials) {
      // The tower uses the same blue trim colour for solid window framing.
      // Give those frames a neutral finish without making them emit light.
      if (modelKey === 'towerB' && material.name === 'trim') {
        if (material instanceof PBRMaterial)
          material.albedoColor = neutralFrame.clone();
        else if (material instanceof StandardMaterial)
          material.diffuseColor = neutralFrame.clone();
        continue;
      }
      if (!isNightWindowMaterialName(material.name, modelKey)) continue;
      if (material instanceof PBRMaterial) {
        const authored =
          material.emissiveTexture !== null ||
          material.emissiveColor.r +
            material.emissiveColor.g +
            material.emissiveColor.b >
            0.001;
        if (authored) continue;
        material.albedoColor = darkPane.clone();
        material.emissiveColor = warm.clone();
        material.emissiveIntensity = 0.42;
      } else if (material instanceof StandardMaterial) {
        const authored =
          material.emissiveTexture !== null ||
          material.emissiveColor.r +
            material.emissiveColor.g +
            material.emissiveColor.b >
            0.001;
        if (authored) continue;
        material.diffuseColor = darkPane.clone();
        material.emissiveColor = warm.scale(0.42);
      }
    }
  }

  private instantiate(
    config: ModelConfig,
    name: string,
    kind: VisualEntry['kind'],
    shadow: boolean,
    animationPivotY = 0,
  ): VisualEntry | null {
    const container = this.containers.get(config.key);
    if (!container) return null;
    const holder = new TransformNode(`${name}-holder`, this.scene);
    let modelParent: TransformNode = holder;
    let animationPivot: TransformNode | null = null;
    if (animationPivotY !== 0) {
      animationPivot = new TransformNode(`${name}-animation-pivot`, this.scene);
      animationPivot.parent = holder;
      animationPivot.position.y = animationPivotY;
      modelParent = new TransformNode(`${name}-model-mount`, this.scene);
      modelParent.parent = animationPivot;
      modelParent.position.y = -animationPivotY;
    }
    const instance = container.instantiateModelsToScene(
      (sourceName) => `${name}-${sourceName}`,
      false,
      // Babylon otherwise clones full meshes; dense traffic must share geometry.
      { doNotInstantiate: false },
    );
    for (const root of instance.rootNodes) {
      root.parent = modelParent;
      if (root instanceof TransformNode) {
        root.rotationQuaternion = null;
        root.rotation.y = config.yaw;
        root.scaling.setAll(config.scale);
      }
      for (const mesh of root.getChildMeshes(false)) {
        mesh.isPickable = false;
        mesh.receiveShadows = false;
        mesh.alwaysSelectAsActiveMesh = false;
      }
    }
    holder.position.y = config.groundY;
    let blob: Mesh | null = null;
    if (shadow) {
      blob = CreateDisc(
        `${name}-blob-shadow`,
        { radius: 1, tessellation: 20 },
        this.scene,
      );
      blob.rotation.x = Math.PI / 2;
      blob.scaling.set(
        kind === 'bus' ? 1.45 : 1,
        kind === 'bus' ? 3.1 : 2.15,
        1,
      );
      blob.position.y = 0.045;
      blob.material = this.shadowMaterial();
      blob.isPickable = false;
    }
    const entry = {
      holder,
      animationPivot,
      shadow: blob,
      kind,
      groundY: config.groundY,
      enabled: true,
    } satisfies VisualEntry;
    setVisible(entry, false);
    return entry;
  }

  private shadowMaterialCache: StandardMaterial | null = null;
  private shadowMaterial(): StandardMaterial {
    if (!this.shadowMaterialCache) {
      const size = 128;
      const texture = new DynamicTexture(
        'blob-shadow-texture',
        size,
        this.scene,
        false,
      );
      const context = texture.getContext();
      const gradient = context.createRadialGradient(
        size / 2,
        size / 2,
        size * 0.06,
        size / 2,
        size / 2,
        size / 2,
      );
      gradient.addColorStop(0, 'rgba(0,0,0,0.5)');
      gradient.addColorStop(0.55, 'rgba(0,0,0,0.26)');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, size, size);
      texture.hasAlpha = true;
      texture.update();

      this.shadowMaterialCache = makeMaterial(
        this.scene,
        'blob-shadow-mat',
        '#000000',
      );
      this.shadowMaterialCache.diffuseTexture = texture;
      this.shadowMaterialCache.useAlphaFromDiffuseTexture = true;
      this.shadowMaterialCache.disableLighting = true;
      this.shadowMaterialCache.backFaceCulling = false;
      this.shadowMaterialCache.freeze();
    }
    return this.shadowMaterialCache;
  }

  private buildModelPools(): void {
    this.playerVisual = this.instantiate(
      MODEL_CONFIGS.sports,
      'player-car',
      'sedan',
      true,
      PLAYER_FLIP_PIVOT_Y_M,
    );
    if (this.playerVisual) {
      setVisible(this.playerVisual, true);
      this.fallbackPlayer.holder.setEnabled(false);
    }
    for (let index = 0; index < RENDER_POOL_LIMITS.frontCars / 2; index += 1) {
      const sedan = this.instantiate(
        MODEL_CONFIGS.sedan,
        `sedan-${index}`,
        'sedan',
        true,
      );
      const suv = this.instantiate(
        MODEL_CONFIGS.suv,
        `suv-${index}`,
        'suv',
        true,
      );
      if (sedan) this.sedanPool.push(sedan);
      if (suv) this.suvPool.push(suv);
    }
    for (let index = 0; index < RENDER_POOL_LIMITS.buses; index += 1) {
      const bus = this.instantiate(
        MODEL_CONFIGS.bus,
        `bus-${index}`,
        'bus',
        true,
      );
      if (bus) this.busPool.push(bus);
    }
    for (
      let stationSlot = 0;
      stationSlot < BUILDING_STATION_POOL_SIZE;
      stationSlot += 1
    ) {
      for (const side of [-1, 1] as const) {
        const key = roadsideBuildingModelKey(stationSlot, side);
        const scenery = this.instantiate(
          MODEL_CONFIGS[key],
          `building-${stationSlot}-${side < 0 ? 'left' : 'right'}`,
          'scenery',
          false,
        );
        this.sceneryPool.push(
          scenery
            ? {
                ...scenery,
                modelKey: key,
                side,
                absoluteStation: null,
              }
            : null,
        );
      }
    }
  }

  private beginCrash(): void {
    this.input.clear();
    this.updateVisuals(1);
    const entry = this.playerVisual;
    const holder = entry?.holder ?? this.fallbackPlayer.holder;
    const pivot = entry
      ? (entry.animationPivot ?? entry.holder)
      : this.fallbackPlayer.animationPivot;
    this.crashAnimation.start(
      {
        xM: holder.position.x,
        yM: holder.position.y - (entry?.groundY ?? 0),
        zM: 0,
        pitch: pivot.rotation.x,
        yaw: pivot.rotation.y,
        roll: pivot.rotation.z,
        scaleX: pivot.scaling.x,
        scaleY: pivot.scaling.y,
        scaleZ: pivot.scaling.z,
      },
      holder.position.x > 0 ? -1 : 1,
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    );
  }

  private frame(): void {
    if (this.disposed) return;
    const rawDeltaMs = this.engine.getDeltaTime();
    const visible = document.visibilityState === 'visible';
    if (!visible) {
      this.renderQuality.sample(rawDeltaMs, false);
      return;
    }
    const deltaMs = Math.min(100, rawDeltaMs);
    const crashFinished = this.crashAnimation.advance(deltaMs / 1000);
    // Keep RAF alive for fresh resume deltas, but do no scene work for an
    // unchanged menu/pause/final crash frame. Assets and viewport events dirty
    // the presentation; crash animation keeps drawing through its final pose.
    if (
      this.simulation.phaseName !== 'running' &&
      !this.crashAnimation.isPlaying &&
      !crashFinished &&
      !this.presentationDirty
    ) {
      this.renderQuality.sample(rawDeltaMs, false);
      return;
    }
    if (this.simulation.phaseName === 'running') {
      this.accumulatorS = Math.min(0.25, this.accumulatorS + deltaMs / 1000);
      let steps = 0;
      while (
        this.accumulatorS + 1e-12 >= FIXED_DT &&
        steps < 15 &&
        this.simulation.phaseName === 'running'
      ) {
        this.simulation.tick(this.input.consume());
        this.accumulatorS -= FIXED_DT;
        steps += 1;
        for (const event of this.simulation.drainEvents()) {
          if (event.type === 'landing-poof')
            this.landingPoofs.start(
              event,
              window.matchMedia('(prefers-reduced-motion: reduce)').matches,
            );
          if (event.type === 'crash') this.beginCrash();
          this.audio.play(event);
          this.callbacks.onEvent(event);
        }
      }
    }
    this.publish(false);
    this.updateVisuals(clamp01(this.accumulatorS / FIXED_DT));
    this.audio.setGameplayActive(this.simulation.phaseName === 'running');
    this.audio.updateEngine(
      this.simulation.renderPlayer.speedMps,
      this.simulation.phaseName === 'running' && !this.muted,
    );
    // Check before drawing: compilation may finish during a render that
    // already skipped an unready mesh. That frame still needs one more draw.
    const presentationReady = !this.presentationDirty || this.scene.isReady();
    this.presentationDirty = false;
    this.scene.render();
    if (!presentationReady) this.presentationDirty = true;
    if (crashFinished) this.callbacks.onCrashAnimationComplete();
    if (
      this.renderQuality.sample(
        rawDeltaMs,
        this.ready &&
          this.simulation.phaseName === 'running' &&
          document.visibilityState === 'visible',
      )
    )
      this.engine.setHardwareScalingLevel(
        this.renderQuality.hardwareScalingLevel,
      );
  }

  private publish(force: boolean): void {
    const tick = this.simulation.renderTick;
    const phase = this.simulation.phaseName;
    if (
      !shouldPublishRunSnapshot(
        force,
        tick,
        this.lastPublishedTick,
        phase,
        this.lastPublishedPhase,
      )
    )
      return;
    this.lastPublishedTick = tick;
    this.lastPublishedPhase = phase;
    this.callbacks.onSnapshot(this.simulation.snapshot());
  }

  private updateVisuals(alpha: number): void {
    // The last simulation tick is frozen; the presentation has its own clock.
    if (this.simulation.phaseName === 'game-over') alpha = 1;
    const player = this.simulation.renderPlayer;
    const interpolatedX =
      player.previousXM + (player.xM - player.previousXM) * alpha;
    const interpolatedPlayerZ =
      player.previousZM + (player.absoluteZM - player.previousZM) * alpha;
    const interpolatedY =
      player.previousYM + (player.yM - player.previousYM) * alpha;
    const boosts = this.simulation.renderBoosters;
    const lanePose = laneChangeAnimationPose(player, alpha);
    // Jump height stays authoritative: flip clearance only fills any missing
    // ground clearance instead of stacking another hop on top of it.
    const visualY = Math.max(interpolatedY, lanePose.liftM);
    const jumpPitch = player.airborne ? -player.verticalSpeedMps * 0.004 : 0;
    const boingProgress =
      boosts.effect === 'boing' ? 1 - boosts.effectRemainingS / 0.8 : 0;
    const boingTurn =
      boingProgress * boingProgress * (3 - 2 * boingProgress) * Math.PI * 2;
    const stretch =
      1 + Math.sin(boingProgress * Math.PI * 4) * (1 - boingProgress) * 0.28;
    const crashPose = this.crashAnimation.pose();
    const carX = crashPose?.xM ?? interpolatedX;
    const carY = crashPose?.yM ?? visualY;
    const carZ = crashPose?.zM ?? 0;
    const pitch = crashPose?.pitch ?? jumpPitch - boingTurn;
    const yaw = crashPose?.yaw ?? 0;
    const roll = crashPose?.roll ?? lanePose.rollRad;
    const scaleX = crashPose?.scaleX ?? 1 / Math.sqrt(stretch);
    const scaleY = crashPose?.scaleY ?? stretch;
    const scaleZ = crashPose?.scaleZ ?? 1 / Math.sqrt(stretch);
    const playerEntry = this.playerVisual;
    if (playerEntry) {
      playerEntry.holder.position.set(carX, playerEntry.groundY + carY, carZ);
      const animationPivot = playerEntry.animationPivot ?? playerEntry.holder;
      animationPivot.rotation.set(pitch, yaw, roll);
      animationPivot.scaling.set(scaleX, scaleY, scaleZ);
      if (playerEntry.shadow) {
        playerEntry.shadow.position.set(carX, 0.05, carZ);
        playerEntry.shadow.rotation.y = yaw;
        playerEntry.shadow.scaling.z = Math.max(0.45, 1 - carY * 0.08);
        playerEntry.shadow.visibility = Math.max(0.08, 0.22 - carY * 0.025);
      }
    } else {
      this.fallbackPlayer.holder.position.set(carX, carY, carZ);
      this.fallbackPlayer.animationPivot.rotation.set(pitch, yaw, roll);
      this.fallbackPlayer.animationPivot.scaling.set(scaleX, scaleY, scaleZ);
    }
    this.boosterVisuals.update(
      this.simulation.renderPickups,
      crashPose ? this.inactiveBoosterVisuals : boosts,
      interpolatedPlayerZ,
      carX,
      carY,
      (this.simulation.renderTick + alpha) * FIXED_DT,
    );
    this.updateTraffic(interpolatedPlayerZ, alpha);
    this.updateRoad(interpolatedPlayerZ);
    this.updateScenery(interpolatedPlayerZ);
    this.updateStreetlights(interpolatedPlayerZ);
    this.updateFurniture(interpolatedPlayerZ);

    // Keep the eye and its target on the same centreline. Partial, mismatched
    // lane offsets made the old shot yaw sideways and read as a tilted camera.
    this.camera.position.x = interpolatedX;
    const framing = chaseCameraFraming(
      this.viewportWidth,
      this.viewportHeight,
      this.touchDriving,
    );
    this.camera.position.z = framing.z;
    const flightFollow = Math.max(0, interpolatedY - 4.5) * 0.9;
    this.camera.position.y =
      framing.height + interpolatedY * 0.12 + flightFollow;
    this.camera.fov =
      framing.fov +
      (boosts.rocket
        ? Math.sin((boosts.rocket.elapsedS / 4) * Math.PI) * 0.13
        : 0);
    this.target.set(
      interpolatedX,
      1.3 + interpolatedY * 0.16 + flightFollow,
      framing.targetZ,
    );
    this.camera.setTarget(this.target);
  }

  private updateTraffic(playerZ: number, alpha: number): void {
    let sedanIndex = 0;
    let suvIndex = 0;
    let busIndex = 0;
    const allocate = (
      vehicle: Readonly<TrafficVehicle>,
    ): VisualEntry | undefined => {
      let entry: VisualEntry | undefined;
      if (vehicle.kind === 'bus') entry = this.busPool[busIndex++];
      else if (vehicle.kind === 'suv') {
        if (suvIndex < this.suvPool.length) entry = this.suvPool[suvIndex++];
        else if (sedanIndex < this.sedanPool.length)
          entry = this.sedanPool[sedanIndex++];
      } else {
        if (sedanIndex < this.sedanPool.length)
          entry = this.sedanPool[sedanIndex++];
        else if (suvIndex < this.suvPool.length)
          entry = this.suvPool[suvIndex++];
      }
      return entry;
    };
    this.landingPoofs.update(
      playerZ,
      (this.simulation.renderTick + alpha) * FIXED_DT,
    );
    this.landingPoofs.forEachCar((vehicle, elapsed, reducedMotion) => {
      const entry = allocate(vehicle);
      if (!entry) return;
      this.placeTrafficVisual(entry, vehicle, playerZ, 1);
      entry.holder.position.z += vehicle.speedMps * elapsed;
      const pose = landingPoofCarPose(elapsed, reducedMotion);
      entry.holder.scaling.set(pose.scaleX, pose.scaleY, pose.scaleZ);
      entry.holder.rotation.z = pose.roll;
      if (entry.shadow) entry.shadow.setEnabled(false);
    });
    for (const vehicle of this.simulation.renderTraffic) {
      const entry = allocate(vehicle);
      if (entry) this.placeTrafficVisual(entry, vehicle, playerZ, alpha);
    }
    for (let index = sedanIndex; index < this.sedanPool.length; index += 1) {
      setVisible(this.sedanPool[index], false);
    }
    for (let index = suvIndex; index < this.suvPool.length; index += 1) {
      setVisible(this.suvPool[index], false);
    }
    for (let index = busIndex; index < this.busPool.length; index += 1) {
      setVisible(this.busPool[index], false);
    }
  }

  private placeTrafficVisual(
    entry: VisualEntry,
    vehicle: Readonly<TrafficVehicle>,
    playerZ: number,
    alpha: number,
  ): void {
    const z =
      vehicle.previousZM +
      (vehicle.absoluteZM - vehicle.previousZM) * alpha -
      playerZ;
    if (z < -75 || z > TRAFFIC_RENDER_AHEAD_M) {
      setVisible(entry, false);
      return;
    }
    setVisible(entry, true);
    entry.holder.scaling.setAll(1);
    entry.holder.rotation.setAll(0);
    entry.holder.position.set(LANE_X[vehicle.lane], entry.groundY, z);
    if (entry.shadow) {
      entry.shadow.setEnabled(true);
      entry.shadow.position.set(LANE_X[vehicle.lane], 0.05, z);
    }
  }

  private dividerActive(boundary: number, distanceM: number): boolean {
    const mask = laneMaskAt(this.simulation.seed, distanceM);
    return (
      hasLane(mask, boundary as LaneIndex) &&
      hasLane(mask, (boundary + 1) as LaneIndex)
    );
  }

  /** Clips a dash exactly where a changing lane becomes available/unavailable. */
  private dividerSpan(
    boundary: number,
    startM: number,
    endM: number,
  ): readonly [number, number] | null {
    const epsilonM = 0.0001;
    const startActive = this.dividerActive(boundary, startM + epsilonM);
    const endActive = this.dividerActive(boundary, endM - epsilonM);
    if (startActive === endActive) return startActive ? [startM, endM] : null;

    // A dash is shorter than the spacing between any two topology changes,
    // so a single deterministic bisection finds the only availability edge.
    let lowM = startM + epsilonM;
    let highM = endM - epsilonM;
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const midpointM = (lowM + highM) / 2;
      if (this.dividerActive(boundary, midpointM) === startActive)
        lowM = midpointM;
      else highM = midpointM;
    }
    const edgeM = (lowM + highM) / 2;
    return startActive ? [startM, edgeM] : [edgeM, endM];
  }

  private rebuildRoadTile(tile: RoadTile, absoluteIndex: number): void {
    const startM = absoluteIndex * ROAD_TILE_LENGTH_M;
    const centerM = startM + ROAD_TILE_LENGTH_M / 2;
    for (let section = 0; section < ROAD_SECTION_COUNT; section += 1) {
      const distanceM = startM + section * ROAD_SAMPLE_INTERVAL_M;
      const localZ = distanceM - centerM;
      const profile = visualRoadProfileAt(this.simulation.seed, distanceM);
      const leftEdgeM = profile.centerX - profile.widthM / 2;
      const rightEdgeM = profile.centerX + profile.widthM / 2;
      const surfaceVertex = section * 2;
      writeVertex(tile.surface.positions, surfaceVertex, leftEdgeM, localZ);
      writeVertex(
        tile.surface.positions,
        surfaceVertex + 1,
        rightEdgeM,
        localZ,
      );

      const shoulderVertex = section * 4;
      writeVertex(
        tile.shoulders.positions,
        shoulderVertex,
        leftEdgeM - ROAD_SIDEWALK_WIDTH_M,
        localZ,
      );
      writeVertex(
        tile.shoulders.positions,
        shoulderVertex + 1,
        leftEdgeM,
        localZ,
      );
      writeVertex(
        tile.shoulders.positions,
        shoulderVertex + 2,
        rightEdgeM,
        localZ,
      );
      writeVertex(
        tile.shoulders.positions,
        shoulderVertex + 3,
        rightEdgeM + ROAD_SIDEWALK_WIDTH_M,
        localZ,
      );
    }

    for (let boundary = 0; boundary < 3; boundary += 1) {
      const centerX = -3.6 + boundary * 3.6;
      for (let dash = 0; dash < DASHES_PER_TILE; dash += 1) {
        const quad = boundary * DASHES_PER_TILE + dash;
        const dashCenterM = startM + 5 + dash * 10;
        const dashStartM = dashCenterM - DASH_LENGTH_M / 2;
        const dashEndM = dashCenterM + DASH_LENGTH_M / 2;
        const span = this.dividerSpan(boundary, dashStartM, dashEndM);
        if (span) {
          writeQuad(
            tile.markings.positions,
            quad * 4,
            centerX - DASH_WIDTH_M / 2,
            centerX + DASH_WIDTH_M / 2,
            span[0] - centerM,
            span[1] - centerM,
          );
        } else {
          // Preserve fixed-capacity buffers by collapsing unavailable dashes.
          const localZ = dashCenterM - centerM;
          writeQuad(
            tile.markings.positions,
            quad * 4,
            centerX,
            centerX,
            localZ,
            localZ,
          );
        }
      }
    }

    // Initial buffers use conservative four-lane bounds, so these uploads do
    // not need to recalculate bounds and can never cull a wider recycled tile.
    tile.surface.mesh.updateVerticesData(
      VertexBuffer.PositionKind,
      tile.surface.positions,
      false,
      false,
    );
    tile.shoulders.mesh.updateVerticesData(
      VertexBuffer.PositionKind,
      tile.shoulders.positions,
      false,
      false,
    );
    tile.markings.mesh.updateVerticesData(
      VertexBuffer.PositionKind,
      tile.markings.positions,
      false,
      false,
    );
    tile.absoluteIndex = absoluteIndex;
  }

  private updateRoad(playerZ: number): void {
    const firstTile = Math.floor((playerZ - 80) / ROAD_TILE_LENGTH_M);
    const tileCount = this.roadTiles.length;
    for (let offset = 0; offset < tileCount; offset += 1) {
      const absoluteIndex = firstTile + offset;
      const tile = this.roadTiles[positiveModulo(absoluteIndex, tileCount)];
      if (tile.absoluteIndex !== absoluteIndex)
        this.rebuildRoadTile(tile, absoluteIndex);
      const startM = absoluteIndex * ROAD_TILE_LENGTH_M;
      const centerM = startM + ROAD_TILE_LENGTH_M / 2;
      const relativeZ = centerM - playerZ;
      tile.surface.mesh.position.z = relativeZ;
      tile.shoulders.mesh.position.z = relativeZ;
      tile.markings.mesh.position.z = relativeZ;
    }
  }

  private updateScenery(playerZ: number): void {
    const firstStation = firstRoadsideBuildingStation(playerZ);
    for (let offset = 0; offset < BUILDING_STATION_POOL_SIZE; offset += 1) {
      const absoluteStation = firstStation + offset;
      for (const side of [-1, 1] as const) {
        const entry =
          this.sceneryPool[roadsideBuildingPoolSlot(absoluteStation, side)];
        if (!entry) continue;
        if (entry.absoluteStation !== absoluteStation) {
          const placement = roadsideBuildingPlacement(
            this.simulation.seed,
            absoluteStation,
            side,
          );
          entry.absoluteStation = absoluteStation;
          entry.holder.position.x = placement.xM;
          entry.holder.position.y = MODEL_CONFIGS[entry.modelKey].groundY;
          // The root already carries the model's facade offset. Applying only
          // this quarter turn avoids the previous double-yaw bug.
          entry.holder.rotation.y = placement.holderYaw;
        }
        const zM = absoluteStation * BUILDING_STATION_SPACING_M;
        entry.holder.position.z = zM - playerZ;
        setVisible(entry, isRoadsideBuildingVisible(zM, playerZ));
      }
    }
  }

  private updateStreetlights(playerZ: number): void {
    const firstStation = firstStreetlightStation(playerZ);
    for (let offset = 0; offset < STREETLIGHT_POOL_SIZE; offset += 1) {
      const absoluteStation = firstStation + offset;
      const entry = this.streetlightPool[streetlightPoolSlot(absoluteStation)];
      // The even-sized pool preserves station parity, so a recycled root keeps
      // the same kerb-facing arm and pool orientation for its whole lifetime.
      if (entry.side !== streetlightSide(absoluteStation)) {
        entry.root.setEnabled(false);
        continue;
      }
      if (entry.absoluteStation !== absoluteStation) {
        const placement = streetlightPlacement(
          this.simulation.seed,
          absoluteStation,
        );
        entry.absoluteStation = absoluteStation;
        entry.root.position.x = placement.xM;
      }
      const zM = absoluteStation * STREETLIGHT_SPACING_M;
      entry.root.position.z = zM - playerZ;
      entry.root.setEnabled(isStreetlightVisible(zM, playerZ));
    }
  }

  private updateFurniture(playerZ: number): void {
    this.countdownLight.position.z = 23 - playerZ;
    this.countdownLight.setEnabled(this.countdownLight.position.z > -25);

    for (const sign of this.transitionSigns) sign.setEnabled(false);
    const firstModule = Math.max(0, Math.floor(playerZ / 100));
    let signIndex = 0;
    for (
      let moduleIndex = firstModule;
      moduleIndex < firstModule + 6 && signIndex < this.transitionSigns.length;
      moduleIndex += 1
    ) {
      const roadModule = roadModuleAt(this.simulation.seed, moduleIndex);
      if (!roadModule.transition || roadModule.startM - playerZ < -20) continue;
      const sign = this.transitionSigns[signIndex++];
      const side = roadModule.transition.lane < 2 ? -1 : 1;
      const signZM = roadModule.startM + 8;
      const profile = visualRoadProfileAt(this.simulation.seed, signZM);
      const roadEdgeM = profile.centerX + side * (profile.widthM / 2);
      sign.position.set(roadEdgeM + side * 0.72, 0, signZM - playerZ);
      sign.rotation.y = side < 0 ? Math.PI / 5 : -Math.PI / 5;
      sign.setEnabled(true);
    }

    const certificate = this.simulation.renderCertificate;
    if (!certificate) {
      for (const light of this.gateLights) light.setEnabled(false);
      return;
    }
    const blocker = this.simulation.renderTraffic.find(
      (vehicle) => vehicle.id === certificate.blockerIds[0],
    );
    if (!blocker) return;
    const lanes = activeLanes(
      laneMaskForCertificate(certificate.blockerTrajectories),
    );
    const left = LANE_X[lanes[0]] - 2.7;
    const right = LANE_X[lanes[lanes.length - 1]] + 2.7;
    for (let index = 0; index < this.gateLights.length; index += 1) {
      const light = this.gateLights[index];
      light.position.set(
        index === 0 ? left : right,
        0,
        blocker.absoluteZM - playerZ - 15,
      );
      light.setEnabled(true);
    }
  }
}

function laneMaskForCertificate(trajectories: ChallengeTrajectories): number {
  let mask = 0;
  for (const trajectory of trajectories) mask |= 1 << trajectory.lane;
  return mask;
}

type ChallengeTrajectories = readonly { readonly lane: 0 | 1 | 2 | 3 }[];

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
