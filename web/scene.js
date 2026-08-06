/* 3D 场景渲染：深度置换 + PBR 材质 + 角色动画 + 音乐/音效 */
const params = new URLSearchParams(location.search);
const batch = params.get("batch") || "";

const titleEl = document.getElementById("scene-title");
const assetsEl = document.getElementById("scene-assets");
const listEl = document.getElementById("asset-list");
const statusEl = document.getElementById("scene-status");
const soundBtn = document.getElementById("sound-btn");
const overlay = document.getElementById("start-overlay");
document.getElementById("ov-title").textContent = batch ? `「${batch}」3D 场景` : "3D 场景";

let scene, camera, renderer, controls;
let music, ambient, clink, clinkTimer;
let soundOn = false;

init();
loadConfig();

async function loadConfig() {
  statusEl.textContent = "加载场景配置…";
  try {
    const resp = await fetch(`/api/scene?batch=${encodeURIComponent(batch)}`);
    if (!resp.ok) throw new Error((await resp.text()).slice(0, 200));
    const cfg = await resp.json();
    titleEl.textContent = cfg.batch;
    buildScene(cfg.assets);
    statusEl.textContent = "就绪 · 拖拽旋转 · 滚轮缩放";
  } catch (err) {
    statusEl.textContent = "加载失败: " + err.message;
  }
}

function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0c09);
  scene.fog = new THREE.FogExp2(0x0a0c09, 0.028);
  camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);
  camera.position.set(0, 2.0, 7.8);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = false;
  renderer.outputEncoding = THREE.sRGBEncoding;
  document.getElementById("canvas-wrap").appendChild(renderer.domElement);
  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0.25, 0);
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.minDistance = 3;
  controls.maxDistance = 16;
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  animate();
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

function buildScene(a) {
  const loader = new THREE.TextureLoader();
  const tex = (u) => {
    if (!u) return null;
    const t = loader.load(u.url, undefined, undefined, () => {
      statusEl.textContent = "纹理加载失败: " + u.url;
    });
    t.encoding = THREE.sRGBEncoding;
    return t;
  };

  // 灯光（增强，避免环境全黑）
  scene.add(new THREE.HemisphereLight(0x8899bb, 0x332211, 1.0));
  scene.add(new THREE.AmbientLight(0x556677, 0.8));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(4, 8, 6);
  scene.add(dir);
  const neon1 = new THREE.PointLight(0xff8844, 1.8, 16);
  neon1.position.set(2.2, 2.4, 2.0);
  scene.add(neon1);
  const neon2 = new THREE.PointLight(0x44ccff, 1.2, 14);
  neon2.position.set(-2.5, 2.0, -0.5);
  scene.add(neon2);
  const neon3 = new THREE.PointLight(0xffaa55, 0.9, 12);
  neon3.position.set(0, 3.2, 1.8);
  scene.add(neon3);

  // 地面（垫在场景下方）
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(16, 10),
    new THREE.MeshStandardMaterial({ color: 0x2a2c20, roughness: 0.95, metalness: 0.05 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -2.05;
  scene.add(floor);

  // 主体：概念图 + 深度置换 + PBR 贴图（竖立浮雕）
  if (a.concept) {
    const geo = new THREE.PlaneGeometry(12, 6, 160, 80);
    const mat = new THREE.MeshStandardMaterial({
      map: tex(a.concept),
      displacementMap: tex(a.depth),
      displacementScale: a.depth ? -1.1 : 0,
      displacementBias: 0,
      normalMap: tex(a.materials && a.materials.normal),
      roughness: 0.85,
      metalness: 0.15,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, 0.15, 0);
    scene.add(mesh);
    listEl.appendChild(item("环境", a.concept.filename));
    if (a.depth) listEl.appendChild(item("深度置换", a.depth.filename));
    if (a.materials) {
      ["normal", "height", "roughness", "metalness"].forEach((k) => {
        const m = a.materials[k];
        if (m) listEl.appendChild(item("材质·" + k, m.filename));
      });
    }
  }

  // 角色：图集序列帧动画
  let sprite = null;
  if (a.atlas && a.sprite_config) {
    const sc = a.sprite_config;
    const t = tex(a.atlas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / sc.columns, 1 / sc.rows);
    const mat = new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false });
    sprite = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4), mat);
    sprite.position.set(0, 0.55, 1.35);
    scene.add(sprite);
    let frame = 0;
    const fps = 1000 / (sc.frame_duration_ms || 80);
    let last = performance.now();
    setInterval(() => {
      if (!sprite) return;
      const row = Math.floor(frame / sc.columns);
      const col = frame % sc.columns;
      t.offset.set(col / sc.columns, 1 - (row + 1) / sc.rows);
      frame = (frame + 1) % sc.frames;
    }, sc.frame_duration_ms || 80);
    (function walk(t) {
      if (sprite) {
        sprite.position.x = Math.sin(t * 0.00045) * 1.4;
        sprite.position.y = 0.55 + Math.abs(Math.sin(t * 0.0018)) * 0.08;
      }
      requestAnimationFrame(walk);
    })(performance.now());
    listEl.appendChild(item("角色序列帧", a.atlas.filename));
  }

  // 音频
  if (a.music) {
    music = new Audio(a.music.url);
    music.loop = true;
    music.volume = 0.5;
    listEl.appendChild(item("背景音乐", a.music.filename));
  }
  const sfxList = (a.sfx || []).filter(Boolean);
  if (sfxList.length) {
    const glass = sfxList.find((s) => /glass|clink/i.test(s.filename));
    const amb = sfxList.find((s) => /ambient|murmur|环境/i.test(s.filename));
    clink = glass ? new Audio(glass.url) : null;
    if (clink) clink.volume = 0.7;
    ambient = amb ? new Audio(amb.url) : null;
    if (ambient) { ambient.loop = true; ambient.volume = 0.22; }
    sfxList.forEach((s) => listEl.appendChild(item("环境音效", s.filename)));
  }
  if (!sprite && !a.concept) statusEl.textContent = "该批次缺少环境或角色资产，仅显示灯光";

  assetsEl.textContent = `共 ${listEl.children.length} 项资产`;
  soundBtn.classList.remove("hidden");
}

function item(kind, name) {
  const li = document.createElement("li");
  li.textContent = `▪ ${kind}: ${name}`;
  return li;
}

function startAudio() {
  if (soundOn) return;
  soundOn = true;
  if (music) music.play().catch(() => {});
  if (ambient) ambient.play().catch(() => {});
  clinkTimer = setInterval(() => {
    if (clink) clink.currentTime = 0, clink.play().catch(() => {});
  }, 6000 + Math.random() * 4000);
}

function stopAudio() {
  soundOn = false;
  [music, ambient].forEach((a) => a && a.pause());
  clearInterval(clinkTimer);
}

overlay.addEventListener("click", () => {
  startAudio();
  overlay.classList.add("hidden");
});
soundBtn.addEventListener("click", () => {
  if (soundOn) { stopAudio(); soundBtn.textContent = "音效开/关（当前关）"; }
  else { startAudio(); soundBtn.textContent = "音效开/关（当前开）"; }
});
if (!batch) {
  overlay.classList.add("hidden");
  statusEl.textContent = "缺少 batch 参数（从任务详情进入）";
}
