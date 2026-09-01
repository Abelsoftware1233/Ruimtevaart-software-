/* ==========================================================================
   Zonnestelsel — Live Visualisatie (actuele tijd, vaste bovenaanzicht-camera)
   Haalt actuele planeetposities op bij de Python-backend (/api/positions)
   en rendert ze met Three.js.
   ========================================================================== */

const AU_TO_SCENE = 40;             // schaal: 1 AU -> scene-eenheden
const SUN_SCENE_RADIUS = 6.0;       // vaste visuele grootte van de zon
const MIN_PLANET_RADIUS = 1.0;      // ondergrens zodat kleine planeten zichtbaar blijven
const PLANET_RADIUS_SCALE = 0.0006; // schaal voor planeetgrootte (km -> scene), ruimer dan werkelijkheid zodat je ze ziet
const MOON_ORBIT_BOOST = 6.0;

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
let bodyMeshes = {};
let currentBodies = [];
let simTime = new Date();
let selectedBody = null;

// ---------------------------------------------------------------------------
// Init — pas starten als de HTML volledig geladen is
// ---------------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", init);

function init() {
  setupScene();
  setupStars();
  setupSun();
  setupUIHandlers();
  animate();
  fetchPositions();               // meteen live data ophalen
  setInterval(fetchPositions, 1000); // elke seconde de actuele live stand verversen
}

function setupScene() {
  const container = document.getElementById("scene-container");
  if (!container) return;

  scene = new THREE.Scene();

  // Vaste bovenaanzicht-camera: geen muis/touch-besturing nodig, direct zichtbaar
  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 50000);
  camera.position.set(0, 480, 340);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  // Heldere belichting zodat MeshStandardMaterial altijd zichtbaar is
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const sunLight = new THREE.PointLight(0xffffff, 2.2, 0, 0);
  sunLight.position.set(0, 0, 0);
  scene.add(sunLight);

  window.addEventListener("resize", onWindowResize);
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
  const starCount = 4000;
  const positions = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount * 3; i += 3) {
    const radius = 1200 + Math.random() * 3500;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i + 1] = radius * Math.cos(phi);
    positions[i + 2] = radius * Math.sin(phi) * Math.sin(theta);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({ size: 1.8, color: 0xffffff, transparent: true, opacity: 0.75 });
  scene.add(new THREE.Points(geometry, material));
}

// ---------------------------------------------------------------------------
// Zon
// ---------------------------------------------------------------------------
function setupSun() {
  const geometry = new THREE.SphereGeometry(SUN_SCENE_RADIUS, 32, 32);
  const material = new THREE.MeshBasicMaterial({ color: 0xffaa00 });
  sunMesh = new THREE.Mesh(geometry, material);
  scene.add(sunMesh);

  const glowGeo = new THREE.SphereGeometry(SUN_SCENE_RADIUS * 1.6, 32, 32);
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.25 });
  sunGlow = new THREE.Mesh(glowGeo, glowMat);
  scene.add(sunGlow);
}

// ---------------------------------------------------------------------------
// Data ophalen bij de backend
// ---------------------------------------------------------------------------
async function fetchPositions() {
  try {
    const res = await fetch("/api/positions");
    const data = await res.json();

    currentBodies = data.bodies;
    simTime = new Date(data.timestamp);

    buildOrUpdateBodies();
    buildOrbitLines();
    updateLegend();
    updateHUD();
    hideLoading();
  } catch (err) {
    console.error("Fout bij ophalen posities:", err);
  }
}

function hideLoading() {
  const loading = document.getElementById("loading");
  if (loading) loading.style.display = "none";
}

function rgbToHex(rgb) {
  if (!Array.isArray(rgb)) return 0xffffff;
  return (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
}

// ---------------------------------------------------------------------------
// Positie in scene-coördinaten
// ---------------------------------------------------------------------------
function scenePositionFor(body) {
  if (body.orbits === "aarde") {
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
  return Math.max(body.radius_km * PLANET_RADIUS_SCALE, MIN_PLANET_RADIUS);
}

// ---------------------------------------------------------------------------
// Planeten (bollen) bouwen/bijwerken
// ---------------------------------------------------------------------------
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
        roughness: 0.5,
        emissive: new THREE.Color(color).multiplyScalar(0.3),
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.bodyName = body.name;
      group.add(mesh);

      if (body.has_rings) {
        const ringGeo = new THREE.RingGeometry(radius * 1.4, radius * 2.3, 48);
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0xd8c9a0, side: THREE.DoubleSide, transparent: true, opacity: 0.8,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = Math.PI / 2;
        group.add(ring);
      }

      scene.add(group);
      bodyMeshes[body.name] = group;
    }

    bodyMeshes[body.name].position.copy(pos);
  });
}

// ---------------------------------------------------------------------------
// Baanlijnen (ellipsen, benaderd als cirkel op huidige afstand)
// ---------------------------------------------------------------------------
function buildOrbitLines() {
  currentBodies.forEach((body) => {
    if (body.orbits === "aarde" || orbitLines[body.name]) return;

    const segments = 180;
    const points = [];
    const distance = Math.sqrt(body.x * body.x + body.y * body.y) * AU_TO_SCENE;

    for (let i = 0; i <= segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      points.push(new THREE.Vector3(distance * Math.cos(t), 0, distance * Math.sin(t)));
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: rgbToHex(body.color), transparent: true, opacity: 0.55,
    });
    const line = new THREE.LineLoop(geometry, material);
    scene.add(line);
    orbitLines[body.name] = line;
  });
}

// ---------------------------------------------------------------------------
// UI: legenda, tijd-HUD, info-paneel, knoppen
// ---------------------------------------------------------------------------
function updateLegend() {
  const list = document.getElementById("legend-list");
  if (!list) return;
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

function selectBody(name) {
  selectedBody = name;
  const body = currentBodies.find((b) => b.name === name);
  if (!body) return;
  showInfoPanel(body);
  document.querySelectorAll(".planet-row").forEach((el) => {
    el.classList.toggle("selected", el.dataset.name === name);
  });
}

function showInfoPanel(body) {
  const panel = document.getElementById("info-panel");
  if (!panel) return;
  panel.classList.add("visible");
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  setText("info-name", DUTCH_NAMES[body.name] || body.name);
  const dist = Math.sqrt(body.x * body.x + body.y * body.y + body.z * body.z);
  setText("info-dist", body.orbits === "aarde" ? "— (baan om de aarde)" : `${dist.toFixed(3)} AE`);
  setText("info-radius", `${body.radius_km.toLocaleString("nl-NL")} km`);
  setText("info-period", `${body.period_days.toFixed(1)} dagen`);
}

function updateHUD() {
  const dtDisplay = document.getElementById("datetime-display");
  if (dtDisplay) {
    dtDisplay.textContent = simTime.toLocaleString("nl-NL", {
      day: "2-digit", month: "long", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  }
}

function setupUIHandlers() {
  const speedSlider = document.getElementById("speed-slider");
  const speedValue = document.getElementById("speed-value");
  const playPauseBtn = document.getElementById("play-pause-btn");
  const resetBtn = document.getElementById("reset-btn");
  const topViewBtn = document.getElementById("topview-btn");

  // Deze versie toont altijd de actuele live tijd (geen simulatiesnelheid nodig),
  // dus we verbergen de tijdsnelheid-regelaar functioneel maar laten de UI intact.
  if (speedSlider) speedSlider.style.display = "none";
  if (speedValue) speedValue.textContent = "Live";
  if (playPauseBtn) playPauseBtn.style.display = "none";

  if (resetBtn) {
    resetBtn.textContent = "Nu";
    resetBtn.addEventListener("click", fetchPositions);
  }

  if (topViewBtn) {
    topViewBtn.addEventListener("click", () => {
      camera.position.set(0, 480, 340);
      camera.lookAt(0, 0, 0);
    });
  }

  // Klikbare planeten
  const raycaster = new THREE.Raycaster();
  const mouseVec = new THREE.Vector2();
  renderer.domElement.addEventListener("click", (e) => {
    mouseVec.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouseVec.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouseVec, camera);
    const meshes = Object.values(bodyMeshes).map((g) => g.children[0]);
    const hits = raycaster.intersectObjects(meshes);
    if (hits.length > 0) {
      selectBody(hits[0].object.userData.bodyName);
    }
  });
}

// ---------------------------------------------------------------------------
// Animatielus
// ---------------------------------------------------------------------------
function animate() {
  requestAnimationFrame(animate);
  if (sunGlow) sunGlow.rotation.y += 0.001;
  if (sunMesh) sunMesh.rotation.y += 0.0015;
  if (renderer && scene && camera) renderer.render(scene, camera);
}
