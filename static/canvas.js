const ASPECT_CHOICES = [
  ["21:9", "21:9 超宽"],
  ["16:9", "16:9 横屏"],
  ["4:3", "4:3 标准"],
  ["1:1", "1:1 方形"],
  ["3:4", "3:4 竖幅"],
  ["9:16", "9:16 竖屏"],
];
const MODEL_CHOICES = [
  ["agnes-video-2.5-flash", "2.5 Flash"],
  ["agnes-video-2.5", "2.5"],
];
const MODEL_IMAGE_LIMIT = {
  "agnes-video-2.5-flash": 5,
  "agnes-video-2.5": 8,
};
const IMAGE_SIZE_CHOICES = [
  ["1024x1024", "1:1 方形"],
  ["1024x768", "4:3 横版"],
  ["768x1024", "3:4 竖版"],
  ["1024x576", "16:9 横屏"],
  ["576x1024", "9:16 竖屏"],
];
const IMAGE_MODEL_CHOICES = [
  ["agnes-image-2.5-flash", "Agnes Image 2.5 Flash（最新）"],
  ["agnes-image-2.1-flash", "Agnes Image 2.1 Flash（推荐）"],
  ["agnes-image-2.0-flash", "Agnes Image 2.0 Flash（旧版）"],
];
const IMAGE_GEN_MODEL = "agnes-image-2.5-flash";
const CARD_LABEL = { character: "人物", environment: "场景", scene: "场景", prop: "道具", text: "文本" };
const CARD_TYPES = ["character", "scene", "prop", "text"];
const ICON = {
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V5h6v2M8 7l1 12h6l1-12"/></svg>',
  swap: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h12l-3-3M20 16H8l3 3"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L19 7"/></svg>',
  pick: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/></svg>',
  expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4.5L19 9.5 14.5 5 4 15.5V20z"/><path d="M13 6.5L17.5 11"/></svg>',
};

function iconBtn(label, icon, attrs = "") {
  const hasClass = /\bclass\s*=/.test(attrs);
  const classAttr = hasClass ? "" : 'class="icon-btn"';
  return `<button type="button" ${classAttr} aria-label="${escapeText(label)}" ${attrs}>${ICON[icon]}<span class="icon-tip">${escapeText(label)}</span></button>`;
}
const WORLD_PAD = 50000;
const WORLD = { width: 8000, height: 6000 }; // kept for legacy reads only

const canvasUi = {
  projects: [],
  project: null,
  renamingId: null,
  picking: false,
  pickingVideoId: null,
  pickingBackup: null,
  fileTarget: null,
  urls: new Map(),
  pollers: new Set(),
  drag: null,
  pan: null,
  marquee: null,
  groupDrag: null,        // 拖动整组：{ groupId, items, clientX, clientY }
  selection: new Set(),
  selectedGroupId: null,  // 当前选中的组（互斥于 selection）
  spaceDown: false,
  view: { x: 48, y: 36, scale: 1 },
  error: "",
  errorVideoId: null,
  generatingCardIds: new Set(),
  tasks: [],
  imageError: "",
  imageErrorCardId: null,
  linking: null,
  dropAt: null,
  viewTimer: null,
  expandedVideoId: null,
  videoToolbarId: null,
  linkFocusId: null,
  selectedLinkId: null,
  toolbarPress: null,
  toolbarGesture: false,
  toolbarGestureTimer: null,
  promptTimer: null,
};

function selKey(kind, id) {
  return `${kind}:${id}`;
}

// =============================================================
// 画布成组（group）功能
// =============================================================

const GROUP_PAD = 16;  // 组框四周留白
const GROUP_PRESETS = [
  "#ef4444",  // 红
  "#f97316",  // 橙
  "#eab308",  // 黄
  "#22c55e",  // 绿
  "#06b6d4",  // 青
  "#3b82f6",  // 蓝
  "#a855f7",  // 紫
  "#6b7280",  // 灰
];

function findGroup(groupId) {
  const groups = canvasUi.project?.groups || [];
  return groups.find((g) => g.id === groupId) || null;
}

function itemSize(kind, id) {
  if (kind === "card") {
    const node = document.querySelector(`[data-card="${id}"]`);
    if (node) return { w: node.offsetWidth || 220, h: node.offsetHeight || 280 };
    return { w: 220, h: 280 };
  }
  if (kind === "video") {
    const node = document.querySelector(`[data-video="${id}"]`);
    if (node) return { w: node.offsetWidth || 360, h: node.offsetHeight || 420 };
    return { w: 360, h: 420 };
  }
  return { w: 200, h: 200 };
}

function computeGroupBounds(group) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let count = 0;
  for (const ref of group.members || []) {
    let item = null;
    if (ref.kind === "card") item = findCard(ref.id);
    else if (ref.kind === "video") item = findVideo(ref.id);
    if (!item) continue;
    const sz = itemSize(ref.kind, ref.id);
    const x = item.x ?? 0, y = item.y ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + sz.w > maxX) maxX = x + sz.w;
    if (y + sz.h > maxY) maxY = y + sz.h;
    count += 1;
  }
  if (!count) return null;
  return {
    x: minX - GROUP_PAD,
    y: minY - GROUP_PAD,
    w: (maxX - minX) + GROUP_PAD * 2,
    h: (maxY - minY) + GROUP_PAD * 2,
  };
}

function groupMarkup(group) {
  const bounds = computeGroupBounds(group);
  if (!bounds) return "";
  const color = group.color || "#3b82f6";
  const isSelected = canvasUi.selectedGroupId === group.id;
  const name = escapeText(group.name || "组");
  return `<div class="group-rect${isSelected ? " is-selected" : ""}" data-group-id="${group.id}" style="left:${bounds.x}px;top:${bounds.y}px;width:${bounds.w}px;height:${bounds.h}px;color:${color};">
    <span class="group-name">${name}</span>
  </div>`;
}

function ensureGroups(project) {
  if (!project) return project;
  if (!Array.isArray(project.groups)) project.groups = [];
  return project;
}

function nextGroupColor() {
  const used = new Set((canvasUi.project?.groups || []).map((g) => (g.color || "").toLowerCase()));
  for (const color of GROUP_PRESETS) {
    if (!used.has(color.toLowerCase())) return color;
  }
  return GROUP_PRESETS[(canvasUi.project?.groups || []).length % GROUP_PRESETS.length];
}

function nextGroupName() {
  const n = (canvasUi.project?.groups || []).length + 1;
  return `组 #${n}`;
}

function createGroupFromSelection() {
  if (canvasUi.selection.size < 2) return null;
  const project = ensureGroups(canvasUi.project);
  const members = [];
  canvasUi.selection.forEach((key) => {
    const parsed = parseSelKey(key);
    if (!parsed) return;
    members.push({ kind: parsed.kind, id: parsed.id });
  });
  if (members.length < 2) return null;
  const group = {
    id: "g_" + canvasUid(),
    name: nextGroupName(),
    color: nextGroupColor(),
    members,
  };
  project.groups.push(group);
  // 选中这个组（互斥于 selection）
  canvasUi.selection.clear();
  canvasUi.selectedGroupId = group.id;
  syncSelectionClasses();
  syncSelectBar();
  renderGroups();
  renderCanvas();   // 同步侧栏：新增组 + 成员分配
  writeProject(project);
  return group;
}

function setGroupColor(groupId, color) {
  const project = canvasUi.project;
  if (!project) return;
  const group = findGroup(groupId);
  if (!group) return;
  group.color = color;
  renderGroups();
  syncSelectBar();
  renderCanvas();   // 同步侧栏：组色点变
  writeProject(project);
}

function renameGroup(groupId, name) {
  const project = canvasUi.project;
  if (!project) return;
  const group = findGroup(groupId);
  if (!group) return;
  group.name = String(name || "").trim() || nextGroupName();
  renderGroups();
  syncSelectBar();
  renderCanvas();   // 同步侧栏：组名变
  writeProject(project);
}

// 在组框的「名字药丸」上双击 → 内联编辑
function beginGroupNameEdit(groupId) {
  if (!groupId) return;
  // 自动选中组（pill 在 is-selected 时才有 pointer-events:auto）
  if (canvasUi.selectedGroupId !== groupId) selectGroup(groupId);
  // selectGroup 内部会 renderGroups()，要重新 query pill
  const pill = document.querySelector(`.group-rect[data-group-id="${groupId}"] .group-name`);
  if (!pill || pill.matches("input")) return;
  const original = pill.textContent;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "group-name is-editing";
  input.value = original;
  input.maxLength = 40;
  input.dataset.original = original;
  input.dataset.groupId = groupId;
  input.dataset.arm = "";
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      input.dataset.cancel = "1";
      input.blur();
    }
  });
  input.addEventListener("blur", () => finishGroupNameEdit(input));
  pill.replaceWith(input);
  // 下一帧再 arm，避免 blur 立刻触发
  setTimeout(() => {
    if (!input.isConnected) return;
    input.dataset.arm = "1";
    input.focus();
    input.select();
  }, 0);
}

function finishGroupNameEdit(input) {
  if (!input?.isConnected || !input.classList?.contains("is-editing")) return;
  if (input.dataset.arm !== "1") return;
  const cancel = input.dataset.cancel === "1";
  input.classList.remove("is-editing");
  const groupId = input.dataset.groupId;
  const value = cancel ? input.dataset.original || "" : input.value;
  if (!cancel) {
    // renameGroup 内部已调 renderGroups / syncSelectBar / renderCanvas
    renameGroup(groupId, value);
  } else {
    // Esc 取消 → 重建 pill 以撤掉 input
    renderGroups();
  }
}

function ungroup(groupId) {
  const project = canvasUi.project;
  if (!project) return;
  project.groups = (project.groups || []).filter((g) => g.id !== groupId);
  if (canvasUi.selectedGroupId === groupId) canvasUi.selectedGroupId = null;
  syncSelectBar();
  renderGroups();
  renderCanvas();   // 让侧栏 cardList 同步（侧栏按组展示）
  writeProject(project);
}


function selectGroup(groupId) {
  if (!groupId) return;
  clearSelection();
  canvasUi.selectedGroupId = groupId;
  syncSelectionClasses();
  syncSelectBar();
  renderGroups();
}

function clearGroupSelection() {
  if (!canvasUi.selectedGroupId) return;
  canvasUi.selectedGroupId = null;
  syncSelectionClasses();
  syncSelectBar();
  renderGroups();
}

function renderGroups() {
  // 局部刷新：只更新 groupsLayer 内的元素，避免重画整个 board
  const project = canvasUi.project;
  const layer = byId("groupsLayer");
  if (!layer || !project) return;
  layer.innerHTML = (project.groups || []).map(groupMarkup).join("");
  schedulePlaceGroupToolbar();
}

// 修改 clearSelection / setSelection，让它们也清掉组的选中
const _origClearSelection = clearSelection;  // 不需要 hook，原函数要改

function parseSelKey(key) {
  const index = String(key).indexOf(":");
  if (index < 0) return null;
  return { kind: key.slice(0, index), id: key.slice(index + 1) };
}

function clearSelection() {
  if (canvasUi.selection.size) {
    canvasUi.selection.clear();
    document.querySelectorAll(".asset.is-selected, .vnode.is-selected").forEach((node) => {
      node.classList.remove("is-selected");
    });
  }
  if (canvasUi.selectedGroupId) {
    canvasUi.selectedGroupId = null;
    document.querySelectorAll(".group-rect.is-selected").forEach((node) => {
      node.classList.remove("is-selected");
    });
  }
  syncSelectBar();
}

function setSelection(keys, { additive = false } = {}) {
  if (!additive) canvasUi.selection.clear();
  keys.forEach((key) => canvasUi.selection.add(key));
  syncSelectionClasses();
  syncSelectBar();
}

function toggleSelection(key) {
  if (canvasUi.selection.has(key)) canvasUi.selection.delete(key);
  else canvasUi.selection.add(key);
  syncSelectionClasses();
  syncSelectBar();
}

function syncSelectionClasses() {
  document.querySelectorAll(".asset[data-card], .vnode[data-video]").forEach((node) => {
    const kind = node.dataset.card ? "card" : "video";
    const id = node.dataset.card || node.dataset.video;
    node.classList.toggle("is-selected", canvasUi.selection.has(selKey(kind, id)));
  });
  syncSelectBar();
}

function syncSelectBar() {
  const bar = byId("selectBar");
  if (!bar) return;
  const elementCount = canvasUi.selection.size + (canvasUi.selectedLinkId ? 1 : 0);
  const groupId = canvasUi.selectedGroupId;

  // 默认：元素选择模式；组选中模式切到组编辑工具
  bar.classList.toggle("is-group", Boolean(groupId));
  bar.hidden = elementCount === 0 && !groupId;

  const label = byId("selectBarLabel");
  if (groupId) {
    // 组模式下隐藏标题栏（组名/成员数已由 #groupNameInput + 计数胶囊承担）
    if (label) label.textContent = "";
  } else if (label) {
    label.textContent = elementCount > 1 ? `已选 ${elementCount} 个` : "已选 1 个";
  }

  // 显隐变化后异步定位（offsetHeight 需要 layout 后才稳定）
  schedulePlaceGroupToolbar();

  // 同步 selectBar 里的按钮状态
  const btnGroup = byId("groupSelectionBtn");
  if (btnGroup) {
    btnGroup.hidden = elementCount < 2 || Boolean(groupId);
    btnGroup.disabled = elementCount < 2;
  }

  // 同步颜色面板 + 组名输入
  const groupPanel = byId("groupPanel");
  if (groupPanel) {
    groupPanel.hidden = !groupId;
    if (groupId) {
      const group = findGroup(groupId);
      const nameInput = byId("groupNameInput");
      if (nameInput && group && document.activeElement !== nameInput) {
        nameInput.value = group.name || "";
      }
      const colorInput = byId("groupColorInput");
      if (colorInput && group) {
        colorInput.value = group.color || "#3b82f6";
      }
      // 高亮当前色
      document.querySelectorAll(".color-swatch").forEach((sw) => {
        sw.classList.toggle(
          "is-current",
          group && (sw.dataset.color || "").toLowerCase() === (group.color || "").toLowerCase()
        );
      });
    }
  }
}

function selectionEntries() {
  const list = [];
  canvasUi.selection.forEach((key) => {
    const parsed = parseSelKey(key);
    if (!parsed) return;
    const point = parsed.kind === "video" ? findVideo(parsed.id) : findCard(parsed.id);
    if (!point) return;
    list.push({ kind: parsed.kind, id: parsed.id, x: point.x, y: point.y });
  });
  return list;
}

const byId = (id) => document.getElementById(id);
function canvasUid() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

function escapeText(text) {
  return String(text || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function shortTitle(prompt) {
  let text = String(prompt || "").replace(/\s+/g, " ").trim();
  text = text.replace(/^[>#*\s]+/, "").replace(/\*\*/g, "");
  const parts = text.split(/[，。,.！？!?：:]/).map((part) => part.trim()).filter(Boolean);
  const name = parts[0] && parts[0].length <= 6 && parts[1] ? parts[1] : (parts[0] || "未命名");
  return name.length > 18 ? `${name.slice(0, 18)}…` : name;
}

function openCanvasDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("agnes-canvas", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function normalizeProject(project) {
  project.cards = (project.cards || []).filter((card) => {
    if (card.type === "environment") card.type = "scene";
    return CARD_TYPES.includes(card.type);
  });
  if (!Array.isArray(project.links)) {
    project.links = [];
    const seen = new Set();
    const legacySelected = project.composer?.selected || project.videos?.[0]?.selected || [];
    legacySelected.forEach((item) => {
      if (seen.has(item.cardId)) return;
      seen.add(item.cardId);
      project.links.push({
        id: canvasUid(),
        from: item.cardId,
        fromSide: "right",
        to: "video",
        toSide: "left",
      });
    });
  }
  ensureVideos(project);
  return project;
}

async function serverProjects() {
  const resp = await fetch("/api/projects", { cache: "no-store" });
  if (!resp.ok) throw new Error("服务端作品接口异常");
  const payload = await resp.json();
  return Array.isArray(payload?.projects) ? payload.projects : [];
}

async function serverSaveProject(project) {
  const serialized = await serializeProject(project);
  const resp = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(serialized),
  });
  if (!resp.ok) throw new Error("保存到服务端失败");
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function uploadProjectImage(projectId, imageId, blob) {
  const dataUrl = await blobToDataUrl(blob);
  const response = await fetch("/api/projects/images", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, imageId, blob: dataUrl }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok || !result.url) {
    throw new Error(result.error || "图片上传失败");
  }
  return result.url;
}

async function serializeProject(project) {
  const copy = Array.isArray(project) ? [...project] : { ...project };
  if (copy.cards) {
    copy.cards = await Promise.all(copy.cards.map(async (card) => {
      const cardCopy = { ...card };
      if (Array.isArray(cardCopy.images)) {
        cardCopy.images = await Promise.all(cardCopy.images.map(async (image) => {
          const imageCopy = { ...image };
          if (imageCopy.blob instanceof Blob) {
            imageCopy.blob = await blobToDataUrl(imageCopy.blob);
          } else if (imageCopy.blob && typeof imageCopy.blob === "object") {
            // 空对象 {}：说明 Blob 曾因序列化丢失，置空避免继续写死
            imageCopy.blob = null;
          }
          return imageCopy;
        }));
      }
      return cardCopy;
    }));
  }
  if (copy.cover instanceof Blob) copy.cover = await blobToDataUrl(copy.cover);
  return copy;
}

async function serverRemoveProject(id) {
  const resp = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!resp.ok) throw new Error("服务端删除失败");
}

async function readProjects() {
  let rows = [];
  let serverOk = false;
  try {
    rows = await serverProjects();
    serverOk = true;
  } catch (error) {
    console.warn("服务端读取失败，回退本地 IndexedDB：", error);
  }
  if (serverOk) {
    rows.forEach(normalizeProject);
    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    let localRows = [];
    try {
      const db = await openCanvasDb();
      localRows = await new Promise((resolve, reject) => {
        const request = db.transaction("projects").objectStore("projects").getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
      db.close();
    } catch (error) {
      console.warn("本地缓存读取失败：", error);
    }
    mergeLocalBlobs(rows, localRows);
    try {
      const db = await openCanvasDb();
      const tx = db.transaction("projects", "readwrite");
      const store = tx.objectStore("projects");
      rows.forEach((project) => store.put(project));
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch (error) {
      console.warn("本地缓存写入失败：", error);
    }
  } else {
    const db = await openCanvasDb();
    const local = await new Promise((resolve, reject) => {
      const request = db.transaction("projects").objectStore("projects").getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    db.close();
    rows = local.map(normalizeProject);
    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  canvasUi.projects = rows;
}

function mergeLocalBlobs(serverRows, localRows) {
  if (!Array.isArray(localRows) || !localRows.length) return;
  const localById = new Map(localRows.map((item) => [item.id, item]));
  for (const project of serverRows) {
    const local = localById.get(project.id);
    if (!local) continue;
    const localCardById = new Map((local.cards || []).map((card) => [card.id, card]));
    for (const card of project.cards || []) {
      const localCard = localCardById.get(card.id);
      if (!localCard) continue;
      const localImageById = new Map((localCard.images || []).map((image) => [image.id, image]));
      for (const image of card.images || []) {
        if (image.blob) continue;
        const localImage = localImageById.get(image.id);
        if (localImage && localImage.blob) image.blob = localImage.blob;
      }
    }
  }
}

async function writeProject(project) {
  project.updatedAt = Date.now();
  try {
    await serverSaveProject(project);
  } catch (error) {
    console.warn("服务端保存失败：", error);
  }
  try {
    const db = await openCanvasDb();
    await new Promise((resolve, reject) => {
      const request = db.transaction("projects", "readwrite").objectStore("projects").put(project);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
  } catch (error) {
    console.warn("本地缓存写入失败：", error);
  }
  const index = canvasUi.projects.findIndex((item) => item.id === project.id);
  if (index >= 0) canvasUi.projects[index] = project;
  else canvasUi.projects.unshift(project);
  canvasUi.projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function removeProject(id) {
  try {
    await serverRemoveProject(id);
  } catch (error) {
    console.warn("服务端删除失败：", error);
  }
  try {
    const db = await openCanvasDb();
    await new Promise((resolve, reject) => {
      const request = db.transaction("projects", "readwrite").objectStore("projects").delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
  } catch (error) {
    console.warn("本地缓存删除失败：", error);
  }
  canvasUi.projects = canvasUi.projects.filter((item) => item.id !== id);
}

function blankVideo(at = null) {
  return {
    id: canvasUid(),
    title: "视频生成",
    x: at ? at.x - 180 : 680,
    y: at ? at.y - 40 : 48,
    prompt: "",
    model: "agnes-video-2.5-flash",
    seconds: 5,
    aspect: "16:9",
    size: "720P",
    selected: [],
    activeId: null,
    generations: [],
  };
}

function blankProject() {
  return {
    id: canvasUid(),
    name: "未命名作品",
    brief: "",
    cover: null,
    updatedAt: Date.now(),
    view: { x: 48, y: 36, scale: 1 },
    cards: [],
    videos: [blankVideo()],
    links: [],
    groups: [],
  };
}

function ensureVideos(project) {
  if (!project) return project;
  if (Array.isArray(project.videos) && project.videos.length) {
    project.videos.forEach((video) => {
      if (!video.title) video.title = "视频生成";
      video.model = normalizeModel(video.model);
      if (!Array.isArray(video.selected)) video.selected = [];
      if (!Array.isArray(video.generations)) video.generations = [];
      video.generations = video.generations.filter((item) => item.status !== "failed");
    });
    delete project.composer;
    delete project.generations;
    return project;
  }
  const legacy = project.composer || {};
  const video = {
    id: canvasUid(),
    title: "视频生成",
    x: Number.isFinite(legacy.x) ? legacy.x : 680,
    y: Number.isFinite(legacy.y) ? legacy.y : 48,
    prompt: legacy.prompt || "",
    model: normalizeModel(legacy.model),
    seconds: legacy.seconds || 5,
    aspect: legacy.aspect || "16:9",
    size: "720P",
    selected: (legacy.selected || []).map((item) => ({ ...item })),
    activeId: legacy.activeId || null,
    generations: (project.generations || []).filter((item) => item.status !== "failed"),
  };
  (project.links || []).forEach((link) => {
    if (link.from === "video") link.from = video.id;
    if (link.to === "video") link.to = video.id;
  });
  project.videos = [video];
  delete project.composer;
  delete project.generations;
  return project;
}

function findVideo(id) {
  return canvasUi.project?.videos?.find((video) => video.id === id);
}

function isVideoTarget(id) {
  return id === "video" || Boolean(findVideo(id));
}

function videoEl(id) {
  return document.querySelector(`[data-video="${id}"]`);
}

function pickingVideo() {
  return findVideo(canvasUi.pickingVideoId);
}

function blobUrl(image) {
  if (!image || !image.blob) return "";
  if (typeof image.blob === "string") return image.blob;
  if (!canvasUi.urls.has(image.id)) canvasUi.urls.set(image.id, URL.createObjectURL(image.blob));
  return canvasUi.urls.get(image.id);
}

function dropBlob(id) {
  const url = canvasUi.urls.get(id);
  if (url) URL.revokeObjectURL(url);
  canvasUi.urls.delete(id);
}

function findCard(id) {
  return canvasUi.project?.cards.find((card) => card.id === id);
}

function findImage(card, imageId) {
  return card?.images.find((image) => image.id === imageId);
}

function selectNumber(cardId, imageId) {
  const video = pickingVideo() || canvasUi.project?.videos?.[0];
  const index = (video?.selected || []).findIndex((item) => item.cardId === cardId && item.imageId === imageId);
  return index >= 0 ? index + 1 : 0;
}

function setView(name) {
  byId("bench").hidden = name !== "bench";
  byId("worksHome").hidden = name !== "works";
  byId("canvasView").hidden = name !== "canvas";
  byId("logsView").hidden = name !== "logs";
  // toolsView 已删除 —— 工具模块下线
  document.body.classList.toggle("canvas-focus", name === "canvas");
  document.body.classList.toggle("logs-focus", name === "logs");
  const works = name === "works";
  const logs = name === "logs";
  byId("pageTitle").textContent = logs
    ? "操作日志"
    : works
      ? "作品集"
      : "秋白漫剧工作台";
  byId("openWorkDialog").hidden = !works;
  byId("titleHelp").hidden = works || logs;
  document.querySelectorAll(".side-tab").forEach((button) => {
    const view = button.dataset.view;
    const on = view === "canvas"
      ? name === "works" || name === "canvas" || name === "logs"
      : name === view;
    button.classList.toggle("on", on);
  });
  // 工具模块（去水印/超分）已移除，原本这里会调 renderTools()，现在不需要
}

function coverUrl(project) {
  if (project.cover) return blobUrl({ id: `cover-${project.id}`, blob: project.cover });
  for (const card of project.cards || []) {
    const image = (card.images || []).find((item) => item.blob);
    if (image) return blobUrl(image);
  }
  return "";
}

function renderWorks() {
  const grid = byId("workGrid");
  if (!canvasUi.projects.length) {
    grid.innerHTML = `<p class="slot-label">还没有作品。</p>`;
    return;
  }
  grid.innerHTML = canvasUi.projects.map((project) => {
    const cover = coverUrl(project);
    const picture = cover
      ? `<img alt="" src="${cover}">`
      : `<div class="work-cover">${escapeText((project.name || "作").slice(0, 1))}</div>`;
    return `<article class="work-card">
      <button type="button" class="open" data-act="open-project" data-id="${project.id}">
        ${picture}
        <b>${escapeText(project.name || "未命名作品")}</b>
        <span>${escapeText(project.brief || "暂无简介")}</span>
      </button>
      ${iconBtn("删除", "trash", `data-act="delete-project" data-id="${project.id}"`)}
    </article>`;
  }).join("");
}

function applyView() {
  const board = byId("board");
  const viewport = byId("viewport");
  if (!board) return;
  const view = canvasUi.view;
  board.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  if (viewport) {
    const size = 22 * (view.scale || 1);
    viewport.style.backgroundSize = `${size}px ${size}px`;
    viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
  }
  const label = byId("zoomLabel");
  if (label) label.textContent = `${Math.round(view.scale * 100)}%`;
  schedulePlaceGroupToolbar();
}

// 计算当前选中元素（卡片/视频）的 board 坐标包围盒
function computeSelectionBounds() {
  const items = selectionEntries();
  if (!items.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const item of items) {
    const sz = itemSize(item.kind, item.id);
    if (item.x < minX) minX = item.x;
    if (item.y < minY) minY = item.y;
    if (item.x + sz.w > maxX) maxX = item.x + sz.w;
    if (item.y + sz.h > maxY) maxY = item.y + sz.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// 把 selectBar 定位到指定 board 坐标 bbox 的正上方（水平居中）
function positionBarAboveBounds(bounds) {
  const bar = byId("selectBar");
  if (!bar || !bounds) return;
  const scale = canvasUi.view.scale || 1;
  const vx = canvasUi.view.x || 0;
  const vy = canvasUi.view.y || 0;
  const gap = 12;
  const centerX = (bounds.x + bounds.w / 2) * scale + vx;
  const topY = bounds.y * scale + vy;
  bar.style.left = `${centerX}px`;
  bar.style.top = `${topY - bar.offsetHeight - gap}px`;
  bar.style.bottom = "auto";
  bar.style.transform = "translateX(-50%)";
}

// 三态：组模式 → 上方组；多选模式 → 上方选区；其他 → 默认顶部居中
function placeGroupToolbar() {
  const bar = byId("selectBar");
  if (!bar) return;
  if (bar.hidden) {
    bar.style.top = "";
    bar.style.left = "";
    bar.style.bottom = "";
    bar.style.transform = "translateX(-50%)";
    return;
  }
  // 1) 组模式
  const gid = canvasUi.selectedGroupId;
  const group = gid ? findGroup(gid) : null;
  if (group) {
    const bounds = computeGroupBounds(group);
    if (bounds) { positionBarAboveBounds(bounds); return; }
  }
  // 2) 元素多选模式（≥2 个，且没有组被选中）
  if (!group && canvasUi.selection.size >= 2) {
    const bounds = computeSelectionBounds();
    if (bounds) { positionBarAboveBounds(bounds); return; }
  }
  // 3) 默认：CSS 顶部居中
  bar.style.top = "";
  bar.style.left = "";
  bar.style.bottom = "";
  bar.style.transform = "translateX(-50%)";
}

let __placeGroupRaf = null;
function schedulePlaceGroupToolbar() {
  if (__placeGroupRaf) return;
  __placeGroupRaf = requestAnimationFrame(() => {
    __placeGroupRaf = null;
    placeGroupToolbar();
  });
}

function zoomAt(nextScale, px, py) {
  const prev = canvasUi.view.scale || 1;
  const next = Math.min(20, Math.max(0.02, nextScale));
  canvasUi.view.x = px - (px - canvasUi.view.x) * (next / prev);
  canvasUi.view.y = py - (py - canvasUi.view.y) * (next / prev);
  canvasUi.view.scale = next;
  if (canvasUi.project) canvasUi.project.view = { ...canvasUi.view };
  applyView();
  renderHeroToolbar();
  placeVideoToolbar();
  clearTimeout(canvasUi.viewTimer);
  canvasUi.viewTimer = setTimeout(() => {
    if (canvasUi.project) writeProject(canvasUi.project);
  }, 250);
}

function renderCardList() {
  const list = byId("cardList");
  if (!list || !canvasUi.project) return;
  const project = canvasUi.project;
  const cards = project.cards;
  const groups = project.groups || [];

  // 建立 cardId → group 映射（一个卡可能属于多个组，但侧栏只展示第一个匹配的组）
  const cardToGroup = new Map();
  for (const group of groups) {
    for (const ref of group.members || []) {
      if (ref.kind === "card" && !cardToGroup.has(ref.id)) {
        cardToGroup.set(ref.id, group);
      }
    }
  }

  const cardRow = (card) => `
    <li>
      <button type="button" data-act="focus-card" data-id="${card.id}">${escapeText(CARD_LABEL[card.type] || "卡片")} · ${escapeText(card.title)}</button>
      ${iconBtn("删除", "trash", `data-act="delete-card" data-id="${card.id}"`)}
    </li>`;

  // 先按组顺序输出已分组的卡
  const groupedIds = new Set();
  const groupSections = groups.map((group) => {
    const members = (group.members || []).filter((ref) => ref.kind === "card");
    const rows = members.map((ref) => {
      const card = cards.find((c) => c.id === ref.id);
      if (!card) return "";
      groupedIds.add(card.id);
      return cardRow(card);
    }).join("");
    if (!rows) return "";
    const color = group.color || "#3b82f6";
    const name = group.name || "未命名组";
    return `
      <li class="side-group" data-side-group="${group.id}">
        <header class="side-group-head">
          <span class="side-group-dot" style="background:${escapeText(color)}"></span>
          <span class="side-group-name">${escapeText(name)}</span>
          <span class="side-group-count">${members.length}</span>
        </header>
        <ul class="side-list-inner">${rows}</ul>
      </li>`;
  }).filter(Boolean).join("");

  // 末尾追加未分组的卡
  const ungroupedCards = cards.filter((c) => !groupedIds.has(c.id));
  const ungroupedSection = ungroupedCards.length
    ? `<li class="side-group side-group--ungrouped">
        <header class="side-group-head">
          <span class="side-group-dot side-group-dot--ghost"></span>
          <span class="side-group-name">未分组</span>
          <span class="side-group-count">${ungroupedCards.length}</span>
        </header>
        <ul class="side-list-inner">${ungroupedCards.map(cardRow).join("")}</ul>
      </li>`
    : "";

  list.innerHTML = groupSections + ungroupedSection;
}

function imageFigure(card, image, large) {
  const number = selectNumber(card.id, image.id);
  const pure = card.type === "character" ? " pure-shot" : "";
  return `<figure class="${card.type === "character" ? "pure-figure" : ""}">
    <img class="${large ? "hero-shot" : "thumb-shot"}${pure}" alt="${escapeText(image.name)}" src="${blobUrl(image)}" draggable="false" ${card.type === "character" ? `data-act="toggle-toolbar" data-id="${card.id}"` : ""}>
    ${number ? `<span class="badge">${number}</span>` : ""}
    <figcaption>${escapeText(image.name)}</figcaption>
    ${card.type === "character"
      ? `<i class="pure-hit" data-act="toggle-toolbar" data-id="${card.id}"></i>`
      : `<div class="icon-row" data-stop="1">
      ${iconBtn("更换", "swap", `data-act="replace-image" data-card="${card.id}" data-image="${image.id}"`)}
      ${iconBtn("删除", "trash", `data-act="delete-image" data-card="${card.id}" data-image="${image.id}"`)}
    </div>`}
  </figure>`;
}

function cardMarkup(card) {
  const heroes = card.images.filter((image) => image.role === "hero");
  const isCharacter = card.type === "character";
  const hasHero = isCharacter && heroes.length > 0;
  const pureBar = hasHero ? `<div class="pure-bar">
        <button type="button" class="pure-title" data-act="edit-title" data-id="${card.id}">${escapeText(card.title)}</button>
      </div>` : "";
  const pictures = isCharacter
    ? `<div class="hero-slot${hasHero ? " pure" : ""}">${pureBar}${heroes.map((image, index) => imageFigure(card, image, index === 0)).join("")}</div>`
      + (hasHero ? "" : `
       ${iconBtn("上传图片", "plus", `data-act="upload" data-id="${card.id}" data-slot="hero" data-multiple="1"`)}`)
    : `<p class="slot-label">${card.type === "scene" || card.type === "environment" ? "场景" : "道具"}</p>
       <div class="turns">${card.images.map((image) => imageFigure(card, image, false)).join("")}</div>
       ${iconBtn("上传图片", "plus", `data-act="upload" data-id="${card.id}" data-slot="image" data-multiple="1"`)}`;
  const pickTarget = pickingVideo();
  const picked = Boolean(pickTarget?.selected.some((item) => item.cardId === card.id));
  const selected = canvasUi.selection.has(selKey("card", card.id)) ? " is-selected" : "";
  const imageFlags = imageGenFlags(card);
  const genBusy = imageFlags.genBusy;
  const genHold = imageFlags.genHold;
  const genErr = canvasUi.imageError && canvasUi.imageErrorCardId === card.id ? canvasUi.imageError : "";
  const imageSizes = IMAGE_SIZE_CHOICES.map(([value, label]) =>
    `<option value="${value}" ${card.imageSize === value ? "selected" : ""}>${label}</option>`).join("");
  const imageModels = IMAGE_MODEL_CHOICES.map(([value, label]) =>
    `<option value="${value}" ${(card.imageModel || IMAGE_GEN_MODEL) === value ? "selected" : ""}>${label}</option>`).join("");
  const toolbarOpen = hasHero && Boolean(card.toolbarOpen);
  const genUi = `<div class="asset-gen${hasHero ? " toolbar" : ""}" data-toolbar="${card.id}" ${hasHero && !toolbarOpen ? "hidden" : ""}>
    ${hasHero ? `
    <div class="asset-gen-tools">
      <span class="toolbar-heroes">
        ${heroes.map((image) => `
          <span class="toolbar-hero-row">
            <i class="hero-name" title="${escapeText(card.title)}">${escapeText(card.title)}</i>
            ${iconBtn("删除", "trash", `data-act="delete-image" data-card="${card.id}" data-image="${image.id}"`)}
          </span>`).join("")}
      </span>
      <span class="toolbar-actions">
        ${iconBtn("上传图片", "plus", `data-act="upload" data-id="${card.id}" data-slot="hero" data-multiple="1"`)}
      </span>
    </div>` : ""}
    <textarea data-field="image-prompt" data-id="${card.id}" placeholder="输入提示词生成图片；卡片已有图片会自动作为参考（图生图）。" ${genHold ? "readonly" : ""}>${escapeText(card.prompt || "")}</textarea>
    <div class="asset-gen-controls" ${genHold ? "hidden" : ""}>
      <label>模型<select data-field="image-model" data-id="${card.id}">${imageModels}</select></label>
      ${hasHero ? "" : `<label>画幅<select data-field="image-size" data-id="${card.id}">${imageSizes}</select></label>`}
      <button type="button" class="go" data-act="generate-image" data-id="${card.id}">生成</button>
    </div>
    <p class="warn" data-field="image-error" data-id="${card.id}" ${genErr ? "" : "hidden"}>${escapeText(genErr || "")}</p>
    <div class="vnode-progress" data-image-live="${card.id}" ${genHold ? "" : "hidden"}>
      <b data-image-live-title>${imageFlags.genWaiting ? "排队等待" : (genBusy ? "正在生成" : "")}</b>
      <span data-image-live-detail>${imageFlags.genWaiting ? escapeText(imageFlags.waitText) : (genBusy ? escapeText(canvasUi.imageLiveDetail || "正在提交") : "")}</span>
      <div class="bar"><i data-image-live-bar style="width:${genBusy ? (canvasUi.imageLiveProgress || 0) : 0}%"></i></div>
    </div>
  </div>`;
  const busyClass = genBusy ? " is-generating" : "";
  const isText = card.type === "text";
  const textUi = isText
    ? `<textarea class="asset-text" data-field="text" data-id="${card.id}" placeholder="输入任意文本内容…">${escapeText(card.text || "")}</textarea>`
    : "";
  return `<article class="asset${picked && canvasUi.picking ? " is-pick-selected" : ""}${canvasUi.picking ? " is-pickable" : ""}${selected}${busyClass}${hasHero ? " is-pure" : ""}" data-card="${card.id}" style="left:${card.x}px;top:${card.y}px">
    <button type="button" class="port port-left" data-act="port" data-id="${card.id}" data-side="left" aria-label="连接左侧" data-tip="连接左侧"></button>
    <button type="button" class="port port-right" data-act="port" data-id="${card.id}" data-side="right" aria-label="连接右侧" data-tip="连接右侧"></button>
    <div class="asset-body">
      <header>
        <span class="grip" data-drag="card" data-id="${card.id}">⋮⋮</span>
        <input data-act="rename-card" data-id="${card.id}" value="${escapeText(card.title)}">
        ${iconBtn("删除", "trash", `data-act="delete-card" data-id="${card.id}"`)}
      </header>
      ${isText ? "" : pictures}
      ${isText ? "" : (hasHero ? "" : genUi)}
      ${textUi}
    </div>
  </article>`;
}

function heroToolbarMarkup(card) {
  const heroes = card.images.filter((image) => image.role === "hero");
  const imageFlags = imageGenFlags(card);
  const genBusy = imageFlags.genBusy;
  const genHold = imageFlags.genHold;
  const genWaiting = imageFlags.genWaiting;
  const waitText = imageFlags.waitText;
  const genErr = canvasUi.imageError && canvasUi.imageErrorCardId === card.id ? canvasUi.imageError : "";
  const imageModels = IMAGE_MODEL_CHOICES.map(([value, label]) =>
    `<option value="${value}" ${(card.imageModel || IMAGE_GEN_MODEL) === value ? "selected" : ""}>${label}</option>`).join("");
  return `<div class="hero-toolbar" data-toolbar="${card.id}">
    <div class="asset-gen-tools">
      <span class="toolbar-heroes">
        ${heroes.map((image) => `
          <span class="toolbar-hero-row">
            <i class="hero-name" title="${escapeText(card.title)}">${escapeText(card.title)}</i>
            ${iconBtn("删除", "trash", `data-act="delete-image" data-card="${card.id}" data-image="${image.id}"`)}
          </span>`).join("")}
      </span>
      <span class="toolbar-actions">
        ${iconBtn("上传图片", "plus", `data-act="upload" data-id="${card.id}" data-slot="hero" data-multiple="1"`)}
      </span>
    </div>
    <textarea data-field="image-prompt" data-id="${card.id}" placeholder="输入提示词生成图片；卡片已有图片会自动作为参考（图生图）。" ${genHold ? "readonly" : ""}>${escapeText(card.prompt || "")}</textarea>
    <div class="asset-gen-controls" ${genHold ? "hidden" : ""}>
      <label>模型<select data-field="image-model" data-id="${card.id}">${imageModels}</select></label>
      <button type="button" class="go" data-act="generate-image" data-id="${card.id}">生成</button>
    </div>
    <p class="warn" data-field="image-error" data-id="${card.id}" ${genErr ? "" : "hidden"}>${escapeText(genErr || "")}</p>
    <div class="vnode-progress" data-image-live="${card.id}" ${genHold ? "" : "hidden"}>
      <b data-image-live-title>${genWaiting ? "排队等待" : (genBusy ? "正在生成" : "")}</b>
      <span data-image-live-detail>${genWaiting ? escapeText(waitText) : (genBusy ? escapeText(canvasUi.imageLiveDetail || "正在提交") : "")}</span>
      <div class="bar"><i data-image-live-bar style="width:${genBusy ? (canvasUi.imageLiveProgress || 0) : 0}%"></i></div>
    </div>
  </div>`;
}

function openHeroCard() {
  return canvasUi.project?.cards.find((card) => card.toolbarOpen
    && card.type === "character" && (card.images || []).some((image) => image.role === "hero"));
}

const FLOAT_TOOLBAR_WIDTH = 360;

function boardBox(el) {
  const board = byId("board");
  if (!el || !board) return null;
  let x = 0;
  let y = 0;
  let node = el;
  while (node && node !== board) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

function placeFloatToolbar(node, anchor, width = FLOAT_TOOLBAR_WIDTH) {
  const board = byId("board");
  const box = boardBox(anchor);
  if (!node || !board || !box) return;
  if (node.parentElement !== board) board.appendChild(node);
  node.style.position = "absolute";
  const toolbarWidth = width > 0 ? width : FLOAT_TOOLBAR_WIDTH;
  node.style.width = `${toolbarWidth}px`;
  node.style.maxWidth = `${toolbarWidth}px`;
  node.style.transform = "none";
  node.style.zIndex = "30";
  const gap = 12;
  if (node.dataset.side == null) {
    const scale = canvasUi.view.scale || 1;
    const rect = anchor.getBoundingClientRect();
    const screenH = (node.offsetHeight || 180) * scale;
    const below = window.innerHeight - rect.bottom;
    node.dataset.side = below < screenH + gap * scale && rect.top > screenH + 16 ? "top" : "bottom";
  }
  const top = node.dataset.side === "top"
    ? box.y - gap - node.offsetHeight
    : box.y + box.h + gap;
  node.style.left = `${box.x}px`;
  node.style.top = `${Math.round(top)}px`;
}

function placeHeroToolbar() {
  const node = byId("heroToolbar");
  const card = openHeroCard();
  if (!node || !card) return;
  if (node.dataset.for !== card.id) {
    delete node.dataset.side;
    delete node.dataset.dx;
    node.dataset.for = card.id;
  }
  const img = document.querySelector(`[data-card="${card.id}"] .hero-slot.pure img`);
  const cardNode = document.querySelector(`[data-card="${card.id}"]`);
  placeFloatToolbar(node, img || cardNode, img?.offsetWidth || cardNode?.offsetWidth || FLOAT_TOOLBAR_WIDTH);
}

function renderHeroToolbar() {
  const board = byId("board");
  let node = byId("heroToolbar");
  const card = openHeroCard();
  if (!card || !board) {
    node?.remove();
    return;
  }
  if (!node) {
    node = document.createElement("div");
    node.id = "heroToolbar";
    board.appendChild(node);
  }
  node.dataset.toolbar = card.id;
  node.innerHTML = heroToolbarMarkup(card);
  placeHeroToolbar();
}

function videoControlsMarkup(video) {
  const busy = videoBusy(video);
  const pickingHere = canvasUi.picking && canvasUi.pickingVideoId === video.id;
  const models = MODEL_CHOICES.map(([value, label]) =>
    `<option value="${value}" ${video.model === value ? "selected" : ""}>${label}</option>`).join("");
  const seconds = Array.from({ length: 9 }, (_, index) => index + 4).map((value) =>
    `<option value="${value}" ${Number(video.seconds) === value ? "selected" : ""}>${value} 秒</option>`).join("");
  const aspects = ASPECT_CHOICES.map(([value, label]) =>
    `<option value="${value}" ${video.aspect === value ? "selected" : ""}>${label}</option>`).join("");
  const records = visibleGenerations(video);
  const active = records.find((item) => item.id === video.activeId)
    || records.find(isGenBusy)
    || records.find((item) => item.status === "completed");
  const live = active && isGenBusy(active);
  const picked = (video.selected || []).map((item, index) => {
    const card = findCard(item.cardId);
    const image = findImage(card, item.imageId);
    if (!image) return "";
    const remove = busy
      ? ""
      : `<button type="button" class="pick-remove" data-act="remove-ref" data-video="${video.id}" data-card="${item.cardId}" data-image="${item.imageId}" aria-label="移除参考图" data-tip="移除参考图">×</button>`;
    return `<figure class="pick-thumb">
      <img alt="" src="${blobUrl(image)}">
      <span class="badge">${index + 1}</span>
      ${remove}
    </figure>`;
  }).join("");
  const pickUi = busy
    ? ""
    : pickingHere
      ? `<div class="pick-float">
           <button type="button" class="ghost" data-act="pick-cancel">取消</button>
           <button type="button" class="go" data-act="pick-done">完成</button>
         </div>`
      : iconBtn("选择画布资源", "pick", `data-act="pick-resources" data-video="${video.id}" class="icon-btn pick-entry"`);
  const lock = busy ? "disabled" : "";
  const err = canvasUi.errorVideoId === video.id ? canvasUi.error : "";
  return `${pickUi}
    <div class="picked">${picked}</div>
    <textarea data-field="prompt" placeholder="可以用图片1、图片2指代上面选中的参考图。" ${busy ? "readonly" : ""}>${escapeText(video.prompt)}</textarea>
    <div class="vnode-controls" ${busy ? "hidden" : ""}>
      <label>模型<select data-field="model" ${lock}>${models}</select></label>
      <label>时长<select data-field="seconds" ${lock}>${seconds}</select></label>
      <label>画幅<select data-field="aspect" ${lock}>${aspects}</select></label>
      <label>分辨率<select data-field="size" ${lock}><option value="720P" selected>720P</option></select></label>
    </div>
    <button type="button" class="go" data-act="generate-video" data-video="${video.id}" ${busy ? "hidden" : ""}>生成</button>
    <p class="warn" data-field="error" ${err ? "" : "hidden"}>${escapeText(err || "")}</p>
    <div class="vnode-progress" data-live ${live ? "" : "hidden"}>
      <b data-live-title>${escapeText(live ? liveTitle(active) : "")}</b>
      <span data-live-detail>${escapeText(active?.detail || (live ? historyStatus(active) : ""))}</span>
      <div class="bar"><i data-live-bar style="width:${live ? (active.progress || 0) : 0}%"></i></div>
    </div>`;
}

function placeVideoToolbar() {
  const node = byId("videoToolbar");
  const video = findVideo(canvasUi.videoToolbarId);
  if (!node || !video) return;
  if (node.dataset.for !== video.id) {
    delete node.dataset.side;
    node.dataset.for = video.id;
  }
  node.dataset.side = "bottom";
  const anchor = document.querySelector(`[data-video="${video.id}"]`);
  placeFloatToolbar(node, anchor);
}

function renderVideoToolbar() {
  const board = byId("board");
  let node = byId("videoToolbar");
  const video = findVideo(canvasUi.videoToolbarId);
  if (!video || !shouldCollapseVideo(video) || !board) {
    node?.remove();
    if (!video) canvasUi.videoToolbarId = null;
    return;
  }
  if (!node) {
    node = document.createElement("div");
    node.id = "videoToolbar";
    board.appendChild(node);
  }
  node.dataset.toolbar = video.id;
  node.innerHTML = `<div class="hero-toolbar video-toolbar">${videoControlsMarkup(video)}</div>`;
  placeVideoToolbar();
}

function toggleVideoToolbar(videoId) {
  if (!canvasUi.project || canvasUi.picking || !videoId) return;
  const video = findVideo(videoId);
  if (!video || !shouldCollapseVideo(video)) return;
  const willOpen = canvasUi.videoToolbarId !== videoId;
  canvasUi.videoToolbarId = willOpen ? videoId : null;
  canvasUi.project.cards.forEach((item) => { item.toolbarOpen = false; });
  canvasUi.toolbarGesture = true;
  clearTimeout(canvasUi.toolbarGestureTimer);
  canvasUi.toolbarGestureTimer = setTimeout(() => { canvasUi.toolbarGesture = false; }, 100);
  renderHeroToolbar();
  renderVideoToolbar();
}

function normalizeModel(value) {
  const id = String(value || "").trim();
  return MODEL_CHOICES.some(([key]) => key === id) ? id : "agnes-video-2.5-flash";
}

function modelImageLimit(model) {
  return MODEL_IMAGE_LIMIT[normalizeModel(model)] || 5;
}

function historyStatus(gen) {
  if (gen.status === "waiting") {
    const place = gen.place || "?";
    const total = gen.queueTotal || place;
    return `排队中 · 共 ${total} 条 · 当前第 ${place} 位`;
  }
  if (gen.status === "submitting") return "正在提交";
  if (gen.status === "queued" || gen.status === "in_progress") return `正在生成 ${gen.progress || 0}%`;
  if (gen.status === "failed") return "失败";
  if (gen.status === "completed") return "已完成";
  return "待生成";
}

function applyJobQueue(gen, job, queue) {
  if (!gen || !job) return;
  if (job.place != null) gen.place = job.place;
  if (Array.isArray(queue)) gen.queueTotal = queue.length;
  else if (job.queue_total != null) gen.queueTotal = job.queue_total;
}

function liveTitle(gen) {
  if (!gen) return "正在生成";
  if (gen.status === "waiting") return "排队等待";
  if (gen.status === "submitting") return "正在提交";
  return "正在生成";
}

function isGenBusy(gen) {
  return Boolean(gen && !["completed", "failed"].includes(gen.status));
}

function visibleGenerations(video) {
  return (video?.generations || []).filter((item) => item.status !== "failed");
}

function videoBusy(video) {
  if (!video) return false;
  if (typeof video === "object" && Array.isArray(video.videos)) {
    return video.videos.some((item) => (item.generations || []).some(isGenBusy));
  }
  return (video.generations || []).some(isGenBusy);
}

function syncGenerateButton(videoId) {
  const scope = [];
  if (videoId) {
    const card = videoEl(videoId);
    if (card) scope.push(card);
    const bar = byId("videoToolbar");
    if (bar?.dataset.toolbar === videoId) scope.push(bar);
  } else {
    scope.push(...document.querySelectorAll("[data-video]"));
    const bar = byId("videoToolbar");
    if (bar) scope.push(bar);
  }
  scope.forEach((node) => {
    const id = node.dataset.video || node.dataset.toolbar;
    const video = findVideo(id);
    const button = node.querySelector('[data-act="generate-video"]');
    if (!button || !video) return;
    const busy = videoBusy(video);
    button.hidden = busy;
    button.disabled = busy;
  });
}

function dropFailedGeneration(gen, message) {
  const project = canvasUi.project;
  const video = findVideo(gen.videoId) || project?.videos?.find((item) => (item.generations || []).some((g) => g.id === gen.id));
  settleGeneration(gen);
  if (!project || !video || !gen) return;
  video.generations = video.generations.filter((item) => item.id !== gen.id);
  if (video.activeId === gen.id) {
    const next = visibleGenerations(video).find((item) => item.status === "completed");
    video.activeId = next?.id || "";
  }
  if (message) showCanvasError(message, video.id);
  canvasUi.pollers.delete(gen.id);
}

function playbackSource(gen) {
  if (!gen || gen.status !== "completed" || !(gen.local_file || gen.url)) return "";
  return gen.local_file ? `/api/jobs/${gen.jobId}/file` : gen.url;
}

function aspectCssValue(aspect) {
  const parts = String(aspect || "9:16").split(":").map((part) => Number(part));
  if (parts.length !== 2 || !parts[0] || !parts[1]) return "9 / 16";
  return `${parts[0]} / ${parts[1]}`;
}

function compactFrameWidth(aspect) {
  const parts = String(aspect || "9:16").split(":").map((part) => Number(part));
  const w = parts[0] || 9;
  const h = parts[1] || 16;
  return w >= h ? 320 : 200;
}

function completedClip(video) {
  const records = visibleGenerations(video);
  const active = records.find((item) => item.id === video.activeId && item.status === "completed")
    || records.find((item) => item.status === "completed");
  return active && playbackSource(active) ? active : null;
}

function shouldCollapseVideo(video) {
  if (!video) return false;
  return Boolean(completedClip(video));
}

function rectsOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function pushOverlapsForExpandedVideo(videoId) {
  const project = canvasUi.project;
  const video = findVideo(videoId);
  const node = videoEl(videoId);
  if (!project || !video || !node) return false;
  const gap = 24;
  const expanded = boundsAt(video.x, video.y, node.offsetWidth || 360, node.offsetHeight || 420);
  const pending = [];
  project.cards.forEach((card) => {
    const size = itemSize("card", card.id);
    pending.push({ ref: card, ...boundsAt(card.x, card.y, size.w, size.h) });
  });
  (project.videos || []).forEach((other) => {
    if (other.id === videoId) return;
    const size = itemSize("video", other.id);
    pending.push({ ref: other, ...boundsAt(other.x, other.y, size.w, size.h) });
  });

  const active = [expanded];
  let moved = false;
  while (pending.length) {
    pending.sort((a, b) => a.top - b.top || a.left - b.left);
    const idx = pending.findIndex((item) => active.some((region) => rectsOverlap(item, region)));
    if (idx < 0) break;
    const item = pending.splice(idx, 1)[0];
    let safety = 0;
    while (safety++ < 40) {
      const hit = active.find((region) => rectsOverlap(item, region));
      if (!hit) break;
      const dy = hit.bottom - item.top + gap;
      if (dy <= 0) break;
      item.top += dy;
      item.bottom += dy;
      item.y = item.top;
      item.cy = item.top + item.h / 2;
      moved = true;
    }
    item.ref.y = Math.round(item.top);
    active.push({
      left: item.left,
      right: item.right,
      top: item.top,
      bottom: item.bottom,
    });
  }
  return moved;
}

function expandVideoCard(videoId) {
  if (canvasUi.expandedVideoId === videoId) return;
  canvasUi.expandedVideoId = videoId;
  renderBoard();
  requestAnimationFrame(() => {
    if (canvasUi.expandedVideoId !== videoId) return;
    if (!pushOverlapsForExpandedVideo(videoId)) return;
    writeProject(canvasUi.project).then(() => {
      if (canvasUi.expandedVideoId !== videoId) return;
      renderBoard();
    });
  });
}

function collapseExpandedVideo(exceptId = null) {
  const id = canvasUi.expandedVideoId;
  if (!id || id === exceptId) return false;
  const video = findVideo(id);
  if (videoBusy(video)) return false;
  if (canvasUi.picking && canvasUi.pickingVideoId === id) return false;
  canvasUi.expandedVideoId = null;
  return true;
}

function isVideoChromeClick(event, videoEl) {
  if (!(videoEl instanceof HTMLVideoElement)) return false;
  const rect = videoEl.getBoundingClientRect();
  if (!rect.height) return false;
  return event.clientY > rect.bottom - 52;
}

function maybeCollapseFromEvent(event) {
  const id = canvasUi.expandedVideoId;
  if (!id) return false;
  if (event.target.closest(`[data-video="${id}"]`)) return false;
  if (event.target.closest("dialog")) return false;
  return collapseExpandedVideo();
}

function bindExclusiveVideoPlayback() {
  const board = byId("board");
  if (!board || board.dataset.exclusivePlay === "1") return;
  board.dataset.exclusivePlay = "1";
  board.addEventListener("play", (event) => {
    const media = event.target;
    if (!(media instanceof HTMLVideoElement)) return;
    board.querySelectorAll("video").forEach((other) => {
      if (other !== media && !other.paused) other.pause();
    });
  }, true);
}

function formatLogTime(value) {
  const stamp = Number(value) || 0;
  if (!stamp) return "—";
  const date = new Date(stamp > 1e12 ? stamp : stamp * 1000);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function collectProjectLogs(project) {
  const rows = [];
  (project?.videos || []).forEach((video) => {
    (video.generations || []).forEach((gen) => {
      rows.push({
        ...gen,
        videoId: video.id,
        videoTitle: video.title || "视频生成",
      });
    });
  });
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return rows;
}

function renderLogs() {
  const list = byId("logsList");
  const name = byId("logsProjectName");
  const project = canvasUi.project;
  if (!list || !project) return;
  if (name) name.textContent = project.name || "未命名作品";
  const rows = collectProjectLogs(project);
  if (!rows.length) {
    list.innerHTML = `<p class="slot-label">还没有操作记录。</p>`;
    return;
  }
  list.innerHTML = rows.map((item) => {
    const src = playbackSource(item);
    const media = src
      ? `<video controls playsinline src="${escapeText(src)}"></video>`
      : "";
    const modelLabel = item.model === "agnes-video-2.5" ? "2.5" : "2.5 Flash";
    return `<article class="log-card">
      <header>
        <strong>${escapeText(item.videoTitle)}</strong>
        <span>${escapeText(formatLogTime(item.createdAt))}</span>
      </header>
      <p class="log-meta">${escapeText(modelLabel)} · ${escapeText(historyStatus(item))}${item.seconds ? ` · ${item.seconds}s` : ""}</p>
      <p class="log-prompt">${escapeText(item.prompt || "（无提示词）")}</p>
      ${item.error ? `<p class="warn">${escapeText(item.error)}</p>` : ""}
      ${media}
    </article>`;
  }).join("");
}

function videoMarkup(video) {
  video.model = normalizeModel(video.model);
  const title = video.title || "视频生成";
  const busy = videoBusy(video);
  const pickingHere = canvasUi.picking && canvasUi.pickingVideoId === video.id;
  const clip = completedClip(video);
  const compact = shouldCollapseVideo(video);
  const src = clip ? playbackSource(clip) : "";

  if (compact) {
    const aspect = clip.aspect || video.aspect || "9:16";
    const width = compactFrameWidth(aspect);
    const ar = aspectCssValue(aspect);
    const selected = canvasUi.selection.has(selKey("video", video.id)) ? " is-selected" : "";
    return `<article class="vnode is-compact${selected}" data-video="${video.id}" style="left:${video.x}px;top:${video.y}px;width:${width}px">
      <button type="button" class="port port-left" data-act="port" data-id="${video.id}" data-side="left" aria-label="连接视频左侧" data-tip="连接视频左侧"></button>
      <button type="button" class="port port-right" data-act="port" data-id="${video.id}" data-side="right" aria-label="连接视频右侧" data-tip="连接视频右侧"></button>
      <div class="vnode-compact-bar">
        <button type="button" class="vnode-compact-title" data-act="edit-video-title" data-id="${video.id}">${escapeText(title)}</button>
        ${busy ? "" : iconBtn("删除", "trash", `data-act="delete-video" data-id="${video.id}" class="icon-btn compact-delete"`)}
      </div>
      <video class="vnode-player" style="aspect-ratio:${ar}" controls playsinline preload="metadata" src="${escapeText(src)}" data-act="expand-video-hit" data-video="${video.id}"></video>
    </article>`;
  }

  const models = MODEL_CHOICES.map(([value, label]) =>
    `<option value="${value}" ${video.model === value ? "selected" : ""}>${label}</option>`).join("");
  const seconds = Array.from({ length: 9 }, (_, index) => index + 4).map((value) =>
    `<option value="${value}" ${Number(video.seconds) === value ? "selected" : ""}>${value} 秒</option>`).join("");
  const aspects = ASPECT_CHOICES.map(([value, label]) =>
    `<option value="${value}" ${video.aspect === value ? "selected" : ""}>${label}</option>`).join("");
  const records = visibleGenerations(video);
  const active = records.find((item) => item.id === video.activeId)
    || records.find(isGenBusy)
    || records.find((item) => item.status === "completed");
  const media = playbackSource(active)
    ? `<video class="vnode-player" controls playsinline preload="metadata" src="${escapeText(playbackSource(active))}"></video>`
    : "";
  const live = active && isGenBusy(active);
  const progress = `<div class="vnode-progress" data-live ${live ? "" : "hidden"}>
      <b data-live-title>${escapeText(liveTitle(active))}</b>
      <span data-live-detail>${escapeText(active?.detail || (live ? historyStatus(active) : ""))}</span>
      <div class="bar"><i data-live-bar style="width:${live ? (active.progress || 0) : 0}%"></i></div>
    </div>`;
  const picked = (video.selected || []).map((item, index) => {
    const card = findCard(item.cardId);
    const image = findImage(card, item.imageId);
    if (!image) return "";
    const remove = busy
      ? ""
      : `<button type="button" class="pick-remove" data-act="remove-ref" data-video="${video.id}" data-card="${item.cardId}" data-image="${item.imageId}" aria-label="移除参考图" data-tip="移除参考图">×</button>`;
    return `<figure class="pick-thumb">
      <img alt="" src="${blobUrl(image)}">
      <span class="badge">${index + 1}</span>
      ${remove}
    </figure>`;
  }).join("");
  const pickUi = busy
    ? ""
    : pickingHere
      ? `<div class="vnode-pick-mask" aria-hidden="true"></div>
         <div class="pick-float">
           <button type="button" class="ghost" data-act="pick-cancel">取消</button>
           <button type="button" class="go" data-act="pick-done">完成</button>
         </div>`
      : `${iconBtn("选择画布资源", "pick", `data-act="pick-resources" data-video="${video.id}" class="icon-btn pick-entry"`)}`;
  const lock = busy ? "disabled" : "";
  const err = canvasUi.errorVideoId === video.id ? canvasUi.error : "";
  const pickingClass = pickingHere ? " is-picking-video" : "";
  const busyClass = busy ? " is-generating" : "";
  const expandedClass = clip && canvasUi.expandedVideoId === video.id ? " is-expanded" : "";
  const selected = canvasUi.selection.has(selKey("video", video.id)) ? " is-selected" : "";
  return `<article class="vnode${pickingClass}${busyClass}${expandedClass}${selected}" data-video="${video.id}" style="left:${video.x}px;top:${video.y}px">
    <button type="button" class="port port-left" data-act="port" data-id="${video.id}" data-side="left" aria-label="连接视频左侧" data-tip="连接视频左侧" ${lock}></button>
    <button type="button" class="port port-right" data-act="port" data-id="${video.id}" data-side="right" aria-label="连接视频右侧" data-tip="连接视频右侧" ${lock}></button>
    <header>
      <span class="grip" data-drag="video" data-id="${video.id}">⋮⋮</span>
      <input data-act="rename-video" data-id="${video.id}" value="${escapeText(title)}" ${busy ? "readonly" : ""}>
      ${busy ? "" : iconBtn("删除", "trash", `data-act="delete-video" data-id="${video.id}"`)}
    </header>
    ${pickUi}
    <div class="picked">${picked}</div>
    <textarea data-field="prompt" placeholder="可以用图片1、图片2指代上面选中的参考图。" ${busy ? "readonly" : ""}>${escapeText(video.prompt)}</textarea>
    <div class="vnode-controls" ${busy ? "hidden" : ""}>
      <label>模型<select data-field="model" ${lock}>${models}</select></label>
      <label>时长<select data-field="seconds" ${lock}>${seconds}</select></label>
      <label>画幅<select data-field="aspect" ${lock}>${aspects}</select></label>
      <label>分辨率<select data-field="size" ${lock}><option value="720P" selected>720P</option></select></label>
    </div>
    <button type="button" class="go" data-act="generate-video" data-video="${video.id}" ${busy ? "hidden" : ""}>生成</button>
    <p class="warn" data-field="error" ${err ? "" : "hidden"}>${escapeText(err || "")}</p>
    ${progress}
    ${media}
  </article>`;
}

function boardSize() {
  return WORLD;
}

function renderBoard() {
  const board = byId("board");
  const project = canvasUi.project;
  if (!project) return;
  board.style.width = "0px";
  board.style.height = "0px";
  board.classList.toggle("is-picking", canvasUi.picking);
  board.classList.toggle("is-linking", Boolean(canvasUi.linking));
  const hint = (project.cards.length || project.videos?.length) ? "" : `<div class="board-hint">拖空白框选，空格/中键拖动画布，滚轮缩放。双击空白处添加人物、场景、道具、文本或视频卡。</div>`;
  board.innerHTML = `<svg class="links" id="links"></svg><svg class="guides" id="guides"></svg><div class="groups-layer" id="groupsLayer">${(project.groups || []).map(groupMarkup).join("")}</div><div class="marquee" id="marquee" hidden></div>${hint}${project.cards.map(cardMarkup).join("")}${(project.videos || []).map(videoMarkup).join("")}`;
  applyView();
  drawLinks();
  clearGuides();
  bindExclusiveVideoPlayback();
  renderHeroToolbar();
  renderVideoToolbar();
}

function nodeBox(targetId) {
  const video = findVideo(targetId) || (targetId === "video" ? canvasUi.project?.videos?.[0] : null);
  if (video) {
    const node = videoEl(video.id);
    if (node) {
      return {
        x: node.offsetLeft,
        y: node.offsetTop,
        w: node.offsetWidth,
        h: node.offsetHeight,
      };
    }
    return { x: video.x, y: video.y, w: 360, h: 420 };
  }
  const card = document.querySelector(`[data-card="${targetId}"]`);
  if (!card) return null;
  return {
    x: card.offsetLeft,
    y: card.offsetTop,
    w: card.offsetWidth,
    h: card.offsetHeight,
  };
}

function nodeCenter(targetId) {
  const box = nodeBox(targetId);
  if (!box) return null;
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

function resolveLinkSides(fromId, toId) {
  let best = null;
  ["left", "right"].forEach((fromSide) => {
    ["left", "right"].forEach((toSide) => {
      const from = portPoint(fromId, fromSide);
      const to = portPoint(toId, toSide);
      if (!from || !to) return;
      const dist = Math.hypot(from.x - to.x, from.y - to.y);
      if (!best || dist < best.dist) best = { fromSide, toSide, dist };
    });
  });
  return best || { fromSide: "right", toSide: "left" };
}

function portPoint(targetId, side) {
  const box = nodeBox(targetId);
  if (!box) return null;
  return {
    x: side === "right" ? box.x + box.w : box.x,
    y: box.y + box.h / 2,
  };
}

function clientToBoard(clientX, clientY) {
  const viewport = byId("viewport");
  const rect = viewport.getBoundingClientRect();
  const scale = canvasUi.view.scale || 1;
  return {
    x: (clientX - rect.left - canvasUi.view.x) / scale,
    y: (clientY - rect.top - canvasUi.view.y) / scale,
  };
}

function bezierPath(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.hypot(dx, dy) || 1;
  const bend = Math.max(56, Math.abs(dx) * 0.45, Math.abs(dy) * 0.18);
  const direction = dx >= 0 ? 1 : -1;
  const ox = WORLD_PAD;
  const oy = WORLD_PAD;
  const c1x = x1 + bend * direction;
  const c2x = x2 - bend * direction;
  const flatLift = Math.abs(dy) < 8 ? Math.min(28, dist * 0.06 + 8) : 0;
  return `M ${x1 + ox} ${y1 + oy} C ${c1x + ox} ${y1 - flatLift + oy}, ${c2x + ox} ${y2 + flatLift + oy}, ${x2 + ox} ${y2 + oy}`;
}

function linkIsFocused(link) {
  if (canvasUi.selectedLinkId === link.id) return true;
  const focus = canvasUi.linkFocusId;
  if (!focus) return false;
  return link.from === focus || link.to === focus;
}

function dedupeLinks(links) {
  const seen = new Set();
  return (links || []).filter((link) => {
    const key = [link.from, link.to].sort().join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectLink(id) {
  clearSelection();
  canvasUi.selectedLinkId = id || null;
  drawLinks();
  syncSelectBar();
}

function clearSelectedLink() {
  if (!canvasUi.selectedLinkId) return;
  canvasUi.selectedLinkId = null;
  drawLinks();
  syncSelectBar();
}

function drawLinks() {
  const project = canvasUi.project;
  const svg = byId("links");
  const board = byId("board");
  if (!project || !svg) return;
  board?.classList.toggle("is-link-focus", Boolean(canvasUi.linkFocusId));
  const defs = [];
  const paths = [];
  project.links = dedupeLinks(project.links);
  project.links.forEach((link) => {
    const sides = resolveLinkSides(link.from, link.to);
    link.fromSide = sides.fromSide;
    link.toSide = sides.toSide;
    const from = portPoint(link.from, sides.fromSide);
    const to = portPoint(link.to, sides.toSide);
    if (!from || !to) return;
    const ox = WORLD_PAD;
    const oy = WORLD_PAD;
    const hot = linkIsFocused(link) ? " is-hot" : "";
    const selected = canvasUi.selectedLinkId === link.id ? " is-selected" : "";
    const gid = `linkGlow-${link.id}`;
    defs.push(`<linearGradient id="${gid}" gradientUnits="userSpaceOnUse"
      x1="${from.x + ox}" y1="${from.y + oy}" x2="${to.x + ox}" y2="${to.y + oy}">
      <stop offset="0%" stop-color="#9ad0ff"/>
      <stop offset="45%" stop-color="#0071e3"/>
      <stop offset="100%" stop-color="#5ac8fa"/>
    </linearGradient>`);
    const d = bezierPath(from.x, from.y, to.x, to.y);
    paths.push(`<path class="link-base${hot}${selected}" d="${d}"></path>
      <path class="link-flow${hot}${selected}" d="${d}" style="stroke:url(#${gid})"></path>
      <path class="link-hit${hot}${selected}" data-act="select-link" data-id="${link.id}" d="${d}"></path>`);
  });
  if (canvasUi.linking?.cursor) {
    const from = portPoint(canvasUi.linking.from, canvasUi.linking.fromSide);
    if (from) {
      const d = bezierPath(from.x, from.y, canvasUi.linking.cursor.x, canvasUi.linking.cursor.y);
      paths.push(`<path class="link-temp" d="${d}"></path>`);
    }
  }
  svg.innerHTML = `<defs>${defs.join("")}</defs>${paths.join("")}`;
}

function setLinkFocus(id) {
  if (canvasUi.linkFocusId === id) return;
  canvasUi.linkFocusId = id || null;
  drawLinks();
}

function distanceToBox(px, py, box) {
  const dx = Math.max(box.x - px, 0, px - (box.x + box.w));
  const dy = Math.max(box.y - py, 0, py - (box.y + box.h));
  return Math.hypot(dx, dy);
}

function clearLinkDropHighlights() {
  document.querySelectorAll(".port.is-drop, .asset.is-drop-target, .vnode.is-drop-target").forEach((node) => {
    node.classList.remove("is-drop", "is-drop-target");
  });
}

function findLinkDropTarget(clientX, clientY) {
  if (!canvasUi.linking || !canvasUi.project) return null;
  const point = clientToBoard(clientX, clientY);
  const scale = canvasUi.view.scale || 1;
  const snap = 72 / scale;
  let best = null;
  const candidates = [];
  (canvasUi.project.cards || []).forEach((card) => {
    const box = nodeBox(card.id);
    if (box) candidates.push({ id: card.id, box });
  });
  (canvasUi.project.videos || []).forEach((video) => {
    const box = nodeBox(video.id);
    if (box) candidates.push({ id: video.id, box });
  });
  candidates.forEach((item) => {
    if (item.id === canvasUi.linking.from) return;
    const dist = distanceToBox(point.x, point.y, item.box);
    if (dist > snap) return;
    if (!best || dist < best.dist) best = { id: item.id, dist };
  });
  if (!best) return null;
  const sides = resolveLinkSides(canvasUi.linking.from, best.id);
  return { id: best.id, side: sides.toSide };
}

function highlightDropTarget(clientX, clientY) {
  clearLinkDropHighlights();
  if (!canvasUi.linking) return null;
  const drop = findLinkDropTarget(clientX, clientY);
  if (!drop) return null;
  document.querySelector(`.port[data-id="${drop.id}"][data-side="${drop.side}"]`)?.classList.add("is-drop");
  document.querySelector(`[data-card="${drop.id}"], [data-video="${drop.id}"]`)?.classList.add("is-drop-target");
  return drop;
}

function addCardImagesToVideo(cardId, videoId = canvasUi.pickingVideoId) {
  const project = canvasUi.project;
  const card = findCard(cardId);
  const video = findVideo(videoId);
  if (!project || !card || !video) return;
  const selected = video.selected;
  card.images.forEach((image) => {
    if (selected.length >= 8) return;
    if (selected.some((item) => item.imageId === image.id)) return;
    selected.push({ cardId, imageId: image.id });
  });
}

function ensureLinkToVideo(cardId, videoId = canvasUi.pickingVideoId) {
  const project = canvasUi.project;
  const video = findVideo(videoId);
  if (!project || !video) return;
  if (!Array.isArray(project.links)) project.links = [];
  const exists = project.links.some((link) =>
    (link.from === cardId && link.to === video.id) || (link.from === video.id && link.to === cardId));
  if (exists) return;
  const sides = resolveLinkSides(cardId, video.id);
  project.links.push({
    id: canvasUid(),
    from: cardId,
    fromSide: sides.fromSide,
    to: video.id,
    toSide: sides.toSide,
  });
}

function removeLinkToVideo(cardId, videoId = canvasUi.pickingVideoId) {
  const project = canvasUi.project;
  const video = findVideo(videoId);
  if (!project || !video) return;
  project.links = (project.links || []).filter((link) =>
    !((link.from === cardId && link.to === video.id) || (link.from === video.id && link.to === cardId)));
}

function removeCardFromSelected(cardId, videoId = canvasUi.pickingVideoId) {
  const video = findVideo(videoId);
  if (!video) return;
  video.selected = video.selected.filter((item) => item.cardId !== cardId);
}

function removeSelectedRef(videoId, cardId, imageId) {
  const video = findVideo(videoId);
  if (!video || videoBusy(video)) return;
  const project = canvasUi.project;
  if (!project) return;
  video.selected = video.selected.filter(
    (item) => !(item.cardId === cardId && item.imageId === imageId),
  );
  if (!video.selected.some((item) => item.cardId === cardId)) {
    removeLinkToVideo(cardId, videoId);
  }
  showCanvasError("", videoId);
  writeProject(project).then(renderBoard);
}

function toggleCardResources(cardId) {
  if (!canvasUi.picking || !canvasUi.project) return;
  const video = pickingVideo();
  const card = findCard(cardId);
  if (!card || !video) return;
  const selected = video.selected;
  const already = selected.some((item) => item.cardId === cardId);
  if (already) {
    removeCardFromSelected(cardId, video.id);
    removeLinkToVideo(cardId, video.id);
    showCanvasError("", video.id);
  } else {
    if (!card.images.length) {
      showCanvasError("这个组件还没有图片", video.id);
      return;
    }
    if (selected.length >= 8) {
      showCanvasError("参考图最多 8 张", video.id);
      return;
    }
    addCardImagesToVideo(cardId, video.id);
    ensureLinkToVideo(cardId, video.id);
    showCanvasError("", video.id);
  }
  renderBoard();
}

function startPicking(videoId) {
  const video = findVideo(videoId);
  if (!canvasUi.project || !video || videoBusy(video)) return;
  canvasUi.picking = true;
  canvasUi.pickingVideoId = video.id;
  canvasUi.pickingBackup = {
    videoId: video.id,
    selected: video.selected.map((item) => ({ ...item })),
    links: (canvasUi.project.links || []).map((link) => ({ ...link })),
  };
  showCanvasError("", video.id);
  renderBoard();
}

function finishPicking() {
  if (!canvasUi.project) return;
  canvasUi.picking = false;
  canvasUi.pickingVideoId = null;
  canvasUi.pickingBackup = null;
  writeProject(canvasUi.project);
  renderBoard();
}

function cancelPicking() {
  if (!canvasUi.project) return;
  const backup = canvasUi.pickingBackup || { selected: [], links: [], videoId: null };
  const video = findVideo(backup.videoId);
  if (video) video.selected = (backup.selected || []).map((item) => ({ ...item }));
  canvasUi.project.links = (backup.links || []).map((link) => ({ ...link }));
  canvasUi.picking = false;
  canvasUi.pickingVideoId = null;
  canvasUi.pickingBackup = null;
  showCanvasError("");
  renderBoard();
}

function cancelLinking() {
  canvasUi.linking = null;
  byId("board")?.classList.remove("is-linking");
  clearLinkDropHighlights();
  document.querySelectorAll(".port.is-active").forEach((node) => node.classList.remove("is-active"));
  drawLinks();
}

function beginLink(fromId, fromSide, dragging = false) {
  canvasUi.linking = {
    from: fromId,
    fromSide: fromSide || "right",
    cursor: null,
    dragging: Boolean(dragging),
  };
  byId("board")?.classList.add("is-linking");
  clearLinkDropHighlights();
  document.querySelectorAll(".port.is-active").forEach((node) => node.classList.remove("is-active"));
  document.querySelector(`.port[data-id="${fromId}"][data-side="${fromSide}"]`)?.classList.add("is-active");
  drawLinks();
}

function finishLink(toId, toSide) {
  const project = canvasUi.project;
  const linking = canvasUi.linking;
  if (!project || !linking) return;
  if (!toId || toId === linking.from) {
    cancelLinking();
    return;
  }
  const fromVideo = findVideo(linking.from);
  const toVideo = findVideo(toId);
  if ((fromVideo && videoBusy(fromVideo)) || (toVideo && videoBusy(toVideo))) {
    cancelLinking();
    return;
  }
  if (!Array.isArray(project.links)) project.links = [];
  const from = linking.from;
  const already = project.links.some((link) =>
    (link.from === from && link.to === toId) || (link.from === toId && link.to === from));
  if (!already) {
    const sides = resolveLinkSides(from, toId);
    project.links.push({
      id: canvasUid(),
      from,
      fromSide: sides.fromSide,
      to: toId,
      toSide: sides.toSide,
    });
    if (toVideo || fromVideo) {
      const video = toVideo || fromVideo;
      const cardId = toVideo ? from : toId;
      if (findCard(cardId)) addCardImagesToVideo(cardId, video.id);
    }
    writeProject(project);
  }
  cancelLinking();
  renderBoard();
}

async function removeLink(id) {
  const project = canvasUi.project;
  if (!project) return;
  const link = (project.links || []).find((item) => item.id === id);
  const linkedVideo = link ? (findVideo(link.to) || findVideo(link.from)) : null;
  if (linkedVideo && videoBusy(linkedVideo)) return;
  if (!(await askConfirm("删除这条连接线？"))) return;
  if (canvasUi.selectedLinkId === id) canvasUi.selectedLinkId = null;
  project.links = (project.links || []).filter((item) => item.id !== id);
  if (link && linkedVideo) {
    const cardId = link.to === linkedVideo.id ? link.from : link.to;
    const stillLinked = (project.links || []).some((item) =>
      (item.to === linkedVideo.id && item.from === cardId) || (item.from === linkedVideo.id && item.to === cardId));
    if (!stillLinked) {
      linkedVideo.selected = linkedVideo.selected.filter((item) => item.cardId !== cardId);
    }
  }
  await writeProject(project);
  renderBoard();
}

function renderCanvas() {
  const project = canvasUi.project;
  if (!project) return;
  byId("canvasTitle").value = project.name || "";
  byId("canvasBriefEdit").value = project.brief || "";
  const preview = byId("canvasCoverPreview");
  const hit = byId("canvasCoverHit");
  if (preview) {
    if (preview.dataset.url) URL.revokeObjectURL(preview.dataset.url);
    if (project.cover) {
      const url = URL.createObjectURL(project.cover);
      preview.dataset.url = url;
      preview.src = url;
      preview.hidden = false;
      hit?.classList.add("has-cover");
    } else {
      preview.removeAttribute("src");
      preview.hidden = true;
      delete preview.dataset.url;
      hit?.classList.remove("has-cover");
    }
  }
  renderCardList();
  renderBoard();
}

function showCanvasError(message, videoId = null) {
  canvasUi.error = message || "";
  canvasUi.errorVideoId = message ? videoId : null;
  document.querySelectorAll("[data-field=error]").forEach((node) => {
    const id = node.closest("[data-video]")?.dataset.video || node.closest("#videoToolbar")?.dataset.toolbar;
    const show = Boolean(message && id && id === videoId);
    node.hidden = !show;
    if (show) node.textContent = message;
  });
}

function paintLiveBox(box, gen, titleText) {
  if (!box) return;
  box.hidden = !isGenBusy(gen);
  const title = box.querySelector("[data-live-title]");
  const detail = box.querySelector("[data-live-detail]");
  const bar = box.querySelector("[data-live-bar]");
  if (title) title.textContent = titleText;
  if (detail) detail.textContent = gen.detail || historyStatus(gen);
  if (bar) bar.style.width = `${isGenBusy(gen) && gen.status !== "waiting" ? (gen.progress || 0) : 0}%`;
}

function paintGeneration(gen) {
  if (gen.status === "failed") return;
  const video = findVideo(gen.videoId);
  if (!video || video.activeId !== gen.id) return;
  const nodes = [videoEl(video.id), byId("videoToolbar")].filter((node) => node && (node.dataset.video === video.id || node.dataset.toolbar === video.id));
  nodes.forEach((node) => paintLiveBox(node.querySelector("[data-live]"), gen, liveTitle(gen)));
  const historyButton = document.querySelector(`[data-act="open-gen"][data-id="${gen.id}"]`);
  if (historyButton) historyButton.textContent = `${shortTitle(gen.prompt)} · ${historyStatus(gen)}`;
  syncGenerateButton(gen.videoId);
}

function readVideoFields(video, node) {
  if (!node) return;
  const prompt = node.querySelector('[data-field="prompt"]');
  const model = node.querySelector('[data-field="model"]');
  const seconds = node.querySelector('[data-field="seconds"]');
  const aspect = node.querySelector('[data-field="aspect"]');
  if (prompt) video.prompt = prompt.value;
  if (model) video.model = normalizeModel(model.value);
  if (seconds) video.seconds = Number(seconds.value);
  if (aspect) video.aspect = aspect.value;
  video.size = "720P";
}

function rememberVideosFromDom() {
  const project = canvasUi.project;
  if (!project) return;
  (project.videos || []).forEach((video) => {
    readVideoFields(video, videoEl(video.id));
    const bar = byId("videoToolbar");
    if (bar?.dataset.toolbar === video.id) readVideoFields(video, bar);
  });
}

async function openProject(id) {
  rememberVideosFromDom();
  if (canvasUi.project) await writeProject(canvasUi.project);
  canvasUi.project = canvasUi.projects.find((item) => item.id === id) || null;
  canvasUi.picking = false;
  canvasUi.pickingVideoId = null;
  canvasUi.selection.clear();
  canvasUi.marquee = null;
  canvasUi.urls.forEach((url) => URL.revokeObjectURL(url));
  canvasUi.urls.clear();
  if (canvasUi.project) {
    ensureVideos(canvasUi.project);
    let changed = false;
    canvasUi.project.videos.forEach((video) => {
      const before = video.generations.length;
      video.generations = visibleGenerations(video);
      if (video.generations.length !== before) changed = true;
    });
    if (changed) await writeProject(canvasUi.project);
  }
  renderCanvas();
  resumeCanvasQueue();
  (canvasUi.project?.videos || []).forEach((video) => {
    (video.generations || []).forEach(watchGeneration);
  });
}

function nextCardPos() {
  const count = canvasUi.project.cards.length;
  return { x: 36, y: 36 + count * 300 };
}

async function placeVideoCard(at = null) {
  const project = canvasUi.project;
  if (!project) return;
  ensureVideos(project);
  const offset = (project.videos.length % 4) * 24;
  const pos = at || {
    x: 680 + offset + 180,
    y: 48 + project.videos.length * 40 + 40,
  };
  const video = blankVideo(pos);
  project.videos.push(video);
  await writeProject(project);
  renderBoard();
  const viewport = byId("viewport");
  if (viewport) {
    canvasUi.view.x = viewport.clientWidth / 2 - (video.x + 180) * canvasUi.view.scale;
    canvasUi.view.y = viewport.clientHeight / 2 - (video.y + 80) * canvasUi.view.scale;
    project.view = { ...canvasUi.view };
    applyView();
    await writeProject(project);
  }
}

async function addCard(type, at = null) {
  if (!canvasUi.project) return;
  if (type === "video") {
    await placeVideoCard(at);
    return;
  }
  if (!CARD_TYPES.includes(type)) return;
  const pos = at || nextCardPos();
  canvasUi.project.cards.push({
    id: canvasUid(),
    type,
    title: `未命名${CARD_LABEL[type]}`,
    x: pos.x - 140,
    y: pos.y - 40,
    images: [],
    prompt: "",
    imageSize: "1024x1024",
    text: "",
  });
  await writeProject(canvasUi.project);
  renderCanvas();
}

async function deleteSelection() {
  const project = canvasUi.project;
  if (!project) return;
  if (canvasUi.selectedLinkId && !canvasUi.selection.size) {
    removeLink(canvasUi.selectedLinkId);
    return;
  }
  const cardIds = [];
  const videoIds = [];
  selectionEntries().forEach((item) => {
    if (item.kind === "card" && findCard(item.id)) cardIds.push(item.id);
    if (item.kind === "video") {
      const video = findVideo(item.id);
      if (video && !videoBusy(video)) videoIds.push(item.id);
    }
  });
  if (!cardIds.length && !videoIds.length) {
    if (canvasUi.selection.size) showCanvasError("生成中的视频不能删除");
    return;
  }
  const total = cardIds.length + videoIds.length;
  const message = total === 1
    ? (videoIds.length ? "删除这张视频卡？" : "删除这张卡片？")
    : `删除选中的 ${total} 个组件？`;
  if (!(await askConfirm(message))) return;
  cardIds.forEach((id) => {
    const card = findCard(id);
    (card?.images || []).forEach((image) => dropBlob(image.id));
    project.cards = project.cards.filter((item) => item.id !== id);
    (project.videos || []).forEach((video) => {
      video.selected = video.selected.filter((item) => item.cardId !== id);
    });
    project.links = (project.links || []).filter((link) => link.from !== id && link.to !== id);
    canvasUi.selection.delete(selKey("card", id));
  });
  videoIds.forEach((id) => {
    const video = findVideo(id);
    if (!video) return;
    if (canvasUi.pickingVideoId === id) {
      canvasUi.picking = false;
      canvasUi.pickingVideoId = null;
      canvasUi.pickingBackup = null;
    }
    if (canvasUi.videoToolbarId === id) canvasUi.videoToolbarId = null;
    (video.generations || []).forEach((gen) => canvasUi.pollers.delete(gen.id));
    project.videos = project.videos.filter((item) => item.id !== id);
    project.links = (project.links || []).filter((link) => link.from !== id && link.to !== id);
    if (canvasUi.errorVideoId === id) showCanvasError("");
    canvasUi.selection.delete(selKey("video", id));
  });
  project.cards.forEach((card) => { card.toolbarOpen = false; });
  clearSelection();
  await writeProject(project);
  renderCanvas();
}

async function deleteCard(id) {
  const project = canvasUi.project;
  if (!project) return;
  if (!(await askConfirm("删除这张卡片？"))) return;
  const card = findCard(id);
  (card?.images || []).forEach((image) => dropBlob(image.id));
  project.cards = project.cards.filter((item) => item.id !== id);
  (project.videos || []).forEach((video) => {
    video.selected = video.selected.filter((item) => item.cardId !== id);
  });
  project.links = (project.links || []).filter((link) => link.from !== id && link.to !== id);
  canvasUi.selection.delete(selKey("card", id));
  pruneGroupMembers(project);   // 把含此卡的组都清掉成员引用
  await writeProject(project);
  renderCanvas();
}

async function deleteVideoCard(id) {
  const project = canvasUi.project;
  const video = findVideo(id);
  if (!project || !video) return;
  if (videoBusy(video)) return;
  if (!(await askConfirm("删除这张视频卡？"))) return;
  if (canvasUi.pickingVideoId === id) {
    canvasUi.picking = false;
    canvasUi.pickingVideoId = null;
    canvasUi.pickingBackup = null;
  }
  if (canvasUi.videoToolbarId === id) canvasUi.videoToolbarId = null;
  (video.generations || []).forEach((gen) => canvasUi.pollers.delete(gen.id));
  project.videos = project.videos.filter((item) => item.id !== id);
  project.links = (project.links || []).filter((link) => link.from !== id && link.to !== id);
  if (canvasUi.errorVideoId === id) showCanvasError("");
  canvasUi.selection.delete(selKey("video", id));
  pruneGroupMembers(project);   // 把含此视频的组都清掉成员引用
  await writeProject(project);
  renderBoard();
}

function beginUpload(target) {
  canvasUi.fileTarget = target;
  const input = byId("cardFile");
  input.multiple = Boolean(target.multiple);
  input.click();
}

async function attachFiles(files) {
  const target = canvasUi.fileTarget;
  const project = canvasUi.project;
  if (!target || !project) return;
  const card = findCard(target.cardId);
  if (!card) return;
  const accepted = [...files].filter((file) => file.size <= 15 * 1024 * 1024);
  if (accepted.length !== files.length) showCanvasError("单张图片请小于 15MB");
  else showCanvasError("");
  if (target.imageId) {
    const image = findImage(card, target.imageId);
    const file = accepted[0];
    if (image && file) {
      dropBlob(image.id);
      image.name = file.name;
      image.blob = file;
      image.id = canvasUid();
    }
  } else {
    accepted.forEach((file) => {
      card.images.push({
        id: canvasUid(),
        name: file.name,
        role: target.slot === "hero" ? "hero" : "extra",
        blob: file,
      });
    });
  }
  canvasUi.fileTarget = null;
  (project.videos || []).forEach((video) => {
    const linked = (project.links || []).some((link) =>
      (link.to === video.id && link.from === card.id) || (link.from === video.id && link.to === card.id));
    if (linked) addCardImagesToVideo(card.id, video.id);
  });
  await writeProject(project);
  renderCanvas();
}

function fileToBase64(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };
    reader.onload = () => {
      // 保留 data:image/...;base64, 前缀，后端 clean_image_refs 要求 data URI 或 http 链接
      resolve(String(reader.result || ""));
    };
    reader.onerror = () => reject(new Error(`读不了图片：${file.name}`));
    reader.readAsDataURL(file);
  });
}

function postCanvas(body, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/videos");
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

function postImage(body, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/images");
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

function showImageLive(cardId, detail, percent, title = "正在生成") {
  const box = document.querySelector(`[data-image-live="${cardId}"]`);
  if (!box) return;
  box.hidden = false;
  const titleNode = box.querySelector("[data-image-live-title]");
  const detailNode = box.querySelector("[data-image-live-detail]");
  const bar = box.querySelector("[data-image-live-bar]");
  if (titleNode) titleNode.textContent = title;
  if (detailNode) detailNode.textContent = detail;
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, Math.round(percent) || 0))}%`;
}

function showCardImageError(cardId, message) {
  canvasUi.imageError = message || "";
  canvasUi.imageErrorCardId = message ? cardId : null;
  document.querySelectorAll("[data-field=image-error]").forEach((node) => {
    const id = node.dataset.id;
    const show = Boolean(message && id === cardId);
    node.hidden = !show;
    if (show) node.textContent = message;
  });
}

function showLive(videoId, detail, percent, title = "正在生成") {
  const nodes = [videoEl(videoId), byId("videoToolbar")].filter((node) => node && (node.dataset.video === videoId || node.dataset.toolbar === videoId));
  nodes.forEach((node) => {
    const box = node.querySelector("[data-live]");
    if (!box) return;
    box.hidden = false;
    const titleNode = box.querySelector("[data-live-title]");
    const detailNode = box.querySelector("[data-live-detail]");
    const bar = box.querySelector("[data-live-bar]");
    if (titleNode) titleNode.textContent = title;
    if (detailNode) detailNode.textContent = detail;
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, Math.round(percent) || 0))}%`;
  });
}

function linkedTexts(targetId) {
  const project = canvasUi.project;
  if (!project || !targetId) return [];
  const seen = new Set();
  const parts = [];
  (project.links || []).forEach((link) => {
    const otherId = link.from === targetId ? link.to : link.to === targetId ? link.from : "";
    if (!otherId || seen.has(otherId)) return;
    const card = findCard(otherId);
    if (!card || card.type !== "text") return;
    seen.add(otherId);
    const live = document.querySelector(`[data-card="${card.id}"] [data-field="text"]`);
    if (live) card.text = live.value;
    const text = String(card.text || "").trim();
    if (text) parts.push(text);
  });
  return parts;
}

function promptWithLinkedText(targetId, prompt) {
  return [...linkedTexts(targetId), String(prompt || "").trim()].filter(Boolean).join("\n");
}

function imageGenFlags(card) {
  const task = activeCanvasTasks().find((item) => item.kind === "image" && item.cardId === card.id);
  const genWaiting = task?.status === "waiting";
  const genBusy = canvasUi.generatingCardIds.has(card.id);
  return {
    genBusy,
    genWaiting,
    genHold: genBusy || genWaiting,
    waitText: genWaiting ? `排队中 · 共 ${task.total || 1} 条 · 当前第 ${task.place || 1} 位` : "",
  };
}

function activeCanvasTasks() {
  return (canvasUi.tasks || []).filter((task) => task.status === "waiting" || task.status === "running");
}

function refreshCanvasQueueMeta() {
  const active = activeCanvasTasks();
  active.forEach((task, index) => {
    task.place = index + 1;
    task.total = active.length;
    if (task.kind !== "video") return;
    const video = findVideo(task.videoId);
    const gen = video?.generations?.find((item) => item.id === task.genId);
    if (!gen || gen.status !== "waiting") return;
    gen.place = task.place;
    gen.queueTotal = task.total;
    gen.detail = historyStatus(gen);
  });
}

function settleGeneration(gen) {
  const done = gen?.onSettle;
  if (gen) gen.onSettle = null;
  if (done) done();
}

function canvasGenerationBusy() {
  // 图片任务支持并发；视频任务仍保持串行（有视频在跑时不再启动新任务）
  return (canvasUi.project?.videos || []).some((video) =>
    (video.generations || []).some((gen) => gen.jobId && isGenBusy(gen) && gen.status !== "waiting"));
}

const IMG_PUMP_CONCURRENCY = 3;

function pumpCanvasQueue() {
  if (canvasGenerationBusy()) return;
  let started = 0;
  while (started < IMG_PUMP_CONCURRENCY + 1) {
    const active = activeCanvasTasks();
    const runningImages = active.filter((task) => task.kind === "image" && task.status === "running").length;
    const runningVideos = active.filter((task) => task.kind === "video" && task.status === "running").length;
    let next = null;
    if (runningVideos === 0) {
      next = active.find((task) => task.status === "waiting" && task.kind === "video")
        || (runningImages < IMG_PUMP_CONCURRENCY ? active.find((task) => task.status === "waiting" && task.kind === "image") : null);
    } else if (runningImages < IMG_PUMP_CONCURRENCY) {
      next = active.find((task) => task.status === "waiting" && task.kind === "image");
    }
    if (!next) break;
    next.status = "running";
    refreshCanvasQueueMeta();
    const finish = () => {
      canvasUi.tasks = (canvasUi.tasks || []).filter((task) => task !== next);
      refreshCanvasQueueMeta();
      renderBoard();
      pumpCanvasQueue();
    };
    const run = next.kind === "image"
      ? generateImage(next.cardId)
      : generateCanvas(next.videoId, next.genId);
    Promise.resolve(run).finally(() => {
      if (next.kind === "image") {
        finish();
        return;
      }
      const video = findVideo(next.videoId);
      const gen = video?.generations?.find((item) => item.id === next.genId);
      if (!gen || !gen.jobId || !isGenBusy(gen)) {
        finish();
        return;
      }
      gen.onSettle = finish;
    });
    started += 1;
  }
}

function resumeCanvasQueue() {
  const project = canvasUi.project;
  canvasUi.tasks = (canvasUi.tasks || []).filter((task) => {
    if (task.status === "running") return true;
    if (!project) return false;
    if (task.kind === "image") return (project.cards || []).some((card) => card.id === task.cardId);
    return (project.videos || []).some((video) => video.id === task.videoId);
  });
  const known = new Set(canvasUi.tasks.map((task) => task.genId).filter(Boolean));
  (project?.videos || []).forEach((video) => {
    (video.generations || []).forEach((gen) => {
      if (gen.status === "waiting" && !gen.jobId && !known.has(gen.id)) {
        canvasUi.tasks.push({ kind: "video", videoId: video.id, genId: gen.id, status: "waiting" });
      }
    });
  });
  refreshCanvasQueueMeta();
  pumpCanvasQueue();
}

const CANVAS_QUEUE_LIMIT = 5;

function enqueueImage(cardId) {
  const project = canvasUi.project;
  const card = findCard(cardId);
  if (!project || !card) return;
  if (activeCanvasTasks().some((task) => task.kind === "image" && task.cardId === cardId)) return;
  const livePrompt = document.querySelector(`#heroToolbar [data-field="image-prompt"][data-id="${card.id}"]`)
    || document.querySelector(`[data-card="${card.id}"] [data-field="image-prompt"]`);
  if (livePrompt) card.prompt = livePrompt.value;
  const prompt = promptWithLinkedText(card.id, card.prompt);
  if (!prompt) {
    showCardImageError(cardId, "请先写提示词");
    return;
  }
  const refs = (card.images || []).filter((image) => image.blob && !image.auto);
  if (refs.length > 5) {
    showCardImageError(cardId, "参考图最多 5 张，请先删除部分图片");
    return;
  }
  if (activeCanvasTasks().length >= CANVAS_QUEUE_LIMIT) {
    showCardImageError(cardId, `队列最多 ${CANVAS_QUEUE_LIMIT} 个任务，请等其中一个完成后再提交`);
    return;
  }
  showCardImageError(cardId, "");
  canvasUi.tasks.push({ kind: "image", cardId, status: "waiting" });
  refreshCanvasQueueMeta();
  renderBoard();
  pumpCanvasQueue();
}

function enqueueVideo(videoId) {
  const project = canvasUi.project;
  const video = findVideo(videoId);
  if (!project || !video || videoBusy(video)) return;
  if (shouldCollapseVideo(video)) canvasUi.videoToolbarId = video.id;
  if (canvasUi.picking) cancelPicking();
  rememberVideosFromDom();
  const prompt = promptWithLinkedText(video.id, video.prompt);
  if (!prompt) {
    showCanvasError("请先写提示词", video.id);
    return;
  }
  const chosen = [];
  (video.selected || []).forEach((item) => {
    const image = findImage(findCard(item.cardId), item.imageId);
    if (image?.blob) chosen.push(image);
  });
  const model = normalizeModel(video.model);
  const limit = modelImageLimit(model);
  if (chosen.length > limit) {
    showCanvasError(`${model === "agnes-video-2.5" ? "2.5" : "2.5 Flash"} 参考图最多 ${limit} 张`, video.id);
    return;
  }
  if (activeCanvasTasks().length >= CANVAS_QUEUE_LIMIT) {
    showCanvasError(`队列最多 ${CANVAS_QUEUE_LIMIT} 个任务，请等其中一个完成后再提交`, video.id);
    return;
  }
  showCanvasError("", video.id);
  const gen = {
    id: canvasUid(),
    videoId: video.id,
    prompt,
    model,
    seconds: video.seconds,
    aspect: video.aspect,
    size: "720P",
    selected: (video.selected || []).map((item) => ({ ...item })),
    createdAt: Date.now(),
    jobId: "",
    status: "waiting",
    progress: 0,
    detail: "",
    error: "",
    url: "",
    local_file: "",
    notice: "",
  };
  video.generations.unshift(gen);
  video.activeId = gen.id;
  canvasUi.tasks.push({ kind: "video", videoId, genId: gen.id, status: "waiting" });
  refreshCanvasQueueMeta();
  writeProject(project);
  renderBoard();
  pumpCanvasQueue();
}

async function generateCanvas(videoId, genId = null) {
  const project = canvasUi.project;
  const video = findVideo(videoId);
  if (!project || !video) return;
  const existing = genId ? (video.generations || []).find((item) => item.id === genId) : null;
  if (!existing && videoBusy(video)) return;
  if (shouldCollapseVideo(video)) canvasUi.videoToolbarId = video.id;
  if (canvasUi.picking) cancelPicking();
  rememberVideosFromDom();
  const prompt = promptWithLinkedText(video.id, video.prompt);
  if (!prompt) {
    showCanvasError("请先写提示词", video.id);
    if (existing) dropFailedGeneration(existing, "");
    return;
  }
  const chosen = [];
  video.selected.forEach((item) => {
    const image = findImage(findCard(item.cardId), item.imageId);
    if (image?.blob) chosen.push(image);
  });
  showCanvasError("", video.id);
  const model = normalizeModel(video.model);
  const limit = modelImageLimit(model);
  if (chosen.length > limit) {
    showCanvasError(`${model === "agnes-video-2.5" ? "2.5" : "2.5 Flash"} 参考图最多 ${limit} 张`, video.id);
    if (existing) dropFailedGeneration(existing, "");
    return;
  }
  const gen = existing || {
    id: canvasUid(),
    videoId: video.id,
    prompt,
    model,
    seconds: video.seconds,
    aspect: video.aspect,
    size: "720P",
    selected: video.selected.map((item) => ({ ...item })),
    createdAt: Date.now(),
    jobId: "",
    status: "submitting",
    progress: 0,
    detail: chosen.length ? `图片 1/${chosen.length}` : "正在提交",
    error: "",
    url: "",
    local_file: "",
    notice: "",
  };
  gen.prompt = prompt;
  gen.model = model;
  gen.seconds = video.seconds;
  gen.aspect = video.aspect;
  gen.status = "submitting";
  gen.progress = 0;
  gen.detail = chosen.length ? `图片 1/${chosen.length}` : "正在提交";
  gen.error = "";
  if (!existing) video.generations.unshift(gen);
  video.activeId = gen.id;
  await writeProject(project);
  renderBoard();
  syncGenerateButton(video.id);
  try {
    const images = [];
    for (let index = 0; index < chosen.length; index += 1) {
      images.push(await fileToBase64(chosen[index].blob, (fraction) => {
        const overall = ((index + fraction) / chosen.length) * 100;
        gen.detail = `图片 ${index + 1}/${chosen.length}`;
        gen.progress = overall;
        showLive(video.id, gen.detail, overall);
      }));
    }
    showLive(video.id, images.length ? "正在上传图片" : "正在提交", images.length ? 0 : 8);
    const data = await postCanvas({
      model,
      mode: images.length ? "reference" : "text",
      prompt,
      seconds: video.seconds,
      size: "720P",
      aspect_ratio: video.aspect,
      images,
      source: "canvas",
    }, (fraction) => {
      gen.detail = images.length ? "正在上传图片" : "正在提交";
      gen.progress = fraction * 100;
      showLive(video.id, gen.detail, gen.progress);
    });
    gen.jobId = data.job.id;
    gen.status = data.job.status;
    gen.progress = data.job.progress || 0;
    gen.notice = data.job.notice || "";
    applyJobQueue(gen, data.job, data.queue);
    gen.detail = data.job.status === "waiting"
      ? historyStatus(gen)
      : (data.job.notice || historyStatus(gen));
    await writeProject(project);
    renderBoard();
    watchGeneration(gen);
  } catch (error) {
    dropFailedGeneration(gen, error.message);
    await writeProject(project);
    renderBoard();
  } finally {
    syncGenerateButton(video.id);
  }
}

async function fetchGeneratedImage(url) {
  const response = await fetch(`/api/images/download?url=${encodeURIComponent(url)}`);
  if (!response.ok) {
    let message = `下载生成图片失败（${response.status}）`;
    try {
      const data = await response.json();
      if (data && data.error) message = data.error;
    } catch (error) { /* ignore */ }
    throw new Error(message);
  }
  return response.blob();
}

function mosaicHeadBlob(blob, fromRatio = 0.08, toRatio = 0.27, blockSize = 24) {
  // 马赛克只覆盖头部区中部的面部范围（fromRatio 到 toRatio 相对高度），顶部（头发/发饰）保持清晰不被打码
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      try {
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        const fromY = Math.max(0, Math.round(height * fromRatio));
        const toY = Math.max(fromY + 1, Math.round(height * toRatio));
        const zoneH = toY - fromY;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0);
        const cols = Math.max(1, Math.round(width / blockSize));
        const rows = Math.max(1, Math.round(zoneH / blockSize));
        const small = document.createElement("canvas");
        small.width = cols;
        small.height = rows;
        const sctx = small.getContext("2d");
        sctx.drawImage(image, 0, fromY, width, zoneH, 0, 0, cols, rows);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(small, 0, 0, cols, rows, 0, fromY, width, zoneH);
        canvas.toBlob((out) => {
          URL.revokeObjectURL(objectUrl);
          resolve(out || blob);
        }, "image/jpeg", 0.92);
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        reject(error);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("马赛克处理失败"));
    };
    image.src = objectUrl;
  });
}

function cropHeadBlob(blob, keepTopRatio = 0.55) {
  // 保留图片顶部 keepTopRatio 区域，画布保持原始宽高比（只截取不拉伸），用于去掉特写图下部的肩部/身体且不变形
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      try {
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        const keepH = Math.max(1, Math.round(height * keepTopRatio));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = keepH;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0, width, keepH, 0, 0, width, keepH);
        canvas.toBlob((out) => {
          URL.revokeObjectURL(objectUrl);
          resolve(out || blob);
        }, "image/jpeg", 0.92);
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        reject(error);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("头部裁剪失败"));
    };
    image.src = objectUrl;
  });
}

function cropBottomBlob(blob, cutRatio = 0.15) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      try {
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        const keepH = Math.max(1, Math.round(height * (1 - cutRatio)));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = keepH;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0, width, height, 0, 0, width, keepH);
        canvas.toBlob((out) => {
          URL.revokeObjectURL(objectUrl);
          resolve(out || blob);
        }, "image/jpeg", 0.92);
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        reject(error);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("脸部裁剪失败"));
    };
    image.src = objectUrl;
  });
}

function combineImagesBlob(blobs) {
  return new Promise((resolve, reject) => {
    const loads = blobs.map((blob) => new Promise((res, rej) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => res({ img, url });
      img.onerror = () => {
        URL.revokeObjectURL(url);
        rej(new Error("长图拼接读取图片失败"));
      };
      img.src = url;
    }));
    Promise.all(loads).then((items) => {
      try {
        // 左脸、右列正面/侧面/背面上下叠。整图宽高比控制在 2.4 以内，满足视频接口 0.4–2.5。
        const face = items[0];
        const bodies = items.slice(1);
        const natural = (item) => ({
          w: item.img.naturalWidth || item.img.width,
          h: item.img.naturalHeight || item.img.height,
        });
        const bodyH = Math.max(1, Math.round(
          bodies.reduce((sum, item) => sum + natural(item).h, 0) / Math.max(1, bodies.length),
        ));
        const bodyDraw = bodies.map((item) => {
          const size = natural(item);
          return { item, w: Math.max(1, Math.round(size.w * bodyH / size.h)), h: bodyH };
        });
        const colW = Math.max(1, ...bodyDraw.map((item) => item.w));
        const colH = bodyH * Math.max(1, bodyDraw.length);
        const faceSize = natural(face);
        let faceW = Math.max(1, Math.round(faceSize.w * colH / faceSize.h));
        const maxRatio = 2.4;
        if ((faceW + colW) / colH > maxRatio) {
          faceW = Math.max(1, Math.floor(colH * maxRatio) - colW);
        }
        let canvasW = faceW + colW;
        let canvasH = colH;
        const longSide = Math.max(canvasW, canvasH);
        const limit = 4096;
        const scale = longSide > limit ? limit / longSide : 1;
        faceW = Math.max(1, Math.round(faceW * scale));
        const scaledColW = Math.max(1, Math.round(colW * scale));
        const scaledBodyH = Math.max(1, Math.round(bodyH * scale));
        canvasW = faceW + scaledColW;
        canvasH = scaledBodyH * Math.max(1, bodyDraw.length);
        if (canvasW / canvasH > maxRatio) {
          canvasH = Math.max(canvasH, Math.ceil(canvasW / maxRatio));
        }
        const canvas = document.createElement("canvas");
        canvas.width = canvasW;
        canvas.height = canvasH;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvasW, canvasH);
        const faceBoxH = scaledBodyH * Math.max(1, bodyDraw.length);
        const faceFit = Math.min(faceW / faceSize.w, faceBoxH / faceSize.h);
        const faceDrawW = Math.max(1, Math.round(faceSize.w * faceFit));
        const faceDrawH = Math.max(1, Math.round(faceSize.h * faceFit));
        ctx.drawImage(
          face.img,
          Math.round((faceW - faceDrawW) / 2),
          Math.round((faceBoxH - faceDrawH) / 2),
          faceDrawW,
          faceDrawH,
        );
        bodyDraw.forEach(({ item }, index) => {
          const size = natural(item);
          const fit = Math.min(scaledColW / size.w, scaledBodyH / size.h);
          const drawW = Math.max(1, Math.round(size.w * fit));
          const drawH = Math.max(1, Math.round(size.h * fit));
          const x = faceW + Math.round((scaledColW - drawW) / 2);
          const y = index * scaledBodyH + Math.round((scaledBodyH - drawH) / 2);
          ctx.drawImage(item.img, x, y, drawW, drawH);
        });
        items.forEach(({ url }) => URL.revokeObjectURL(url));
        canvas.toBlob((out) => resolve(out), "image/jpeg", 0.92);
      } catch (error) {
        items.forEach(({ url }) => URL.revokeObjectURL(url));
        reject(error);
      }
    }).catch(reject);
  });
}

async function generateViewBlob(cardId, model, size, basePrompt, refBlob, viewPrompt, viewLabel, basePercent) {
  canvasUi.imageLiveDetail = `正在生成${viewLabel}视图`;
  canvasUi.imageLiveProgress = basePercent;
  showImageLive(cardId, canvasUi.imageLiveDetail, basePercent);
  const refBase64 = await fileToBase64(refBlob);
  const data = await postImage({
    model,
    mode: "reference",
    prompt: `${basePrompt}，${viewPrompt}，与正面图保持同一人物形象与服装，身体比例自然协调、无畸形无扭曲`,
    size,
    images: [refBase64],
    source: "canvas",
  });
  canvasUi.imageLiveDetail = `正在保存${viewLabel}视图`;
  canvasUi.imageLiveProgress = basePercent + 8;
  showImageLive(cardId, canvasUi.imageLiveDetail, basePercent + 8);
  const rawBlob = await fetchGeneratedImage(data.url);
  return rawBlob;
}

async function generateImage(cardId) {
  const project = canvasUi.project;
  const card = findCard(cardId);
  if (!project || !card) return;
  if (canvasUi.generatingCardIds.has(cardId)) return;
  if (canvasUi.picking) cancelPicking();
  const livePrompt = document.querySelector(`#heroToolbar [data-field="image-prompt"][data-id="${card.id}"]`)
    || document.querySelector(`[data-card="${card.id}"] [data-field="image-prompt"]`);
  if (livePrompt) card.prompt = livePrompt.value;
  const prompt = promptWithLinkedText(card.id, card.prompt);
  if (!prompt) {
    showCardImageError(cardId, "请先写提示词");
    renderBoard();
    return;
  }
  // 移除上一次自动生成的四视图，避免重复点击堆积
  card.images = (card.images || []).filter((image) => !image.auto);
  const refs = card.images.filter((image) => image.blob);
  if (refs.length > 5) {
    showCardImageError(cardId, "参考图最多 5 张，请先删除部分图片");
    renderBoard();
    return;
  }
  showCardImageError(cardId, "");
  canvasUi.generatingCardIds.add(cardId);
  canvasUi.imageLiveDetail = "准备生成四视图";
  canvasUi.imageLiveProgress = 0;
  renderBoard();
  try {
    const model = card.imageModel || IMAGE_GEN_MODEL;
    const size = card.imageSize || "1024x1024";
    const heroRefs = [];
    for (let index = 0; index < refs.length; index += 1) {
      heroRefs.push(await fileToBase64(refs[index].blob, (fraction) => {
        canvasUi.imageLiveDetail = `图片 ${index + 1}/${refs.length}`;
        canvasUi.imageLiveProgress = ((index + fraction) / refs.length) * 100;
        showImageLive(cardId, canvasUi.imageLiveDetail, canvasUi.imageLiveProgress);
      }));
    }
    // 1/4 正面全身（文生图；卡片已有图片则自动图生图）
    canvasUi.imageLiveDetail = heroRefs.length ? "正在上传图片" : "正在提交";
    canvasUi.imageLiveProgress = heroRefs.length ? 0 : 8;
    showImageLive(cardId, canvasUi.imageLiveDetail, canvasUi.imageLiveProgress);
    const heroData = await postImage({
      model,
      mode: heroRefs.length ? "reference" : "text",
      prompt: `${prompt}，人物正面全身照，正对镜头、正面平视，双手自然下垂或自然摆放，从头到脚完整入镜、双脚与鞋完整可见，画面不截断人物，躯干与全身完整入镜，身体比例协调、四肢正常无畸形，不要侧身斜角`,
      size,
      images: heroRefs,
      source: "canvas",
    }, (fraction) => {
      canvasUi.imageLiveDetail = heroRefs.length ? "正在上传图片" : "正在提交";
      canvasUi.imageLiveProgress = fraction * 100;
      showImageLive(cardId, canvasUi.imageLiveDetail, canvasUi.imageLiveProgress);
    });
    canvasUi.imageLiveDetail = "正在保存正面全身";
    canvasUi.imageLiveProgress = 45;
    showImageLive(cardId, canvasUi.imageLiveDetail, 45);
    const frontBlob = await fetchGeneratedImage(heroData.url);
    canvasUi.imageLiveDetail = "正在处理正面面部马赛克";
    canvasUi.imageLiveProgress = 50;
    showImageLive(cardId, canvasUi.imageLiveDetail, 50);
    const frontMosaic = await mosaicHeadBlob(frontBlob);

    // 2/4 侧面全身（图生图 + 面部马赛克）
    const sideBlob = await generateViewBlob(
      cardId, model, size, prompt, frontBlob,
      "人物全身正侧面视角（侧身 90 度，仅见侧面轮廓，从头到脚完整入镜、双脚与鞋完整可见，画面不截断人物，双手自然下垂，展示双手、躯干与全身站姿，不要斜侧角）",
      "侧面全身", 54,
    );
    canvasUi.imageLiveDetail = "正在处理侧面面部马赛克";
    canvasUi.imageLiveProgress = 62;
    showImageLive(cardId, canvasUi.imageLiveDetail, 62);
    const sideMosaic = await mosaicHeadBlob(sideBlob);

    // 3/4 背面全身（图生图 + 面部马赛克）
    const backBlob = await generateViewBlob(
      cardId, model, size, prompt, frontBlob,
      "人物背面视角：相机在人物正后方拍摄，人物背对镜头、转身背向相机，画面只呈现完整后背、后脑勺与后颈部，正面脸部与五官绝对不出现，从头到脚完整入镜、双脚与鞋完整可见，画面不截断人物，双手自然下垂，展示双手、躯干与全身站姿",
      "背面全身", 66,
    );
    canvasUi.imageLiveDetail = "正在处理背面面部马赛克";
    canvasUi.imageLiveProgress = 71;
    showImageLive(cardId, canvasUi.imageLiveDetail, 71);
    const backMosaic = await mosaicHeadBlob(backBlob);

    // 4/4 脸部高清大图（图生图，不打马赛克；仅头部特写）
    const faceBlob = await generateViewBlob(
      cardId, model, size, prompt, frontBlob,
      "人物脸部高清特写头像：只保留头部与面部，头顶与画面上缘相接、头顶上方仅留少量空白，画面底部截止于下颌线，脖子、肩膀与躯干一律不进入画面，面部居中、五官清晰细节丰富",
      "脸部高清", 76,
    );
    // 后处理：仅保留顶部区域（保持宽高比、不拉伸），去掉特写图下部的肩部/身体，保证脸部大图只含头部
    const faceBlobTrimmed = await cropHeadBlob(faceBlob, 0.55);

    // 左脸、右列三视图上下叠，避免横条长图超出视频接口宽高比 0.4–2.5
    canvasUi.imageLiveDetail = "正在拼接四视图";
    canvasUi.imageLiveProgress = 86;
    showImageLive(cardId, canvasUi.imageLiveDetail, 86);
    const combinedBlob = await combineImagesBlob([faceBlobTrimmed, frontMosaic, sideMosaic, backMosaic]);
    const combinedName = /image\/png/.test(combinedBlob.type) ? "四视图长图.png" : "四视图长图.jpg";
    const combinedImageId = canvasUid();
    const combinedUrl = await uploadProjectImage(canvasUi.project.id, combinedImageId, combinedBlob);
    card.images.push({ id: combinedImageId, name: combinedName, role: "hero", blob: combinedUrl, auto: true, view: "combined" });
    await writeProject(project);
    renderCanvas();

    canvasUi.imageLiveDetail = "四视图长图已生成";
    canvasUi.imageLiveProgress = 100;
    showImageLive(cardId, canvasUi.imageLiveDetail, 100);
  } catch (error) {
    showCardImageError(cardId, error.message || "生成失败，请重试");
    renderBoard();
  } finally {
    canvasUi.generatingCardIds.delete(cardId);
    canvasUi.imageLiveDetail = "";
    canvasUi.imageLiveProgress = 0;
    renderBoard();
  }
}

function watchGeneration(gen) {
  if (!gen.jobId || canvasUi.pollers.has(gen.id)) return;
  if (gen.status === "completed" || gen.status === "failed") return;
  canvasUi.pollers.add(gen.id);
  const tick = async () => {
    try {
      const response = await fetch(`/api/jobs/${gen.jobId}`);
      const data = await response.json();
      const job = data.job;
      if (!job) throw new Error(data.error || "找不到任务");
      gen.status = job.status;
      gen.progress = job.progress || 0;
      gen.notice = job.notice || "";
      gen.error = job.error || "";
      gen.url = job.url || "";
      gen.local_file = job.local_file || "";
      applyJobQueue(gen, job, data.queue);
      gen.detail = job.error
        || (job.status === "waiting" ? historyStatus(gen) : (job.notice || historyStatus(gen)));
      const video = findVideo(gen.videoId);
      if (job.status === "failed") {
        dropFailedGeneration(gen, job.error || "生成失败");
        if (canvasUi.project) await writeProject(canvasUi.project);
        renderBoard();
        return;
      }
      if (canvasUi.project) await writeProject(canvasUi.project);
      if (job.status === "completed") {
        canvasUi.pollers.delete(gen.id);
        settleGeneration(gen);
        if (video?.activeId === gen.id) renderBoard();
        else {
          paintGeneration(gen);
          syncGenerateButton(gen.videoId);
        }
        return;
      }
      paintGeneration(gen);
    } catch (error) {
      gen.detail = error.message;
      paintGeneration(gen);
    }
    setTimeout(tick, 2000);
  };
  tick();
}

function openGeneration(videoId, genId) {
  const video = findVideo(videoId);
  if (!video || videoBusy(video)) return;
  const gen = video.generations.find((item) => item.id === genId && item.status !== "failed");
  if (!gen) return;
  video.prompt = gen.prompt;
  video.model = normalizeModel(gen.model);
  video.seconds = gen.seconds;
  video.aspect = gen.aspect;
  video.size = "720P";
  video.selected = (gen.selected || []).map((item) => ({ ...item }));
  video.activeId = gen.id;
  writeProject(canvasUi.project);
  renderBoard();
}

function itemSize(kind, id) {
  if (kind === "video") {
    const node = videoEl(id);
    return { w: node?.offsetWidth || 360, h: node?.offsetHeight || 420 };
  }
  const node = document.querySelector(`[data-card="${id}"]`);
  return { w: node?.offsetWidth || 280, h: node?.offsetHeight || 240 };
}

function boundsAt(x, y, w, h) {
  return {
    x, y, w, h,
    left: x,
    cx: x + w / 2,
    right: x + w,
    top: y,
    cy: y + h / 2,
    bottom: y + h,
  };
}

function otherBounds(drag) {
  const project = canvasUi.project;
  if (!project) return [];
  const moving = new Set((drag.items || []).map((item) => selKey(item.kind, item.id)));
  if (drag.kind && drag.id) moving.add(selKey(drag.kind, drag.id));
  const list = [];
  project.cards.forEach((card) => {
    if (moving.has(selKey("card", card.id))) return;
    const size = itemSize("card", card.id);
    list.push(boundsAt(card.x, card.y, size.w, size.h));
  });
  (project.videos || []).forEach((video) => {
    if (moving.has(selKey("video", video.id))) return;
    const size = itemSize("video", video.id);
    list.push(boundsAt(video.x, video.y, size.w, size.h));
  });
  return list;
}

function clearGuides() {
  const svg = byId("guides");
  if (svg) svg.innerHTML = "";
}

function drawGuides(verticalXs, horizontalYs) {
  const svg = byId("guides");
  if (!svg) return;
  const pad = WORLD_PAD;
  const span = 100000;
  const lines = [];
  verticalXs.forEach((x) => {
    lines.push(`<line x1="${x + pad}" y1="0" x2="${x + pad}" y2="${span}"></line>`);
  });
  horizontalYs.forEach((y) => {
    lines.push(`<line x1="0" y1="${y + pad}" x2="${span}" y2="${y + pad}"></line>`);
  });
  svg.innerHTML = lines.join("");
}

function applyDragGuides(drag, point) {
  const size = itemSize(drag.kind, drag.id);
  const active = boundsAt(point.x, point.y, size.w, size.h);
  const others = otherBounds(drag);
  const threshold = 8;
  const xKeys = ["left", "cx", "right"];
  const yKeys = ["top", "cy", "bottom"];
  let bestX = null;
  let bestY = null;
  let refX = null;
  let refY = null;

  others.forEach((other) => {
    xKeys.forEach((ak) => {
      xKeys.forEach((ok) => {
        const delta = Math.abs(active[ak] - other[ok]);
        if (delta <= threshold && (!bestX || delta < bestX.delta)) {
          bestX = { delta, shift: other[ok] - active[ak], line: other[ok] };
          refX = other;
        }
      });
    });
    yKeys.forEach((ak) => {
      yKeys.forEach((ok) => {
        const delta = Math.abs(active[ak] - other[ok]);
        if (delta <= threshold && (!bestY || delta < bestY.delta)) {
          bestY = { delta, shift: other[ok] - active[ak], line: other[ok] };
          refY = other;
        }
      });
    });
  });

  const shiftX = bestX ? bestX.shift : 0;
  const shiftY = bestY ? bestY.shift : 0;
  if (bestX) point.x += bestX.shift;
  if (bestY) point.y += bestY.shift;

  const verticalXs = refX ? [refX.left, refX.cx, refX.right] : [];
  const horizontalYs = refY ? [refY.top, refY.cy, refY.bottom] : [];
  drawGuides(verticalXs, horizontalYs);
  return { x: shiftX, y: shiftY };
}

function updateMarqueeEl() {
  const el = byId("marquee");
  if (!el) return;
  const m = canvasUi.marquee;
  if (!m) {
    el.hidden = true;
    return;
  }
  const x = Math.min(m.x0, m.x1);
  const y = Math.min(m.y0, m.y1);
  const w = Math.abs(m.x1 - m.x0);
  const h = Math.abs(m.y1 - m.y0);
  el.hidden = false;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
}

function marqueeRect() {
  const m = canvasUi.marquee;
  if (!m) return null;
  return {
    x: Math.min(m.x0, m.x1),
    y: Math.min(m.y0, m.y1),
    w: Math.abs(m.x1 - m.x0),
    h: Math.abs(m.y1 - m.y0),
  };
}

function rectsIntersect(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function keysInMarquee() {
  const rect = marqueeRect();
  if (!rect || (rect.w < 2 && rect.h < 2)) return [];
  const keys = [];
  (canvasUi.project?.cards || []).forEach((card) => {
    const size = itemSize("card", card.id);
    if (rectsIntersect(rect, { x: card.x, y: card.y, w: size.w, h: size.h })) {
      keys.push(selKey("card", card.id));
    }
  });
  (canvasUi.project?.videos || []).forEach((video) => {
    const size = itemSize("video", video.id);
    if (rectsIntersect(rect, { x: video.x, y: video.y, w: size.w, h: size.h })) {
      keys.push(selKey("video", video.id));
    }
  });
  return keys;
}

function previewMarqueeSelection() {
  const hits = new Set(keysInMarquee());
  const additive = Boolean(canvasUi.marquee?.additive);
  document.querySelectorAll(".asset[data-card], .vnode[data-video]").forEach((node) => {
    const kind = node.dataset.card ? "card" : "video";
    const id = node.dataset.card || node.dataset.video;
    const key = selKey(kind, id);
    const on = hits.has(key) || (additive && canvasUi.selection.has(key));
    node.classList.toggle("is-selected", on);
  });
}

function commitMarquee() {
  const m = canvasUi.marquee;
  if (!m) return;
  const keys = keysInMarquee();
  const moved = Math.hypot(m.x1 - m.x0, m.y1 - m.y0) > 4;
  if (!moved) {
    if (!m.additive) clearSelection();
  } else {
    setSelection(keys, { additive: m.additive });
  }
  canvasUi.marquee = null;
  updateMarqueeEl();
  syncSelectionClasses();
}

function startDrag(event, kind, id) {
  const project = canvasUi.project;
  const point = kind === "video" ? findVideo(id) : findCard(id);
  if (!point || !project) return false;
  const key = selKey(kind, id);
  if (event.shiftKey) {
    toggleSelection(key);
    return false;
  }
  if (!canvasUi.selection.has(key)) setSelection([key]);
  else syncSelectionClasses();

  let items = selectionEntries();
  if (!items.some((item) => item.kind === kind && item.id === id)) {
    items = [{ kind, id, x: point.x, y: point.y }];
  }
  canvasUi.drag = {
    kind,
    id,
    items,
    clientX: event.clientX,
    clientY: event.clientY,
  };
  byId("viewport")?.classList.add("is-dragging");
  items.forEach((item) => {
    const node = item.kind === "video"
      ? videoEl(item.id)
      : document.querySelector(`[data-card="${item.id}"]`);
    node?.classList.add("is-dragging");
  });
  if (document.activeElement && event.target.closest(".asset, .vnode")?.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  return true;
}

// 拖动整组：点组框空白处（不在卡片/视频上）就拖所有成员一起走
function startGroupDrag(event, groupId) {
  const group = findGroup(groupId);
  if (!group || !canvasUi.project) return false;
  const items = [];
  for (const ref of group.members || []) {
    let item = null;
    if (ref.kind === "card") item = findCard(ref.id);
    else if (ref.kind === "video") item = findVideo(ref.id);
    if (item) items.push({ kind: ref.kind, id: ref.id, x: item.x, y: item.y });
  }
  if (!items.length) return false;
  // 自动选中这个组（拖组 = 选组），UX 一致
  if (canvasUi.selectedGroupId !== groupId) selectGroup(groupId);
  canvasUi.groupDrag = {
    groupId,
    items,
    clientX: event.clientX,
    clientY: event.clientY,
  };
  byId("viewport")?.classList.add("is-dragging");
  return true;
}

function moveDrag(event) {
  // 整组拖动：移动组内所有成员
  const gdrag = canvasUi.groupDrag;
  if (gdrag && canvasUi.project) {
    const scale = canvasUi.view.scale || 1;
    const dx = (event.clientX - gdrag.clientX) / scale;
    const dy = (event.clientY - gdrag.clientY) / scale;
    gdrag.items.forEach((item) => {
      const point = item.kind === "video" ? findVideo(item.id) : findCard(item.id);
      if (!point) return;
      point.x = item.x + dx;
      point.y = item.y + dy;
      const node = item.kind === "video"
        ? videoEl(item.id)
        : document.querySelector(`[data-card="${item.id}"]`);
      if (node) {
        node.style.left = `${point.x}px`;
        node.style.top = `${point.y}px`;
      }
    });
    drawLinks();
    placeHeroToolbar();
    placeVideoToolbar();
    renderGroups();
    return;
  }
  if (canvasUi.marquee) {
    const point = clientToBoard(event.clientX, event.clientY);
    canvasUi.marquee.x1 = point.x;
    canvasUi.marquee.y1 = point.y;
    updateMarqueeEl();
    previewMarqueeSelection();
    return;
  }
  if (canvasUi.pan) {
    canvasUi.view.x = canvasUi.pan.x + event.clientX - canvasUi.pan.clientX;
    canvasUi.view.y = canvasUi.pan.y + event.clientY - canvasUi.pan.clientY;
    applyView();
    placeHeroToolbar();
    placeVideoToolbar();
    return;
  }
  const drag = canvasUi.drag;
  if (!drag || !canvasUi.project) return;
  const scale = canvasUi.view.scale || 1;
  let dx = (event.clientX - drag.clientX) / scale;
  let dy = (event.clientY - drag.clientY) / scale;
  const primary = drag.items.find((item) => item.kind === drag.kind && item.id === drag.id) || drag.items[0];
  if (primary) {
    const guidePoint = { x: primary.x + dx, y: primary.y + dy };
    const snap = applyDragGuides(drag, guidePoint);
    dx = guidePoint.x - primary.x;
    dy = guidePoint.y - primary.y;
    void snap;
  }
  drag.items.forEach((item) => {
    const point = item.kind === "video" ? findVideo(item.id) : findCard(item.id);
    if (!point) return;
    point.x = item.x + dx;
    point.y = item.y + dy;
    const node = item.kind === "video"
      ? videoEl(item.id)
      : document.querySelector(`[data-card="${item.id}"]`);
    if (node) {
      node.style.left = `${point.x}px`;
      node.style.top = `${point.y}px`;
    }
  });
  drawLinks();
  placeHeroToolbar();
  placeVideoToolbar();
}

function toggleHeroToolbar(cardId) {
  if (!canvasUi.project || canvasUi.picking || !cardId) return;
  const card = findCard(cardId);
  const hasHero = card?.type === "character" && (card.images || []).some((image) => image.role === "hero");
  if (!hasHero) return;
  const willOpen = !card.toolbarOpen;
  canvasUi.project.cards.forEach((item) => { item.toolbarOpen = false; });
  card.toolbarOpen = willOpen;
  if (willOpen) canvasUi.videoToolbarId = null;
  canvasUi.toolbarGesture = true;
  clearTimeout(canvasUi.toolbarGestureTimer);
  canvasUi.toolbarGestureTimer = setTimeout(() => { canvasUi.toolbarGesture = false; }, 100);
  renderBoard();
}

async function endDrag(event) {
  const press = canvasUi.toolbarPress;
  const drag = canvasUi.drag;
  if (drag && event && Number.isFinite(event.clientX)) {
    const moved = Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) > 6;
    if (moved) {
      canvasUi.suppressClick = true;
      setTimeout(() => { canvasUi.suppressClick = false; }, 0);
    }
  }
  // 整组拖动结束：先 suppress click，再清状态并写盘
  if (canvasUi.groupDrag) {
    const gdrag = canvasUi.groupDrag;
    if (event && Number.isFinite(event.clientX)) {
      const gMoved = Math.hypot(event.clientX - gdrag.clientX, event.clientY - gdrag.clientY) > 6;
      if (gMoved) {
        canvasUi.suppressClick = true;
        setTimeout(() => { canvasUi.suppressClick = false; }, 0);
      }
    }
    canvasUi.groupDrag = null;
    document.querySelectorAll(".is-dragging").forEach((node) => node.classList.remove("is-dragging"));
    byId("viewport")?.classList.remove("is-dragging");
    if (canvasUi.project) {
      await writeProject(canvasUi.project);
      renderGroups();
    }
    return;
  }
  canvasUi.toolbarPress = null;
  if (canvasUi.linking?.dragging) {
    const drop = highlightDropTarget(event.clientX, event.clientY);
    if (drop) finishLink(drop.id, drop.side);
    else cancelLinking();
    return;
  }
  if (canvasUi.marquee) {
    commitMarquee();
    byId("viewport")?.classList.remove("is-selecting");
    return;
  }
  const moved = canvasUi.drag || canvasUi.pan;
  document.querySelectorAll(".is-dragging").forEach((node) => node.classList.remove("is-dragging"));
  canvasUi.drag = null;
  canvasUi.pan = null;
  clearGuides();
  byId("viewport")?.classList.remove("panning", "is-dragging", "is-selecting");
  const tap = press
    && event?.type !== "pointercancel"
    && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 6;
  if (tap) toggleHeroToolbar(press.id);
  else if (press && openHeroCard()?.id === press.id) {
    canvasUi.toolbarGesture = true;
    clearTimeout(canvasUi.toolbarGestureTimer);
    canvasUi.toolbarGestureTimer = setTimeout(() => { canvasUi.toolbarGesture = false; }, 100);
  }
  if (!moved || !canvasUi.project) return;
  canvasUi.project.view = { ...canvasUi.view };
  await writeProject(canvasUi.project);
  renderHeroToolbar();
  placeVideoToolbar();
  // 成员位置变了，组框 bounds 也得跟着变
  if (canvasUi.project.groups?.length) renderGroups();
}

function onCanvasClick(event) {
  const actor = event.target.closest("[data-act]");
  if (!actor) {
    if (canvasUi.linking && !canvasUi.linking.dragging) cancelLinking();
    if (!event.target.closest("[data-card], [data-video]")) clearSelection();
    return;
  }
  const act = actor.dataset.act;
  if (act !== "port" && act !== "edit-title" && act !== "edit-video-title" && act !== "expand-video-hit") clearSelection();
  const id = actor.dataset.id;
  if (act === "port") return;
  if (act === "toggle-toolbar") {
    if (canvasUi.toolbarGesture) return;
    toggleHeroToolbar(id);
    return;
  }
  if (act === "edit-title") {
    if (actor.dataset.wasSelected !== "1") return;
    beginPureTitleEdit(id);
    return;
  }
  if (act === "edit-video-title") {
    if (actor.dataset.wasSelected !== "1") return;
    beginVideoTitleEdit(actor.dataset.id);
    return;
  }
  if (act === "select-link" || act === "delete-link") {
    selectLink(id);
    return;
  }
  if (act === "open-project") location.hash = `#works/${id}`;
  if (act === "delete-project") {
    askConfirm("删除这个作品？删除后无法恢复。").then((ok) => {
      if (!ok) return;
      removeProject(id).then(() => {
        if (canvasUi.project && canvasUi.project.id === id) {
          canvasUi.project = null;
          location.hash = "#works";
        }
        renderWorks();
      });
    });
  }
  if (act === "focus-card") {
    const card = findCard(id);
    const viewport = byId("viewport");
    if (!card || !viewport) return;
    canvasUi.view.x = viewport.clientWidth / 2 - (card.x + 140) * canvasUi.view.scale;
    canvasUi.view.y = viewport.clientHeight / 2 - (card.y + 80) * canvasUi.view.scale;
    if (canvasUi.project) canvasUi.project.view = { ...canvasUi.view };
    applyView();
    writeProject(canvasUi.project);
  }
  if (act === "delete-card") deleteCard(id);
  if (act === "upload") beginUpload({ cardId: actor.dataset.id, slot: actor.dataset.slot, multiple: actor.dataset.multiple === "1" });
  if (act === "replace-image") beginUpload({ cardId: actor.dataset.card, imageId: actor.dataset.image, multiple: false });
  if (act === "delete-image") {
    askConfirm("删除这张图片？").then((ok) => {
      if (!ok) return;
      const card = findCard(actor.dataset.card);
      if (!card) return;
      dropBlob(actor.dataset.image);
      card.images = card.images.filter((image) => image.id !== actor.dataset.image);
      (canvasUi.project.videos || []).forEach((video) => {
        video.selected = video.selected.filter((item) => item.imageId !== actor.dataset.image);
      });
      writeProject(canvasUi.project).then(renderCanvas);
    });
  }
  if (act === "open-gen") return;
  if (act === "expand-video") {
    const video = findVideo(actor.dataset.video);
    if (video && shouldCollapseVideo(video)) toggleVideoToolbar(video.id);
    else expandVideoCard(actor.dataset.video);
    return;
  }
  if (act === "remove-ref") {
    removeSelectedRef(actor.dataset.video, actor.dataset.card, actor.dataset.image);
    return;
  }
  if (act === "delete-video") {
    deleteVideoCard(id);
    return;
  }
  if (act === "pick-resources") {
    startPicking(actor.dataset.video);
    return;
  }
  if (act === "generate-video") {
    if (actor.disabled || actor.hidden) return;
    enqueueVideo(actor.dataset.video);
    return;
  }
  if (act === "generate-image") {
    if (actor.disabled || actor.hidden) return;
    enqueueImage(actor.dataset.id);
    return;
  }
}

function beginPureTitleEdit(id) {
  const card = findCard(id);
  const current = document.querySelector(`[data-card="${id}"] .pure-title`);
  if (!card || !current || current.matches("input")) return;
  const input = document.createElement("input");
  input.className = "pure-title is-editing";
  input.dataset.act = "rename-card";
  input.dataset.id = id;
  input.dataset.original = card.title || "";
  input.value = card.title || "";
  input.setAttribute("aria-label", "标题");
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      input.value = input.dataset.original || "";
      const live = findCard(id);
      if (live) live.title = input.dataset.original || live.title;
      input.blur();
    }
  });
  input.dataset.arm = "";
  input.addEventListener("blur", () => finishPureTitleEdit(input));
  current.replaceWith(input);
  setTimeout(() => {
    if (!input.isConnected) return;
    input.dataset.arm = "1";
    input.focus();
    input.select();
  }, 0);
}

function finishPureTitleEdit(input) {
  if (!input?.isConnected || !input.classList?.contains("is-editing")) return;
  if (input.dataset.arm !== "1") return;
  input.classList.remove("is-editing");
  const card = findCard(input.dataset.id);
  const title = input.value.trim() || input.dataset.original || card?.title || "";
  if (card) {
    card.title = title;
    const label = document.querySelector(`#cardList [data-id="${card.id}"]`);
    if (label) label.textContent = `${CARD_LABEL[card.type] || "卡片"} · ${card.title}`;
    writeProject(canvasUi.project);
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pure-title";
  button.dataset.act = "edit-title";
  button.dataset.id = input.dataset.id;
  button.textContent = title;
  input.replaceWith(button);
}

function beginVideoTitleEdit(id) {
  const video = findVideo(id);
  const current = document.querySelector(`[data-video="${id}"] .vnode-compact-title`);
  if (!video || videoBusy(video) || !current || current.matches("input")) return;
  const input = document.createElement("input");
  input.className = "vnode-compact-title is-editing";
  input.dataset.act = "rename-video";
  input.dataset.id = id;
  input.dataset.original = video.title || "视频生成";
  input.value = video.title || "视频生成";
  input.setAttribute("aria-label", "标题");
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      input.value = input.dataset.original || "视频生成";
      const live = findVideo(id);
      if (live) live.title = input.dataset.original || live.title;
      input.blur();
    }
  });
  input.addEventListener("blur", () => finishVideoTitleEdit(input));
  current.replaceWith(input);
  input.focus();
  input.select();
}

function finishVideoTitleEdit(input) {
  if (!input?.isConnected || !input.classList?.contains("is-editing")) return;
  input.classList.remove("is-editing");
  const video = findVideo(input.dataset.id);
  const title = input.value.trim() || input.dataset.original || video?.title || "视频生成";
  if (video) {
    video.title = title;
    writeProject(canvasUi.project);
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "vnode-compact-title";
  button.dataset.act = "edit-video-title";
  button.dataset.id = input.dataset.id;
  button.textContent = title;
  input.replaceWith(button);
}

function onCanvasInput(event) {
  const actor = event.target.closest("[data-act]");
  if (!actor || !canvasUi.project) return;
  if (actor.dataset.act === "rename-card") {
    const card = findCard(actor.dataset.id);
    if (!card) return;
    card.title = actor.value.trim() || card.title;
    const label = document.querySelector(`#cardList [data-id="${card.id}"]`);
    if (label) label.textContent = `${CARD_LABEL[card.type] || "卡片"} · ${card.title}`;
    writeProject(canvasUi.project);
  }
  if (actor.dataset.act === "rename-video") {
    const video = findVideo(actor.dataset.id);
    if (!video || videoBusy(video)) return;
    video.title = actor.value.trim() || "视频生成";
    writeProject(canvasUi.project);
  }
}

function onCanvasChange(event) {
  if (!canvasUi.project) return;
  if (event.target.closest("[data-video]") && event.target.matches("select[data-field]")) {
    rememberVideosFromDom();
    writeProject(canvasUi.project);
  }
  const cardNode = event.target.closest("[data-card]");
  if (cardNode && event.target.matches('select[data-field="image-size"]')) {
    const card = findCard(cardNode.dataset.card);
    if (card) {
      card.imageSize = event.target.value;
      writeProject(canvasUi.project);
    }
    return;
  }
  if (cardNode && event.target.matches('select[data-field="image-model"]')) {
    const card = findCard(cardNode.dataset.card);
    if (card) {
      card.imageModel = event.target.value;
      writeProject(canvasUi.project);
    }
    return;
  }
  if (event.target.dataset.act === "rename-project") return;
}

function applyRoute() {
  const hash = location.hash || "#bench";
  // #tools 路由已删除 —— 工具模块下线时去掉；如果用户存了旧 hash，跳到 bench
  if (hash === "#works") {
    canvasUi.project = null;
    setView("works");
    renderWorks();
    return;
  }
  const logsMatch = hash.match(/^#works\/([^/]+)\/logs$/);
  if (logsMatch) {
    const id = decodeURIComponent(logsMatch[1]);
    const project = canvasUi.projects.find((item) => item.id === id);
    if (!project) {
      location.hash = "#works";
      return;
    }
    canvasUi.project = project;
    ensureVideos(project);
    setView("logs");
    renderLogs();
    return;
  }
  if (hash.startsWith("#works/")) {
    const id = decodeURIComponent(hash.slice("#works/".length));
    const project = canvasUi.projects.find((item) => item.id === id);
    if (!project) {
      location.hash = "#works";
      return;
    }
    canvasUi.project = project;
    ensureVideos(project);
    canvasUi.view = { x: 48, y: 36, scale: 1, ...(project.view || {}) };
    canvasUi.picking = false;
    canvasUi.pickingVideoId = null;
    canvasUi.expandedVideoId = null;
    canvasUi.videoToolbarId = null;
    canvasUi.selection.clear();
    canvasUi.marquee = null;
    setView("canvas");
    renderCanvas();
    resumeCanvasQueue();
    (project.videos || []).forEach((video) => {
      (video.generations || []).forEach(watchGeneration);
    });
    return;
  }
  setView("bench");
}

document.querySelectorAll(".side-tab").forEach((button) => {
  button.addEventListener("click", () => {
    const view = button.dataset.view;
    location.hash = view === "canvas" ? "#works" : "#bench";
  });
});
byId("openWorkDialog").addEventListener("click", () => {
  byId("workForm").reset();
  byId("workCoverPreview").hidden = true;
  byId("workCoverPreview").removeAttribute("src");
  byId("workDialogError").hidden = true;
  byId("workDialog").showModal();
});
byId("closeWorkDialog").addEventListener("click", () => byId("workDialog").close());
byId("workCover").addEventListener("change", () => {
  const file = byId("workCover").files[0];
  const preview = byId("workCoverPreview");
  if (preview.dataset.url) URL.revokeObjectURL(preview.dataset.url);
  if (!file) {
    preview.hidden = true;
    return;
  }
  const url = URL.createObjectURL(file);
  preview.dataset.url = url;
  preview.src = url;
  preview.hidden = false;
});
byId("workForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = byId("workCover").files[0];
  if (file && file.size > 15 * 1024 * 1024) {
    byId("workDialogError").hidden = false;
    byId("workDialogError").textContent = "封面请小于 15MB";
    return;
  }
  const project = blankProject();
  project.name = byId("workName").value.trim() || "未命名作品";
  project.brief = byId("workBrief").value.trim();
  if (file) project.cover = file;
  await writeProject(project);
  byId("workDialog").close();
  byId("workForm").reset();
  renderWorks();
});
byId("worksHome").addEventListener("click", onCanvasClick);
byId("backWorks").addEventListener("click", () => {
  location.hash = "#works";
});
byId("openLogs").addEventListener("click", () => {
  if (!canvasUi.project) return;
  location.hash = `#works/${encodeURIComponent(canvasUi.project.id)}/logs`;
});

// === 侧边栏 section 折叠（accordion） ===
const RAIL_FOLD_KEY = "agnes.railFold.v1";

function readRailFold() {
  try {
    const raw = localStorage.getItem(RAIL_FOLD_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}

function writeRailFold(state) {
  try {
    localStorage.setItem(RAIL_FOLD_KEY, JSON.stringify(state || {}));
  } catch (e) { /* ignore quota errors */ }
}

function applyRailFoldState() {
  const state = readRailFold();
  document.querySelectorAll("[data-rail-section]").forEach((section) => {
    const key = section.dataset.railSection;
    const folded = Boolean(state[key]);
    section.classList.toggle("is-folded", folded);
    const head = section.querySelector(".rail-section-head");
    if (head) head.setAttribute("aria-expanded", String(!folded));
  });
  syncRailFoldAllButton();
}

function syncRailFoldAllButton() {
  const btn = byId("railFoldAll");
  if (!btn) return;
  const sections = document.querySelectorAll("[data-rail-section]");
  const allFolded = sections.length > 0 && Array.from(sections).every((s) => s.classList.contains("is-folded"));
  const rail = byId("canvasRail");
  if (rail) rail.classList.toggle("is-all-folded", allFolded);
  const tip = btn.querySelector(".icon-tip");
  if (tip) tip.textContent = allFolded ? "全部展开" : "全部收起";
  btn.setAttribute("aria-label", allFolded ? "全部展开" : "全部收起");
  btn.setAttribute("title", allFolded ? "全部展开" : "全部收起");
}

function toggleRailSection(key) {
  const state = readRailFold();
  state[key] = !state[key];
  writeRailFold(state);
  applyRailFoldState();
}

function toggleAllRailSections() {
  const sections = document.querySelectorAll("[data-rail-section]");
  if (!sections.length) return;
  const allFolded = Array.from(sections).every((s) => s.classList.contains("is-folded"));
  const state = readRailFold();
  const wantFold = !allFolded;
  sections.forEach((section) => {
    state[section.dataset.railSection] = wantFold;
  });
  writeRailFold(state);
  applyRailFoldState();
}

document.addEventListener("click", (event) => {
  const head = event.target.closest(".rail-section-head");
  if (!head) return;
  // 阻止内嵌按钮（如更换封面）误触折叠
  if (event.target.closest(".rail-section-action")) return;
  const section = head.closest("[data-rail-section]");
  if (!section) return;
  toggleRailSection(section.dataset.railSection);
});

byId("railFoldAll")?.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleAllRailSections();
});

applyRailFoldState();
byId("backLogs").addEventListener("click", () => {
  if (!canvasUi.project) {
    location.hash = "#works";
    return;
  }
  location.hash = `#works/${encodeURIComponent(canvasUi.project.id)}`;
});
byId("canvasRail").addEventListener("click", (event) => {
  clearSelection();
  const collapsed = maybeCollapseFromEvent(event);
  onCanvasClick(event);
  if (collapsed) renderBoard();
});
byId("canvasTitle").addEventListener("change", () => {
  if (!canvasUi.project) return;
  canvasUi.project.name = byId("canvasTitle").value.trim() || "未命名作品";
  writeProject(canvasUi.project);
});
byId("canvasBriefEdit").addEventListener("change", () => {
  if (!canvasUi.project) return;
  canvasUi.project.brief = byId("canvasBriefEdit").value.trim();
  writeProject(canvasUi.project);
});
function openCoverPicker() {
  byId("canvasCover").click();
}
byId("canvasCoverBtn").addEventListener("click", openCoverPicker);
byId("canvasCoverHit").addEventListener("click", openCoverPicker);
byId("canvasCover").addEventListener("change", async () => {
  const project = canvasUi.project;
  const file = byId("canvasCover").files[0];
  byId("canvasCover").value = "";
  if (!project || !file) return;
  if (file.size > 15 * 1024 * 1024) {
    showCanvasError("封面请小于 15MB");
    return;
  }
  if (project.cover) dropBlob(`cover-${project.id}`);
  project.cover = file;
  showCanvasError("");
  await writeProject(project);
  renderCanvas();
  renderWorks();
});
byId("zoomIn").addEventListener("click", () => {
  clearSelection();
  const viewport = byId("viewport");
  zoomAt(canvasUi.view.scale * 1.08, viewport.clientWidth / 2, viewport.clientHeight / 2);
  if (canvasUi.project) writeProject(canvasUi.project);
});
byId("zoomOut").addEventListener("click", () => {
  clearSelection();
  const viewport = byId("viewport");
  zoomAt(canvasUi.view.scale / 1.08, viewport.clientWidth / 2, viewport.clientHeight / 2);
  if (canvasUi.project) writeProject(canvasUi.project);
});
// === 组（group）相关按钮 + 颜色面板 ===
function paintColorSwatches() {
  const container = byId("colorSwatches");
  if (!container) return;
  container.innerHTML = GROUP_PRESETS.map(
    (c) => `<button type="button" class="color-swatch" data-color="${c}" style="background:${c};" aria-label="选择颜色 ${c}"></button>`
  ).join("");
}
paintColorSwatches();

byId("groupSelectionBtn")?.addEventListener("click", () => {
  createGroupFromSelection();
});

// 按组件名字横向排序组内成员（保持相对 Y 在同一行）
function sortGroupMembersByName(groupId) {
  const group = findGroup(groupId);
  if (!group || !canvasUi.project) return;
  const bounds = computeGroupBounds(group);
  if (!bounds) return;
  const project = canvasUi.project;
  const items = [];
  for (const ref of group.members || []) {
    let item = null;
    if (ref.kind === "card") item = findCard(ref.id);
    else if (ref.kind === "video") item = findVideo(ref.id);
    if (item) items.push({ ref, item });
  }
  if (!items.length) return;

  // 按标题排序（locale-aware，中文按拼音 / 英文字母）
  items.sort((a, b) => {
    const ta = String(a.item.title || a.item.prompt || "").trim();
    const tb = String(b.item.title || b.item.prompt || "").trim();
    return ta.localeCompare(tb, "zh-Hans-CN", { numeric: true });
  });

  // 用最大成员宽度作为列距，留 32px 间隙
  let maxW = 0;
  for (const { ref } of items) {
    const sz = itemSize(ref.kind, ref.id);
    if (sz.w > maxW) maxW = sz.w;
  }
  const stride = maxW + 32;
  const startX = bounds.x + GROUP_PAD;
  const rowY = bounds.y + GROUP_PAD;

  items.forEach(({ ref, item }, i) => {
    item.x = startX + i * stride;
    item.y = rowY;
    const node = ref.kind === "video"
      ? videoEl(ref.id)
      : document.querySelector(`[data-card="${ref.id}"]`);
    if (node) {
      node.style.left = `${item.x}px`;
      node.style.top = `${item.y}px`;
    }
  });

  drawLinks();
  placeHeroToolbar();
  placeVideoToolbar();
  renderGroups();
  writeProject(project);
}

byId("sortGroupBtn")?.addEventListener("click", () => {
  if (canvasUi.selectedGroupId) sortGroupMembersByName(canvasUi.selectedGroupId);
});

byId("deleteGroupBtn")?.addEventListener("click", () => {
  if (canvasUi.selectedGroupId) ungroup(canvasUi.selectedGroupId);
});

byId("groupNameInput")?.addEventListener("change", () => {
  if (canvasUi.selectedGroupId) renameGroup(canvasUi.selectedGroupId, byId("groupNameInput").value);
});
byId("groupNameInput")?.addEventListener("blur", () => {
  if (canvasUi.selectedGroupId) renameGroup(canvasUi.selectedGroupId, byId("groupNameInput").value);
});
byId("groupColorInput")?.addEventListener("input", () => {
  if (canvasUi.selectedGroupId) setGroupColor(canvasUi.selectedGroupId, byId("groupColorInput").value);
});

byId("colorSwatches")?.addEventListener("click", (event) => {
  const swatch = event.target.closest(".color-swatch");
  if (!swatch) return;
  const color = swatch.dataset.color;
  if (canvasUi.selectedGroupId && color) setGroupColor(canvasUi.selectedGroupId, color);
});

// 组的 click / dblclick 委托：挂在 board（持久容器）上，groupsLayer 会被 renderBoard() 整体替换
byId("board")?.addEventListener("click", (event) => {
  const groupEl = event.target.closest(".group-rect");
  if (!groupEl) return;
  if (event.target.closest(".asset, .vnode")) return;
  if (event.target.closest(".group-name.is-editing")) return;
  event.stopPropagation();
  selectGroup(groupEl.dataset.groupId);
});
byId("board")?.addEventListener("dblclick", (event) => {
  const nameEl = event.target.closest(".group-name");
  if (!nameEl || !nameEl.matches("span")) return;
  const groupEl = nameEl.closest(".group-rect");
  if (!groupEl) return;
  event.stopPropagation();
  event.preventDefault();
  beginGroupNameEdit(groupEl.dataset.groupId);
});

// 删除单卡时也要把成员关系从组里清掉
function pruneGroupMembers(project) {
  if (!project?.groups?.length) return;
  for (const group of project.groups) {
    group.members = (group.members || []).filter((ref) => {
      if (ref.kind === "card") return !!findCard(ref.id);
      if (ref.kind === "video") return !!findVideo(ref.id);
      return false;
    });
  }
  project.groups = project.groups.filter((g) => (g.members || []).length >= 1);
}
byId("viewport").addEventListener("wheel", (event) => {
  if (byId("canvasView").hidden) return;
  if (event.target.closest("textarea, input, select")) return;
  event.preventDefault();
  // 触控板双指滑动 / 鼠标滚轮：平移画布。捏合（macOS 会带 ctrlKey）或 Ctrl/⌘+滚轮才缩放。
  if (event.ctrlKey || event.metaKey) {
    const rect = byId("viewport").getBoundingClientRect();
    const intensity = Math.min(0.08, Math.abs(event.deltaY) * 0.0012);
    const factor = event.deltaY < 0 ? 1 + intensity : 1 / (1 + intensity);
    zoomAt(canvasUi.view.scale * factor, event.clientX - rect.left, event.clientY - rect.top);
    return;
  }
  const line = 16;
  const page = byId("viewport")?.clientHeight || 400;
  const dx = event.deltaMode === 1 ? event.deltaX * line
    : event.deltaMode === 2 ? event.deltaX * page
    : event.deltaX;
  const dy = event.deltaMode === 1 ? event.deltaY * line
    : event.deltaMode === 2 ? event.deltaY * page
    : event.deltaY;
  if (!dx && !dy) return;
  canvasUi.view.x -= dx;
  canvasUi.view.y -= dy;
  if (canvasUi.project) canvasUi.project.view = { ...canvasUi.view };
  applyView();
  placeHeroToolbar();
  placeVideoToolbar();
  clearTimeout(canvasUi.viewTimer);
  canvasUi.viewTimer = setTimeout(() => {
    if (canvasUi.project) writeProject(canvasUi.project);
  }, 250);
}, { passive: false });
byId("viewport").addEventListener("dblclick", (event) => {
  if (byId("canvasView").hidden || !canvasUi.project) return;
  if (event.target.closest(".asset, .vnode, .group-rect, button, input, textarea, select, a, .port")) return;
  clearSelection();
  if (collapseExpandedVideo()) renderBoard();
  canvasUi.dropAt = clientToBoard(event.clientX, event.clientY);
  byId("addCardDialog").showModal();
});
byId("closeAddCardDialog").addEventListener("click", () => byId("addCardDialog").close());
byId("addCardForm").addEventListener("click", (event) => {
  const button = event.target.closest("[data-card-type]");
  if (!button) return;
  const at = canvasUi.dropAt;
  canvasUi.dropAt = null;
  byId("addCardDialog").close();
  addCard(button.dataset.cardType, at);
});
byId("board").addEventListener("pointerover", (event) => {
  const node = event.target.closest("[data-card], [data-video]");
  if (!node) return;
  setLinkFocus(node.dataset.card || node.dataset.video);
});
byId("board").addEventListener("pointerout", (event) => {
  const from = event.target.closest("[data-card], [data-video]");
  if (!from) return;
  const to = event.relatedTarget?.closest?.("[data-card], [data-video]");
  if (to && (to.dataset.card || to.dataset.video) === (from.dataset.card || from.dataset.video)) return;
  if (!event.relatedTarget || !byId("board")?.contains(event.relatedTarget)) {
    setLinkFocus(null);
    return;
  }
  if (!to) setLinkFocus(null);
});
byId("board").addEventListener("click", (event) => {
  if (canvasUi.suppressClick) {
    canvasUi.suppressClick = false;
    return;
  }
  const compactPlayer = event.target.closest(".vnode.is-compact video.vnode-player");
  if (compactPlayer && !isVideoChromeClick(event, compactPlayer)) {
    const id = compactPlayer.closest("[data-video]")?.dataset.video;
    if (id) {
      toggleVideoToolbar(id);
      return;
    }
  }

  const collapsed = maybeCollapseFromEvent(event);

  if (event.target.closest("[data-act=pick-done]")) {
    finishPicking();
    if (collapsed) renderBoard();
    return;
  }
  if (event.target.closest("[data-act=pick-cancel]")) {
    cancelPicking();
    if (collapsed) renderBoard();
    return;
  }
  if (event.target.closest("[data-stop]")) {
    onCanvasClick(event);
    if (collapsed) renderBoard();
    return;
  }
  if (canvasUi.picking) {
    const card = event.target.closest("[data-card]");
    if (card) {
      toggleCardResources(card.dataset.card);
      if (collapsed) renderBoard();
      return;
    }
  }
  onCanvasClick(event);
  if (collapsed) renderBoard();
});
byId("board").addEventListener("input", (event) => {
  const videoNode = event.target.closest("[data-video]");
  if (videoNode && event.target.matches('[data-field="prompt"]')) {
    const video = findVideo(videoNode.dataset.video);
    if (video) video.prompt = event.target.value;
    return;
  }
  const cardNode = event.target.closest("[data-card]");
  if (cardNode && event.target.matches('[data-field="image-prompt"]')) {
    rememberHeroPrompt(event.target);
    return;
  }
  if (cardNode && event.target.matches('[data-field="text"]')) {
    const card = findCard(cardNode.dataset.card);
    if (card) card.text = event.target.value;
    return;
  }
  onCanvasInput(event);
});
byId("board").addEventListener("change", (event) => {
  if (maybeCollapseFromEvent(event)) {
    onCanvasChange(event);
    renderBoard();
    return;
  }
  onCanvasChange(event);
});
// 浮动工具栏挂在 viewport（不在卡片内部）：内部操作走 onCanvasClick；点外面收起
byId("viewport").addEventListener("click", (event) => {
  if (!canvasUi.project) return;
  const toolbar = event.target.closest("#heroToolbar, #videoToolbar");
  if (toolbar) {
    if (event.target.closest("[data-act=pick-done]")) {
      finishPicking();
      return;
    }
    if (event.target.closest("[data-act=pick-cancel]")) {
      cancelPicking();
      return;
    }
    onCanvasClick(event);
    return;
  }
  if (canvasUi.picking) return;
  if (event.target.closest("[data-act=toggle-toolbar], [data-act=expand-video], .vnode.is-compact, .pure-bar")) return;
  if (canvasUi.toolbarGesture) return;
  const heroOpen = canvasUi.project.cards.some((card) => card.toolbarOpen);
  const videoOpen = Boolean(canvasUi.videoToolbarId);
  if (!heroOpen && !videoOpen) return;
  canvasUi.project.cards.forEach((card) => { card.toolbarOpen = false; });
  canvasUi.videoToolbarId = null;
  renderHeroToolbar();
  renderVideoToolbar();
});
function rememberHeroPrompt(field) {
  if (!canvasUi.project || !field?.matches?.('[data-field="image-prompt"]')) return;
  const card = findCard(field.dataset.id);
  if (!card) return;
  card.prompt = field.value;
  clearTimeout(canvasUi.promptTimer);
  canvasUi.promptTimer = setTimeout(() => {
    if (canvasUi.project) writeProject(canvasUi.project);
  }, 250);
}

byId("viewport").addEventListener("input", (event) => {
  const hero = event.target.closest("#heroToolbar");
  if (hero && event.target.matches('[data-field="image-prompt"]')) {
    rememberHeroPrompt(event.target);
    return;
  }
  const videoBar = event.target.closest("#videoToolbar");
  if (videoBar && canvasUi.project && event.target.matches('[data-field="prompt"]')) {
    const video = findVideo(videoBar.dataset.toolbar);
    if (video) video.prompt = event.target.value;
  }
});
byId("viewport").addEventListener("change", (event) => {
  const hero = event.target.closest("#heroToolbar");
  if (hero && canvasUi.project && event.target.matches('select[data-field="image-model"]')) {
    const card = findCard(event.target.dataset.id || hero.dataset.toolbar);
    if (card) {
      card.imageModel = event.target.value;
      writeProject(canvasUi.project);
    }
    return;
  }
  const videoBar = event.target.closest("#videoToolbar");
  if (!videoBar || !canvasUi.project) return;
  if (event.target.matches("select[data-field]")) {
    rememberVideosFromDom();
    writeProject(canvasUi.project);
  }
});
byId("viewport").addEventListener("focusout", (event) => {
  if (!canvasUi.project) return;
  if (event.target.closest("#heroToolbar") && event.target.matches('[data-field="image-prompt"]')) {
    rememberHeroPrompt(event.target);
    clearTimeout(canvasUi.promptTimer);
    writeProject(canvasUi.project);
    return;
  }
  if (!event.target.closest("#videoToolbar")) return;
  rememberVideosFromDom();
  writeProject(canvasUi.project);
});
byId("viewport").addEventListener("pointerdown", (event) => {
  if (event.target.closest(".zoom-bar, .select-bar")) return;
  if (canvasUi.picking) {
    if (event.target.closest("[data-video]")) return;
    if (event.target.closest("[data-card]")) return;
    canvasUi.pan = {
      x: canvasUi.view.x,
      y: canvasUi.view.y,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    byId("viewport").classList.add("panning");
    try { byId("viewport").setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
    return;
  }
  const linkHit = event.target.closest("[data-act=select-link], [data-act=delete-link]");
  if (linkHit && event.button === 0) {
    event.preventDefault();
    event.stopPropagation();
    selectLink(linkHit.dataset.id);
    return;
  }
  const compactTitle = event.target.closest(".vnode-compact-title");
  if (compactTitle && event.button === 0 && !compactTitle.matches("input")) {
    const id = compactTitle.dataset.id;
    const key = selKey("video", id);
    compactTitle.dataset.wasSelected = canvasUi.selection.has(key) ? "1" : "";
    clearSelectedLink();
    if (event.shiftKey) toggleSelection(key);
    else if (startDrag(event, "video", id)) {
      try { byId("viewport").setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
    }
    event.stopPropagation();
    return;
  }
  if (event.target.closest(".compact-delete") && event.button === 0) {
    event.stopPropagation();
    return;
  }
  const compactPlayer = event.target.closest(".vnode.is-compact video.vnode-player");
  const compactBody = compactPlayer && !isVideoChromeClick(event, compactPlayer);
  if (compactPlayer && !compactBody) return;
  if (compactBody && event.button === 0) event.preventDefault();
  const port = event.target.closest(".port");
  if (port) {
    const portVideo = findVideo(port.dataset.id);
    if (port.disabled || (portVideo && videoBusy(portVideo))) return;
    if (port.dataset.id !== canvasUi.expandedVideoId && collapseExpandedVideo()) renderBoard();
    event.preventDefault();
    event.stopPropagation();
    clearSelection();
    beginLink(port.dataset.id, port.dataset.side, true);
    canvasUi.linking.cursor = clientToBoard(event.clientX, event.clientY);
    drawLinks();
    try { byId("viewport").setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
    return;
  }
  const pureTitle = event.target.closest(".pure-title");
  if (pureTitle && event.button === 0 && !pureTitle.matches("input")) {
    const id = pureTitle.dataset.id;
    const key = selKey("card", id);
    pureTitle.dataset.wasSelected = event.shiftKey ? "" : (canvasUi.selection.has(key) ? "1" : "");
    clearSelectedLink();
    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) toggleSelection(key);
    else if (startDrag(event, "card", id)) {
      try { byId("viewport").setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
    }
    return;
  }
  if (pureTitle?.matches("input") && event.button === 0) {
    event.stopPropagation();
    return;
  }
  if (!compactBody && event.target.closest("#heroToolbar, #videoToolbar, button, input, textarea, select, a, label, .icon-btn, .icon-row, video")) {
    clearSelection();
    return;
  }
  if (canvasUi.linking) return;
  const video = event.target.closest("[data-video]");
  const card = event.target.closest("[data-card]");
  if (video) {
    clearSelectedLink();
    if (video.dataset.video !== canvasUi.expandedVideoId && collapseExpandedVideo()) renderBoard();
    if (startDrag(event, "video", video.dataset.video)) {
      try { byId("viewport").setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
    }
    return;
  }
  if (card) {
    clearSelectedLink();
    const pureTap = event.button === 0
      && !event.shiftKey
      && card.classList.contains("is-pure")
      && !event.target.closest(".pure-bar");
    if (pureTap) {
      const editing = card.querySelector(".pure-title.is-editing");
      if (editing) finishPureTitleEdit(editing);
      canvasUi.toolbarPress = { id: card.dataset.card, x: event.clientX, y: event.clientY };
      event.preventDefault();
    }
    if (collapseExpandedVideo()) renderBoard();
    if (startDrag(event, "card", card.dataset.card)) {
      try { byId("viewport").setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
    }
    return;
  }
  // 点组框空白处（不在卡片/视频上）→ 拖整组
  const groupEl = event.target.closest(".group-rect");
  if (groupEl && !event.target.closest(".asset, .vnode")) {
    if (event.button === 0) event.preventDefault();
    clearSelectedLink();
    if (startGroupDrag(event, groupEl.dataset.groupId)) {
      try { byId("viewport").setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
    }
    return;
  }
  if (collapseExpandedVideo()) renderBoard();
  if (event.button === 1) event.preventDefault();
  const wantPan = canvasUi.spaceDown || event.button === 1 || event.altKey;
  clearSelectedLink();
  if (wantPan) {
    clearSelection();
    canvasUi.pan = {
      x: canvasUi.view.x,
      y: canvasUi.view.y,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    byId("viewport").classList.add("panning");
  } else {
    const point = clientToBoard(event.clientX, event.clientY);
    if (!event.shiftKey) clearSelection();
    canvasUi.marquee = {
      x0: point.x,
      y0: point.y,
      x1: point.x,
      y1: point.y,
      additive: event.shiftKey,
    };
    byId("viewport").classList.add("is-selecting");
    updateMarqueeEl();
  }
  try { byId("viewport").setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
});
window.addEventListener("pointermove", (event) => {
  if (canvasUi.linking?.dragging) {
    const drop = highlightDropTarget(event.clientX, event.clientY);
    if (drop) {
      const snap = portPoint(drop.id, drop.side);
      canvasUi.linking.cursor = snap || clientToBoard(event.clientX, event.clientY);
    } else {
      canvasUi.linking.cursor = clientToBoard(event.clientX, event.clientY);
    }
    drawLinks();
    return;
  }
  if (canvasUi.linking) {
    const drop = highlightDropTarget(event.clientX, event.clientY);
    if (drop) {
      const snap = portPoint(drop.id, drop.side);
      canvasUi.linking.cursor = snap || clientToBoard(event.clientX, event.clientY);
    } else {
      canvasUi.linking.cursor = clientToBoard(event.clientX, event.clientY);
    }
    drawLinks();
  }
  moveDrag(event);
});
window.addEventListener("pointerup", endDrag);
window.addEventListener("pointercancel", endDrag);
window.addEventListener("keydown", (event) => {
  if (event.code === "Space" && !event.repeat && !event.target.closest("input, textarea, select, [contenteditable]")) {
    canvasUi.spaceDown = true;
    byId("viewport")?.classList.add("space-pan");
    event.preventDefault();
  }
  if (event.key === "Escape") {
    if (canvasUi.linking) cancelLinking();
    else {
      clearSelectedLink();
      clearSelection();
    }
  }
  if ((event.key === "Backspace" || event.key === "Delete")
    && !event.target.closest("input, textarea, select, [contenteditable]")
    && (canvasUi.selectedLinkId || canvasUi.selection.size)) {
    event.preventDefault();
    deleteSelection();
  }
  if ((event.key === "a" || event.key === "A") && (event.metaKey || event.ctrlKey)
    && byId("canvasView") && !byId("canvasView").hidden
    && !event.target.closest("input, textarea, select, [contenteditable]")) {
    event.preventDefault();
    const keys = [
      ...(canvasUi.project?.cards || []).map((card) => selKey("card", card.id)),
      ...(canvasUi.project?.videos || []).map((video) => selKey("video", video.id)),
    ];
    setSelection(keys);
  }
});
window.addEventListener("keyup", (event) => {
  if (event.code === "Space") {
    canvasUi.spaceDown = false;
    byId("viewport")?.classList.remove("space-pan");
  }
});
window.addEventListener("blur", () => {
  canvasUi.spaceDown = false;
  byId("viewport")?.classList.remove("space-pan");
});
byId("cardFile").addEventListener("change", () => {
  const files = [...byId("cardFile").files];
  byId("cardFile").value = "";
  if (files.length) attachFiles(files);
});
byId("board").addEventListener("focusout", (event) => {
  if (event.target.matches?.(".pure-title.is-editing")) finishPureTitleEdit(event.target);
  if (event.target.matches?.(".vnode-compact-title.is-editing")) finishVideoTitleEdit(event.target);
  if (!canvasUi.project) return;
  if (event.target.closest("[data-video]") && event.target.matches('[data-field="prompt"]')) {
    rememberVideosFromDom();
    writeProject(canvasUi.project);
  }
});
function setToolButton(id, handler) {
  const el = byId(id);
  if (el) el.addEventListener("click", handler);
  return el;
}

// ===== 工具模块（去水印 / 超分）已移除 =====
// renderTools / postTool / setToolButton("upReveal") / setToolButton("wmOpen/Start/Stop")
// 全部清理；applyRoute 里的 `if (tools) renderTools();` 也已删

window.addEventListener("hashchange", applyRoute);

readProjects().then(applyRoute).catch((error) => showCanvasError(error.message));
