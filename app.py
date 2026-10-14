#!/usr/bin/env python3
"""Local Agnes video workbench. The API key stays in .env and never reaches the browser."""

from __future__ import annotations

import base64
import io
import json
import math
import mimetypes
import os
import re
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
OUTPUTS = ROOT / "outputs"
JOBS_PATH = ROOT / "jobs.json"
PROJECTS_PATH = ROOT / "projects.json"
ENV_PATH = ROOT / ".env"
GATEWAYS = {
    "cn-hub": {
        "label": "国内线路",
        "create": "https://apihub.agnes-ai.cn/v1/videos",
        "poll": "https://apihub.agnes-ai.cn/agnesapi",
    },
    "cn-site": {
        "label": "国内站",
        "create": "https://api.agnes-ai.cn/v1/videos",
        "poll": "https://api.agnes-ai.cn/v1/agnesapi",
    },
    "intl": {
        "label": "国际站",
        "create": "https://apihub.agnes-ai.com/v1/videos",
        "poll": "https://apihub.agnes-ai.com/agnesapi",
    },
}
ACTIVE = {"id": "cn-site"}

MODELS = {
    "agnes-video-2.5-flash": {
        "label": "Video 2.5 Flash",
        "sizes": ["720P"],
        "max_images": 5,
        "max_audios": 3,
        "allow_video": False,
    },
    "agnes-video-2.5": {
        "label": "Video 2.5",
        "sizes": ["720P"],
        "max_images": 8,
        "max_audios": 3,
        "allow_video": True,
    },
}
ASPECTS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]
RATES = {
    "agnes-video-2.5-flash": {"720P": 0},
    "agnes-video-2.5": {"720P": 0.025, "1080P": 0.04, "1K": 0.04, "2K": 0.055},
}
IMAGE_MODEL = "agnes-image-2.1-flash"
IMAGE_MODELS = {
    "agnes-image-2.0-flash": "exact",
    "agnes-image-2.1-flash": "tier",
    "agnes-image-2.5-flash": "tier",
}
IMAGE_SIZES = ["1024x1024", "1024x768", "768x1024", "1024x576", "576x1024"]
IMAGE_SIZE_TO_TIER = {
    "1024x1024": ("1K", "1:1"),
    "1024x768": ("1K", "4:3"),
    "768x1024": ("1K", "3:4"),
    "1024x576": ("1K", "16:9"),
    "576x1024": ("1K", "9:16"),
}
IMAGE_EXTRA_BODY = {"response_format": "url"}

LOCK = threading.Lock()


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def api_key() -> str:
    return os.environ.get("AGNES_API_KEY", "").strip()


def mask_key(key: str) -> str:
    if len(key) < 12:
        return "未配置"
    return f"{key[:6]}…{key[-4:]}"


def load_jobs() -> list[dict]:
    if not JOBS_PATH.exists():
        return []
    try:
        data = json.loads(JOBS_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    return data if isinstance(data, list) else []


def save_jobs(jobs: list[dict]) -> None:
    tmp = JOBS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(jobs, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(JOBS_PATH)


def load_projects() -> list[dict]:
    if not PROJECTS_PATH.exists():
        return []
    try:
        data = json.loads(PROJECTS_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    return data if isinstance(data, list) else []


def save_projects(projects: list[dict]) -> None:
    tmp = PROJECTS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(projects, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(PROJECTS_PATH)


QUEUE_LIMIT = 5
# 图片生成并发闸门：最多同时 4 个请求在飞，撞 Agnes RPM 限流时退避重试
IMG_CONCURRENCY = 4
IMG_RETRY = 3
IMG_RETRY_WAIT = 60
IMG_GATE = threading.BoundedSemaphore(IMG_CONCURRENCY)
RATE_LIMIT_HINTS = ("too many", "rate", "rpm", "速率", "频率", "队列已满", "请求频率", "限流")
DONE = {"completed", "failed"}
RUNNING = {"submitting", "queued", "in_progress"}
SOURCES = {"bench", "canvas"}


def job_source(job: dict) -> str:
    source = str(job.get("source") or "bench").strip().lower()
    return source if source in SOURCES else "bench"


def normalize_source(value: object) -> str:
    source = str(value or "bench").strip().lower()
    return source if source in SOURCES else "bench"


def jobs_for(jobs: list[dict], source: str | None = None) -> list[dict]:
    if not source:
        return list(jobs)
    wanted = normalize_source(source)
    return [job for job in jobs if job_source(job) == wanted]


def public_job(job: dict, place: int | None = None) -> dict:
    hidden = {"downloading", "payload", "next_try_at"}
    data = {k: v for k, v in job.items() if k not in hidden}
    data["source"] = job_source(job)
    if place is not None:
        data["place"] = place
    return data


def is_running(job: dict) -> bool:
    if job.get("status") in DONE:
        return False
    return job.get("status") in RUNNING or bool(job.get("video_id"))


def ordered_queue(jobs: list[dict], source: str | None = None) -> list[dict]:
    scoped = jobs_for(jobs, source)
    running = [job for job in scoped if is_running(job)]
    waiting = [job for job in scoped if job.get("status") == "waiting"]
    running.sort(key=lambda job: job.get("created_at") or 0)
    waiting.sort(key=lambda job: job.get("created_at") or 0)
    return running + waiting


def queue_view(jobs: list[dict], source: str | None = None) -> list[dict]:
    view = []
    for index, job in enumerate(ordered_queue(jobs, source), start=1):
        view.append(
            {
                "id": job["id"],
                "prompt": job.get("prompt") or "",
                "status": job.get("status"),
                "progress": job.get("progress") or 0,
                "place": index,
                "notice": job.get("notice"),
                "source": job_source(job),
            }
        )
    return view


def placed_jobs(jobs: list[dict], source: str | None = None) -> list[dict]:
    scoped = jobs_for(jobs, source)
    places = {item["id"]: item["place"] for item in queue_view(jobs, source)}
    return [public_job(job, places.get(job["id"])) for job in scoped]


def active_count(jobs: list[dict], source: str | None = None) -> int:
    return sum(1 for job in jobs_for(jobs, source) if job.get("status") not in DONE)


def queue_full_message(view: list[dict]) -> str:
    lines = [f"队列最多 {QUEUE_LIMIT} 个任务，请等其中一个完成后再提交。当前队列："]
    for item in view:
        state = "执行中" if item["status"] != "waiting" else "等待中"
        prompt = " ".join((item["prompt"] or "").split())[:36]
        lines.append(f"{item['place']}. {state} {prompt}")
    return "\n".join(lines)


def update_job(job_id: str, **fields) -> None:
    jobs = load_jobs()
    for job in jobs:
        if job["id"] == job_id:
            job.update(fields)
            break
    save_jobs(jobs)


def pump_queue() -> None:
    starters = []
    with LOCK:
        jobs = load_jobs()
        sources = []
        for job in jobs:
            source = job_source(job)
            if source not in sources:
                sources.append(source)
        for source in sources:
            scoped = [job for job in jobs if job_source(job) == source]
            if any(is_running(job) for job in scoped):
                continue
            waiting = [job for job in scoped if job.get("status") == "waiting"]
            if not waiting:
                continue
            waiting.sort(key=lambda job: job.get("created_at") or 0)
            nxt = waiting[0]
            if float(nxt.get("next_try_at") or 0) > time.time():
                continue
            nxt["status"] = "submitting"
            nxt.pop("notice", None)
            starters.append(nxt["id"])
        if starters:
            save_jobs(jobs)
    for job_id in starters:
        _submit_queued_job(job_id)


def _submit_queued_job(job_id: str) -> None:
    with LOCK:
        jobs = load_jobs()
        nxt = next((job for job in jobs if job["id"] == job_id), None)
        if not nxt or nxt.get("status") != "submitting":
            return
        payload = nxt.get("payload")
        gateway_id = nxt.get("gateway")
    if not payload:
        with LOCK:
            update_job(job_id, status="failed", error="队列任务缺少提交内容")
        return
    _, gateway = gateway_by_id(gateway_id)
    try:
        status, data = agnes_json("POST", gateway["create"], payload)
    except RuntimeError as error:
        with LOCK:
            update_job(
                job_id,
                status="waiting",
                notice=str(error),
                next_try_at=time.time() + 10,
            )
        return
    if status >= 400:
        message = error_message(data, status)
        code = str(data.get("code") or "")
        if isinstance(data.get("error"), dict):
            code = str(data["error"].get("code") or code)
        rpm = status == 429 or "队列已满" in message or "RPM" in message or "请求频率" in message
        with LOCK:
            if rpm:
                update_job(
                    job_id,
                    status="waiting",
                    notice=message.split("\n", 1)[0],
                    next_try_at=time.time() + 65,
                )
            else:
                update_job(job_id, status="failed", error=message, notice=None)
        return
    video_id = data.get("video_id") or data.get("id")
    with LOCK:
        if not video_id:
            update_job(job_id, status="failed", error="Agnes 没有返回 video_id")
            return
        update_job(
            job_id,
            video_id=video_id,
            task_id=data.get("task_id") or data.get("id"),
            status=str(data.get("status") or "queued"),
            progress=int(data.get("progress") or 0),
            notice=None,
            next_try_at=None,
        )


def kick_queue() -> None:
    threading.Thread(target=pump_queue, daemon=True).start()


def queue_worker() -> None:
    while True:
        time.sleep(5)
        try:
            pump_queue()
        except Exception as error:
            print(f"队列调度失败：{error}", flush=True)


def recover_submitting() -> None:
    with LOCK:
        jobs = load_jobs()
        changed = False
        for job in jobs:
            if job.get("status") == "submitting":
                job["status"] = "waiting"
                job["notice"] = "提交被中断，已回到队列"
                changed = True
        if changed:
            save_jobs(jobs)


def slug(text: str, limit: int = 24) -> str:
    cleaned = re.sub(r"[^\w\u4e00-\u9fff]+", "-", text, flags=re.UNICODE).strip("-")
    return (cleaned[:limit] or "video").strip("-")


def is_http_url(value: str) -> bool:
    parsed = urllib.parse.urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


IMAGE_MIN_SIDE = 256
IMAGE_MAX_SIDE = 5760
# 接口要求宽高比在 0.4–2.5。留出一点余量，避免取整后贴边被拒。
IMAGE_MIN_RATIO = 0.41
IMAGE_MAX_RATIO = 2.49


def _contain(image, box_w: int, box_h: int):
    from PIL import Image

    width, height = image.size
    scale = min(box_w / width, box_h / height)
    new_w = max(1, min(box_w, round(width * scale)))
    new_h = max(1, min(box_h, round(height * scale)))
    if (new_w, new_h) == (width, height):
        return image
    return image.resize((new_w, new_h), Image.Resampling.LANCZOS)


def _center_on(image, canvas_w: int, canvas_h: int):
    from PIL import Image

    if image.mode in {"RGBA", "LA"} or (image.mode == "P" and "transparency" in image.info):
        image = image.convert("RGBA")
        canvas = Image.new("RGBA", (canvas_w, canvas_h), (255, 255, 255, 255))
        canvas.paste(image, ((canvas_w - image.width) // 2, (canvas_h - image.height) // 2), image)
        return canvas
    if image.mode != "RGB":
        image = image.convert("RGB")
    canvas = Image.new("RGB", (canvas_w, canvas_h), (255, 255, 255))
    canvas.paste(image, ((canvas_w - image.width) // 2, (canvas_h - image.height) // 2))
    return canvas


def _encode_image(image) -> str:
    buf = io.BytesIO()
    if image.mode in {"RGBA", "LA"}:
        image.save(buf, format="PNG")
    else:
        if image.mode != "RGB":
            image = image.convert("RGB")
        image.save(buf, format="JPEG", quality=92)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def fit_image_sides(raw_b64: str) -> str:
    """参考图边长收进 256–5760，宽高比收进 0.4–2.5。只等比缩放和补边，不拉伸。"""
    from PIL import Image

    try:
        image = Image.open(io.BytesIO(base64.b64decode(raw_b64)))
        image.load()
    except Exception as error:
        raise ValueError("参考图片无法读取，请重新选择") from error
    src_w, src_h = image.size
    width, height = src_w, src_h
    scale = 1.0
    short = min(width, height)
    long = max(width, height)
    if short < IMAGE_MIN_SIDE:
        scale = IMAGE_MIN_SIDE / short
    if long * scale > IMAGE_MAX_SIDE:
        scale = IMAGE_MAX_SIDE / long
    new_w = min(IMAGE_MAX_SIDE, max(1, round(width * scale)))
    new_h = min(IMAGE_MAX_SIDE, max(1, round(height * scale)))
    if (new_w, new_h) != (width, height):
        image = image.resize((new_w, new_h), Image.Resampling.LANCZOS)
    width, height = image.size
    canvas_w, canvas_h = width, height
    ratio = width / height
    if ratio > IMAGE_MAX_RATIO:
        canvas_h = min(IMAGE_MAX_SIDE, max(height, math.ceil(width / IMAGE_MAX_RATIO)))
        if width / canvas_h > IMAGE_MAX_RATIO:
            canvas_h = IMAGE_MAX_SIDE
            canvas_w = max(IMAGE_MIN_SIDE, math.floor(canvas_h * IMAGE_MAX_RATIO))
            image = _contain(image, canvas_w, canvas_h)
    elif ratio < IMAGE_MIN_RATIO:
        canvas_w = min(IMAGE_MAX_SIDE, max(width, math.ceil(height * IMAGE_MIN_RATIO)))
        if canvas_w / height < IMAGE_MIN_RATIO:
            canvas_w = IMAGE_MAX_SIDE
            canvas_h = max(IMAGE_MIN_SIDE, math.floor(canvas_w / IMAGE_MIN_RATIO))
            image = _contain(image, canvas_w, canvas_h)
    width, height = image.size
    canvas_w = min(IMAGE_MAX_SIDE, max(canvas_w, width, IMAGE_MIN_SIDE))
    canvas_h = min(IMAGE_MAX_SIDE, max(canvas_h, height, IMAGE_MIN_SIDE))
    if canvas_w / canvas_h > IMAGE_MAX_RATIO:
        canvas_h = min(IMAGE_MAX_SIDE, math.ceil(canvas_w / IMAGE_MAX_RATIO))
    if canvas_h and canvas_w / canvas_h < IMAGE_MIN_RATIO:
        canvas_w = min(IMAGE_MAX_SIDE, math.ceil(canvas_h * IMAGE_MIN_RATIO))
    if (canvas_w, canvas_h) == (src_w, src_h) and image.size == (src_w, src_h):
        return raw_b64
    if image.size != (canvas_w, canvas_h):
        image = _center_on(image, canvas_w, canvas_h)
    fitted = image.size
    if not (IMAGE_MIN_SIDE <= fitted[0] <= IMAGE_MAX_SIDE and IMAGE_MIN_SIDE <= fitted[1] <= IMAGE_MAX_SIDE):
        raise ValueError("参考图无法收进 256–5760 像素")
    if not (IMAGE_MIN_RATIO <= fitted[0] / fitted[1] <= IMAGE_MAX_RATIO):
        raise ValueError("参考图无法收进宽高比 0.4–2.5")
    return _encode_image(image)


def as_image_data_uri(raw: str) -> str:
    """JPEG 的 base64 以 /9j/ 开头，Agnes 会把它当成本地路径。提交时改成 data URI。"""
    if raw.startswith("data:image/") and ";base64," in raw:
        return raw
    if raw.startswith("iVBORw0KGgo"):
        mime = "image/png"
    elif raw.startswith("R0lGOD"):
        mime = "image/gif"
    elif raw.startswith("UklGR"):
        mime = "image/webp"
    else:
        mime = "image/jpeg"
    return f"data:{mime};base64,{raw}"


def clean_images(values, limit: int) -> list[str]:
    if values is None:
        return []
    if not isinstance(values, list):
        raise ValueError("参考图片需要从本机上传")
    images = []
    for item in values:
        if not isinstance(item, str):
            raise ValueError("参考图片格式无效")
        item = "".join(item.split())
        if not item:
            continue
        if item.startswith(("http://", "https://")):
            raise ValueError("参考图仅支持本地上传")
        if item.startswith("data:image/"):
            _, _, item = item.partition(",")
        if len(item) < 32 or not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", item):
            raise ValueError("参考图片格式无效，请重新选择本地图片")
        if len(item) > 20_000_000:
            raise ValueError("单张参考图请小于 15MB")
        images.append(as_image_data_uri(fit_image_sides(item)))
    if len(images) > limit:
        raise ValueError(f"参考图片最多 {limit} 张")
    return images


def clean_urls(values, limit: int, label: str) -> list[str]:
    if values is None:
        return []
    if not isinstance(values, list):
        raise ValueError(f"{label}需要是链接列表")
    urls = []
    for item in values:
        if not isinstance(item, str):
            raise ValueError(f"{label}里有无效条目")
        item = item.strip()
        if not item:
            continue
        if not is_http_url(item):
            raise ValueError(f"{label}必须是 http 或 https 链接")
        urls.append(item)
    if len(urls) > limit:
        raise ValueError(f"{label}最多 {limit} 个")
    return urls


def build_payload(body: dict) -> dict:
    model = body.get("model")
    if model not in MODELS:
        raise ValueError("请选择 Video 2.5 或 Video 2.5 Flash")
    spec = MODELS[model]
    mode = body.get("mode")
    if mode not in {"text", "keyframe", "reference"}:
        raise ValueError("生成模式无效")
    prompt = str(body.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("请先写提示词")
    if len(prompt) > 4000:
        raise ValueError("提示词请控制在 4000 字以内")

    try:
        seconds = int(body.get("seconds"))
    except (TypeError, ValueError):
        raise ValueError("时长需要是 4 到 12 秒")
    if seconds < 4 or seconds > 12:
        raise ValueError("时长需要是 4 到 12 秒")

    size = str(body.get("size") or "720P")
    if size not in spec["sizes"]:
        raise ValueError(f"{spec['label']}不支持分辨率 {size}")

    aspect = str(body.get("aspect_ratio") or "16:9")
    if size == "1K":
        aspect = "1:1"
    elif aspect not in ASPECTS:
        raise ValueError("画幅不在支持列表里")

    payload = {
        "model": model,
        "prompt": prompt,
        "mode": mode,
        "seconds": str(seconds),
        "size": size,
        "aspect_ratio": aspect,
    }

    seed = body.get("seed")
    if seed not in (None, ""):
        try:
            payload["seed"] = int(seed)
        except (TypeError, ValueError):
            raise ValueError("随机种子需要是整数")

    if mode == "text":
        return payload

    if mode == "keyframe":
        first = str(body.get("first_frame") or "").strip()
        last = str(body.get("last_frame") or "").strip()
        if first and not is_http_url(first):
            raise ValueError("首帧必须是 http 或 https 图片链接")
        if last and not is_http_url(last):
            raise ValueError("尾帧必须是 http 或 https 图片链接")
        if not first and not last:
            raise ValueError("首帧和尾帧至少填一个图片链接")
        if first:
            payload["first_frame"] = first
        if last:
            payload["last_frame"] = last
        return payload

    images = clean_images(body.get("images"), spec["max_images"])
    audios = clean_urls(body.get("audios"), spec["max_audios"], "参考音频")
    videos = []
    if spec["allow_video"]:
        raw_videos = body.get("videos") or []
        if raw_videos and not isinstance(raw_videos, list):
            raise ValueError("参考视频格式无效")
        if len(raw_videos) > 1:
            raise ValueError("参考视频最多 1 个")
        for item in raw_videos:
            if not isinstance(item, dict):
                raise ValueError("参考视频格式无效")
            url = str(item.get("url") or "").strip()
            if not url:
                continue
            if not is_http_url(url):
                raise ValueError("参考视频必须是 http 或 https 链接")
            entry = {"url": url, "require_audio": bool(item.get("require_audio"))}
            start = item.get("start_seconds")
            if start not in (None, ""):
                try:
                    start_value = float(start)
                except (TypeError, ValueError):
                    raise ValueError("参考视频起始秒数无效")
                if start_value < 0:
                    raise ValueError("参考视频起始秒数不能小于 0")
                entry["start_seconds"] = start_value
            videos.append(entry)
    elif body.get("videos"):
        raise ValueError("Flash 不支持参考视频，请改用 Video 2.5")

    if not images and not audios and not videos:
        raise ValueError("参考模式至少需要一张图片、一段音频或一个视频链接")
    if len(images) + len(audios) + len(videos) > 12:
        raise ValueError("单次参考素材不能超过 12 个")
    if images:
        payload["images"] = images
    if audios:
        payload["audios"] = audios
    if videos:
        payload["videos"] = videos
    return payload


def clean_image_refs(value: object) -> list[str]:
    if value in (None, ""):
        return []
    if not isinstance(value, list):
        raise ValueError("参考图格式无效")
    if not value:
        raise ValueError("图生图需要至少一张参考图")
    if len(value) > 5:
        raise ValueError("参考图最多 5 张")
    refs = []
    for item in value:
        if not isinstance(item, str):
            raise ValueError("参考图格式无效")
        ref = "".join(item.split())
        if not ref:
            continue
        if ref.startswith("data:image/") and ";base64," in ref:
            refs.append(ref)
            continue
        if is_http_url(ref):
            refs.append(ref)
            continue
        raise ValueError("参考图必须是 base64 图片或 http 链接")
    if not refs:
        raise ValueError("图生图需要至少一张参考图")
    return refs


def build_image_payload(body: dict) -> dict:
    model = str(body.get("model") or IMAGE_MODEL)
    if model not in IMAGE_MODELS:
        raise ValueError("图片模型仅支持 Agnes Image 2.0/2.1/2.5 Flash")
    prompt = str(body.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("请先写提示词")
    if len(prompt) > 4000:
        raise ValueError("提示词请控制在 4000 字以内")
    size = str(body.get("size") or "1024x1024")
    if size not in IMAGE_SIZES:
        raise ValueError("图片尺寸仅支持 1:1/4:3/3:4/16:9/9:16 五档")

    payload = {
        "model": model,
        "prompt": prompt,
        "extra_body": dict(IMAGE_EXTRA_BODY),
    }
    if IMAGE_MODELS[model] == "tier":
        tier, ratio = IMAGE_SIZE_TO_TIER[size]
        payload["size"] = tier
        payload["ratio"] = ratio
    else:
        payload["size"] = size
    mode = str(body.get("mode") or "text")
    if mode == "reference":
        refs = clean_image_refs(body.get("images"))
        payload["extra_body"]["image"] = refs
    elif mode != "text":
        raise ValueError("生成模式无效")
    return payload


def agnes_json(method: str, url: str, payload: dict | None = None, timeout: int = 60):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Authorization", f"Bearer {api_key()}")
    request.add_header("Content-Type", "application/json")
    request.add_header("User-Agent", "AgnesWorkbench/1.0")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, decode_body(response.read())
    except urllib.error.HTTPError as error:
        return error.code, decode_body(error.read())
    except urllib.error.URLError as error:
        raise RuntimeError(f"连不上 Agnes：{error.reason}") from error


def decode_body(raw: bytes) -> dict:
    if not raw:
        return {}
    text = raw.decode("utf-8", errors="replace")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return {"detail": text[:800]}
    return parsed if isinstance(parsed, dict) else {"detail": parsed}


def error_message(data: dict, status: int) -> str:
    raw = ""
    code = ""
    error = data.get("error")
    if isinstance(error, dict):
        raw = str(error.get("message") or error)
        code = str(error.get("code") or "")
    elif isinstance(error, str) and error:
        raw = error
    elif data.get("detail"):
        raw = str(data["detail"])
    elif data.get("message"):
        raw = str(data["message"])
        code = str(data.get("code") or "")
    else:
        raw = f"Agnes 返回 HTTP {status}"
    if not code:
        code = str(data.get("code") or "")
    return friendly_agnes_error(raw, status, code)


def is_rate_limited(status: int, data: dict) -> bool:
    if status == 429:
        return True
    text = (error_message(data, status) or "").lower()
    return any(hint in text for hint in RATE_LIMIT_HINTS)


def friendly_agnes_error(message: str, status: int, code: str = "") -> str:
    text = (message or "").strip()
    lowered = text.lower()
    code = (code or "").lower()
    if status == 429 or "too many" in lowered or "rate" in lowered:
        return (
            f"{text}\n"
            "这是请求频率限制（RPM），不是余额。免费视频模型大约每分钟 1 次，"
            "请隔约 1 分钟再试；工作台会自动放慢重试。"
        ).strip()
    if (
        status in {402, 403}
        or code == "insufficient_user_quota"
        or "额度不足" in text
        or "insufficient" in lowered and "quota" in lowered
    ):
        return (
            f"{text}\n"
            "这是模型侧人民币配额不足（insufficient_user_quota），不是 RPM。"
            "页面上的「余额不限」指美元订阅额度；Video 2.5 / 参考图走标准模型，"
            "当前账号该模型剩余约 ￥0。纯文生可用 Flash；带参考图需在 Agnes 控制台给标准视频模型充值或开通配额。"
        ).strip()
    if status == 403:
        return f"{text}\n权限被拒绝（403）。请确认密钥属于已开通视频能力的账号。"
    return text


def result_url(data: dict) -> str | None:
    url = data.get("url")
    if isinstance(url, str) and url.startswith("http"):
        return url
    metadata = data.get("metadata")
    if isinstance(metadata, dict):
        nested = metadata.get("url")
        if isinstance(nested, str) and nested.startswith("http"):
            return nested
    return None


def download_video(job_id: str, url: str, prompt: str) -> None:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dest = OUTPUTS / f"{stamp}_{slug(prompt)}.mp4"
    part = dest.with_suffix(".mp4.part")
    try:
        request = urllib.request.Request(url)
        request.add_header("User-Agent", "AgnesWorkbench/1.0")
        with urllib.request.urlopen(request, timeout=180) as response, part.open("wb") as handle:
            while True:
                chunk = response.read(256 * 1024)
                if not chunk:
                    break
                handle.write(chunk)
        part.replace(dest)
        with LOCK:
            jobs = load_jobs()
            for job in jobs:
                if job["id"] == job_id:
                    job["local_file"] = dest.name
                    job["downloading"] = False
                    job.pop("download_error", None)
                    break
            save_jobs(jobs)
    except Exception as error:
        part.unlink(missing_ok=True)
        with LOCK:
            jobs = load_jobs()
            for job in jobs:
                if job["id"] == job_id:
                    job["downloading"] = False
                    job["download_error"] = str(error)
                    break
            save_jobs(jobs)


def schedule_download(job: dict) -> None:
    if job.get("local_file") or job.get("downloading") or not job.get("url"):
        return
    job["downloading"] = True
    threading.Thread(
        target=download_video,
        args=(job["id"], job["url"], job.get("prompt") or "video"),
        daemon=True,
    ).start()


def gateway_by_id(gateway_id: str | None) -> tuple[str, dict]:
    if gateway_id in GATEWAYS:
        return gateway_id, GATEWAYS[gateway_id]
    current = ACTIVE["id"] if ACTIVE["id"] in GATEWAYS else "cn-hub"
    return current, GATEWAYS[current]


def refresh_job(job: dict) -> dict:
    if job.get("status") in {"completed", "failed"} or not job.get("video_id"):
        return job
    _, gateway = gateway_by_id(job.get("gateway"))
    status, data = agnes_json(
        "GET",
        gateway["poll"]
        + "?"
        + urllib.parse.urlencode(
            {"video_id": job["video_id"], "model_name": job["model"]}
        ),
        timeout=30,
    )
    if status == 429:
        job["poll_error"] = "查询过于频繁（RPM），约 1 分钟后再查"
        return job
    if status >= 400:
        job["poll_error"] = error_message(data, status)
        fresh = time.time() - int(job.get("created_at") or 0) < 30
        if status == 400 or (status == 404 and not fresh):
            job["status"] = "failed"
            job["error"] = job["poll_error"]
        return job
    job.pop("poll_error", None)
    job["status"] = str(data.get("status") or job.get("status") or "queued")
    if isinstance(data.get("progress"), int):
        job["progress"] = data["progress"]
    url = result_url(data)
    if url:
        job["url"] = url
    if job["status"] == "failed":
        job["error"] = error_message(data, status)
    return job


def money(value: float) -> str:
    if abs(value) < 0.01 and value != 0:
        return f"${value:.4f}"
    return f"${value:,.2f}"


def fetch_balance() -> dict:
    _, gateway = gateway_by_id(ACTIVE["id"])
    origin = gateway["create"].rsplit("/v1/", 1)[0]
    sub_status, subscription = agnes_json(
        "GET", f"{origin}/v1/dashboard/billing/subscription", timeout=20
    )
    if sub_status != 200 or not isinstance(subscription.get("hard_limit_usd"), (int, float)):
        return {"ok": False, "message": "余额暂时查不到"}
    use_status, usage = agnes_json("GET", f"{origin}/v1/dashboard/billing/usage", timeout=20)
    used = 0.0
    if use_status == 200 and isinstance(usage.get("total_usage"), (int, float)):
        used = float(usage["total_usage"]) / 100
    total = float(subscription["hard_limit_usd"])
    if total >= 100_000_000:
        return {
            "ok": True,
            "unlimited": True,
            "used": used,
            "used_label": money(used),
            "label": f"余额不限 · 已用 {money(used)}（美元订阅；不含视频人民币配额）",
        }
    remaining = total - used
    return {
        "ok": True,
        "unlimited": False,
        "remaining": remaining,
        "used": used,
        "total": total,
        "used_label": money(used),
        "remaining_label": money(remaining),
        "total_label": money(total),
        "label": f"余额 {money(remaining)} · 已用 {money(used)}",
    }


def probe_key() -> dict:
    key = api_key()
    if not key:
        return {"ok": False, "message": "还没有配置密钥", "checks": []}
    checks = []
    chosen = None
    for gateway_id, gateway in GATEWAYS.items():
        try:
            status, data = agnes_json("POST", gateway["create"], {}, timeout=20)
            # An empty body must be rejected before a task is created. 400/422 means the key was accepted.
            ok = status in {400, 422}
            message = "密钥可用" if ok else error_message(data, status)
        except RuntimeError as error:
            status, ok, message = 0, False, str(error)
        checks.append(
            {
                "id": gateway_id,
                "label": gateway["label"],
                "ok": ok,
                "status": status,
                "message": message,
            }
        )
        if ok and chosen is None:
            chosen = gateway_id
    if chosen:
        ACTIVE["id"] = chosen
        label = GATEWAYS[chosen]["label"]
        return {
            "ok": True,
            "masked": mask_key(key),
            "gateway": chosen,
            "label": label,
            "message": f"{label}可用",
            "checks": checks,
        }
    return {
        "ok": False,
        "masked": mask_key(key),
        "message": "这把密钥在国内线路、国内站和国际站都没有通过",
        "checks": checks,
    }


# ===== 工具模块（去水印 / 超分）已移除 =====
# 原 TOOL_ROOT_VIDEO2X / VIDEO_TOOLS_* / VIDEO2X_* / TOOL_JOBS / UPLOADED
# find_ffmpeg / parse_multipart_body / build_mask / process_video
# run_watermark_job / run_upscale_job / video_tools_status / tools_status
# resolve_video_files / ensure_video_tools_dirs 全部清掉
# video_tools/ 目录、video-tools.js、HTML vtool 卡片一并删除



class Handler(BaseHTTPRequestHandler):
    server_version = "AgnesWorkbench/1.0"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        if path == "/api/images/download":
            self.proxy_image_download()
            return
        if path == "/api/health":
            self.send_json({"ok": bool(api_key()), "masked": mask_key(api_key()), "models": MODELS, "rates": RATES})
            return
        if path == "/api/balance":
            try:
                self.send_json(fetch_balance())
            except RuntimeError as error:
                self.send_json({"ok": False, "message": str(error)}, 502)
            return
        if path == "/api/probe":
            try:
                self.send_json(probe_key())
            except RuntimeError as error:
                self.send_json({"ok": False, "masked": mask_key(api_key()), "message": str(error)}, 502)
            return
        if path == "/api/jobs":
            query = urllib.parse.parse_qs(parsed.query)
            source = normalize_source((query.get("source") or ["bench"])[0])
            with LOCK:
                jobs = load_jobs()
                payload = {
                    "jobs": placed_jobs(jobs, source),
                    "queue": queue_view(jobs, source),
                    "limit": QUEUE_LIMIT,
                    "source": source,
                }
            self.send_json(payload)
            return
        if path == "/api/projects":
            with LOCK:
                projects = load_projects()
            self.send_json({"projects": projects})
            return
        if path.startswith("/api/projects/"):
            project_id = path[len("/api/projects/") :]
            with LOCK:
                projects = load_projects()
            project = next((item for item in projects if item.get("id") == project_id), None)
            if project is None:
                self.send_json({"error": "找不到这个作品"}, 404)
                return
            self.send_json(project)
            return
        if path.startswith("/api/jobs/"):
            self.handle_job_get(path)
            return
        self.serve_static(path)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/videos":
            self.create_video()
            return
        if parsed.path == "/api/images":
            self.create_image()
            return
        if parsed.path == "/api/projects":
            self.save_project_post()
            return
        if parsed.path == "/api/projects/images":
            self.save_project_image_post()
            return
        if parsed.path == "/api/reveal":
            self.reveal()
            return
        self.send_json({"error": "未知接口"}, 404)

    def do_DELETE(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/projects/"):
            project_id = parsed.path[len("/api/projects/") :]
            with LOCK:
                projects = load_projects()
                kept = [item for item in projects if item.get("id") != project_id]
                changed = len(kept) != len(projects)
                if changed:
                    save_projects(kept)
            if not changed:
                self.send_json({"error": "找不到这个作品"}, 404)
                return
            self.send_json({"ok": True})
            return
        prefix = "/api/jobs/"
        if not parsed.path.startswith(prefix):
            self.send_json({"error": "未知接口"}, 404)
            return
        job_id = parsed.path[len(prefix) :]
        removed = None
        with LOCK:
            jobs = load_jobs()
            kept = []
            for job in jobs:
                if job["id"] == job_id:
                    removed = job
                else:
                    kept.append(job)
        if removed:
            save_jobs(kept)
        if removed and removed.get("status") not in DONE:
            kick_queue()
        if not removed:
            self.send_json({"error": "找不到这条记录"}, 404)
            return
        local_file = removed.get("local_file")
        if local_file:
            (OUTPUTS / Path(local_file).name).unlink(missing_ok=True)
        self.send_json({"ok": True})

    # ---- 视频处理工具接口（去水印 / 超分） ----
    def create_video(self) -> None:
        if not api_key():
            self.send_json({"error": "请先在 .env 里填写 AGNES_API_KEY"}, 400)
            return
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            self.send_json({"error": "请求无效"}, 400)
            return
        if length > 60_000_000:
            self.send_json({"error": "请求过大"}, 400)
            return
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            payload = build_payload(body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json({"error": "请求不是有效的 JSON"}, 400)
            return
        except ValueError as error:
            self.send_json({"error": str(error)}, 400)
            return

        gateway_id, _gateway = gateway_by_id(body.get("gateway") or ACTIVE["id"])
        source = normalize_source(body.get("source"))
        job = {
            "id": uuid.uuid4().hex[:12],
            "video_id": None,
            "task_id": None,
            "gateway": gateway_id,
            "source": source,
            "payload": payload,
            "model": payload["model"],
            "mode": payload["mode"],
            "prompt": payload["prompt"],
            "seconds": payload["seconds"],
            "size": payload["size"],
            "aspect_ratio": payload["aspect_ratio"],
            "status": "waiting",
            "progress": 0,
            "url": None,
            "local_file": None,
            "error": None,
            "notice": None,
            "created_at": int(time.time()),
        }
        with LOCK:
            jobs = load_jobs()
            view = queue_view(jobs, source)
            if active_count(jobs, source) >= QUEUE_LIMIT:
                self.send_json({"error": queue_full_message(view), "queue": view}, 409)
                return
            running = [item for item in view if item["status"] != "waiting"]
            if running:
                names = "、".join(
                    f"第{item['place']}条" for item in running[:3]
                )
                job["notice"] = f"前面有任务正在执行（{names}），这条已排在后面"
            jobs.insert(0, job)
            save_jobs(jobs)
            snapshot = placed_jobs(jobs, source)
            queued = queue_view(jobs, source)
        kick_queue()
        self.send_json({"job": next(item for item in snapshot if item["id"] == job["id"]), "queue": queued})

    def create_image(self) -> None:
        if not api_key():
            self.send_json({"error": "请先在 .env 里填写 AGNES_API_KEY"}, 400)
            return
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            self.send_json({"error": "请求无效"}, 400)
            return
        if length > 60_000_000:
            self.send_json({"error": "请求过大"}, 400)
            return
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            payload = build_image_payload(body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json({"error": "请求不是有效的 JSON"}, 400)
            return
        except ValueError as error:
            self.send_json({"error": str(error)}, 400)
            return

        gateway_id, _gateway = gateway_by_id(body.get("gateway") or ACTIVE["id"])
        origin = GATEWAYS[gateway_id]["create"].rsplit("/v1/", 1)[0]
        url = f"{origin}/v1/images/generations"
        # 并发闸门：最多 IMG_CONCURRENCY 个图片请求同时打向 Agnes；
        # 命中 RPM 限流时自动退避 IMG_RETRY_WAIT 秒重试，最多 IMG_RETRY 次
        with IMG_GATE:
            status, data = self._request_image_with_retry(url, payload)
        if status < 200 or status >= 300:
            self.send_json({"error": error_message(data, status)}, 502)
            return
        result = data.get("data") or []
        image_url = result[0].get("url") if result and isinstance(result[0], dict) else None
        if not image_url:
            self.send_json({"error": "Agnes 没有返回图片地址，请稍后重试"}, 502)
            return
        self.send_json({"url": image_url, "model": payload["model"], "gateway": gateway_id})

    def _request_image_with_retry(self, url: str, payload: dict) -> tuple[int, dict]:
        attempts = 0
        while True:
            attempts += 1
            try:
                status, data = agnes_json("POST", url, payload, timeout=300)
            except RuntimeError as error:
                return 502, {"error": str(error)}
            if 200 <= status < 300:
                return status, data
            if is_rate_limited(status, data) and attempts <= IMG_RETRY:
                time.sleep(IMG_RETRY_WAIT)
                continue
            return status, data

    def proxy_image_download(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        image_url = (query.get("url") or [""])[0].strip()
        if not image_url.startswith(("http://", "https://")):
            self.send_json({"error": "下载地址无效"}, 400)
            return
        request = urllib.request.Request(image_url, method="GET")
        request.add_header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            self.send_json({"error": f"图片服务返回 {error.code}"}, 502)
            return
        except urllib.error.URLError as error:
            self.send_json({"error": f"图片下载失败：{error.reason}"}, 502)
            return
        if len(raw) > 30_000_000:
            self.send_json({"error": "图片过大"}, 502)
            return
        content_type = response.headers.get("Content-Type") or "image/png"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "public, max-age=3600")
        self.end_headers()
        self.wfile.write(raw)

    def handle_job_get(self, path: str) -> None:
        prefix = "/api/jobs/"
        rest = path[len(prefix) :]
        if rest.endswith("/file"):
            job_id = rest[: -len("/file")]
            self.serve_job_file(job_id)
            return
        job_id = rest
        with LOCK:
            job = next((item for item in load_jobs() if item["id"] == job_id), None)
            if not job:
                self.send_json({"error": "找不到这条记录"}, 404)
                return
            working = dict(job)
        if working.get("status") not in {"completed", "failed"} and working.get("video_id"):
            try:
                refresh_job(working)
            except RuntimeError as error:
                working["poll_error"] = str(error)
        with LOCK:
            jobs = load_jobs()
            current = next((item for item in jobs if item["id"] == job_id), None)
            if not current:
                self.send_json({"error": "找不到这条记录"}, 404)
                return
            if working.get("video_id"):
                for key in ("status", "progress", "url", "error"):
                    if key in working:
                        current[key] = working[key]
                if working.get("poll_error"):
                    current["poll_error"] = working["poll_error"]
                else:
                    current.pop("poll_error", None)
            if current.get("status") == "completed":
                schedule_download(current)
            finished = current.get("status") in DONE
            save_jobs(jobs)
            snapshot = next(
                item for item in placed_jobs(jobs, job_source(current)) if item["id"] == job_id
            )
            queue = queue_view(jobs, job_source(current))
        if finished:
            kick_queue()
        self.send_json({"job": snapshot, "queue": queue})

    def serve_job_file(self, job_id: str) -> None:
        with LOCK:
            job = next((item for item in load_jobs() if item["id"] == job_id), None)
        if not job or not job.get("local_file"):
            self.send_json({"error": "视频还没下载到本机"}, 404)
            return
        file_path = OUTPUTS / Path(job["local_file"]).name
        if not file_path.exists():
            self.send_json({"error": "本地文件不存在"}, 404)
            return
        self.stream_file(file_path, "video/mp4")

    def reveal(self) -> None:
        try:
            length = int(self.headers.get("Content-Length") or "0")
            body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
            body = {}
        name = str(body.get("file") or "")
        target = OUTPUTS
        args = ["open", str(OUTPUTS)]
        if name:
            candidate = OUTPUTS / Path(name).name
            if candidate.exists():
                target = candidate
                args = ["open", "-R", str(candidate)]
        if not target.exists():
            OUTPUTS.mkdir(parents=True, exist_ok=True)
            args = ["open", str(OUTPUTS)]
        subprocess.run(args, check=False)
        self.send_json({"ok": True})

    def save_project_post(self) -> None:
        try:
            length = int(self.headers.get("Content-Length") or "0")
            raw = self.rfile.read(length).decode("utf-8") or "{}"
            body = json.loads(raw)
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
            self.send_json({"error": "请求体不是合法 JSON"}, 400)
            return
        items = body if isinstance(body, list) else [body]
        valid = [item for item in items if isinstance(item, dict) and item.get("id")]
        if not valid:
            self.send_json({"error": "作品缺少 id 字段"}, 400)
            return
        with LOCK:
            projects = load_projects()
            by_id = {item.get("id"): item for item in projects}
            for item in valid:
                item["updatedAt"] = int(time.time() * 1000)
                self._persist_project_images(item)
                by_id[item["id"]] = item
            merged = sorted(by_id.values(), key=lambda p: p.get("updatedAt") or 0, reverse=True)
            save_projects(merged)
        self.send_json({"ok": True, "count": len(valid)})

    def _persist_project_images(self, project: dict) -> None:
        """把 images 中的 base64 data URL 落盘为静态图片文件，并将 blob 字段替换为可访问的 URL 引用。

        此前 Blob 经 JSON.stringify 序列化会变成空对象 {}，导致图片实体从未真正到达服务端；
        本方法保证图片数据实体落盘，任何浏览器都能通过 /images/<projectId>/<imageId>.<ext> 访问。
        """
        project_id = project.get("id")
        if not project_id:
            return
        images_dir = STATIC / "images" / project_id
        allowed = {"jpg", "jpeg", "png", "webp", "gif", "bmp"}
        for card in project.get("cards") or []:
            for image in card.get("images") or []:
                blob = image.get("blob")
                if not isinstance(blob, str) or not blob.startswith("data:image/"):
                    # 空对象 / null / 已存 URL 的图片直接跳过，避免覆盖已落盘文件
                    continue
                try:
                    header, _, b64 = blob.partition(",")
                    mime = header[5:header.find(";")]
                    ext = mime.split("/")[-1].lower()
                    if ext not in allowed:
                        ext = "jpg"
                    image_id = image.get("id")
                    if not image_id:
                        continue
                    images_dir.mkdir(parents=True, exist_ok=True)
                    target = images_dir / f"{image_id}.{ext}"
                    target.write_bytes(base64.b64decode(b64))
                    image["blob"] = f"/images/{project_id}/{image_id}.{ext}"
                except Exception:
                    image["blob"] = None

    def save_project_image_post(self) -> None:
        """单张图片上传：接收 base64 data URL，落盘为静态文件，返回可访问的 URL。

        生成链路中每张图完成后立即单独上传，避免全量项目 JSON 携带 base64 造成体积过大。
        """
        try:
            length = int(self.headers.get("Content-Length") or "0")
            body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
            self.send_json({"error": "请求体不是合法 JSON"}, 400)
            return
        project_id = body.get("projectId") or body.get("project_id")
        image_id = body.get("imageId") or body.get("image_id")
        blob = body.get("blob") or body.get("dataUrl")
        if not project_id or not image_id or not isinstance(blob, str) or not blob.startswith("data:image/"):
            self.send_json({"error": "缺少 projectId/imageId/blob"}, 400)
            return
        try:
            header, _, b64 = blob.partition(",")
            mime = header[5:header.find(";")]
            ext = mime.split("/")[-1].lower()
            if ext not in {"jpg", "jpeg", "png", "webp", "gif", "bmp"}:
                ext = "jpg"
            images_dir = STATIC / "images" / project_id
            images_dir.mkdir(parents=True, exist_ok=True)
            target = images_dir / f"{image_id}.{ext}"
            target.write_bytes(base64.b64decode(b64))
        except Exception:
            self.send_json({"error": "图片数据解码失败"}, 400)
            return
        url = f"/images/{project_id}/{image_id}.{ext}"
        self.send_json({"ok": True, "url": url})

    def _read_json_body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or "0")
            body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
            body = {}
        return body if isinstance(body, dict) else {}

    def serve_static(self, path: str) -> None:
        relative = "index.html" if path in {"", "/"} else path.lstrip("/")
        file_path = (STATIC / relative).resolve()
        if not str(file_path).startswith(str(STATIC.resolve())) or not file_path.is_file():
            self.send_json({"error": "找不到页面"}, 404)
            return
        mime = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        if file_path.suffix in {".html", ".css", ".js"}:
            mime += "; charset=utf-8"
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def stream_file(self, file_path: Path, mime: str) -> None:
        size = file_path.stat().st_size
        start, end = 0, size - 1
        status = 200
        range_header = self.headers.get("Range")
        if range_header and range_header.startswith("bytes="):
            piece = range_header.split("=", 1)[1].split(",", 1)[0]
            start_text, _, end_text = piece.partition("-")
            try:
                if start_text:
                    start = int(start_text)
                if end_text:
                    end = int(end_text)
                elif not start_text:
                    start = max(size - int(end_text or 0), 0)
            except ValueError:
                start, end = 0, size - 1
            end = min(end, size - 1)
            if start > end or start < 0:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with file_path.open("rb") as handle:
            handle.seek(start)
            remaining = length
            while remaining > 0:
                chunk = handle.read(min(256 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def send_json(self, data: dict, status: int = 200) -> None:
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)


def pick_port() -> int:
    for port in range(8765, 8776):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise SystemExit("8765–8775 端口都已被占用")


def main() -> None:
    load_env(ENV_PATH)
    OUTPUTS.mkdir(parents=True, exist_ok=True)
    recover_submitting()
    threading.Thread(target=queue_worker, daemon=True).start()
    port = pick_port()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}"
    key = api_key()
    print(f"秋白漫剧工作台：{url}", flush=True)
    print(f"密钥：{mask_key(key) if key else '未配置，请检查 .env'}", flush=True)
    print("关闭这个窗口即停止服务。成片保存在 outputs 文件夹。", flush=True)
    threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
