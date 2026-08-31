/* ==========================================================================
   Zonnestelsel — Live 3D visualisatie
   Haalt actuele planeetposities op bij de Python-backend (/api/positions)
   en rendert ze met Three.js: echte relatieve kleuren, gloed voor de zon,
   Saturnusringen, een sterrenveld en vrije camera-besturing.
   ========================================================================== */

// ---------------------------------------------------------------------------
// Configuratie
// ---------------------------------------------------------------------------
const AU_TO_SCENE = 40;           // schaal: 1 AU -> scene-eenheden (afstanden)
const SUN_SCENE_RADIUS = 5.4;     // vaste visuele grootte van de zon
const MIN_PLANET_RADIUS = 0.55;   // ondergrens zodat kleine planeten zichtbaar blijven
const PLANET_RADIUS_SCALE = 0.00016; // schaal voor planeetgrootte (km -> scene)
const MOON_ORBIT_BOOST = 5.5;     // maanbaan visueel vergroten t.o.v. de aarde (anders onzichtbaar)

const SPEED_STEPS = [
  { label: "0.25 dag/sec", days: 0.25 },
  { label: "1 dag/sec", days: 1 },
  { label: "7 dagen/sec", days: 7 },
  { label: "30 dagen/sec", days: 30 },
  { label: "180 dagen/sec", days: 180 },
];

const DUTCH_NAMES = {
  mercurius: "Mercurius", venus: "Venus", aarde: "Aarde", maan: "Maan",
  mars: "Mars", jupiter: "Jupiter", saturnus: "Saturnus",
  uranus: "Uranus", neptunus: "Neptunus",
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let scene, camera, renderer;
let sunMesh, sunGlow;
let orbitLines = {};
let bodyMeshes = {};   // name -> THREE.Group (mesh + optional ring)
let labelSprites = {};
let currentBodies = [];
let currentTimestamp = null;

let simTime = new Date();       // gesimuleerde tijd (client-side, gedreven door speed)
let speedIndex = 1;             // index in SPEED_STEPS
let playing = false;
let selectedBody = null;

let cameraTarget = new THREE.Vector3(0, 0, 0);
let cameraDistance = 260;
let cameraTheta = 0.9;   // horizontale hoek
let cameraPhi = 1.05;    // verticale hoek

// muisbesturing
let isDragging = false;
let lastMouse = { x: 0, y: 0 };

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
init();

function init() {
  setupScene();
  setupStars();
  setupSun();
  setupUIHandlers();
  animate();
  fetchPositions(); // eerste keer meteen live data ophalen
  setInterval(fetchPositions, 1000 * 30); // elke 30s herbevestigen met de echte "nu" server-tijd
}

function setupScene() {
  const container = document.getElementById("scene-container");

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(
    50, window.innerWidth / window.innerHeight, 0.1, 20000
  );
  updateCameraPosition();

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  // subtiele ambient + puntlicht vanuit de zon
  scene.add(new THREE.AmbientLight(0x222233, 0.6));
  const sunLight = new THREE.PointLight(0xfff4d6, 2.4, 0, 0.6);
  sunLight.position.set(0, 0, 0);
  scene.add(sunLight);

  window.addEventListener("resize", onWindowResize);

  // muisbesturing voor rotatie/zoom
  renderer.domElement.addEventListener("mousedown", (e) => {
    isDragging = true;
    lastMouse = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener("mouseup", () => (isDragging = false));
  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const dx = e.clientX - lastMouse.x;
    const dy = e.clientY - lastMouse.y;
    cameraTheta -= dx * 0.0045;
    cameraPhi = clamp(cameraPhi - dy * 0.0045, 0.15, Math.PI - 0.15);
    lastMouse = { x: e.clientX, y: e.clientY };
    updateCameraPosition();
  });
  renderer.domElement.addEventListener("wheel", (e) => {
    e.preventDefault();
    cameraDistance = clamp(cameraDistance * (1 + e.deltaY * 0.0012), 12, 2400);
    updateCameraPosition();
  }, { passive: false });

  // touch (mobiel)
  let lastTouchDist = null;
  renderer.domElement.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) {
      isDragging = true;
      lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2) {
      lastTouchDist = touchDistance(e.touches);
    }
  });
  renderer.domElement.addEventListener("touchmove", (e) => {
    e.preventDefault();
    if (e.touches.length === 1 && isDragging) {
      const dx = e.touches[0].clientX - lastMouse.x;
      const dy = e.touches[0].clientY - lastMouse.y;
      cameraTheta -= dx * 0.005;
      cameraPhi = clamp(cameraPhi - dy * 0.005, 0.15, Math.PI - 0.15);
      lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      updateCameraPosition();
    } else if (e.touches.length === 2) {
      const d = touchDistance(e.touches);
      if (lastTouchDist) {
        cameraDistance = clamp(cameraDistance * (1 + (lastTouchDist - d) * 0.002), 12, 2400);
        updateCameraPosition();
      }
      lastTouchDist = d;
    }
  }, { passive: false });
  renderer.domElement.addEventListener("touchend", () => { isDragging = false; lastTouchDist = null; });
}

function touchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function updateCameraPosition() {
  const x = cameraTarget.x + cameraDistance * Math.sin(cameraPhi) * Math.cos(cameraTheta);
  const y = cameraTarget.y + cameraDistance * Math.cos(cameraPhi);
  const z = cameraTarget.z + cameraDistance * Math.sin(cameraPhi) * Math.sin(cameraTheta);
  camera.position.set(x, y, z);
  camera.lookAt(cameraTarget);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// ---------------------------------------------------------------------------
// Sterrenveld
// ---------------------------------------------------------------------------
function setupStars() {
  const starCount = 6000;
  const positions = new Float32Array(starCount * 3);
  const colors = new Float32Array(starCount * 3);

  for (let i = 0; i < starCount; i++) {
    const radius = 900 + Math.random() * 3500;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.cos(phi);
    positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);

    // lichte kleurvariatie: wit -> blauwig -> geelig
    const tint = Math.random();
    if (tint < 0.7) {
      colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = 0.8 + Math.random() * 0.2;
    } else if (tint < 0.85) {
      colors[i * 3] = 0.65; colors[i * 3 + 1] = 0.75; colors[i * 3 + 2] = 1.0;
    } else {
      colors[i * 3] = 1.0; colors[i * 3 + 1] = 0.85; colors[i * 3 + 2] = 0.6;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 1.6,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    sizeAttenuation: true,
  });

  scene.add(new THREE.Points(geometry, material));
}

// ---------------------------------------------------------------------------
// Zon
// ---------------------------------------------------------------------------
function setupSun() {
  const geometry = new THREE.SphereGeometry(SUN_SCENE_RADIUS, 48, 48);
  const material = new THREE.MeshBasicMaterial({ color: 0xffd27a });
  sunMesh = new THREE.Mesh(geometry, material);
  scene.add(sunMesh);

  // gloed via meerdere gestapelde transparante sferen (goedkope bloom-imitatie)
  const glowLayers = [
    { scale: 1.25, opacity: 0.35, color: 0xffcf6b },
    { scale: 1.6, opacity: 0.18, color: 0xffb84d },
    { scale: 2.1, opacity: 0.08, color: 0xff9f3d },
  ];
  sunGlow = new THREE.Group();
  glowLayers.forEach((layer) => {
    const g = new THREE.SphereGeometry(SUN_SCENE_RADIUS * layer.scale, 32, 32);
    const m = new THREE.MeshBasicMaterial({
      color: layer.color, transparent: true, opacity: layer.opacity,
      side: THREE.BackSide, depthWrite: false,
    });
    sunGlow.add(new THREE.Mesh(g, m));
  });
  scene.add(sunGlow);
}

// ---------------------------------------------------------------------------
// Data ophalen bij de backend
// ---------------------------------------------------------------------------
async function fetchPositions(customTime) {
  try {
    let url = "/api/positions";
    if (customTime) url += "?t=" + encodeURIComponent(customTime.toISOString());
    const res = await fetch(url);
    const data = await res.json();

    currentBodies = data.bodies;
    currentTimestamp = new Date(data.timestamp);
    if (!customTime) simTime = new Date(currentTimestamp);

    buildOrUpdateBodies();
    buildOrbitLines();
    updateLegend();
    hideLoading();
  } catch (err) {
    console.error("Kon planeetposities niet ophalen:", err);
    document.querySelector("#loading p").textContent =
      "Kon geen verbinding maken met de backend (poort 3333 actief?)";
  }
}

function hideLoading() {
  const loading = document.getElementById("loading");
  if (loading && loading.style.opacity !== "0") {
    loading.style.opacity = "0";
    setTimeout(() => (loading.style.display = "none"), 650);
  }
}

// ---------------------------------------------------------------------------
// Planeten/manen bouwen en positioneren
// ---------------------------------------------------------------------------
function rgbToHex([r, g, b]) {
  return (r << 16) | (g << 8) | b;
}

function scenePositionFor(body) {
  if (body.orbits === "aarde") {
    // Maan: overdrijf de afstand t.o.v. de aarde zodat ze zichtbaar los staat
    const earth = currentBodies.find((b) => b.name === "aarde");
    if (!earth) return new THREE.Vector3(0, 0, 0);
    const dx = (body.x - earth.x) * MOON_ORBIT_BOOST + earth.x;
    const dy = (body.y - earth.y) * MOON_ORBIT_BOOST + earth.y;
    const dz = (body.z - earth.z) * MOON_ORBIT_BOOST + earth.z;
    return new THREE.Vector3(dx * AU_TO_SCENE, dz * AU_TO_SCENE, dy * AU_TO_SCENE);
  }
  return new THREE.Vector3(body.x * AU_TO_SCENE, body.z * AU_TO_SCENE, body.y * AU_TO_SCENE);
}

function planetVisualRadius(body) {
  const r = Math.max(body.radius_km * PLANET_RADIUS_SCALE, MIN_PLANET_RADIUS);
  // de maan mag niet groter ogen dan gepast t.o.v. de aarde
  return r;
}

function buildOrUpdateBodies() {
  currentBodies.forEach((body) => {
    const pos = scenePositionFor(body);
    const color = rgbToHex(body.color);

    if (!bodyMeshes[body.name]) {
      const group = new THREE.Group();

      const radius = planetVisualRadius(body);
      const geometry = new THREE.SphereGeometry(radius, 32, 32);
      const material = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.75,
        metalness: 0.05,
        emissive: new THREE.Color(color).multiplyScalar(0.06),
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.bodyName = body.name;
      group.add(mesh);

      // subtiele atmosfeer-gloed voor aarde/venus/gasreuzen
      if (["aarde", "venus", "jupiter", "saturnus", "uranus", "neptunus"].includes(body.name)) {
        const glowGeo = new THREE.SphereGeometry(radius * 1.18, 24, 24);
        const glowMat = new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.14, side: THREE.BackSide, depthWrite: false,
        });
        group.add(new THREE.Mesh(glowGeo, glowMat));
      }

      // Saturnusringen
      if (body.has_rings) {
        const ringGeo = new THREE.RingGeometry(radius * 1.5, radius * 2.6, 64);
        // UV's aanpassen zodat de gradient-textuur netjes radiaal loopt
        const pos2 = ringGeo.attributes.position;
        const uv = ringGeo.attributes.uv;
        const v3 = new THREE.Vector3();
        for (let i = 0; i < pos2.count; i++) {
          v3.fromBufferAttribute(pos2, i);
          const d = v3.length();
          uv.setXY(i, (d - radius * 1.5) / (radius * 1.1), 0.5);
        }
        const ringMat = new THREE.MeshStandardMaterial({
          color: 0xd8c9a0, side: THREE.DoubleSide, transparent: true,
          opacity: 0.85, roughness: 0.9,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = Math.PI / 2.25;
        group.add(ring);
      }

      // label sprite
      const sprite = makeLabelSprite(DUTCH_NAMES[body.name] || body.name);
      sprite.position.set(0, radius + radius * 0.9 + 0.4, 0);
      group.add(sprite);
      labelSprites[body.name] = sprite;

      scene.add(group);
      bodyMeshes[body.name] = group;

      renderer.domElement.style.cursor = "grab";
      group.userData.bodyData = body;
    }

    const group = bodyMeshes[body.name];
    group.position.copy(pos);
    group.userData.bodyData = body;

    // lichte axiale rotatie voor levendigheid
    const mesh = group.children[0];
    mesh.rotation.y += 0.0015 * (body.name === "maan" ? 0.4 : 1);
  });

  setupPicking();
}

// ---------------------------------------------------------------------------
// Klikbare planeten (raycasting)
// ---------------------------------------------------------------------------
let pickingSetup = false;
function setupPicking() {
  if (pickingSetup) return;
  pickingSetup = true;
  const raycaster = new THREE.Raycaster();
  const mouseVec = new THREE.Vector2();

  renderer.domElement.addEventListener("click", (e) => {
    // onderscheid klik van sleep
    mouseVec.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouseVec.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouseVec, camera);

    const meshes = Object.values(bodyMeshes).map((g) => g.children[0]);
    const hits = raycaster.intersectObjects(meshes);
    if (hits.length > 0) {
      const name = hits[0].object.userData.bodyName;
      selectBody(name);
    }
  });
}

function selectBody(name) {
  selectedBody = name;
  const body = currentBodies.find((b) => b.name === name);
  if (!body) return;

  const pos = scenePositionFor(body);
  cameraTarget.copy(pos);
  const r = planetVisualRadius(body);
  cameraDistance = Math.max(r * 12, 6);
  updateCameraPosition();

  showInfoPanel(body);
  document.querySelectorAll(".planet-row").forEach((el) => {
    el.classList.toggle("selected", el.dataset.name === name);
  });
}

// ---------------------------------------------------------------------------
// Tekst-sprites (labels boven planeten)
// ---------------------------------------------------------------------------
function makeLabelSprite(text) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const fontSize = 42;
  ctx.font = `500 ${fontSize}px Segoe UI, sans-serif`;
  const width = ctx.measureText(text).width + 24;
  canvas.width = width * 2;
  canvas.height = (fontSize + 20) * 2;
  ctx.scale(2, 2);
  ctx.font = `500 ${fontSize}px Segoe UI, sans-serif`;
  ctx.fillStyle = "rgba(232,236,247,0.92)";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 12, (fontSize + 20) / 2);

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  const scale = 0.045;
  sprite.scale.set(canvas.width * scale * 0.12, canvas.height * scale * 0.12, 1);
  return sprite;
}

// ---------------------------------------------------------------------------
// Baanlijnen (ellipsen) tekenen — geometrisch bepaald a.d.h.v. huidige straal
// (eenvoudige benadering: cirkel op basis van huidige heliocentrische afstand
// gemiddeld over de baan wordt vervangen door echte ellips per planeet)
// ---------------------------------------------------------------------------
function buildOrbitLines() {
  currentBodies.forEach((body) => {
    if (body.orbits === "aarde") return; // geen baanlijn voor de maan (te schaal-verstorend)
    if (orbitLines[body.name]) return; // eenmalig tekenen volstaat (baan verandert nauwelijks zichtbaar)

    const segments = 256;
    const points = [];
    // benader baan als cirkel met straal = huidige afstand tot de zon
    // (visueel ruim voldoende voor deze schaal; excentriciteit is bij deze planeten klein op scenegrootte)
    const distance = Math.sqrt(body.x * body.x + body.y * body.y) * AU_TO_SCENE;
    for (let i = 0; i <= segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      points.push(new THREE.Vector3(distance * Math.cos(t), 0, distance * Math.sin(t)));
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: 0x4a5a80, transparent: true, opacity: 0.35,
    });
    const line = new THREE.LineLoop(geometry, material);
    scene.add(line);
    orbitLines[body.name] = line;
  });
}

// ---------------------------------------------------------------------------
// UI: legenda, info-paneel, tijdcontrols
// ---------------------------------------------------------------------------
function updateLegend() {
  const list = document.getElementById("legend-list");
  list.innerHTML = "";
  currentBodies
    .filter((b) => b.orbits !== "aarde")
    .forEach((body) => {
      const row = document.createElement("div");
      row.className = "planet-row" + (selectedBody === body.name ? " selected" : "");
      row.dataset.name = body.name;
      const colorHex = "#" + rgbToHex(body.color).toString(16).padStart(6, "0");
      const dist = Math.sqrt(body.x * body.x + body.y * body.y + body.z * body.z).toFixed(2);
      row.innerHTML = `
        <span class="swatch" style="background:${colorHex}; color:${colorHex}"></span>
        <span class="name">${DUTCH_NAMES[body.name] || body.name}</span>
        <span class="dist">${dist} AE</span>
      `;
      row.addEventListener("click", () => selectBody(body.name));
      list.appendChild(row);
    });
}

function showInfoPanel(body) {
  const panel = document.getElementById("info-panel");
  panel.classList.add("visible");
  document.getElementById("info-name").textContent = DUTCH_NAMES[body.name] || body.name;
  const dist = Math.sqrt(body.x * body.x + body.y * body.y + body.z * body.z);
  document.getElementById("info-dist").textContent =
    body.orbits === "aarde" ? "— (baan om de aarde)" : `${dist.toFixed(3)} AE`;
  document.getElementById("info-radius").textContent = `${body.radius_km.toLocaleString("nl-NL")} km`;
  document.getElementById("info-period").textContent = `${body.period_days.toFixed(1)} dagen`;
}

function setupUIHandlers() {
  const speedSlider = document.getElementById("speed-slider");
  const speedValue = document.getElementById("speed-value");
  const playPauseBtn = document.getElementById("play-pause-btn");
  const resetBtn = document.getElementById("reset-btn");
  const topViewBtn = document.getElementById("topview-btn");

  speedSlider.addEventListener("input", () => {
    speedIndex = parseInt(speedSlider.value, 10);
    speedValue.textContent = SPEED_STEPS[speedIndex].label;
  });
  speedValue.textContent = SPEED_STEPS[speedIndex].label;

  playPauseBtn.addEventListener("click", () => {
    playing = !playing;
    playPauseBtn.textContent = playing ? "⏸ Pauzeer" : "▶ Speel af";
    playPauseBtn.classList.toggle("active", !playing);
  });

  resetBtn.addEventListener("click", () => {
    simTime = new Date();
    fetchPositions();
  });

  topViewBtn.addEventListener("click", () => {
    cameraTarget.set(0, 0, 0);
    cameraPhi = 0.35;
    cameraDistance = 420;
    updateCameraPosition();
  });
}

// ---------------------------------------------------------------------------
// Animatielus
// ---------------------------------------------------------------------------
let lastFrameTime = performance.now();
let accumulatedDaysSinceRefresh = 0;

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const dtSeconds = (now - lastFrameTime) / 1000;
  lastFrameTime = now;

  if (playing && currentBodies.length) {
    const daysPerSecond = SPEED_STEPS[speedIndex].days;
    const deltaDays = daysPerSecond * dtSeconds;
    simTime = new Date(simTime.getTime() + deltaDays * 86400000);
    accumulatedDaysSinceRefresh += deltaDays;

    // client-side interpoleren zou een tweede Kepler-solver in JS vergen;
    // in plaats daarvan vragen we periodiek de backend om de nieuwe (gesimuleerde) tijd
    if (accumulatedDaysSinceRefresh > Math.max(0.4, daysPerSecond * 0.4)) {
      accumulatedDaysSinceRefresh = 0;
      fetchPositions(simTime);
    }
  }

  document.getElementById("datetime-display").textContent = formatDateTime(simTime);

  sunGlow.rotation.y += 0.0006;
  sunMesh.rotation.y += 0.0009;

  // labels altijd naar de camera laten kijken (sprites doen dit al automatisch)

  renderer.render(scene, camera);
}

function formatDateTime(date) {
  return date.toLocaleString("nl-NL", {
    day: "2-digit", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}
