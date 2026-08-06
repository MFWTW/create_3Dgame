"""
独立游戏资产工作室自定义节点（P3）
- W3: PBRFromDepth   深度图 → normal / height / roughness / metalness
- W4: MusicGenNode   文本 → 背景音乐（transformers MusicGen）
- W5: ProceduralSFX  类型 → 环境音效（程序化合成）
"""
import os
from pathlib import Path

import numpy as np
import torch

PROJECT_ROOT = Path(__file__).resolve().parents[2]
MUSICGEN_DIR = Path(
    os.environ.get("MUSICGEN_MODEL_DIR", PROJECT_ROOT / "ComfyUI" / "models" / "musicgen" / "musicgen-small")
)

SR = 44100


# ---------------------------------------------------------------- W3
class PBRFromDepth:
    """由灰度深度图生成 PBR 贴图组：法线 / 高度 / 粗糙度 / 金属度"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "depth_image": ("IMAGE",),
                "strength": ("FLOAT", {"default": 2.0, "min": 0.1, "max": 10.0, "step": 0.1}),
                "roughness_scale": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 4.0, "step": 0.1}),
                "metalness": ("FLOAT", {"default": 0.6, "min": 0.0, "max": 1.0, "step": 0.05}),
            }
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "IMAGE")
    RETURN_NAMES = ("normal", "height", "roughness", "metalness")
    FUNCTION = "run"
    CATEGORY = "indie-studio"

    @staticmethod
    def _to_img(arr: np.ndarray) -> torch.Tensor:
        if arr.ndim == 2:
            arr = np.repeat(arr[..., None], 3, axis=-1)
        return torch.from_numpy(arr.astype(np.float32)).unsqueeze(0).clamp(0.0, 1.0)

    def run(self, depth_image, strength, roughness_scale, metalness):
        depth = depth_image[0, :, :, 0].float().cpu().numpy()
        gy, gx = np.gradient(depth, edge_order=1)
        gx, gy = gx * strength, gy * strength
        normal = np.stack([-gx, -gy, np.ones_like(gx)], axis=-1)
        normal = normal / np.maximum(np.linalg.norm(normal, axis=-1, keepdims=True), 1e-6)
        normal = (normal * 0.5 + 0.5).clip(0, 1)
        height = depth
        edge = np.sqrt(gx ** 2 + gy ** 2)
        roughness = (edge / max(float(edge.max()), 1e-6) * roughness_scale).clip(0, 1)
        metal = np.full_like(depth, metalness)
        return (
            self._to_img(normal),
            self._to_img(height),
            self._to_img(roughness),
            self._to_img(metal),
        )


# ---------------------------------------------------------------- W4
class MusicGenNode:
    """文本提示 → 背景音乐（transformers MusicGen small）"""

    _model = None
    _processor = None

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "dark ambient electronic music, industrial, heavy metal clanking percussion, ominous, slow tempo, underground bar atmosphere",
                    },
                ),
                "duration": ("FLOAT", {"default": 8.0, "min": 2.0, "max": 30.0, "step": 0.5}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 2 ** 31 - 1}),
            }
        }

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "run"
    CATEGORY = "indie-studio"

    @classmethod
    def _load(cls):
        if cls._model is None:
            from transformers import AutoProcessor, MusicgenForConditionalGeneration

            if not (MUSICGEN_DIR / "pytorch_model.bin").exists():
                raise FileNotFoundError(
                    f"MusicGen 模型未找到: {MUSICGEN_DIR}\n"
                    "请执行: bash scripts/download_musicgen.sh（或从 hf-mirror 下载 facebook/musicgen-small）"
                )
            cls._processor = AutoProcessor.from_pretrained(str(MUSICGEN_DIR))
            cls._model = MusicgenForConditionalGeneration.from_pretrained(str(MUSICGEN_DIR))
            device = "cuda" if torch.cuda.is_available() else "cpu"
            cls._model.to(device)
            cls._model.eval()
        return cls._processor, cls._model

    def run(self, prompt, duration, seed):
        processor, model = self._load()
        inputs = processor(text=[prompt], padding=True, return_tensors="pt")
        inputs = {k: v.to(model.device) for k, v in inputs.items()}
        max_new_tokens = max(64, int(duration * 50))  # MusicGen v1 帧率约 50 tokens/s
        torch.manual_seed(seed)
        with torch.no_grad():
            audio = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=True, temperature=1.0)
        waveform = audio.cpu()  # (batch, channels, samples)
        sample_rate = int(model.config.audio_encoder.sampling_rate)
        return ({"waveform": waveform, "sample_rate": sample_rate},)


# ---------------------------------------------------------------- W5
class ProceduralSFX:
    """程序化环境音效：玻璃杯碰撞 / 含糊交谈 / 酒吧环境底噪"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "kind": (["glass_clink", "murmur", "ambient_bar"], {"default": "glass_clink"}),
                "duration": ("FLOAT", {"default": 4.0, "min": 0.5, "max": 60.0, "step": 0.5}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 2 ** 31 - 1}),
            }
        }

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "run"
    CATEGORY = "indie-studio"

    @staticmethod
    def _lowpass(x: np.ndarray, cutoff: float, sr: int = SR) -> np.ndarray:
        from scipy.signal import butter, lfilter

        b, a = butter(2, cutoff / (sr / 2), btype="low")
        return lfilter(b, a, x)

    @staticmethod
    def _bandpass(x: np.ndarray, lo: float, hi: float, sr: int = SR) -> np.ndarray:
        from scipy.signal import butter, lfilter

        b, a = butter(2, [lo / (sr / 2), hi / (sr / 2)], btype="band")
        return lfilter(b, a, x)

    def _glass_clink(self, rng: np.random.Generator, duration: float) -> np.ndarray:
        n = int(duration * SR)
        t = np.arange(n) / SR
        out = np.zeros(n)
        for _ in range(int(rng.integers(3, 9))):
            start = float(rng.uniform(0.0, max(duration - 1.0, 0.1)))
            length = int(rng.uniform(0.25, 0.9) * SR)
            i0, i1 = int(start * SR), min(int(start * SR) + length, n)
            seg = t[i0:i1] - start
            freqs = rng.uniform(2200, 8200, size=10)
            wave = sum(np.sin(2 * np.pi * f * seg + rng.uniform(0, 6.28)) for f in freqs) / 10
            env = np.exp(-seg * rng.uniform(12, 38))
            out[i0:i1] += float(rng.uniform(0.25, 1.0)) * wave * env
        return np.tanh(out * 1.4)

    def _murmur(self, rng: np.random.Generator, duration: float) -> np.ndarray:
        n = int(duration * SR)
        t = np.arange(n) / SR
        noise = self._bandpass(rng.standard_normal(n), 220, 1400)
        # 拟音节包络
        syllable = np.zeros(n)
        pos = 0
        while pos < n:
            on = int(rng.uniform(0.08, 0.35) * SR)
            off = int(rng.uniform(0.05, 0.3) * SR)
            seg = np.minimum(np.arange(on) / max(on, 1), 1.0)
            syllable[pos:min(pos + on, n)] += seg[: max(n - pos, 0)]
            pos += on + off
        out = noise * syllable
        out = self._lowpass(out, 900)
        return np.tanh(out * 1.2)

    def _ambient_bar(self, rng: np.random.Generator, duration: float) -> np.ndarray:
        n = int(duration * SR)
        rumble = self._lowpass(rng.standard_normal(n) * 0.7, 120)
        murmur = self._murmur(rng, duration) * 0.25
        clinks = self._glass_clink(rng, duration) * 0.5
        return np.tanh(rumble + murmur + clinks)

    def run(self, kind, duration, seed):
        rng = np.random.default_rng(seed)
        if kind == "glass_clink":
            mono = self._glass_clink(rng, duration)
        elif kind == "murmur":
            mono = self._murmur(rng, duration)
        else:
            mono = self._ambient_bar(rng, duration)
        waveform = torch.from_numpy(mono[None, None, :]).float()
        return ({"waveform": waveform, "sample_rate": SR},)


NODE_CLASS_MAPPINGS = {
    "PBRFromDepth": PBRFromDepth,
    "MusicGenNode": MusicGenNode,
    "ProceduralSFX": ProceduralSFX,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "PBRFromDepth": "PBR From Depth (IndieStudio)",
    "MusicGenNode": "MusicGen (IndieStudio)",
    "ProceduralSFX": "Procedural SFX (IndieStudio)",
}
