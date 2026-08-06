const DEFAULTS = {
  W1: {
    text: "wasteland style bar interior, post-apocalyptic saloon, dark moody atmosphere, neon glow, metal bar counter, dusty bottles, grunge textures, cinematic lighting, highly detailed 2d game concept art background",
    negative: "blurry, low quality, deformed, watermark, text, oversaturated",
    width: 1024, height: 1024,
    seed: () => Math.floor(Math.random() * 1e9),
    steps: 20, cfg: 7,
  },
  W2: { resolution: 512 },
};

const FIELD_LABELS = {
  text: "设定文本（prompt）",
  negative: "负面提示词",
  width: "宽度",
  height: "高度",
  seed: "随机种子",
  steps: "采样步数",
  cfg: "CFG",
  resolution: "深度图分辨率",
};

let workflows = [];
let currentWorkflow = null;
let pollTimer = null;
let currentJobId = null;

async function api(path, opts) {
  const resp = await fetch(path, opts);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text.slice(0, 300) || resp.statusText);
  }
  return resp.json();
}

async function loadWorkflows() {
  workflows = await api("/api/workflows");
  renderWorkflowSelect();
  renderFields();
}

function renderWorkflowSelect() {
  const box = document.getElementById("workflow-select");
  box.innerHTML = "";
  workflows.forEach((wf) => {
    const el = document.createElement("div");
    el.className = "workflow-option" + (wf.name === currentWorkflow ? " active" : "");
    el.innerHTML = `<strong>${wf.title}</strong><small>${wf.description}</small>`;
    el.onclick = () => {
      currentWorkflow = wf.name;
      renderWorkflowSelect();
      renderFields();
    };
    box.appendChild(el);
  });
}

function renderFields() {
  const wf = workflows.find((w) => w.name === currentWorkflow);
  const form = document.getElementById("job-form");
  const fields = document.getElementById("dynamic-fields");
  fields.innerHTML = "";
  document.getElementById("image-upload").classList.toggle("hidden", !wf || !wf.accepts_image);
  document.getElementById("submit-btn").disabled = !wf;
  if (!wf) return;

  wf.inputs.forEach((key) => {
    const label = document.createElement("label");
    label.textContent = FIELD_LABELS[key] || key;
    fields.appendChild(label);
    let input;
    if (key === "text" || key === "negative") {
      input = document.createElement("textarea");
      input.value = typeof DEFAULTS[currentWorkflow][key] === "function"
        ? DEFAULTS[currentWorkflow][key]()
        : DEFAULTS[currentWorkflow][key];
    } else {
      input = document.createElement("input");
      input.type = "number";
      const v = DEFAULTS[currentWorkflow][key];
      input.value = typeof v === "function" ? v() : v;
      input.step = key === "cfg" ? "0.1" : "1";
    }
    input.name = key;
    fields.appendChild(input);
  });
}

async function submitJob(ev) {
  ev.preventDefault();
  const form = document.getElementById("job-form");
  const params = {};
  form.querySelectorAll("#dynamic-fields input, #dynamic-fields textarea").forEach((el) => {
    params[el.name] = el.name === "text" || el.name === "negative" ? el.value : Number(el.value);
  });
  const fd = new FormData();
  fd.append("workflow", currentWorkflow);
  fd.append("params", JSON.stringify(params));
  const fileInput = document.getElementById("image-file");
  if (fileInput.files.length) fd.append("image", fileInput.files[0]);
  try {
    const job = await api("/api/jobs", { method: "POST", body: fd });
    currentJobId = job.id;
    refreshJobs();
    showDetail(job);
    startPolling(job.id);
  } catch (err) {
    alert("提交失败: " + err.message);
  }
}

function startPolling(jobId) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const job = await api(`/api/jobs/${jobId}`);
      showDetail(job);
      refreshJobs();
      if (job.status === "done" || job.status === "error") clearInterval(pollTimer);
    } catch (_) { /* 服务暂不可用则跳过 */ }
  }, 2000);
}

function showDetail(job) {
  const detail = document.getElementById("job-detail");
  detail.classList.remove("hidden");
  currentJobId = job.id;
  document.getElementById("detail-title").textContent =
    `${workflows.find((w) => w.name === job.workflow)?.title || job.workflow} · ${job.id}`;
  const status = document.getElementById("detail-status");
  const badge = `<span class="badge ${job.status}">${job.status}</span>`;
  status.innerHTML = badge + (job.error ? `<br><span style="color:var(--err)">${job.error}</span>` : "");
  const preview = document.getElementById("detail-preview");
  if (job.outputs && job.outputs.length) {
    preview.innerHTML =
      `<img src="/api/jobs/${job.id}/image" alt="result">` +
      `<br><a href="/api/jobs/${job.id}/image" download>下载原图</a>`;
  } else {
    preview.innerHTML = "";
  }
  document.getElementById("detail-params").textContent =
    JSON.stringify(job.params, null, 2);
}

async function refreshJobs() {
  const jobs = await api("/api/jobs?limit=10");
  const list = document.getElementById("job-list");
  list.innerHTML = "";
  jobs.forEach((job) => {
    const li = document.createElement("li");
    const name = workflows.find((w) => w.name === job.workflow)?.title || job.workflow;
    li.innerHTML = `<span class="jid">#${job.id}</span> ${name} <span class="badge ${job.status}">${job.status}</span>`;
    li.onclick = () => showDetail(job);
    list.appendChild(li);
  });
}

document.getElementById("job-form").addEventListener("submit", submitJob);
loadWorkflows();
refreshJobs();
