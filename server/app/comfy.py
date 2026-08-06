"""ComfyUI HTTP API 客户端"""
import os
from urllib.parse import quote

import httpx

COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
TIMEOUT = 60.0


def submit(workflow: dict) -> str:
    """提交 API 格式工作流，返回 prompt_id"""
    resp = httpx.post(f"{COMFY_URL}/prompt", json={"prompt": workflow}, timeout=TIMEOUT)
    resp.raise_for_status()
    data = resp.json()
    if "error" in data:
        raise RuntimeError(data["error"].get("message", str(data["error"])))
    return data["prompt_id"]


def get_history(prompt_id: str):
    resp = httpx.get(f"{COMFY_URL}/history/{prompt_id}", timeout=TIMEOUT)
    resp.raise_for_status()
    return resp.json().get(prompt_id)


def view_url(filename: str, subfolder: str = "", type_: str = "output") -> str:
    return f"{COMFY_URL}/view?filename={quote(filename)}&subfolder={quote(subfolder)}&type={type_}"
