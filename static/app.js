const ASPECTS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
const PIXELS = {
  "agnes-video-2.5-flash": {
    "720P": { "21:9": "1680×720", "16:9": "1280×704", "4:3": "960×720", "1:1": "720×720", "3:4": "720×960", "9:16": "720×1280" },
  },
  "agnes-video-2.5": {
    "720P": { "21:9": "1470×630", "16:9": "1280×720", "4:3": "1112×834", "1:1": "960×960", "3:4": "834×1112", "9:16": "720×1280" },
    "1080P": { "21:9": "2206×946", "16:9": "1920×1080", "4:3": "1664×1248", "1:1": "1440×1440", "3:4": "1248×1664", "9:16": "1080×1920" },
    "1K": { "1:1": "1024×1024" },
    "2K": { "21:9": "2940×1260", "16:9": "2560×1440", "4:3": "2224×1668", "1:1": "1920×1920", "3:4": "1668×2224", "9:16": "1440×2560" },
  },
};
const RATES = {
  "agnes-video-2.5-flash": { "720P": 0 },
  "agnes-video-2.5": { "720P": 0.025, "1080P": 0.04, "1K": 0.04, "2K": 0.055 },
};
const SIZES = {
  "agnes-video-2.5-flash": ["720P"],
  "agnes-video-2.5": ["720P"],
};
const STATUS = {
  waiting: "排队等待",
  submitting: "正在提交",
  queued: "执行中",
  in_progress: "执行中",
  completed: "已完成",
  failed: "失败",
};

function askConfirm(message) {
  const dialog = document.getElementById("confirmDialog");
  const text = document.getElementById("confirmMessage");
  if (!dialog || !text) return Promise.resolve(window.confirm(message));
  text.textContent = message;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener("close", onClose);
      resolve(dialog.returnValue === "ok");
    };
    dialog.addEventListener("close", onClose);
  });
}

function statusLabel(job) {
  if (job.status === "waiting") return `排队第 ${job.place || "?"} 位`;
  if (job.status === "submitting") return "正在提交";
  if (job.status === "queued" || job.status === "in_progress") return `执行中 · ${job.progress || 0}%`;
  return `${STATUS[job.status] || job.status} · ${job.progress || 0}%`;
}

const state = {
  aspect: "16:9",
  size: "720P",
  jobs: [],
  activeId: null,
  timers: new Set(),
  billed: new Set(),
  gateway: "cn-hub",
  imageFiles: [],
  library: [],
  preparing: false,
  composing: false,
};

const $ = (id) => document.getElementById(id);
const form = $("form");

function model() {
  return $("model").value;
}

function mode() {
  const checked = document.querySelector('input[name="mode"]:checked');
  return checked ? checked.value : "text";
}

function renderChoices() {
  const pixels = (PIXELS[model()][state.size] || {})[state.aspect] || "以成片为准";
  $("specLine").textContent = `预计输出 ${pixels}。实际尺寸以 Agnes 返回的文件为准。`;
  const rate = RATES[model()][state.size] ?? 0;
  const seconds = Number($("seconds").value);
  const quote = rate === 0
    ? "Flash 在国际站当前限时 $0 / 秒"
    : `Video 2.5 国际站刊例价约 $${(rate * seconds).toFixed(3)}（${seconds} 秒 × $${rate}/秒）`;
  $("priceLine").textContent = state.gateway === "cn-site"
    ? `${quote}。当前密钥走国内站，实际扣费以 Agnes 控制台为准。`
    : `${quote}。参考视频会按素材时长另计。`;
  $("videoBox").hidden = model() !== "agnes-video-2.5";
  $("keyframePanel").hidden = mode() !== "keyframe";
  $("referencePanel").hidden = mode() !== "reference";
  if (state.imageFiles.length > imageLimit()) {
    state.imageFiles = state.imageFiles.slice(0, imageLimit());
    renderImagePreview();
  }
}

function imageLimit() {
  return model() === "agnes-video-2.5" ? 8 : 5;
}

function renderImagePreview() {
  const list = $("imagePreview");
  if (!list) return;
  if (state.imageFiles.length > imageLimit()) state.imageFiles = state.imageFiles.slice(0, imageLimit());
  list.querySelectorAll("img").forEach((img) => URL.revokeObjectURL(img.src));
  list.innerHTML = "";
  state.imageFiles.forEach((file, index) => {
    const item = document.createElement("li");
    const img = document.createElement("img");
    img.alt = file.name;
    img.src = URL.createObjectURL(file);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "drop";
    remove.textContent = "移除";
    remove.addEventListener("click", () => {
      URL.revokeObjectURL(img.src);
      state.imageFiles.splice(index, 1);
      renderImagePreview();
    });
    const name = document.createElement("span");
    name.textContent = file.name;
    item.append(img, name, remove);
    list.appendChild(item);
  });
  renderLibrary();
}

function imageKey(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function openImageDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("agnes-references", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("images")) db.createObjectStore("images", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadLibrary() {
  const db = await openImageDb();
  const records = await new Promise((resolve, reject) => {
    const request = db.transaction("images").objectStore("images").getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  db.close();
  records.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  state.library = records.slice(0, 30);
  renderLibrary();
}

async function rememberImages(files) {
  const db = await openImageDb();
  const store = db.transaction("images", "readwrite").objectStore("images");
  await Promise.all(files.map((file) => new Promise((resolve, reject) => {
    const request = store.put({
      id: imageKey(file),
      name: file.name,
      type: file.type || "image/png",
      size: file.size,
      lastModified: file.lastModified,
      blob: file,
      addedAt: Date.now(),
    });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  })));
  db.close();
  await loadLibrary();
}

function renderLibrary() {
  const block = $("imageLibraryBlock");
  const list = $("imageLibrary");
  if (!block || !list) return;
  list.querySelectorAll("img").forEach((img) => URL.revokeObjectURL(img.src));
  list.innerHTML = "";
  block.hidden = state.library.length === 0;
  const selected = new Set(state.imageFiles.map(imageKey));
  state.library.forEach((record) => {
    const item = document.createElement("li");
    item.className = selected.has(record.id) ? "saved used" : "saved";
    const use = document.createElement("button");
    use.type = "button";
    use.className = "use";
    const img = document.createElement("img");
    img.alt = record.name;
    img.src = URL.createObjectURL(record.blob);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = record.name;
    use.append(img, name);
    use.addEventListener("click", () => useLibraryImage(record));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "drop";
    remove.textContent = "删除记录";
    remove.addEventListener("click", async () => {
      if (!(await askConfirm("删除这条参考图记录？"))) return;
      forgetLibraryImage(record.id);
    });
    item.append(use, remove);
    list.appendChild(item);
  });
}

function useLibraryImage(record) {
  if (state.imageFiles.some((file) => imageKey(file) === record.id)) return;
  if (state.imageFiles.length >= imageLimit()) {
    showError(`参考图片最多 ${imageLimit()} 张`);
    return;
  }
  const file = new File([record.blob], record.name, {
    type: record.type || "image/png",
    lastModified: record.lastModified || Date.now(),
  });
  state.imageFiles.push(file);
  showError("");
  renderImagePreview();
}

async function forgetLibraryImage(id) {
  const db = await openImageDb();
  await new Promise((resolve, reject) => {
    const request = db.transaction("images", "readwrite").objectStore("images").delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  db.close();
  state.library = state.library.filter((record) => record.id !== id);
  renderLibrary();
}

function showIdlePreview() {
  const player = $("player");
  if (!player.hidden) player.pause();
  player.hidden = true;
  player.removeAttribute("src");
  player.dataset.bound = "";
  $("live").hidden = true;
  $("empty").hidden = false;
  $("empty").querySelector("b").textContent = "还没有成片";
  $("empty").querySelector("span").textContent = "写好提示词后点生成。完成后在这里播放。";
  $("now").hidden = true;
  $("nowError").hidden = true;
}

function fileToBase64(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };
    reader.onload = () => {
      if (onProgress) onProgress(1);
      const text = String(reader.result || "");
      resolve(text.slice(text.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error(`读不了图片：${file.name}`));
    reader.readAsDataURL(file);
  });
}

function showPreviewProgress(title, detail, percent) {
  const value = Math.max(0, Math.min(100, Math.round(percent) || 0));
  $("empty").hidden = true;
  $("player").hidden = true;
  $("live").hidden = false;
  $("liveTitle").textContent = title;
  $("liveDetail").textContent = detail;
  $("livePercent").textContent = `${value}%`;
  $("liveBar").style.width = `${value}%`;
}

function postJson(url, body, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };
    xhr.onerror = () => reject(new Error("网络中断，请重试"));
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || "{}"); } catch (error) { data = {}; }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(data.error || data.message || `请求失败（${xhr.status}）`));
        return;
      }
      resolve(data);
    };
    xhr.send(JSON.stringify(body));
  });
}

function addUrlRow(list, placeholder) {
  const limit = list.id === "imageList" ? (model() === "agnes-video-2.5" ? 8 : 5) : 3;
  if (list.children.length >= limit) return;
  const row = document.createElement("div");
  row.className = "url-row";
  row.innerHTML = `<input type="url" placeholder="${placeholder}"><button type="button" aria-label="删除">删除</button>`;
  row.querySelector("button").addEventListener("click", () => row.remove());
  list.appendChild(row);
}

function urlsFrom(list) {
  return [...list.querySelectorAll("input")].map((input) => input.value.trim()).filter(Boolean);
}

function showError(message) {
  const node = $("formError");
  node.hidden = !message;
  node.textContent = message || "";
}

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || `请求失败（${response.status}）`);
  return data;
}

function queueTitle(job) {
  if (job.status === "waiting") return `排队第 ${job.place || "?"} 位`;
  if (job.status === "submitting") return "正在提交";
  if (job.status === "queued" || job.status === "in_progress") return `正在生成 ${job.progress || 0}%`;
  return STATUS[job.status] || "任务";
}

function selectJob(job) {
  state.activeId = job.id;
  const player = $("player");
  const failed = job.error || (job.status === "failed" ? "生成失败" : "");
  const local = job.local_file ? `/api/jobs/${job.id}/file` : "";
  const src = local || job.url || "";
  const downloadError = job.download_error ? `已生成，但保存到本机失败：${job.download_error}` : "";
  $("nowError").hidden = !downloadError;
  $("nowError").textContent = downloadError;
  if (src && !failed) {
    $("live").hidden = true;
    $("empty").hidden = true;
    const next = new URL(src, location.origin).href;
    if (player.dataset.bound !== next) {
      player.dataset.bound = next;
      player.src = next;
    }
    player.hidden = false;
  } else if (!state.preparing) {
    player.hidden = true;
    player.removeAttribute("src");
    player.dataset.bound = "";
    if (failed) {
      showPreviewProgress("生成失败", failed, 0);
    } else {
      const waiting = job.status === "waiting" || job.status === "submitting";
      const detail = waiting
        ? (job.notice || `排队第 ${job.place || 1} 位`)
        : `视频生成 ${job.progress || 0}%`;
      showPreviewProgress("正在生成", detail, waiting ? 0 : (job.progress || 0));
    }
  }
  $("now").hidden = !job.url && !job.local_file;
  $("openRemote").hidden = !job.url;
  $("openRemote").href = job.url || "#";
  $("revealFile").hidden = !job.local_file;
  $("revealFile").dataset.file = job.local_file || "";
  renderHistory();
}

function jobTitle(job) {
  let text = String(job.prompt || "").replace(/\s+/g, " ").trim();
  text = text.replace(/^[>#*\s]+/, "").replace(/\*\*/g, "");
  const parts = text.split(/[，。,.！？!?：:]/).map((part) => part.trim()).filter(Boolean);
  const name = parts[0] && parts[0].length <= 6 && parts[1] ? parts[1] : (parts[0] || "未命名");
  return name.length > 18 ? `${name.slice(0, 18)}…` : name;
}

function jobCard(job, list) {
  const item = document.createElement("li");
  if (job.id === state.activeId) item.classList.add("active");
  if (job.status === "failed") item.classList.add("failed");
  item.innerHTML = `
      <span class="title">${escapeHtml(jobTitle(job))}</span>
      <button type="button" class="ghost" data-remove="${job.id}">删除记录</button>`;
  item.addEventListener("click", (event) => {
    if (event.target.closest("[data-remove]")) return;
    selectJob(job);
  });
  item.querySelector("[data-remove]").addEventListener("click", async () => {
    if (!(await askConfirm("删除这条生成记录？"))) return;
    removeJob(job.id);
  });
  list.appendChild(item);
}

function renderHistory() {
  const active = state.jobs
    .filter((job) => job.status !== "completed" && job.status !== "failed")
    .sort((a, b) => (a.place || 99) - (b.place || 99));
  const done = state.jobs.filter((job) => job.status === "completed" || job.status === "failed");
  const queue = $("queue");
  const queueHead = $("queueHead");
  queue.innerHTML = "";
  queueHead.hidden = active.length === 0;
  active.forEach((job) => {
    const item = document.createElement("li");
    item.textContent = queueTitle(job);
    queue.appendChild(item);
  });
  const list = $("history");
  if (!done.length) {
    list.innerHTML = `<li><span class="sub">完成后的视频会留在这里。</span></li>`;
    return;
  }
  list.innerHTML = "";
  for (const job of done) jobCard(job, list);
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

async function refreshJobs() {
  const data = await readJson(await fetch("/api/jobs?source=bench"));
  state.jobs = data.jobs || [];
  renderHistory();
  for (const job of state.jobs) {
    if (job.status !== "completed" && job.status !== "failed") watch(job.id);
  }
  if (state.preparing || state.composing) return;
  const active = state.jobs.find((job) => job.id === state.activeId) || state.jobs[0];
  if (active) selectJob(active);
}

function watch(id) {
  if (state.timers.has(id)) return;
  state.timers.add(id);
  const tick = async () => {
    try {
      const data = await readJson(await fetch(`/api/jobs/${id}`));
      const job = data.job;
      const index = state.jobs.findIndex((item) => item.id === id);
      if (index >= 0) state.jobs[index] = job;
      else state.jobs.unshift(job);
      if (!state.preparing && !state.composing && (state.activeId === id || state.activeId === null)) selectJob(job);
      else renderHistory();
      if (job.status === "completed" || job.status === "failed") {
        state.timers.delete(id);
        if (job.status === "completed" && !state.billed.has(id)) {
          state.billed.add(id);
          loadBalance();
        }
        if (job.status === "completed" && !job.local_file && !job.download_error) {
          setTimeout(tick, 2000);
          state.timers.add(id);
        }
        return;
      }
    } catch (error) {
      showError(error.message);
    }
    setTimeout(tick, 2000);
  };
  tick();
}

async function removeJob(id) {
  await fetch(`/api/jobs/${id}`, { method: "DELETE" });
  if (state.activeId === id) state.activeId = null;
  await refreshJobs();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  const payload = {
    model: model(),
    mode: mode(),
    prompt: $("prompt").value.trim(),
    seconds: Number($("seconds").value),
    size: state.size,
    aspect_ratio: state.aspect,
    seed: $("seed").value.trim(),
    gateway: state.gateway,
    source: "bench",
  };
  if (payload.mode === "keyframe") {
    payload.first_frame = $("firstFrame").value.trim();
    payload.last_frame = $("lastFrame").value.trim();
  }
  if (payload.mode === "reference" && state.imageFiles.some((file) => file.size > 15 * 1024 * 1024)) {
    showError("单张参考图请小于 15MB");
    return;
  }
  const filesToSend = payload.mode === "reference" ? state.imageFiles.slice() : [];
  const previousId = state.activeId;
  $("submit").disabled = true;
  $("submit").textContent = "正在提交…";
  state.preparing = true;
  state.composing = false;
  state.activeId = null;
  const imageCount = filesToSend.length;
  showPreviewProgress("正在生成", imageCount ? `图片 1/${imageCount}` : "正在提交", 0);
  try {
    if (payload.mode === "reference") {
      const images = [];
      for (let index = 0; index < filesToSend.length; index += 1) {
        const file = filesToSend[index];
        images.push(await fileToBase64(file, (fraction) => {
          const overall = ((index + fraction) / filesToSend.length) * 100;
          showPreviewProgress("正在生成", `图片 ${index + 1}/${filesToSend.length}`, overall);
        }));
      }
      payload.images = images;
      payload.audios = urlsFrom($("audioList"));
      const videoUrl = $("videoUrl").value.trim();
      if (videoUrl && model() === "agnes-video-2.5") {
        payload.videos = [{
          url: videoUrl,
          start_seconds: $("videoStart").value.trim(),
          require_audio: $("videoAudio").checked,
        }];
      }
    }
    showPreviewProgress("正在生成", imageCount ? "正在上传图片" : "正在提交", imageCount ? 0 : 8);
    const data = await postJson("/api/videos", payload, (fraction) => {
      showPreviewProgress(
        "正在生成",
        imageCount ? "正在上传图片" : "正在提交",
        imageCount ? fraction * 100 : Math.max(8, fraction * 100),
      );
    });
    state.preparing = false;
    state.jobs.unshift(data.job);
    watch(data.job.id);
    if (state.composing) renderHistory();
    else selectJob(data.job);
  } catch (error) {
    state.preparing = false;
    showError(error.message);
    if (!state.composing) {
      state.activeId = previousId;
      const previous = state.jobs.find((job) => job.id === previousId);
      if (previous) selectJob(previous);
      else showIdlePreview();
    }
  } finally {
    state.preparing = false;
    $("submit").disabled = false;
    $("submit").textContent = "生成视频";
  }
});

$("seconds").addEventListener("input", () => {
  $("secondsLabel").textContent = `${$("seconds").value} 秒`;
  renderChoices();
});
form.addEventListener("change", renderChoices);
$("sizes").addEventListener("click", (event) => {
  const size = event.target.dataset.size;
  if (!size) return;
  state.size = size;
  renderChoices();
});
$("aspects").addEventListener("click", (event) => {
  const aspect = event.target.dataset.aspect;
  if (!aspect) return;
  state.aspect = aspect;
  renderChoices();
});
$("examples").addEventListener("click", (event) => {
  const prompt = event.target.dataset.prompt;
  if (prompt) $("prompt").value = prompt;
});
$("pickImages").addEventListener("click", () => $("imageFiles").click());
$("imageFiles").addEventListener("change", () => {
  const picked = [...$("imageFiles").files];
  $("imageFiles").value = "";
  const room = imageLimit() - state.imageFiles.length;
  if (room <= 0) {
    showError(`参考图片最多 ${imageLimit()} 张`);
    return;
  }
  const accepted = picked.slice(0, room);
  state.imageFiles.push(...accepted);
  if (picked.length > room) showError(`参考图片最多 ${imageLimit()} 张，多出的没有加入`);
  else showError("");
  renderImagePreview();
  rememberImages(accepted).catch((error) => showError(error.message));
});
$("newTask").addEventListener("click", () => {
  $("prompt").value = "";
  showError("");
  state.activeId = null;
  state.composing = true;
  showIdlePreview();
  renderHistory();
  $("prompt").focus();
});
$("addAudio").addEventListener("click", () => addUrlRow($("audioList"), "https://音频链接"));
$("revealFolder").addEventListener("click", () => fetch("/api/reveal", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
$("revealFile").addEventListener("click", () => fetch("/api/reveal", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ file: $("revealFile").dataset.file || "" }),
}));

async function loadBalance() {
  const node = $("balance");
  node.classList.remove("bad");
  try {
    const data = await readJson(await fetch("/api/balance"));
    node.textContent = data.label || data.message || "余额未知";
    node.classList.toggle("bad", !data.ok);
    node.title = data.unlimited
      ? "这把密钥没有额度上限。点击可刷新。"
      : `总额度 ${data.total_label || ""}。点击可刷新。`;
  } catch (error) {
    node.textContent = "余额暂时查不到";
    node.classList.add("bad");
    node.title = error.message;
  }
}

async function boot() {
  renderChoices();
  addUrlRow($("audioList"), "https://音频链接");
  try {
    const probe = await readJson(await fetch("/api/probe"));
    if (probe.gateway) state.gateway = probe.gateway;
    renderChoices();
    $("keyline").textContent = probe.ok
      ? `${probe.label} · 密钥可用 ${probe.masked}`
      : (probe.message || "密钥不可用");
    $("keyline").title = (probe.checks || []).map((item) => `${item.label}：${item.message}`).join("\n");
    $("keyline").classList.toggle("bad", !probe.ok);
    if (probe.ok) loadBalance();
    else $("balance").hidden = true;
  } catch (error) {
    $("keyline").textContent = error.message;
    $("keyline").classList.add("bad");
    $("balance").hidden = true;
  }
  refreshJobs().catch((error) => showError(error.message));
  loadLibrary().catch((error) => showError(error.message));
}

$("balance").addEventListener("click", loadBalance);
boot();

(function setupFloatTips() {
  const tip = document.createElement("div");
  tip.id = "floatTip";
  tip.className = "float-tip";
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);

  let active = null;
  let hideTimer = 0;

  function tipText(el) {
    if (!el) return "";
    if (el.dataset.tip) return el.dataset.tip.trim();
    const nested = el.querySelector(":scope > .icon-tip, :scope > .help-tip");
    if (nested) return nested.textContent.trim();
    const help = el.closest(".help");
    if (help) {
      const helpTip = help.querySelector(".help-tip");
      if (helpTip) return helpTip.textContent.trim();
    }
    const label = el.getAttribute("aria-label");
    if (label) return label.trim();
    const clone = el.cloneNode(true);
    clone.querySelectorAll(".icon-tip, .help-tip, svg, .cover-placeholder, img").forEach((node) => node.remove());
    return clone.textContent.replace(/\s+/g, " ").trim();
  }

  function place(el) {
    const text = tipText(el);
    if (!text) {
      hide();
      return;
    }
    tip.textContent = text;
    tip.classList.toggle("wide", text.length > 18);
    tip.classList.add("on");
    const rect = el.getBoundingClientRect();
    tip.style.left = "0px";
    tip.style.top = "0px";
    const size = tip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - size.width / 2;
    let top = rect.bottom + 8;
    if (top + size.height > window.innerHeight - 8) top = rect.top - size.height - 8;
    if (left < 8) left = 8;
    if (left + size.width > window.innerWidth - 8) left = window.innerWidth - size.width - 8;
    if (top < 8) top = 8;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  function show(el) {
    clearTimeout(hideTimer);
    active = el;
    place(el);
  }

  function hide() {
    active = null;
    tip.classList.remove("on");
  }

  function targetFrom(node) {
    if (!node || !node.closest) return null;
    const el = node.closest("button, .port, [data-tip]");
    if (!el || el.closest(".pure-title, .vnode-compact-title")) return null;
    return el;
  }

  document.addEventListener("pointerover", (event) => {
    const el = targetFrom(event.target);
    if (!el) return;
    if (active === el) return;
    show(el);
  });
  document.addEventListener("pointerout", (event) => {
    const el = targetFrom(event.target);
    if (!el || el !== active) return;
    const next = event.relatedTarget && targetFrom(event.relatedTarget);
    if (next === el) return;
    hideTimer = window.setTimeout(hide, 40);
  });
  document.addEventListener("focusin", (event) => {
    const el = targetFrom(event.target);
    if (el) show(el);
  });
  document.addEventListener("focusout", (event) => {
    const el = targetFrom(event.target);
    if (el && el === active) hide();
  });
  window.addEventListener("scroll", () => {
    if (active) place(active);
  }, true);
  window.addEventListener("resize", () => {
    if (active) place(active);
  });
})();
