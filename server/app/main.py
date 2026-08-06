"""独立游戏 AI 资产生成平台 - 后端 API（P2/P3/P4）"""
import json
import shutil
from contextlib import asynccontextmanager
from math import ceil
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import comfy, db, translator

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
WORKFLOWS_DIR = PROJECT_ROOT / "workflows"
WEB_DIR = PROJECT_ROOT / "web"
COMFY_INPUT_DIR = PROJECT_ROOT / "ComfyUI" / "input"

# 工作流名 → 模板文件名
TEMPLATE_FILES = {
    "W1": "W1_concept.json",
    "W2": "W2_depth.json",
    "W3": "W3_material.json",
    "W4": "W4_music.json",
    "W5": "W5_sfx.json",
    "W6": "W6_sprite.json",
}

# 每个工作流允许从网页覆盖的参数 → (节点id, 输入名) 或 [(节点id, 输入名), ...]
PARAM_MAP = {
    "W1": {
        "text": ("2", "text"),
        "negative": ("3", "text"),
        "width": ("4", "width"),
        "height": ("4", "height"),
        "seed": ("5", "seed"),
        "steps": ("5", "steps"),
        "cfg": ("5", "cfg"),
    },
    "W2": {"resolution": ("11", "resolution")},
    "W3": {
        "resolution": ("11", "resolution"),
        "strength": ("12", "strength"),
        "roughness_scale": ("12", "roughness_scale"),
        "metalness": ("12", "metalness"),
    },
    "W4": {"prompt": ("20", "prompt"), "duration": ("20", "duration"), "seed": ("20", "seed")},
    "W5": {"kind": ("22", "kind"), "duration": ("22", "duration"), "seed": ("22", "seed")},
    "W6": {
        "text": ("2", "text"),
        "negative": ("3", "text"),
        "action": ("32", "action"),
        "frames": [("32", "frames"), ("36", "amount")],
        "width": [("35", "width"), ("32", "width")],
        "height": [("35", "height"), ("32", "height")],
        "seed": ("5", "seed"),
        "steps": ("5", "steps"),
        "cfg": ("5", "cfg"),
        "denoise": ("5", "denoise"),
        "strength": ("34", "strength"),
    },
}

WORKFLOW_META = {
    "W1": {
        "title": "W1 · 概念原画",
        "description": "文本设定 → 高清概念图（SDXL）",
        "inputs": ["text", "negative", "width", "height", "seed", "steps", "cfg"],
        "accepts_image": False,
    },
    "W2": {
        "title": "W2 · 深度图",
        "description": "概念图 → 灰度深度图（MiDaS）",
        "inputs": ["resolution"],
        "accepts_image": True,
    },
    "W3": {
        "title": "W3 · 3D 贴图材质",
        "description": "概念图 → 深度 → 法线/高度/粗糙度/金属度",
        "inputs": ["resolution", "strength", "roughness_scale", "metalness"],
        "accepts_image": True,
    },
    "W4": {
        "title": "W4 · 背景音乐",
        "description": "音乐风格文本 → 暗黑氛围电子乐（MusicGen）",
        "inputs": ["prompt", "duration", "seed"],
        "accepts_image": False,
    },
    "W5": {
        "title": "W5 · 环境音效",
        "description": "玻璃杯碰撞 / 含糊交谈 / 酒吧环境音",
        "inputs": ["kind", "duration", "seed"],
        "accepts_image": False,
    },
    "W6": {
        "title": "W6 · 序列帧图集",
        "description": "角色设定图 + 动作指令 → 帧图集 + JSON 配置",
        "inputs": ["text", "negative", "action", "frames", "width", "height", "seed", "steps", "cfg", "denoise", "strength"],
        "accepts_image": True,
    },
}

FRAME_DURATIONS = {"run": 80, "attack": 110, "idle": 160}


# 需要自动中→英翻译的提示词字段
PROMPT_FIELDS = {"W1": ["text", "negative"], "W4": ["prompt"], "W6": ["text", "negative"]}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init_db()
    COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
    yield


app = FastAPI(title="Indie Game Asset Studio", version="0.4.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html")


def _load_template(name: str) -> dict:
    path = WORKFLOWS_DIR / TEMPLATE_FILES.get(name, f"{name}.json")
    if not path.exists():
        raise HTTPException(404, f"工作流 {name} 不存在")
    return json.loads(path.read_text(encoding="utf-8"))


def _apply_params(workflow: dict, name: str, params: dict, job_id: str) -> dict:
    for key, value in params.items():
        targets = PARAM_MAP.get(name, {}).get(key)
        if targets is None:
            continue
        if not isinstance(targets, list):
            targets = [targets]
        for node_id, input_name in targets:
            if node_id in workflow:
                workflow[node_id]["inputs"][input_name] = value
    # 输出文件名带上 job_id，方便定位
    for node in workflow.values():
        if node["class_type"] in ("SaveImage", "SaveAudioAdvanced"):
            node["inputs"]["filename_prefix"] = f"{name}_{job_id}"
    return workflow


def _collect_outputs(history: dict) -> list[dict]:
    outputs = []
    for node_output in (history.get("outputs") or {}).values():
        for image in node_output.get("images", []):
            outputs.append(
                {
                    "filename": image["filename"],
                    "subfolder": image.get("subfolder", ""),
                    "type": image.get("type", "output"),
                    "kind": "image",
                }
            )
        for audio in node_output.get("audio", []):
            outputs.append(
                {
                    "filename": audio["filename"],
                    "subfolder": audio.get("subfolder", ""),
                    "type": audio.get("type", "output"),
                    "kind": "audio",
                }
            )
    return outputs


def _refresh_job(job: dict) -> dict:
    """查询 ComfyUI，把排队/运行中的任务状态同步到本地"""
    if not job or not job.get("prompt_id"):
        return job
    try:
        history = comfy.get_history(job["prompt_id"])
    except Exception:
        return job
    if history is None:
        return job
    status = (history.get("status") or {}).get("status_str")
    if status == "success":
        db.update_job(
            job["id"],
            status="done",
            outputs=json.dumps(_collect_outputs(history), ensure_ascii=False),
        )
    elif status == "error":
        err = "未知错误"
        for msg in (history.get("status") or {}).get("messages", []):
            if msg[0] == "execution_error":
                err = msg[1].get("exception_message", err)
        db.update_job(job["id"], status="error", error=err)
    return db.get_job(job["id"])


@app.get("/api/workflows")
def list_workflows():
    return [{"name": k, **v} for k, v in WORKFLOW_META.items()]


@app.get("/api/files")
def list_files(location: str = "input"):
    """列出服务器上的图片文件（输入目录或输出目录），供前端选择"""
    base = COMFY_INPUT_DIR if location == "input" else PROJECT_ROOT / "ComfyUI" / "output"
    if not base.exists():
        return []
    files = []
    for p in base.iterdir():
        if p.is_file() and p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}:
            st = p.stat()
            files.append({"name": p.name, "size": st.st_size, "mtime": st.st_mtime})
    files.sort(key=lambda f: f["mtime"], reverse=True)
    return files


from pydantic import BaseModel


class TranslateRequest(BaseModel):
    text: str


@app.post("/api/translate")
def translate_text(req: TranslateRequest):
    """中文 → 英文；纯英文原样返回"""
    try:
        return {
            "text": translator.translate(req.text),
            "translated": translator.needs_translation(req.text),
        }
    except Exception as exc:
        raise HTTPException(502, f"翻译失败: {exc}")


@app.post("/api/jobs")
async def create_job(
    workflow: str = Form(...),
    params: str = Form("{}"),
    image: UploadFile | None = File(None),
    image_filename: str = Form(""),
    image_location: str = Form("input"),
):
    if workflow not in WORKFLOW_META:
        raise HTTPException(404, "未知工作流")
    try:
        params = json.loads(params)
    except json.JSONDecodeError:
        raise HTTPException(400, "params 必须是合法 JSON")

    # 提示词字段：中文自动翻译成英文（英文原样保留），失败则用原文
    for field in PROMPT_FIELDS.get(workflow, []):
        if field in params and isinstance(params[field], str):
            try:
                params[field] = translator.translate(params[field])
            except Exception:
                pass

    job_id = db.create_job(workflow, params)
    template = _load_template(workflow)

    # 图片来源一：上传新文件 → 保存到 ComfyUI/input
    if image is not None and image.filename:
        filename = f"{job_id}_{Path(image.filename).name}"
        dest = COMFY_INPUT_DIR / filename
        with dest.open("wb") as f:
            shutil.copyfileobj(image.file, f)
    # 图片来源二：选择服务器已有图片（输出目录的会先复制到输入目录）
    elif image_filename:
        safe = Path(image_filename).name
        if image_location == "output":
            src = PROJECT_ROOT / "ComfyUI" / "output" / safe
            if src.is_file():
                shutil.copy2(src, COMFY_INPUT_DIR / safe)
            else:
                raise HTTPException(400, f"服务器输出目录不存在该图片: {safe}")
        if not (COMFY_INPUT_DIR / safe).is_file():
            raise HTTPException(400, f"服务器输入目录不存在该图片: {safe}")
        filename = safe
    else:
        filename = None

    if filename is not None:
        for node in template.values():
            if node["class_type"] == "LoadImage":
                node["inputs"]["image"] = filename

    workflow_json = _apply_params(template, workflow, params, job_id)
    try:
        prompt_id = comfy.submit(workflow_json)
    except Exception as exc:
        db.update_job(job_id, status="error", error=str(exc))
        raise HTTPException(502, f"提交 ComfyUI 失败: {exc}")
    db.update_job(job_id, status="running", prompt_id=prompt_id)
    return db.get_job(job_id)
@app.get("/api/jobs")
def jobs_list(limit: int = 20):
    return [_refresh_job(j) for j in db.list_jobs(limit)]


@app.get("/api/jobs/{job_id}")
def job_detail(job_id: str):
    job = db.get_job(job_id)
    if job is None:
        raise HTTPException(404, "任务不存在")
    return _refresh_job(job)


@app.get("/api/jobs/{job_id}/outputs")
def job_outputs(job_id: str):
    job = _refresh_job(db.get_job(job_id))
    if job is None:
        raise HTTPException(404, "任务不存在")
    return job.get("outputs", [])


@app.get("/api/jobs/{job_id}/sprite-config")
def sprite_config(job_id: str):
    job = db.get_job(job_id)
    if job is None:
        raise HTTPException(404, "任务不存在")
    if job["workflow"] != "W6":
        raise HTTPException(400, "仅 W6 序列帧任务有图集配置")
    p = job["params"]
    frames = max(1, int(p.get("frames", 8)))
    width = int(p.get("width", 512))
    height = int(p.get("height", 512))
    action = p.get("action", "run")
    columns = min(4, frames)
    rows = ceil(frames / columns)
    return {
        "action": action,
        "frames": frames,
        "frame_width": width,
        "frame_height": height,
        "columns": columns,
        "rows": rows,
        "frame_duration_ms": FRAME_DURATIONS.get(action, 80),
        "files": job.get("outputs", []),
    }


@app.get("/api/jobs/{job_id}/file/{index}")
def job_file(job_id: str, index: int):
    job = db.get_job(job_id)
    if job is None:
        raise HTTPException(404, "任务不存在")
    outputs = job.get("outputs") or []
    if index < 0 or index >= len(outputs):
        raise HTTPException(404, "输出不存在")
    out = outputs[index]
    return RedirectResponse(
        comfy.view_url(out["filename"], out.get("subfolder", ""), out.get("type", "output"))
    )


@app.get("/api/jobs/{job_id}/image")
def job_image(job_id: str):
    job = db.get_job(job_id)
    if job is None:
        raise HTTPException(404, "任务不存在")
    outputs = job.get("outputs") or []
    if not outputs:
        raise HTTPException(404, "任务还没有输出")
    first = outputs[0]
    return RedirectResponse(
        comfy.view_url(first["filename"], first.get("subfolder", ""), first.get("type", "output"))
    )


app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")
