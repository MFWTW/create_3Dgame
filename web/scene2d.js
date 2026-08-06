/* 2D 横版场景：2D 侧视构图 + 真实 3D 体积角色
   与 scene.js（2D 角色贴入 3D 场景）相反：
   - 场景：概念图平铺成 2D 背景，视差层次 + 剪影道具 + 地板渐变（纯 2D 视觉）
   - 角色：序列帧抠像后按 9 层「卡片」沿 Z 堆叠（最亮层靠前），
     视差剪切 + 前脸浮雕位移，构成有厚度的 3D 体积；
     按帧切换贴图播放动画，A/D 或 ←/→ 移动、空格旋转查看立体、P 恢复自动演出 */
const params = new URLSearchParams(location.search);
const batch = params.get("batch") || "";

const $ = (id) => document.getElementById(id);
const titleEl = $("scene-title");
const assetsEl = $("scene-assets");
const listEl = $("asset-list");
const statusEl = $("scene-status");
const actionEl = $("scene-action");
const soundBtn = $("sound-btn");
const spinBtn = $("spin-btn");
const overlay = $("start-overlay");
const modeLink = $("mode-link");
$("ov-title").textContent = batch ? `「${batch}」2D 场景` : "2D 场景";
if (batch) modeLink.href = `/scene.html?batch=${encodeURIComponent(batch)}`;

let scene, camera, renderer;
let music, ambient, clink, clinkTimer, soundOn = false;
let webglOK = true;

// 角色
let charGroup = null, charCards = null, charTex = null, frameOffsets = null, charCfg = null;
let charX = 0, charFacing = 1, yaw = BASE_YAW, spinning = false;
let state = "idle", frameIdx = 0, frameAcc = 0;
let targetX = null, walkResolve = null;
let running = true, manualMode = false, scriptActive = false;
const keys = { left: false, right: false };
let mouse = { x: 0, y: 0 };

// 环境
let bgPlane = null, shadow = null;
let dustPts = null, dustPuff = null, dustLife = null, dustTimer = 0;
const parallaxLayers = [];

const CHAR_H = 1.9;
const CARD_COUNT = 9;
const CARD_GAP = 0.07;
const CARD_DEPTH = 0.07;
const WALK_SPEED = 1.7;
const VIEW_H = 5.6;
const X_LIMIT = 3.0;
const BASE_YAW = 0.08;          // 静止时的轻微转角，让厚度可见
const DUST_POOL = 24;           // 脚步扬尘粒子池
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

let lastT = performance.now();

window.addEventListener("error", (e) => {
  statusEl.textContent = "脚本错误: " + (e.message || e.type);
  overlay.classList.add("hidden");
});

try {
  init();
  loadConfig();
} catch (err) {
  statusEl.textContent = "初始化失败: " + err.message + "（浏览器是否支持 WebGL？可尝试 Chrome/Edge）";
  overlay.classList.add("hidden");
}

async function loadConfig() {
  statusEl.textContent = "加载场景配置…";
  try {
    const resp = await fetch(`/api/scene?batch=${encodeURIComponent(batch)}`);
    if (!resp.ok) throw new Error((await resp.text()).slice(0, 200));
    const cfg = await resp.json();
    titleEl.textContent = cfg.batch;
    await buildScene(cfg.assets);
    statusEl.textContent = "就绪 · A/D 或 ←/→ 移动 · 空格旋转角色 · P 恢复自动演出";
  } catch (err) {
    statusEl.textContent = "加载失败: " + err.message;
  }
}

function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0c09);
  const w = VIEW_H * (innerWidth / innerHeight);
  camera = new THREE.OrthographicCamera(-w / 2, w / 2, VIEW_H / 2, -VIEW_H / 2, 0.1, 50);
  camera.position.set(0, 1.55, 8);
  camera.lookAt(0, 1.55, 0);

  addEventListener("resize", () => {
    const hw = VIEW_H * (innerWidth / innerHeight) / 2;
    camera.left = -hw; camera.right = hw;
    camera.top = VIEW_H / 2; camera.bottom = -VIEW_H / 2;
    camera.updateProjectionMatrix();
    if (renderer) renderer.setSize(innerWidth, innerHeight);
  });
  addEventListener("mousemove", (e) => {
    mouse.x = e.clientX / innerWidth - 0.5;
    mouse.y = e.clientY / innerHeight - 0.5;
  });
  addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") {
      keys.left = true; manualMode = true; running = false; targetX = null;
      resolveWalkers(); e.preventDefault();
    }
    if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") {
      keys.right = true; manualMode = true; running = false; targetX = null;
      resolveWalkers(); e.preventDefault();
    }
    if (e.key === " " || e.key === "Spacebar") { spinning = !spinning; updateSpinBtn(); e.preventDefault(); }
    if (e.key === "p" || e.key === "P") {
      manualMode = false; running = true;
      if (!scriptActive) {
        if (webglOK) startScript(); else fbScript();
      }
    }
    updateModeHint();
  });
  addEventListener("keyup", (e) => {
    if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") keys.left = false;
    if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") keys.right = false;
  });

  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch (err) {
    webglOK = false;
    return;
  }
  if (!renderer.getContext()) {
    webglOK = false;
    return;
  }
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  $("canvas-wrap").appendChild(renderer.domElement);
  animate();
}

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min((now - lastT) / 1000, 0.1);
  lastT = now;
  updateParallax();
  updateDust(dt);
  if (charGroup) updateCharacter(dt, now);
  updateDustPuff(dt);
  renderer.render(scene, camera);
}

function resolveWalkers() {
  if (walkResolve) { const r = walkResolve; walkResolve = null; r(); }
  if (fbWalkResolve) { const r = fbWalkResolve; fbWalkResolve = null; r(); }
}

function updateModeHint() {
  if (!webglOK) return;
  statusEl.textContent = manualMode
    ? "手动控制 · A/D 或 ←/→ 移动 · 空格旋转角色 · P 恢复自动演出"
    : "自动演出中 · A/D 或 ←/→ 接管移动 · 空格旋转角色";
}

/* ---------------- 角色更新：走位 / 帧动画 / 3D 旋转 ---------------- */
function updateCharacter(dt, now) {
  if (!charCfg || !frameOffsets) return;
  let manualWalk = false;
  if (keys.left || keys.right) {
    const dir = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    if (dir) {
      manualWalk = true;
      targetX = null;
      charX = clamp(charX + dir * WALK_SPEED * dt, -X_LIMIT, X_LIMIT);
      charFacing = dir;
    }
  }
  if (!manualWalk && state === "walk" && targetX != null) {
    const dx = targetX - charX;
    const dist = Math.abs(dx);
    const step = WALK_SPEED * dt;
    if (dist <= step) {
      charX = targetX;
      targetX = null;
      state = "idle";
      if (walkResolve) { const r = walkResolve; walkResolve = null; r(); }
    } else {
      charX += Math.sign(dx) * step;
      charFacing = dx > 0 ? 1 : -1;
    }
  }
  if (manualWalk) state = "walk";
  else if (!targetX && state === "walk") state = "idle";

  // 帧动画（走路快，待机慢放）
  const mul = state === "walk" ? 1 : 2.6;
  frameAcc += dt * 1000;
  const dur = charCfg.frame_duration_ms * mul;
  while (frameAcc >= dur) {
    frameAcc -= dur;
    frameIdx = (frameIdx + 1) % charCfg.frames;
  }
  const fo = frameOffsets[frameIdx];
  charTex.offset.set(fo.offsetX, fo.offsetY);
  charTex.repeat.set(fo.repeatX, fo.repeatY);

  if (spinning) yaw += dt * 1.9;
  const walkPhase = now * 0.011;
  const moving = state === "walk";
  const breathe = Math.sin(now * 0.0022);
  const bob = moving ? Math.abs(Math.sin(walkPhase)) * 0.05 : Math.abs(breathe) * 0.012;
  const stretch = moving ? Math.sin(walkPhase * 2) : breathe;
  const sy = 1 + stretch * (moving ? 0.05 : 0.008);
  const sx = 1 - stretch * (moving ? 0.04 : 0.006);

  // 卡片视差剪切：鼠标移动时各层沿 X 错开，产生真实纵深（深度剪影）
  for (const card of charCards.children) {
    const d = card.userData.depth;
    if (d == null) continue;
    card.position.x = d * (0.012 + mouse.x * 0.045);
    card.position.y = d * 0.0015;
  }

  charGroup.position.set(charX, bob, 0);
  charCards.rotation.y = yaw + breathe * 0.02;
  charCards.rotation.z = moving ? -charFacing * Math.sin(walkPhase) * 0.03 : 0;
  charCards.scale.x = charFacing * sx;
  charCards.scale.y = sy;

  shadow.position.set(charX, 0.02, 0);
  const sh = 1 + bob * 2.0;
  shadow.scale.set(sh, sh, 1);
  shadow.material.opacity = 0.36 + bob * 0.8;

  // 脚步扬尘
  if (moving) {
    dustTimer -= dt;
    if (dustTimer <= 0 && dustPuff) {
      dustTimer = 0.13;
      spawnDust();
    }
  }
}

function spawnDust() {
  const arr = dustPuff.geometry.attributes.position.array;
  for (let i = 0; i < DUST_POOL; i++) {
    if (dustLife[i] <= 0) {
      dustLife[i] = 1;
      arr[i * 3] = charX - charFacing * 0.16 + (Math.random() - 0.5) * 0.08;
      arr[i * 3 + 1] = 0.05 + Math.random() * 0.04;
      arr[i * 3 + 2] = (Math.random() - 0.5) * 0.1;
      dustPuff.visible = true;
      dustPuff.geometry.attributes.position.needsUpdate = true;
      return;
    }
  }
}

function updateDustPuff(dt) {
  if (!dustPuff) return;
  const arr = dustPuff.geometry.attributes.position.array;
  let any = false;
  for (let i = 0; i < DUST_POOL; i++) {
    if (dustLife[i] <= 0) continue;
    dustLife[i] -= dt / 0.7;
    if (dustLife[i] <= 0) { arr[i * 3 + 1] = -1; continue; }
    any = true;
    arr[i * 3] += (Math.random() - 0.5) * 0.004;
    arr[i * 3 + 1] += dt * 0.18;
  }
  dustPuff.geometry.attributes.position.needsUpdate = true;
  dustPuff.visible = any;
}

/* ---------------- 环境：纯 2D 侧视构图 ---------------- */
async function buildEnv(a) {
  scene.add(new THREE.AmbientLight(0x9aa8b8, 0.9));
  const dir = new THREE.DirectionalLight(0xffd9a0, 1.25);
  dir.position.set(3, 7, 5);
  scene.add(dir);
  const fill = new THREE.DirectionalLight(0x445566, 0.35);
  fill.position.set(-4, 2, -2);
  scene.add(fill);

  // 背景：概念图平铺（2D 视差）
  if (a.concept) {
    const t = await loadTexture(a.concept.url);
    if (t) {
      bgTex = t;
      bgPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(26, 9),
        new THREE.MeshBasicMaterial({ map: t, depthWrite: false })
      );
      bgPlane.position.set(0, 1.7, -7);
      scene.add(bgPlane);
      listEl.appendChild(item("2D 背景", a.concept.filename));
    }
  } else {
    statusEl.textContent = "该批次缺少概念图，背景使用纯色";
  }

  // 远景霓虹招牌
  const sign = makeSign();
  sign.position.set(0, 3.2, -6.1);
  scene.add(sign);
  parallaxLayers.push({ mesh: sign, baseX: 0, k: 0.10, mouseK: 0.4 });

  // 地板渐变 + 地平线
  const floor = makeFloor();
  scene.add(floor);
  const groundLine = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 0.05),
    new THREE.MeshBasicMaterial({ color: 0x6b5f3e, transparent: true, opacity: 0.85, depthWrite: false })
  );
  groundLine.position.set(0, 0.02, -6.3);
  scene.add(groundLine);

  // 剪影道具（不同视差系数形成 2D 纵深）
  const furniture = [
    { x: 2.45, w: 2.1, h: 1.15, z: -3.0, k: 0.30, color: 0x1c1e14 },
    { x: -1.55, w: 1.15, h: 0.95, z: -2.1, k: 0.50, color: 0x191b12 },
    { x: 0.15, w: 1.15, h: 0.95, z: -1.6, k: 0.70, color: 0x171910 },
    { x: -2.2, w: 0.42, h: 0.55, z: -1.85, k: 0.62, color: 0x15170f },
    { x: -0.42, w: 0.42, h: 0.55, z: -1.45, k: 0.82, color: 0x14160e },
  ];
  for (const f of furniture) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(f.w, f.h),
      new THREE.MeshBasicMaterial({ color: f.color, transparent: true, opacity: 0.96, depthWrite: false })
    );
    m.position.set(f.x, f.h / 2, f.z);
    scene.add(m);
    parallaxLayers.push({ mesh: m, baseX: f.x, k: f.k, mouseK: 0.55 });
  }

  // 前景吧台：角色走进吧台后时被其遮挡（2D 前后层）
  const frontCounter = new THREE.Mesh(
    new THREE.PlaneGeometry(2.1, 1.15),
    new THREE.MeshBasicMaterial({ color: 0x111209, transparent: true, opacity: 0.97, depthWrite: false })
  );
  frontCounter.position.set(2.45, 0.575, 1.2);
  frontCounter.renderOrder = 2;
  scene.add(frontCounter);
  parallaxLayers.push({ mesh: frontCounter, baseX: 2.45, k: 1.0, mouseK: 0.05 });

  // 吊灯辉光
  const lampMat = new THREE.MeshBasicMaterial({
    color: 0xffaa55, transparent: true, opacity: 0.8,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  for (const lx of [-2.35, 2.05]) {
    const l = new THREE.Mesh(new THREE.CircleGeometry(0.16, 24), lampMat);
    l.position.set(lx, 2.85, -5.6);
    scene.add(l);
    parallaxLayers.push({ mesh: l, baseX: lx, k: 0.14, mouseK: 0.6 });
  }

  // 灰尘粒子
  const n = 150;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 9;
    pos[i * 3 + 1] = Math.random() * 3.4;
    pos[i * 3 + 2] = -0.5 - Math.random() * 5.5;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  dustPts = new THREE.Points(g, new THREE.PointsMaterial({
    color: 0xccbb99, size: 0.02, transparent: true, opacity: 0.45,
  }));
  scene.add(dustPts);
}

function updateParallax() {
  if (bgPlane) {
    bgPlane.position.x = -charX * 0.12 + mouse.x * 0.5;
    bgPlane.position.y = 1.7 + mouse.y * 0.12;
  }
  for (const L of parallaxLayers) {
    L.mesh.position.x = L.baseX - charX * L.k + mouse.x * L.mouseK;
  }
}

function updateDust(dt) {
  if (!dustPts) return;
  const pos = dustPts.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    let y = pos.getY(i) + dt * 0.06;
    if (y > 3.4) y = 0.05;
    pos.setY(i, y);
  }
  pos.needsUpdate = true;
}

function makeSign() {
  const cv = document.createElement("canvas");
  cv.width = 1024; cv.height = 128;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 1024, 128);
  ctx.font = "bold 72px 'Arial Black', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "#ff7733";
  ctx.shadowBlur = 26;
  ctx.fillStyle = "#ffaa55";
  ctx.fillText("WASTELAND BAR", 512, 64);
  const t = new THREE.CanvasTexture(cv);
  t.encoding = THREE.sRGBEncoding;
  return new THREE.Mesh(
    new THREE.PlaneGeometry(4.4, 0.58),
    new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false })
  );
}

function makeFloor() {
  const cv = document.createElement("canvas");
  cv.width = 64; cv.height = 256;
  const ctx = cv.getContext("2d");
  const grd = ctx.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, "rgba(0,0,0,0)");
  grd.addColorStop(0.1, "rgba(30,33,21,0.85)");
  grd.addColorStop(0.5, "rgba(16,18,12,0.94)");
  grd.addColorStop(1, "rgba(6,7,5,1)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 64, 256);
  ctx.strokeStyle = "rgba(120,110,80,0.14)";
  ctx.lineWidth = 2;
  for (let y = 18; y < 256; y += 30) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(64, y);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(9, 1);
  t.encoding = THREE.sRGBEncoding;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(27, 5.6),
    new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false })
  );
  m.position.set(0, -2.8, -6.8);
  m.renderOrder = 1;
  return m;
}

/* ---------------- 角色：序列帧 → 3D 卡片堆叠 ---------------- */
function loadImg(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败: " + url));
    img.src = url;
  });
}

function loadTexture(url) {
  return new Promise((resolve) => {
    new THREE.TextureLoader().load(url, (t) => {
      t.encoding = THREE.sRGBEncoding;
      resolve(t);
    }, undefined, () => resolve(null));
  });
}

function keySprite(img, cfg) {
  // 思路：多数 W6 图集是「亮色角色 + 深色背景 + 每帧外圈装饰」。
  // 1) 按亮度筛出角色亮部像素（排除贴近帧边缘的装饰环）；
  // 2) 连通域过滤噪点，得到每帧角色亮部包围盒；
  // 3) 包围盒内整体保留（含角色深色衣物/阴影），盒外全部抠掉。
  const W = img.width, H = img.height;
  if (!W || !H) return null;
  const C = Math.max(1, cfg.columns || 1), R = Math.max(1, cfg.rows || 1);
  const cellW = W / C, cellH = H / R;
  const n = W * H;

  const srcCv = document.createElement("canvas");
  srcCv.width = W; srcCv.height = H;
  const sctx = srcCv.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(img, 0, 0);
  const src = sctx.getImageData(0, 0, W, H);
  const d = src.data;

  const LUM = 108;              // 亮部阈值（max 通道）
  const BAND = 30;              // 帧边缘装饰环宽度
  const light = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    const m = r > g ? (r > b ? r : b) : (g > b ? g : b);
    if (m >= LUM) light[i] = 1;
  }

  // 连通域（4 邻接）
  const compId = new Int32Array(n);
  compId.fill(-1);
  const meta = [];              // { size, touch, cell }
  const queue = [];
  for (let s = 0; s < n; s++) {
    if (!light[s] || compId[s] >= 0) continue;
    const cid = meta.length;
    compId[s] = cid;
    queue.length = 0;
    queue.push(s);
    let size = 0, touch = false;
    let repX = s % W, repY = (s / W) | 0;
    while (queue.length) {
      const i = queue.pop();
      size++;
      const x = i % W, y = (i / W) | 0;
      const cx = (x / cellW) | 0, cy = (y / cellH) | 0;
      const ex = x - cx * cellW, ey = y - cy * cellH;
      if (ex < BAND || ey < BAND || ex > cellW - BAND || ey > cellH - BAND) touch = true;
      if (x > 0 && light[i - 1] && compId[i - 1] < 0) { compId[i - 1] = cid; queue.push(i - 1); }
      if (x < W - 1 && light[i + 1] && compId[i + 1] < 0) { compId[i + 1] = cid; queue.push(i + 1); }
      if (y > 0 && light[i - W] && compId[i - W] < 0) { compId[i - W] = cid; queue.push(i - W); }
      if (y < H - 1 && light[i + W] && compId[i + W] < 0) { compId[i + W] = cid; queue.push(i + W); }
    }
    meta.push({ size, touch, cell: ((repY / cellH) | 0) * C + ((repX / cellW) | 0) });
  }

  // 每帧最大「角色候选」组件 → 过滤小噪点
  const cellMax = new Array(C * R).fill(0);
  for (const m of meta) {
    if (!m.touch && m.size > cellMax[m.cell]) cellMax[m.cell] = m.size;
  }
  if (cellMax.every((v) => v === 0)) return null;   // 找不到角色 → 走 rawCells

  const ux0 = new Array(C * R).fill(W), ux1 = new Array(C * R).fill(-1);
  const uy0 = new Array(C * R).fill(H), uy1 = new Array(C * R).fill(-1);
  for (let i = 0; i < n; i++) {
    if (!light[i]) continue;
    const m = meta[compId[i]];
    if (m.touch) continue;
    const th = Math.max(150, Math.floor(cellMax[m.cell] * 0.04));
    if (m.size < th) continue;
    const x = i % W, y = (i / W) | 0;
    if (x < ux0[m.cell]) ux0[m.cell] = x;
    if (x > ux1[m.cell]) ux1[m.cell] = x;
    if (y < uy0[m.cell]) uy0[m.cell] = y;
    if (y > uy1[m.cell]) uy1[m.cell] = y;
  }
  let found = 0;
  for (let c = 0; c < C * R; c++) if (ux1[c] >= ux0[c]) found++;
  if (found < Math.ceil((C * R) / 2)) return null;

  // 包围盒内保留（含深色衣物），盒外透明
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const octx = out.getContext("2d");
  const od = octx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    const cy = (y / cellH) | 0;
    for (let x = 0; x < W; x++) {
      const c = cy * C + ((x / cellW) | 0);
      const keep = ux1[c] >= ux0[c] && x >= ux0[c] && x <= ux1[c] && y >= uy0[c] && y <= uy1[c];
      const si = (row + x) * 4;
      od.data[si] = d[si];
      od.data[si + 1] = d[si + 1];
      od.data[si + 2] = d[si + 2];
      od.data[si + 3] = keep ? 255 : 0;
    }
  }
  octx.putImageData(od, 0, 0);
  return makeFrames(out, cfg, C, R, cellW, cellH, 0, 0, W, H, W, H);
}

function rawCells(img, cfg) {
  const W = img.width, H = img.height;
  const C = Math.max(1, cfg.columns || 1), R = Math.max(1, cfg.rows || 1);
  const cellW = W / C, cellH = H / R;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return makeFrames(cv, cfg, C, R, cellW, cellH, 0, 0, W, H, W, H);
}

function makeFrames(canvas, cfg, C, R, cellW, cellH, uMin, vMin, cw, ch, W, H) {
  const frames = [];
  const total = Math.max(1, cfg.frames || 1);
  for (let f = 0; f < total; f++) {
    const c = f % C, r = Math.floor(f / C);
    const ox = Math.floor(c * cellW), oy = Math.floor(r * cellH);
    const ow = Math.min(W, Math.ceil((c + 1) * cellW)) - ox;
    const oh = Math.min(H, Math.ceil((r + 1) * cellH)) - oy;
    frames.push({
      offsetX: (ox - uMin) / cw,
      offsetY: 1 - (oy + oh - vMin) / ch,
      repeatX: ow / cw,
      repeatY: oh / ch,
      rect: { x: ox - uMin, y: oy - vMin, w: ow, h: oh },
    });
  }
  return { canvas, frames, aspect: cellW / cellH };
}

async function buildCharacter(a) {
  charCfg = a.sprite_config;
  statusEl.textContent = "抠像并构建 3D 角色…";
  const img = await loadImg(a.atlas.url);
  let kr = keySprite(img, charCfg);
  if (!kr) kr = rawCells(img, charCfg);
  frameOffsets = kr.frames;

  charTex = new THREE.CanvasTexture(kr.canvas);
  charTex.encoding = THREE.sRGBEncoding;
  charTex.generateMipmaps = false;
  charTex.minFilter = THREE.LinearFilter;
  charTex.wrapS = charTex.wrapT = THREE.ClampToEdgeWrapping;

  // 9 层卡片沿 Z 堆叠 = 有厚度的 3D 体积
  charGroup = new THREE.Group();
  charCards = new THREE.Group();
  const gW = CHAR_H * kr.aspect, gH = CHAR_H;
  const geo = new THREE.BoxGeometry(gW, gH, CARD_DEPTH);
  geo.translate(0, gH / 2, 0);
  for (let i = 0; i < CARD_COUNT; i++) {
    const t = i / (CARD_COUNT - 1);
    const shade = 1 - t * 0.8;
    const cap = new THREE.MeshBasicMaterial({
      map: charTex,
      color: new THREE.Color(shade, shade * 0.97, shade * 0.93),
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    });
    const edge = new THREE.MeshLambertMaterial({
      color: new THREE.Color().setHSL(0.075, 0.30, 0.28 - t * 0.16),
      emissive: new THREE.Color().setHSL(0.075, 0.45, 0.045 - t * 0.02),
    });
    const card = new THREE.Mesh(geo, [edge, edge, edge, edge, cap, cap]);
    // i=0 为最亮且最靠前（面向镜头），向后逐层变暗
    card.position.z = ((CARD_COUNT - 1) / 2 - i) * CARD_GAP;
    card.userData.depth = (CARD_COUNT - 1) / 2 - i;
    charCards.add(card);
  }

  // 前脸浮雕：以精灵亮度为位移贴图，亮部鼓起，转动时能看到真实曲面而非平面贴图
  const relGeo = new THREE.PlaneGeometry(gW, gH, 64, 80);
  relGeo.translate(0, gH / 2, 0);
  const relief = new THREE.Mesh(relGeo, new THREE.MeshBasicMaterial({
    map: charTex,
    displacementMap: charTex,
    displacementScale: 0.10,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
  }));
  relief.position.z = ((CARD_COUNT - 1) / 2) * CARD_GAP + CARD_DEPTH / 2 + 0.012;
  relief.userData.depth = (CARD_COUNT - 1) / 2;
  charCards.add(relief);
  charGroup.add(charCards);
  scene.add(charGroup);

  shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.55, 28),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.38, depthWrite: false })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0, 0.02, 0);
  scene.add(shadow);

  // 脚步扬尘粒子池
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(DUST_POOL * 3), 3));
  dustLife = new Float32Array(DUST_POOL);
  dustPuff = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    color: 0xbbaa88, size: 0.03, transparent: true, opacity: 0.5, depthWrite: false,
  }));
  dustPuff.visible = false;
  scene.add(dustPuff);

  const fo = frameOffsets[0];
  charTex.offset.set(fo.offsetX, fo.offsetY);
  charTex.repeat.set(fo.repeatX, fo.repeatY);
  listEl.appendChild(item("3D 角色（序列帧卡片堆叠）", a.atlas.filename));
}

/* ---------------- 剧本：酒保的 2D 横版日常 ---------------- */
const SCRIPT = [
  { x: 2.45, dur: 6000, text: "酒保在吧台后擦洗玻璃杯" },
  { x: 1.45, dur: 2500, text: "从吧台走出来" },
  { x: -1.55, dur: 2600, text: "走向 1 号桌" },
  { x: -1.55, dur: 5000, text: "收拾 1 号桌的酒杯" },
  { x: 0.15, dur: 2600, text: "走向 2 号桌" },
  { x: 0.15, dur: 5000, text: "擦 2 号桌台面" },
  { x: 2.45, dur: 2600, text: "回到吧台" },
  { x: 2.45, dur: 8000, text: "在吧台后待机，等待打烊" },
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function startScript() {
  if (scriptActive) return;
  scriptActive = true;
  while (running) {
    for (const step of SCRIPT) {
      if (!running) break;
      actionEl.textContent = step.text;
      targetX = step.x;
      state = "walk";
      await new Promise((res) => { walkResolve = res; });
      if (!running) break;
      state = "idle";
      await sleep(step.dur);
    }
    if (!running) break;
    actionEl.textContent = "（循环）";
    await sleep(2500);
  }
  scriptActive = false;
}

async function buildScene(a) {
  if (!webglOK) {
    await fallback2D(a);
    return;
  }
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0c09);
  await buildEnv(a);
  if (a.atlas && a.sprite_config) {
    await buildCharacter(a);
  } else {
    statusEl.textContent = "该批次缺少角色图集，仅展示 2D 背景";
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

function updateSpinBtn() {
  spinBtn.textContent = spinning ? "停止旋转" : "旋转角色";
}

if (!batch) {
  overlay.classList.add("hidden");
  statusEl.textContent = "缺少 batch 参数（从任务详情进入）";
}
overlay.addEventListener("click", () => {
  startAudio();
  overlay.classList.add("hidden");
});
soundBtn.addEventListener("click", () => {
  if (soundOn) { stopAudio(); soundBtn.textContent = "音效开/关（当前关）"; }
  else { startAudio(); soundBtn.textContent = "音效开/关（当前开）"; }
});
spinBtn.addEventListener("click", () => {
  spinning = !spinning;
  updateSpinBtn();
});

/* ---------------- 2D 兼容模式（WebGL 不可用时自动启用） ---------------- */
let fbCtx = null, fbCanvas = null, fbBg = null, fbFrames = null, fbCfg = null;
let fbX = 0.8, fbFrame = 0, fbAcc = 0, fbTarget = null, fbWalkResolve = null;
let fbLastT = performance.now();
const fbDust = Array.from({ length: 90 }, () => ({
  x: Math.random(), y: Math.random(), s: 0.4 + Math.random() * 0.6,
}));

async function fallback2D(a) {
  overlay.classList.add("hidden");
  statusEl.textContent = "2D 兼容模式（当前环境不支持 WebGL）· A/D 或 ←/→ 移动 · P 恢复自动演出";
  fbCanvas = document.createElement("canvas");
  fbCanvas.style.width = "100%";
  fbCanvas.style.height = "100%";
  $("canvas-wrap").appendChild(fbCanvas);
  fbCtx = fbCanvas.getContext("2d");
  fbCfg = a.sprite_config;
  if (a.concept) fbBg = await loadImg(a.concept.url);
  if (a.atlas && fbCfg) {
    const img = await loadImg(a.atlas.url);
    let kr = keySprite(img, fbCfg);
    if (!kr) kr = rawCells(img, fbCfg);
    if (kr) fbFrames = kr;
  }
  setupAudio(a);
  assetsEl.textContent = `共 ${listEl.children.length} 项资产`;
  soundBtn.classList.remove("hidden");
  fbLoop();
  fbScript();
}

function fbLoop() {
  const ctx = fbCtx, w = (fbCanvas.width = innerWidth), h = (fbCanvas.height = innerHeight);
  const now = performance.now();
  const dt = Math.min((now - fbLastT) / 1000, 0.1);
  fbLastT = now;
  ctx.fillStyle = "#0a0c09";
  ctx.fillRect(0, 0, w, h);
  if (fbBg) {
    const k = Math.max(w / fbBg.width, h / fbBg.height) * 1.06;
    const bw = fbBg.width * k, bh = fbBg.height * k;
    const ox = -(fbX * 14) + (w - bw) / 2;
    const oy = -(h - bh) / 2 - h * 0.02;
    ctx.drawImage(fbBg, ox, oy, bw, bh);
    const grd = ctx.createLinearGradient(0, h * 0.52, 0, h);
    grd.addColorStop(0, "rgba(8,10,7,0)");
    grd.addColorStop(1, "rgba(8,10,7,0.92)");
    ctx.fillStyle = grd;
    ctx.fillRect(0, h * 0.52, w, h * 0.48);
  }
  ctx.fillStyle = "rgba(204,187,153,0.45)";
  fbDust.forEach((d) => {
    d.y -= 0.00016 * d.s;
    if (d.y < -0.02) d.y = 1.02;
    ctx.beginPath();
    ctx.arc(d.x * w, d.y * h, 1.1 * d.s, 0, Math.PI * 2);
    ctx.fill();
  });
  if (fbFrames && fbCfg) {
    let manualWalk = false;
    if (keys.left || keys.right) {
      const dir = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
      if (dir) {
        manualWalk = true;
        fbTarget = null;
        fbX = clamp(fbX + dir * WALK_SPEED * dt, -X_LIMIT, X_LIMIT);
      }
    }
    if (!manualWalk && fbTarget != null) {
      const dx = fbTarget - fbX, step = WALK_SPEED * dt;
      if (Math.abs(dx) <= step) {
        fbX = fbTarget;
        fbTarget = null;
        state = "idle";
        if (fbWalkResolve) { const r = fbWalkResolve; fbWalkResolve = null; r(); }
      } else {
        fbX += Math.sign(dx) * step;
        state = "walk";
      }
    }
    if (manualWalk) state = "walk";
    else if (!fbTarget && state === "walk") state = "idle";

    const mul = state === "walk" ? 1 : 2.6;
    fbAcc += dt * 1000;
    const dur = fbCfg.frame_duration_ms * mul;
    while (fbAcc >= dur) {
      fbAcc -= dur;
      fbFrame = (fbFrame + 1) % fbCfg.frames;
    }
    const fo = fbFrames.frames[fbFrame];
    const cx = ((fbX + 3.5) / 7) * w;
    const groundY = h * 0.78;
    const chH = h * 0.34;
    const cw2 = chH * fbFrames.aspect;
    ctx.fillStyle = "rgba(0,0,0,0.38)";
    ctx.beginPath();
    ctx.ellipse(cx, groundY + chH * 0.02, cw2 * 0.3, cw2 * 0.05, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.drawImage(fbFrames.canvas, fo.rect.x, fo.rect.y, fo.rect.w, fo.rect.h, cx - cw2 / 2, groundY - chH, cw2, chH);
  }
  requestAnimationFrame(fbLoop);
}

async function fbScript() {
  if (scriptActive) return;
  scriptActive = true;
  while (running) {
    for (const step of SCRIPT) {
      if (!running) break;
      actionEl.textContent = step.text;
      fbTarget = step.x;
      state = "walk";
      await new Promise((res) => { fbWalkResolve = res; });
      if (!running) break;
      state = "idle";
      await sleep(step.dur);
    }
    if (!running) break;
    actionEl.textContent = "（循环）";
    await sleep(2500);
  }
  scriptActive = false;
}
