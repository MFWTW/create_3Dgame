/* 废土酒吧 3D 场景：真实几何环境 + 脚本化角色演出 */
const params = new URLSearchParams(location.search);
const batch = params.get("batch") || "";

const titleEl = document.getElementById("scene-title");
const assetsEl = document.getElementById("scene-assets");
const listEl = document.getElementById("asset-list");
const statusEl = document.getElementById("scene-status");
const actionEl = document.getElementById("scene-action");
const soundBtn = document.getElementById("sound-btn");
const overlay = document.getElementById("start-overlay");
document.getElementById("ov-title").textContent = batch ? `「${batch}」3D 场景` : "3D 场景";

let scene, camera, renderer, controls;
let music, ambient, clink, clinkTimer, soundOn = false;

let sprite = null, spriteTex = null, spriteCfg = null;
let shadow = null, charPos = null, charTarget = null, charFacing = 1;
let walkResolve = null, frameIdx = 0, frameMs = 80;
let dustPts = null;

init();
loadConfig();

async function loadConfig() {
  statusEl.textContent = "加载场景配置…";
  try {
    const resp = await fetch(`/api/scene?batch=${encodeURIComponent(batch)}`);
    if (!resp.ok) throw new Error((await resp.text()).slice(0, 200));
    const cfg = await resp.json();
    titleEl.textContent = cfg.batch;
    await buildScene(cfg.assets);
    statusEl.textContent = "就绪 · 拖拽旋转 · 滚轮缩放";
  } catch (err) {
    statusEl.textContent = "加载失败: " + err.message;
  }
}

function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d0a);
  scene.fog = new THREE.FogExp2(0x0b0d0a, 0.05);
  camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 100);
  camera.position.set(0, 1.9, 5.2);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  document.getElementById("canvas-wrap").appendChild(renderer.domElement);
  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 1.2, -0.8);
  controls.maxPolarAngle = 1.48;
  controls.minDistance = 2.5;
  controls.maxDistance = 12;
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  animate();
}

let lastT = performance.now();
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min((now - lastT) / 1000, 0.1);
  lastT = now;
  controls.update();
  if (dustPts) {
    const pos = dustPts.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      let y = pos.getY(i) + dt * 0.06;
      if (y > 2.8) y = 0.1;
      pos.setY(i, y);
    }
    pos.needsUpdate = true;
  }
  if (sprite) {
    if (state === "walk" && charTarget) {
      const dx = charTarget.x - charPos.x, dz = charTarget.z - charPos.z;
      const dist = Math.hypot(dx, dz);
      const speed = 1.4 * dt;
      if (dist <= speed) {
        charPos.set(charTarget.x, 0, charTarget.z);
        charTarget = null;
        state = "stand";
        if (walkResolve) { walkResolve(); walkResolve = null; }
      } else {
        charPos.x += dx / dist * speed;
        charPos.z += dz / dist * speed;
        charFacing = dx >= 0 ? 1 : -1;
      }
    }
    const bob = state === "walk" ? Math.abs(Math.sin(now * 0.01)) * 0.05 : 0;
    sprite.position.set(charPos.x, 0.9 + bob, charPos.z);
    sprite.scale.x = charFacing * 1.8;
    if (shadow) shadow.position.set(charPos.x, 0.02, charPos.z);
  }
  renderer.render(scene, camera);
}

/* ---------------- 环境：真实几何 ----------------
   房间 9(x) × 7(z)，后墙 z=-3.5，吧台靠右，两张桌在左侧 */
function buildRoom(a) {
  const loader = new THREE.TextureLoader();
  const std = (opt) => new THREE.MeshStandardMaterial(opt);
  const wood = std({ color: 0x4a3a26, roughness: 0.85, metalness: 0.05 });
  const metal = std({ color: 0x5c5a52, roughness: 0.55, metalness: 0.65 });
  const dark = std({ color: 0x2b2a24, roughness: 0.9, metalness: 0.1 });
  const neonMat = (c, e) => std({ color: c, emissive: e, emissiveIntensity: 1.4, roughness: 0.4 });

  // 地面
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(9, 7), wood);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // 后墙 + 两侧墙
  const backWall = new THREE.Mesh(new THREE.BoxGeometry(9, 3.6, 0.2), dark);
  backWall.position.set(0, 1.8, -3.5);
  scene.add(backWall);
  for (const sx of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.2, 3.6, 7), dark);
    wall.position.set(sx * 4.5, 1.8, 0);
    scene.add(wall);
  }

  // 概念图作为后墙大幅海报（带深度置换与法线）
  if (a.concept) {
    const poster = new THREE.Mesh(
      new THREE.PlaneGeometry(6.6, 2.7, 96, 36),
      new THREE.MeshStandardMaterial({
        map: tex(loader, a.concept),
        displacementMap: tex(loader, a.depth),
        displacementScale: a.depth ? -0.22 : 0,
        normalMap: tex(loader, a.materials && a.materials.normal),
        roughness: 0.85,
        metalness: 0.12,
      })
    );
    poster.position.set(0, 1.85, -3.39);
    scene.add(poster);
    listEl.appendChild(item("背景海报", a.concept.filename));
  }

  // 吧台（右侧）：台面 + 前面板
  const counterTop = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.14, 4.8), wood);
  counterTop.position.set(3.6, 1.12, 0);
  scene.add(counterTop);
  const counterFront = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.1, 4.8), metal);
  counterFront.position.set(3.6, 0.55, 0);
  scene.add(counterFront);

  // 后墙酒架 + 酒瓶
  const shelfMat = wood;
  for (const sy of [2.15, 2.6]) {
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.07, 0.4), shelfMat);
    shelf.position.set(-1.2, sy, -3.28);
    scene.add(shelf);
    const bottleColors = [0x3f6f5a, 0x7a4a2f, 0x4f5f8f, 0x8f3f3f, 0x5f8f4f, 0x8f7f3f, 0x3f7f8f];
    for (let i = 0; i < 7; i++) {
      const b = new THREE.Mesh(
        new THREE.CylinderGeometry(0.055, 0.06, 0.26, 8),
        std({ color: bottleColors[i % bottleColors.length], roughness: 0.3, metalness: 0.2 })
      );
      b.position.set(-3.1 + i * 0.62, sy + 0.15, -3.28);
      scene.add(b);
    }
  }

  // 桌子 + 凳子（左侧两张）
  for (const [tx, tz] of [[-1.6, -1.5], [-1.6, 0.8]]) {
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.08, 1.0), wood);
    top.position.set(tx, 0.82, tz);
    scene.add(top);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.78, 8), metal);
    leg.position.set(tx, 0.39, tz);
    scene.add(leg);
    for (const off of [[0.55, 0], [-0.55, 0]]) {
      const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.5, 10), dark);
      stool.position.set(tx + off[0], 0.25, tz);
      scene.add(stool);
    }
  }

  // 霓虹招牌（发光文字）
  const signCanvas = document.createElement("canvas");
  signCanvas.width = 1024; signCanvas.height = 128;
  const sctx = signCanvas.getContext("2d");
  sctx.fillStyle = "#000";
  sctx.fillRect(0, 0, 1024, 128);
  sctx.font = "bold 72px 'Arial Black', sans-serif";
  sctx.textAlign = "center";
  sctx.textBaseline = "middle";
  sctx.shadowColor = "#ff7733";
  sctx.shadowBlur = 24;
  sctx.fillStyle = "#ffaa55";
  sctx.fillText("WASTELAND BAR", 512, 64);
  const signTex = new THREE.CanvasTexture(signCanvas);
  signTex.encoding = THREE.sRGBEncoding;
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(4.2, 0.55),
    new THREE.MeshBasicMaterial({ map: signTex, transparent: true })
  );
  sign.position.set(0, 2.95, -3.38);
  scene.add(sign);

  // 吊灯 + 灯光
  for (const lx of [-2.2, 2.0]) {
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 12), neonMat(0xffcc88, 0xffaa55));
    bulb.position.set(lx, 3.05, -1.2);
    scene.add(bulb);
    const pl = new THREE.PointLight(0xffaa55, 1.3, 10);
    pl.position.set(lx, 2.7, -1.2);
    scene.add(pl);
  }
  const neonR = new THREE.PointLight(0xff8844, 1.5, 12);
  neonR.position.set(1.2, 2.6, -2.0);
  scene.add(neonR);

  // 灰尘粒子
  const n = 260;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 7.5;
    pos[i * 3 + 1] = Math.random() * 2.6;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 5.5;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  dustPts = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xccbb99, size: 0.02, transparent: true, opacity: 0.5 }));
  scene.add(dustPts);
}

function tex(loader, u) {
  if (!u) return null;
  const t = loader.load(u.url, undefined, undefined, () => {
    statusEl.textContent = "纹理加载失败: " + u.url;
  });
  t.encoding = THREE.sRGBEncoding;
  return t;
}

/* ---------------- 角色：贴地 + 阴影 + 统一色调 ---------------- */
function buildSpriteTexture(atlasUrl, sc) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement("canvas");
      cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext("2d");
      ctx.filter = "contrast(1.18) brightness(1.06) saturate(1.3)";
      ctx.drawImage(img, 0, 0);
      const t = new THREE.CanvasTexture(cv);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(1 / sc.columns, 1 / sc.rows);
      t.encoding = THREE.sRGBEncoding;
      resolve(t);
    };
    img.onerror = () => reject(new Error("图集加载失败: " + atlasUrl));
    img.src = atlasUrl;
  });
}

function setSpriteFrame() {
  if (!spriteTex || !spriteCfg) return;
  const row = Math.floor(frameIdx / spriteCfg.columns);
  const col = frameIdx % spriteCfg.columns;
  spriteTex.offset.set(col / spriteCfg.columns, 1 - (row + 1) / spriteCfg.rows);
}

async function buildCharacter(a) {
  spriteCfg = a.sprite_config;
  spriteTex = await buildSpriteTexture(a.atlas.url, spriteCfg);
  sprite = new THREE.Mesh(
    new THREE.PlaneGeometry(1.8, 1.8),
    new THREE.MeshBasicMaterial({ map: spriteTex, transparent: true, depthWrite: false })
  );
  charPos = new THREE.Vector3(3.6, 0, 0.4);
  sprite.position.set(charPos.x, 0.9, charPos.z);
  scene.add(sprite);

  shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.55, 24),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false })
  );
  shadow.rotation.x = -Math.PI / 2;
  scene.add(shadow);

  setInterval(() => {
    if (!spriteTex) return;
    frameIdx = (frameIdx + 1) % spriteCfg.frames;
    setSpriteFrame();
  }, frameMs);
  listEl.appendChild(item("角色序列帧", a.atlas.filename));
}

/* ---------------- 剧本：酒保在酒吧里干什么 ---------------- */
let state = "idle";
const ACTION_TEXT = {
  walk: "正在走向…",
  wipe: "正在擦洗…",
  idle: "在吧台后待机",
};
const SCRIPT = [
  { action: "wipe", at: { x: 3.6, z: 0.4 }, dur: 6, text: "酒保在吧台后擦洗玻璃杯" },
  { action: "walk", to: { x: 1.3, z: -0.6 }, text: "从吧台走出来" },
  { action: "walk", to: { x: -1.6, z: -1.5 }, text: "走向 1 号桌" },
  { action: "wipe", at: { x: -1.6, z: -1.5 }, dur: 5, text: "收拾 1 号桌的酒杯" },
  { action: "walk", to: { x: -1.6, z: 0.8 }, text: "走向 2 号桌" },
  { action: "wipe", at: { x: -1.6, z: 0.8 }, dur: 5, text: "擦 2 号桌台面" },
  { action: "walk", to: { x: 3.6, z: 0.4 }, text: "回到吧台" },
  { action: "idle", at: { x: 3.6, z: 0.4 }, dur: 8, text: "在吧台后待机，等待打烊" },
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function startScript() {
  await sleep(500);
  while (true) {
    for (const step of SCRIPT) {
      actionEl.textContent = step.text || ACTION_TEXT[step.action] || "";
      if (step.action === "walk") {
        state = "walk";
        frameMs = spriteCfg ? spriteCfg.frame_duration_ms : 80;
        charTarget = step.to;
        await new Promise((res) => { walkResolve = res; });
      } else {
        state = step.action;
        frameMs = spriteCfg ? Math.round(spriteCfg.frame_duration_ms * 2.4) : 200;
        await sleep(step.dur * 1000);
      }
    }
    actionEl.textContent = "（循环）";
    await sleep(2500);
  }
}

/* ---------------- 音频 ---------------- */
function setupAudio(a) {
  if (a.music) {
    music = new Audio(a.music.url);
    music.loop = true;
    music.volume = 0.45;
    listEl.appendChild(item("背景音乐", a.music.filename));
  }
  const sfxList = (a.sfx || []).filter(Boolean);
  if (sfxList.length) {
    const glass = sfxList.find((s) => /glass|clink/i.test(s.filename));
    const amb = sfxList.find((s) => /ambient|murmur|环境/i.test(s.filename));
    clink = glass ? new Audio(glass.url) : null;
    if (clink) clink.volume = 0.65;
    ambient = amb ? new Audio(amb.url) : null;
    if (ambient) { ambient.loop = true; ambient.volume = 0.2; }
    sfxList.forEach((s) => listEl.appendChild(item("环境音效", s.filename)));
  }
}

async function buildScene(a) {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d0a);
  scene.fog = new THREE.FogExp2(0x0b0d0a, 0.05);
  scene.add(new THREE.HemisphereLight(0x8899bb, 0x332211, 0.95));
  scene.add(new THREE.AmbientLight(0x556677, 0.7));
  const dir = new THREE.DirectionalLight(0xffeedd, 1.0);
  dir.position.set(4, 8, 5);
  scene.add(dir);

  buildRoom(a);
  if (a.atlas && a.sprite_config) {
    await buildCharacter(a);
  } else {
    statusEl.textContent = "该批次缺少角色图集，仅展示环境";
  }
  setupAudio(a);
  assetsEl.textContent = `共 ${listEl.children.length} 项资产`;
  soundBtn.classList.remove("hidden");
  startScript();
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
    if (clink) { clink.currentTime = 0; clink.play().catch(() => {}); }
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
