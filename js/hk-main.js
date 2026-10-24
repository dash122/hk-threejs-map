import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, positionView, metalness, roughness, vec2, smoothstep } from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { createPostProcessing } from './post-processing.js';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
import { isTypingInField } from './city-config.js';
import { ThirdPersonControllerManager } from './controllers.js';
import { TouchControls } from './touch-controls.js';
import { GamepadControls } from './gamepad-controls.js';
import { CameraSystem, CAMERA_PRESETS } from './cameras.js';
import { LightingSystem } from './lighting.js';
import { GEO } from './hk-geodata.js';
import { buildHongKong, groundY, groundMPD, locationLabel, lonLatToWorld, WATER_MPD } from './hk-world.js';
import { HKMinimap } from './hk-minimap.js';

// js/hk-main.js
// Main entry point for Hong Kong (Eastern District pilot): the Slop New York engine (renderer, lighting, players,
// cameras, post-processing) on the real geography of js/hk-geodata.js, built by js/hk-world.js. Traffic, pedestrians,
// audio and the full map still only exist for New York (nyc.html).

// Players stand on the terrain (and roads) instead of Manhattan's flat deck, and stay on land inside the pilot area
const P = GEO.pilot;
const EDGE = 15;
class HKControllerManager extends ThirdPersonControllerManager {
  getGroundHeight(x, z) {
    return groundY(x, z) + 0.12;
  }

  isPointOnSidewalk() {
    return false;
  }

  clampToWorld(x, z, heli) {
    const m = heli ? 6000 : -EDGE;
    x = Math.max(P.minX - m, Math.min(P.maxX + m, x));
    z = Math.max(P.minZ - m, Math.min(P.maxZ + m, z));
    if (!heli && groundMPD(x, z) < WATER_MPD + 0.4) return null; // in the harbour
    return { x, z };
  }

  worldCentreToward() {
    return { x: 0, z: 0 };
  }

  keepInWorld(pos, carEntity, entity) {
    const heli = this.activeMode === 'helicopter';
    const m = heli ? 6000 : -EDGE;
    pos.x = Math.max(P.minX - m, Math.min(P.maxX + m, pos.x));
    pos.z = Math.max(P.minZ - m, Math.min(P.maxZ + m, pos.z));
    if (heli || !entity) return;
    // the seawall: step back to the last point on land
    if (groundMPD(pos.x, pos.z) < WATER_MPD + 0.4) {
      if (entity._lastLand) {
        pos.x = entity._lastLand.x;
        pos.z = entity._lastLand.z;
      }
      if (carEntity && carEntity.speed) carEntity.speed *= 0.4;
    } else {
      entity._lastLand = { x: pos.x, z: pos.z };
    }
  }

  update(dt, elapsed) {
    super.update(dt, elapsed);
    // the helicopter lands on the hillside, not on sea level
    const h = this.entities.helicopter;
    const floor = groundY(h.position.x, h.position.z) + 0.25;
    if (h.position.y < floor) {
      h.position.y = floor;
      if (h.verticalSpeed < 0) h.verticalSpeed = 0;
      h.mesh.position.y = floor;
    }
  }
}

// Teleport destinations [lon, lat, heading (0 = south, π/2 = east)]
const TELEPORTS = {
  northpoint: [114.2001, 22.2911, Math.PI / 2],
  victoriapark: [114.1890, 22.2817, Math.PI / 2],
  tinhau: [114.1922, 22.2822, Math.PI / 2],
  fortresshill: [114.1935, 22.2878, Math.PI / 2],
  quarrybay: [114.2125, 22.2870, Math.PI / 2],
  islandeast: [114.2135, 22.2862, Math.PI],
  taikoo: [114.2165, 22.2848, Math.PI / 2],
  ferrypier: [114.1993, 22.2925, Math.PI]
};

async function initApp() {
  const container = document.getElementById('canvas-container');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingStatus = document.getElementById('loading-status');
  const loadingTrack = loadingOverlay ? loadingOverlay.querySelector('.loader-track') : null;
  const loadingFill = document.getElementById('loading-progress');
  const setLoadingProgress = (p) => {
    if (!loadingFill) return;
    if (loadingTrack) loadingTrack.classList.remove('is-indeterminate');
    loadingFill.style.transform = `scaleX(${Math.min(1, Math.max(0, p))})`;
  };
  if (loadingStatus) loadingStatus.textContent = `Initializing Three.js r${THREE.REVISION} WebGPURenderer & TSL Shaders...`;

  // 1. Renderer
  const renderer = new THREE.WebGPURenderer({ antialias: true, powerPreference: 'high-performance', reversedDepthBuffer: true });
  renderer.setPixelRatio(1.0);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.lighting = new ClusteredLighting(256, 32, 28, 48);
  container.appendChild(renderer.domElement);
  let initTimings = [];
  let initMark = performance.now();
  const markInit = (label) => {
    const now = performance.now();
    initTimings.push(`${label} ${Math.round(now - initMark)}ms`);
    initMark = now;
  };
  await renderer.init();
  markInit('renderer');

  // 2. Scene, sky & sun
  const scene = new THREE.Scene();
  const lightingSystem = new LightingSystem(scene, renderer);
  markInit('lighting');

  // 3. Hong Kong: terrain, harbour, roads, flyovers, buildings, parks, trams, trees
  if (loadingStatus) loadingStatus.textContent = 'Building North Point, Quarry Bay & Tai Koo...';
  await new Promise((resolve) => setTimeout(resolve, 0)); // let the status paint first
  const world = buildHongKong(scene);
  markInit('world');

  // 4. Players & cameras
  const controllerManager = new HKControllerManager(scene, world.colliders);
  const startAt = (mode, key) => {
    const [lon, lat, heading] = TELEPORTS[key];
    const [x, z] = lonLatToWorld(lon, lat);
    controllerManager.setMode(mode);
    controllerManager.teleportActiveTo(x, z, heading, mode === 'helicopter' ? 140 : null);
  };
  let restored = false;
  try {
    const saved = JSON.parse(localStorage.getItem('hk-player-state'));
    if (saved?.version === 1) {
      for (const mode of Object.keys(controllerManager.entities)) {
        const p = saved.entities?.[mode];
        if (!p || ![p.x, p.y, p.z, p.heading].every(Number.isFinite)) continue;
        controllerManager.setMode(mode);
        controllerManager.teleportActiveTo(p.x, p.z, p.heading, p.y);
      }
      controllerManager.setMode(Object.hasOwn(controllerManager.entities, saved.activeMode) ? saved.activeMode : 'car');
      restored = true;
    }
  } catch { /* Missing or unavailable storage does not prevent playing. */ }
  if (!restored) {
    startAt('person', 'northpoint');
    startAt('cyclist', 'northpoint');
    startAt('helicopter', 'northpoint');
    startAt('car', 'northpoint');
  }
  function savePlayerState() {
    try {
      const entities = Object.fromEntries(Object.entries(controllerManager.entities).map(([mode, entity]) => [mode, {
        x: entity.position.x, y: entity.position.y, z: entity.position.z, heading: entity.heading
      }]));
      localStorage.setItem('hk-player-state', JSON.stringify({ version: 1, activeMode: controllerManager.activeMode, entities }));
    } catch { /* Storage may be disabled or full. */ }
  }
  window.addEventListener('pagehide', savePlayerState);
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePlayerState(); });

  const cameraSystem = new CameraSystem(renderer.domElement, controllerManager);
  cameraSystem.groundAt = groundY;
  const touchControls = new TouchControls(controllerManager);
  const minimap = new HKMinimap(document.getElementById('minimap-canvas'));
  markInit('controllers');

  scene.traverse((object) => {
    if (object.isInstancedMesh) object.instanceMatrix = new THREE.StorageInstancedBufferAttribute(object.instanceMatrix.array, 16);
  });

  // 5. Post-processing: SSR, bloom & grading (as in js/main.js)
  const scenePass = pass(scene, cameraSystem.camera);
  scenePass.renderTarget.storeMultisampledColorBuffer = false;
  const ssrFade = smoothstep(360.0, 180.0, positionView.z.negate());
  const maxSSRRoughness = 0.75;
  const sceneMRT = mrt({
    output: output,
    normal: normalView,
    metalRough: vec2(roughness.lessThan(maxSSRRoughness).select(metalness.mul(ssrFade), 0), roughness)
  });
  sceneMRT.setBlendMode('normal', new THREE.BlendMode(THREE.MaterialBlending));
  sceneMRT.setBlendMode('metalRough', new THREE.BlendMode(THREE.MaterialBlending));
  scenePass.setMRT(sceneMRT);
  const scenePassColor = scenePass.getTextureNode('output');
  const scenePassMetalRough = scenePass.getTextureNode('metalRough');
  const ssrPass = ssr(scenePassColor, scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal'), {
    metalnessNode: scenePassMetalRough.r,
    roughnessNode: scenePassMetalRough.g,
    camera: cameraSystem.camera
  });
  ssrPass.resolutionScale = 0.5;
  ssrPass.blurQuality = 1;
  ssrPass.maxDistance.value = 42;
  ssrPass.thickness.value = 0.85;
  ssrPass.quality.value = 0.25;
  ssrPass.binaryRefine = true;
  ssrPass.intensity.value = 0.5;
  ssrPass.screenEdgeFadeBlack = true;
  const reflectionMask = scenePassMetalRough.r.greaterThan(0).select(smoothstep(maxSSRRoughness, 0.55, scenePassMetalRough.g), 0);
  const colorGrade = createPostProcessing(renderer, scenePassColor, ssrPass.mul(reflectionMask));
  const renderPipeline = new THREE.RenderPipeline(renderer, colorGrade.outputNode);

  // 6. HUD
  const modeButtons = document.querySelectorAll('[data-mode]');
  const cameraButtons = document.querySelectorAll('[data-camera]');
  const timeButtons = document.querySelectorAll('[data-time]');
  const teleportButtons = document.querySelectorAll('[data-teleport]');
  const hudToggleBtn = document.getElementById('btn-toggle-hud');
  const modeSwitch = document.getElementById('mode-switch');
  touchControls.onAvailabilityChange = placeModeIndicator;
  const elFps = document.getElementById('hud-fps');
  const elMode = document.getElementById('hud-active-mode');
  const elCamera = document.getElementById('hud-active-camera');
  const elSpeed = document.getElementById('hud-speed');
  const elSpeedMeter = document.getElementById('hud-speed-meter');
  const elAltitude = document.getElementById('hud-altitude');
  const elLocation = document.getElementById('hud-location');
  const elControlsHint = document.getElementById('hud-controls-hint');
  const FOLLOW_CAMERAS = CAMERA_PRESETS.filter((p) => p.category === 'follow');
  const gamepadControls = new GamepadControls(controllerManager, cameraSystem, {
    onCycleMode: (step) => {
      const modes = ['person', 'car', 'cyclist', 'helicopter'];
      selectMode(modes[(modes.indexOf(controllerManager.activeMode) + step + modes.length) % modes.length]);
    },
    onCycleCamera: cycleCamera,
    onToggleMap: () => {},
    onCloseMap: () => {}
  });

  const controlHints = {
    person: [[['W', 'S'], 'Walk'], [['A', 'D'], 'Turn'], [['Shift'], 'Sprint'], [['Space'], 'Jump'], [['Drag'], 'Orbit']],
    car: [[['W', 'S'], 'Drive / Reverse'], [['A', 'D'], 'Steer'], [['Shift'], 'Boost'], [['Drag'], 'Orbit']],
    cyclist: [[['W', 'S'], 'Pedal / Brake'], [['A', 'D'], 'Lean & Turn'], [['Shift'], 'Sprint'], [['Drag'], 'Orbit']],
    helicopter: [[['W', 'S'], 'Pitch'], [['A', 'D'], 'Yaw'], [['Space', 'E'], 'Ascend'], [['Q', 'C'], 'Descend'], [['Shift'], 'Boost']]
  };
  // Boosted top speeds in km/h (controllers.js caps them at 8.2, 36, 19 & 52 m/s): full scale of the speed meter
  const topSpeedKmh = { person: 30, car: 130, cyclist: 68, helicopter: 187 };

  function renderControlHints(mode) {
    if (!elControlsHint) return;
    const items = (controlHints[mode] || []).map(([keys, action]) => {
      const item = document.createElement('span');
      item.className = 'hint';
      for (const key of keys) {
        const kbd = document.createElement('kbd');
        kbd.textContent = key;
        item.appendChild(kbd);
      }
      const label = document.createElement('span');
      label.className = 'hint-label';
      label.textContent = action;
      item.appendChild(label);
      return item;
    });
    elControlsHint.replaceChildren(...items);
  }
  function placeModeIndicator() {
    const active = modeSwitch ? modeSwitch.querySelector('.mode-btn.active') : null;
    if (!active) return;
    modeSwitch.style.setProperty('--ind-x', `${active.offsetLeft}px`);
    modeSwitch.style.setProperty('--ind-w', `${active.offsetWidth}px`);
  }
  const MODE_LABELS = { person: 'On Foot', car: 'Red Taxi', cyclist: 'Bicycle', helicopter: 'Helicopter' };
  function selectMode(mode) {
    controllerManager.setMode(mode);
    touchControls.setMode(controllerManager.activeMode);
    gamepadControls.reset();
    modeButtons.forEach((btn) => btn.classList.toggle('active', btn.getAttribute('data-mode') === mode));
    document.body.dataset.mode = mode;
    placeModeIndicator();
    if (elMode) elMode.textContent = MODE_LABELS[mode] || controllerManager.getActiveEntity().label;
    renderControlHints(mode);
  }
  function selectCamera(camId, snap = false) {
    cameraSystem.setCameraPreset(camId, snap);
    cameraButtons.forEach((btn) => btn.classList.toggle('active', btn.getAttribute('data-camera') === camId));
    if (elCamera) elCamera.textContent = cameraSystem.getActivePreset().name;
  }
  function cycleCamera(step) {
    const n = FOLLOW_CAMERAS.length;
    const idx = FOLLOW_CAMERAS.findIndex((p) => p.id === cameraSystem.activePresetId);
    selectCamera(FOLLOW_CAMERAS[(idx + step + n) % n].id, true);
  }
  function selectTime(timeId) {
    lightingSystem.applyPreset(timeId);
    colorGrade.applyPreset(lightingSystem.activePresetId);
    timeButtons.forEach((btn) => btn.classList.toggle('active', btn.getAttribute('data-time') === timeId));
  }

  const popovers = document.querySelectorAll('.popover[popover]');
  const supportsPopover = typeof HTMLElement.prototype.togglePopover === 'function';
  function closePopovers() {
    if (!supportsPopover) return;
    popovers.forEach((pop) => { if (pop.matches(':popover-open')) pop.hidePopover(); });
  }
  popovers.forEach((pop) => {
    const invoker = document.querySelector(`[popovertarget="${pop.id}"]`);
    pop.addEventListener('beforetoggle', (e) => {
      const open = e.newState === 'open';
      if (invoker) invoker.classList.toggle('is-open', open);
      if (!open) return;
      const anchor = document.getElementById(pop.dataset.anchor) || invoker;
      const align = document.getElementById(pop.dataset.align) || invoker;
      if (!anchor || !align) return;
      const r = anchor.getBoundingClientRect();
      const spaceAbove = Math.max(0, r.top - 20);
      const spaceBelow = Math.max(0, window.innerHeight - r.bottom - 20);
      let above = pop.dataset.side === 'above';
      if ((above ? spaceAbove : spaceBelow) < 160) above = spaceAbove > spaceBelow;
      pop.style.right = `${Math.max(8, window.innerWidth - align.getBoundingClientRect().right)}px`;
      if (above) {
        pop.style.top = 'auto';
        pop.style.bottom = `${window.innerHeight - r.top + 8}px`;
        pop.style.maxHeight = `${spaceAbove}px`;
      } else {
        pop.style.bottom = 'auto';
        pop.style.top = `${r.bottom + 8}px`;
        pop.style.maxHeight = `${spaceBelow}px`;
      }
    });
  });

  modeButtons.forEach((btn) => btn.addEventListener('click', () => selectMode(btn.getAttribute('data-mode'))));
  cameraButtons.forEach((btn) => btn.addEventListener('click', () => { selectCamera(btn.getAttribute('data-camera'), true); closePopovers(); }));
  document.getElementById('cam-prev')?.addEventListener('click', () => cycleCamera(-1));
  document.getElementById('cam-next')?.addEventListener('click', () => cycleCamera(1));
  timeButtons.forEach((btn) => btn.addEventListener('click', () => selectTime(btn.getAttribute('data-time'))));
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (btn && e.detail > 0) btn.blur();
  });

  // Where you are: the station area's name over its roads, drawn as street-name signs
  let locationText = '';
  function renderLocation(label) {
    if (!elLocation || label === locationText) return;
    locationText = label;
    const split = label.indexOf(' · ');
    const place = split >= 0 ? label.slice(0, split) : label.includes(' & ') || /Road|Street|Corridor|Avenue|Path|Lane|Terrace/.test(label) ? '' : label;
    const streets = split >= 0 ? label.slice(split + 3) : place ? '' : label;
    const nodes = [];
    if (place) {
      const el = document.createElement('div');
      el.className = 'location-place';
      el.textContent = place;
      nodes.push(el);
    }
    if (streets) {
      const row = document.createElement('div');
      row.className = 'location-signs';
      for (const name of streets.split(' & ')) {
        const sign = document.createElement('span');
        sign.className = 'street-sign';
        sign.textContent = name;
        row.appendChild(sign);
      }
      nodes.push(row);
    }
    elLocation.replaceChildren(...nodes);
  }

  function teleportTo(key) {
    const t = TELEPORTS[key];
    if (!t) return;
    const [x, z] = lonLatToWorld(t[0], t[1]);
    controllerManager.teleportActiveTo(x, z, t[2]);
    touchControls.reset();
    gamepadControls.reset();
    cameraSystem.resetForTeleport();
    selectCamera('chase', true);
  }
  teleportButtons.forEach((btn) => btn.addEventListener('click', () => { teleportTo(btn.getAttribute('data-teleport')); closePopovers(); }));

  if (hudToggleBtn) {
    hudToggleBtn.addEventListener('click', () => {
      document.body.classList.toggle('hud-minimized');
      const isMin = document.body.classList.contains('hud-minimized');
      hudToggleBtn.setAttribute('aria-pressed', String(isMin));
      hudToggleBtn.setAttribute('aria-label', isMin ? 'Show HUD' : 'Hide HUD');
      hudToggleBtn.title = isMin ? 'Show the HUD [H]' : 'Clean view: hide the HUD [H]';
      if (isMin) closePopovers();
    });
  }
  window.addEventListener('keydown', (e) => {
    if (isTypingInField(e)) return;
    switch (e.code) {
      case 'Digit1': selectMode('person'); break;
      case 'Digit2': selectMode('car'); break;
      case 'Digit3': selectMode('cyclist'); break;
      case 'Digit4': selectMode('helicopter'); break;
      case 'Digit5': selectCamera('chase', true); break;
      case 'Digit6': selectCamera('action', true); break;
      case 'Digit7': selectCamera('pov', true); break;
      case 'KeyV': cycleCamera(e.shiftKey ? -1 : 1); break;
      case 'KeyH': if (hudToggleBtn) hudToggleBtn.click(); break;
    }
  });
  window.addEventListener('resize', () => {
    cameraSystem.onResize(window.innerWidth, window.innerHeight);
    renderer.setSize(window.innerWidth, window.innerHeight);
    placeModeIndicator();
  });

  selectMode(controllerManager.activeMode);
  selectCamera('chase', true);
  selectTime('golden');
  if (document.fonts) document.fonts.ready.then(placeModeIndicator);
  markInit('ui');

  // 7. Shader pre-compilation behind the loading screen (as in js/main.js)
  if (loadingStatus) loadingStatus.textContent = 'Compiling Shaders & Render Pipelines...';
  const nextTask = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0)));
  async function precompileShaders() {
    scene.visible = false;
    renderPipeline.render();
    scene.visible = true;
    const culled = [];
    const jobs = [];
    const jobByMaterial = new Map();
    scene.traverseVisible((o) => {
      if (o.frustumCulled) { culled.push(o); o.frustumCulled = false; }
      if (!o.isMesh && !o.isLine && !o.isPoints && !o.isSprite) return;
      if (o.isInstancedMesh || Array.isArray(o.material)) { jobs.push([o]); return; }
      let job = jobByMaterial.get(o.material);
      if (!job) { job = []; jobByMaterial.set(o.material, job); jobs.push(job); }
      job.push(o);
    });
    renderer.setRenderTarget(scenePass.renderTarget);
    renderer.setMRT(sceneMRT);
    let next = 0, done = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        for (const object of job) {
          await nextTask();
          try { await renderer.compileAsync(object, cameraSystem.camera, scene); } catch (e) { console.warn('[compile]', e); }
        }
        done++;
        if (loadingStatus) loadingStatus.textContent = `Compiling Shaders & Render Pipelines... ${Math.round((done / jobs.length) * 100)}%`;
        setLoadingProgress(done / jobs.length);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    renderer.setMRT(null);
    renderer.setRenderTarget(null);
    for (const o of culled) o.frustumCulled = true;
  }
  await precompileShaders();
  markInit('compile');

  // 8. Animation loop
  let lastTime = performance.now();
  let elapsed = 0, frameCount = 0, fpsTimer = 0, nextPlayerSave = 0;
  let warmedUp = false;
  if (elFps) elFps.textContent = '60';
  renderer.setAnimationLoop((now) => {
    const rawDt = (now - lastTime) * 0.001;
    lastTime = now;
    const dt = Math.min(Math.max(rawDt, 0.001), 0.05);
    elapsed += dt;
    gamepadControls.update(dt);
    controllerManager.update(dt, elapsed);
    cameraSystem.update(dt, elapsed);
    lightingSystem.update(cameraSystem.currentPos);
    if (!document.hidden && now >= nextPlayerSave) {
      savePlayerState();
      nextPlayerSave = now + 5000;
    }
    renderPipeline.render();
    if (!warmedUp) {
      warmedUp = true;
      markInit('firstFrame');
      const device = renderer.backend.device;
      Promise.resolve(device && device.queue.onSubmittedWorkDone()).catch(() => {}).then(() => {
        console.log(`[init] ${initTimings.join(', ')}`);
        initTimings = null;
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
        setLoadingProgress(1);
      });
    }
    frameCount++;
    fpsTimer += Math.max(0, rawDt);
    if (fpsTimer >= 0.25) {
      const currentFps = Math.round(frameCount / fpsTimer);
      frameCount = 0;
      fpsTimer = 0;
      const ent = controllerManager.getActiveEntity();
      const mode = controllerManager.activeMode;
      const kmh = Math.round(Math.abs(ent.speed) * 3.6);
      const altM = Math.max(0, Math.round(ent.position.y - groundY(ent.position.x, ent.position.z)));
      if (elFps) {
        elFps.textContent = String(currentFps);
        elFps.className = currentFps >= 50 ? 'fps-ok' : currentFps >= 30 ? 'fps-warn' : 'fps-bad';
      }
      if (elSpeed) elSpeed.textContent = String(kmh);
      if (elSpeedMeter) elSpeedMeter.style.transform = `scaleX(${Math.min(1, kmh / (topSpeedKmh[mode] || 120))})`;
      document.body.classList.toggle('is-boosting', controllerManager.keys.boost && kmh > 0);
      if (elAltitude) elAltitude.textContent = altM.toLocaleString('en-US');
      const where = ent.position;
      renderLocation(locationLabel(where.x, where.z));
      minimap.update(where.x, where.z, ent.heading);
    }
  });
}

initApp();
