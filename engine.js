/* =========================================================
 * Darask Novel Engine
 * scenario.txt を置くだけで動くシンプルなノベルゲームエンジン
 * ========================================================= */
"use strict";

/* ---------- 定数 ---------- */
const STORAGE_PREFIX = "dne_";
const ASSET_DIR = { bg: "bg/", cg: "cg/", bgm: "bgm/", se: "se/", chara: "chara/", voice: "voice/" };
const ENTRY_FILE = "scenario.txt";

// 立ち絵の表示位置キーワード → 内部位置
const CHARA_POS = {
  left: "left", l: "left", "左": "left",
  center: "center", c: "center", "中": "center", "中央": "center",
  right: "right", r: "right", "右": "right",
};

// 既知の @コマンド(検証で未知コマンドを警告するのに使う)
const KNOWN_CMDS = new Set([
  "title", "titlebg", "bg", "cg", "chara", "show", "sprite", "face", "expr",
  "hide", "bgm", "se", "voice", "amb", "scene", "wait", "set", "jump", "goto",
  "label", "if", "end", "ending",
  "shake", "flash", "fadeout", "fadein", "input",
]);

const DEFAULT_KEYS = {
  advance:    "Enter",       // 読み進める
  skip:       "ControlLeft", // 押している間スキップ
  auto:       "KeyA",        // オートモード切替
  hide:       "KeyH",        // メッセージウィンドウ非表示
  backlog:    "KeyB",        // バックログ
  fullscreen: "KeyF",        // フルスクリーン
  save:       "KeyS",        // クイックセーブ
  load:       "KeyL",        // クイックロード
  menu:       "Escape",      // メニュー
  debug:      "F9",          // デバッグ表示
};

const KEY_LABELS = {
  advance: "読み進める",
  skip: "スキップ(押しっぱなし)",
  auto: "オートモード切替",
  hide: "ウィンドウ非表示",
  backlog: "バックログ",
  fullscreen: "フルスクリーン",
  save: "クイックセーブ",
  load: "クイックロード",
  menu: "メニュー",
  debug: "デバッグ表示",
};

const DEFAULT_SETTINGS = {
  textSpeed: 30,     // 1文字あたりms (0=瞬間表示)
  autoWait: 1800,    // オートモードの待ち時間ms
  bgmVol: 60,
  seVol: 80,
  voiceVol: 90,
  skipUnread: 0,     // 1: 未読もスキップ / 0: 既読のみスキップ
};

const NAME_COLORS = [
  "#8ecbff", "#ffb3c1", "#b6f2a8", "#ffd88a",
  "#d3b3ff", "#8affe2", "#ffab8a", "#c9d4ff",
];

const FADE_MS = 350;          // 既定のフェード時間
const SAVE_SLOTS = ["q", "1", "2", "3", "4", "5", "6"]; // q=クイックセーブ

/* ---------- 状態 ---------- */
const G = {
  file: ENTRY_FILE,
  nodes: [],
  rawFiles: {},
  parsedFiles: {},
  nameColors: {},

  flags: {},
  pos: 0,
  shownIndex: -1,
  curBg: "",
  curCg: "",
  chara: {},
  lastSpeaker: null,
  currentScene: "",

  typing: false,
  typeTimer: null,
  units: [],          // 整形済みテキストユニット
  totalSteps: 0,
  waiting: false,
  waitTimer: null,
  choosing: false,
  choiceOptions: [],

  autoMode: false,
  autoTimer: null,
  skipHeld: false,
  skipTimer: null,
  uiHidden: false,
  lastLineRead: false, // 直近に表示した行が既読だったか(既読スキップ判定用)

  inGame: false,
  keyCapture: null,
  debugOn: false,

  backlog: [],
  settingsReturn: "title",
  saveMode: false,    // セーブ/ロード画面がセーブモードか

  keys: { ...DEFAULT_KEYS },
  settings: { ...DEFAULT_SETTINGS },
  unlockedCG: new Set(),
  cgRegistry: [],
  sceneRegistry: [],
  sceneSnaps: {},
  readSet: new Set(),        // 既読行 "file#idx"
  endingRegistry: [],        // [{file, name}]
  unlockedEndings: new Set(),
  titleBg: "",

  bgm: null,
  bgmName: "",
  bgmFadeTimer: null,
  voice: null,
  amb: null,
  ambName: "",
  pendingVoice: null,   // 次のセリフに紐づくボイス
  lastLineVoice: null,  // バックログ再生用
  chosenSet: new Set(), // 選択済みの選択肢 "file|テキスト"
  devTimer: null,       // 開発モードの自動リロード
  devRaw: {},           // 自動リロード比較用の生テキスト
};

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const screens = {
  title: $("screen-title"),
  game: $("screen-game"),
  gallery: $("screen-gallery"),
  scenes: $("screen-scenes"),
  endings: $("screen-endings"),
  settings: $("screen-settings"),
};

/* =========================================================
 * ストレージ
 * ========================================================= */
/* 永続化は「メモリ上の CACHE + バックエンド書き込み」方式。
 *  - exe(Electron): window.daraskFS 経由で save/<key>.json に読み書き(exeと同じ階層)
 *  - ブラウザ: localStorage
 * どちらでも restore()/store() は同期的に CACHE を参照/更新する。 */
let FS = null;
const CACHE = {};
const flushTimers = {};

async function initStorage() {
  FS = (typeof window !== "undefined" && window.daraskFS) || null;
  if (FS) {
    let files = [];
    try { files = await FS.list(); } catch (e) {}
    for (const f of files) {
      const key = f.replace(/\.json$/, "");
      try { const txt = await FS.read(f); if (txt != null) CACHE[key] = JSON.parse(txt); } catch (e) {}
    }
  } else {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const lk = localStorage.key(i);
        if (lk && lk.startsWith(STORAGE_PREFIX)) {
          try { CACHE[lk.slice(STORAGE_PREFIX.length)] = JSON.parse(localStorage.getItem(lk)); } catch (e) {}
        }
      }
    } catch (e) {}
  }
}

function persistKey(key) {
  const val = CACHE[key];
  if (FS) {
    // セーブスロットは即書き込み、頻繁に更新される他キーはデバウンス
    if (key.startsWith("slot_")) { FS.write(key + ".json", JSON.stringify(val)); }
    else {
      clearTimeout(flushTimers[key]);
      flushTimers[key] = setTimeout(() => FS.write(key + ".json", JSON.stringify(val)), 250);
    }
  } else {
    try { localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(val)); } catch (e) {}
  }
}

function store(key, val) { CACHE[key] = val; persistKey(key); }
function restore(key, fallback) { return key in CACHE ? CACHE[key] : fallback; }
function removeKey(key) {
  delete CACHE[key];
  if (FS) { clearTimeout(flushTimers[key]); FS.remove(key + ".json"); }
  else { try { localStorage.removeItem(STORAGE_PREFIX + key); } catch (e) {} }
}

/* エクスポート/インポート(全セーブ・設定・解放状況を1ファイルで) */
function exportAll() {
  const blob = new Blob([JSON.stringify({ engine: "darask-novel-engine", data: CACHE }, null, 2)],
    { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "darask-save.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importAll(file) {
  file.text().then((txt) => {
    let obj;
    try { obj = JSON.parse(txt); } catch (e) { showToast("読み込めないファイルです"); return; }
    const data = obj && obj.data ? obj.data : obj;
    if (!data || typeof data !== "object") { showToast("形式が違います"); return; }
    for (const [k, v] of Object.entries(data)) store(k, v);
    loadPersistent();
    updateContinueButton();
    showToast("読み込みました");
    if (!$("overlay-saveload").classList.contains("hidden")) buildSlotGrid();
  });
}

function loadPersistent() {
  G.keys = { ...DEFAULT_KEYS, ...restore("keys", {}) };
  G.settings = { ...DEFAULT_SETTINGS, ...restore("settings", {}) };
  G.unlockedCG = new Set(restore("unlockedCG", []));
  G.cgRegistry = restore("cgRegistry", []);
  G.sceneRegistry = restore("sceneRegistry", []);
  G.sceneSnaps = restore("sceneSnaps", {});
  G.readSet = new Set(restore("readSet", []));
  G.endingRegistry = restore("endingRegistry", []);
  G.unlockedEndings = new Set(restore("unlockedEndings", []));
  G.chosenSet = new Set(restore("chosenSet", []));
}

function savePersistent() {
  store("keys", G.keys);
  store("settings", G.settings);
  store("unlockedCG", [...G.unlockedCG]);
  store("cgRegistry", G.cgRegistry);
  store("sceneRegistry", G.sceneRegistry);
  store("sceneSnaps", G.sceneSnaps);
  store("endingRegistry", G.endingRegistry);
  store("unlockedEndings", [...G.unlockedEndings]);
}
// 既読は量が多くなるので個別に保存
function saveRead() { store("readSet", [...G.readSet]); }

/* =========================================================
 * シナリオのパース
 * ========================================================= */
function parseScenario(text) {
  const nodes = [];
  const scenes = [];
  const cgList = [];
  const labels = {};
  const warnings = [];

  // 行末が \ の行は次行と連結(1つのメッセージにする)
  const rawLines = text.split(/\r?\n/);
  const lines = [];
  const lineNo = [];
  for (let i = 0; i < rawLines.length; i++) {
    let ln = rawLines[i];
    let no = i + 1;
    while (/\\\s*$/.test(ln) && i + 1 < rawLines.length) {
      ln = ln.replace(/\\\s*$/, "\n") + rawLines[i + 1];
      i++;
    }
    lines.push(ln);
    lineNo.push(no);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, "");
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (isComment(trimmed)) continue;

    // 選択肢ブロック
    if (trimmed === "選択肢" || trimmed.toLowerCase() === "@choice") {
      const options = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1].trim();
        if (!next || next.startsWith("@") || next === "選択肢") break;
        i++;
        if (isComment(next)) continue;
        options.push(parseChoiceLine(next));
      }
      if (options.length > 0) nodes.push({ type: "choice", options });
      continue;
    }

    // @コマンド
    if (trimmed.startsWith("@")) {
      const sp = trimmed.search(/\s/);
      const cmd = (sp === -1 ? trimmed.slice(1) : trimmed.slice(1, sp)).toLowerCase();
      const arg = sp === -1 ? "" : trimmed.slice(sp + 1).trim();

      if (cmd === "scene") {
        scenes.push({ title: arg || `シーン${scenes.length + 1}`, index: nodes.length });
      }
      if (cmd === "label") {
        if (arg) labels[arg] = nodes.length; // ラベルは「次のノード」を指す
        continue; // ラベル自体はノードにしない
      }
      if (cmd === "cg" && arg && arg.toLowerCase() !== "off") {
        const f = arg.split(/\s+/)[0];
        if (!cgList.includes(f)) cgList.push(f);
      }
      if (!KNOWN_CMDS.has(cmd)) {
        warnings.push(`${lineNo[i]}行目: 未知のコマンド @${cmd}`);
      }
      nodes.push({ type: "cmd", cmd, arg, line: lineNo[i] });
      continue;
    }

    // 「名前:セリフ」
    const m = trimmed.match(/^([^:：\s]{1,12})[:：](.*)$/);
    if (m) {
      nodes.push({ type: "say", name: m[1], text: m[2].trim() });
    } else {
      nodes.push({ type: "text", text: trimmed });
    }
  }

  // ラベル参照の検証(同一ファイル内で解決できるか)
  for (const n of nodes) {
    if (n.type !== "cmd") continue;
    let target = null;
    if (n.cmd === "goto") target = n.arg;
    else if (n.cmd === "if") { const mm = n.arg.match(/^(.*\S)\s+(\S+)$/); if (mm) target = mm[2]; }
    if (!target) continue;
    target = target.replace(/^>/, "");
    if (!/\.txt$/i.test(target) && !(target in labels)) {
      warnings.push(`${n.line}行目: ラベル「${target}」が見つかりません`);
    }
  }

  return { nodes, scenes, cgList, labels, warnings };
}

function isComment(line) {
  return line.startsWith("#") || line.startsWith("//") ||
         line.startsWith(";") || line.startsWith("；");
}

/* 選択肢行「テキスト -> 効果, 効果 [表示条件]」 */
function parseChoiceLine(line) {
  let cond = null;
  const cm = line.match(/\[([^\]]+)\]\s*$/); // 末尾の [条件]
  if (cm) { cond = cm[1].trim(); line = line.slice(0, cm.index).trim(); }

  const parts = line.split(/->|→/);
  const text = parts[0].trim();
  const effects = [];
  if (parts.length > 1) {
    for (const part of parts.slice(1).join("->").split(/[,、]/)) {
      const eff = parseEffect(part);
      if (eff) effects.push(eff);
    }
  }
  return { text, effects, cond };
}

/* 効果: "file.txt"(ジャンプ) / ">ラベル"or"ラベル"(goto) / "flag=値" / "flag+1" */
function parseEffect(s) {
  s = s.trim();
  if (!s) return null;
  if (/\.txt$/i.test(s)) return { type: "jump", file: s };
  if (s.startsWith(">")) return { type: "goto", label: s.slice(1).trim() };

  let m = s.match(/^(.+?)\s*=\s*(.+)$/);
  if (m) return { type: "set", name: m[1].trim(), value: parseValue(m[2].trim()) };

  m = s.match(/^(.+?)\s*([+-])\s*(\d+)$/);
  if (m) return { type: "add", name: m[1].trim(), delta: (m[2] === "-" ? -1 : 1) * parseInt(m[3], 10) };

  // それ以外の1語はラベル goto とみなす
  if (/^\S+$/.test(s)) return { type: "goto", label: s };
  return null;
}

function parseValue(s) {
  const low = s.toLowerCase();
  if (low === "true") return true;
  if (low === "false") return false;
  const n = Number(s);
  return Number.isNaN(n) ? s : n;
}

function applyEffect(eff) {
  if (!eff) return;
  if (eff.type === "set") G.flags[eff.name] = eff.value;
  else if (eff.type === "add") G.flags[eff.name] = (Number(G.flags[eff.name]) || 0) + eff.delta;
}

/* 条件式: "flag>=2" "flag==true" など */
function evalCond(expr) {
  const m = expr.match(/^(.+?)\s*(>=|<=|==|!=|=|>|<)\s*(.+)$/);
  if (!m) { console.warn("解釈できない条件:", expr); return false; }
  const name = m[1].trim();
  const op = m[2];
  const target = parseValue(m[3].trim());
  let cur = G.flags[name];

  if (typeof target === "boolean") cur = !!cur;
  else if (typeof target === "number") cur = Number(cur) || 0;
  else cur = String(cur ?? "");

  switch (op) {
    case ">=": return cur >= target;
    case "<=": return cur <= target;
    case ">":  return cur > target;
    case "<":  return cur < target;
    case "!=": return cur !== target;
    case "==":
    case "=":  return cur === target;
  }
  return false;
}

/* =========================================================
 * テキスト整形(ルビ・色・太字)
 *   |漢字《かんじ》   ルビ
 *   **強調**          太字
 *   [color:#f55]赤[/color]  色
 * 戻り値: [{ html, steps }] のユニット列(steps=文字送りの歩数)
 * ========================================================= */
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatUnits(raw) {
  const units = [];
  let i = 0;
  let color = null;
  let bold = false;

  const wrap = (inner) => {
    let h = inner;
    if (bold) h = "<b>" + h + "</b>";
    if (color) h = `<span style="color:${color}">` + h + "</span>";
    return h;
  };

  while (i < raw.length) {
    // タグ: **  [color:...]  [/color]
    if (raw.startsWith("**", i)) { bold = !bold; i += 2; continue; }
    const cm = raw.slice(i).match(/^\[color:([^\]]+)\]/);
    if (cm) { color = cm[1].trim(); i += cm[0].length; continue; }
    if (raw.startsWith("[/color]", i)) { color = null; i += 8; continue; }

    // ルビ: |base《yomi》 (| は半角/全角)
    const rm = raw.slice(i).match(/^[|｜]([^《]+)《([^》]+)》/);
    if (rm) {
      const base = esc(rm[1]);
      const yomi = esc(rm[2]);
      units.push({ html: wrap(`<ruby>${base}<rt>${yomi}</rt></ruby>`), steps: rm[1].length });
      i += rm[0].length;
      continue;
    }

    // 改行
    if (raw[i] === "\n") { units.push({ html: "<br>", steps: 1 }); i++; continue; }

    // 通常の1文字
    units.push({ html: wrap(esc(raw[i])), steps: 1 });
    i++;
  }
  return units;
}

function renderUnits(container, units, revealSteps) {
  let html = "";
  let acc = 0;
  for (const u of units) {
    if (acc >= revealSteps) break;
    html += u.html;
    acc += u.steps;
  }
  container.innerHTML = html;
}

/* =========================================================
 * ファイル読み込み(複数ファイル対応)
 * ========================================================= */
async function loadFile(name) {
  if (G.parsedFiles[name]) return G.parsedFiles[name];

  let text = G.rawFiles[name];
  if (text == null) {
    try {
      const res = await fetch(name, { cache: "no-store" });
      if (!res.ok) throw new Error("not found");
      text = await res.text();
    } catch (e) {
      return null;
    }
  }

  const parsed = parseScenario(text);
  G.parsedFiles[name] = parsed;
  registerContent(name, parsed);
  if (parsed.warnings.length && G.debugOn) {
    console.warn(`[${name}] シナリオ警告:\n` + parsed.warnings.join("\n"));
  }
  return parsed;
}

function registerContent(file, parsed) {
  let changed = false;
  for (const cg of parsed.cgList) {
    if (!G.cgRegistry.includes(cg)) { G.cgRegistry.push(cg); changed = true; }
  }
  for (const s of parsed.scenes) {
    if (!G.sceneRegistry.some((r) => r.file === file && r.title === s.title)) {
      G.sceneRegistry.push({ file, title: s.title });
      changed = true;
    }
  }
  // エンディング登録(@ending 名前)
  for (const n of parsed.nodes) {
    if (n.type === "cmd" && n.cmd === "ending") {
      const name = n.arg || "エンディング";
      if (!G.endingRegistry.some((e) => e.file === file && e.name === name)) {
        G.endingRegistry.push({ file, name });
        changed = true;
      }
    }
  }
  if (changed) savePersistent();

  if (file === ENTRY_FILE) {
    const titleNode = parsed.nodes.find((n) => n.type === "cmd" && n.cmd === "title");
    if (titleNode && titleNode.arg) {
      $("game-title").textContent = titleNode.arg;
      document.title = titleNode.arg;
    }
    const tbg = parsed.nodes.find((n) => n.type === "cmd" && n.cmd === "titlebg");
    if (tbg && tbg.arg) applyTitleBg(tbg.arg);
  }
}

function applyTitleBg(file) {
  G.titleBg = file;
  const apply = (url) => {
    $("screen-title").style.backgroundImage =
      `linear-gradient(rgba(8,10,16,.55), rgba(8,10,16,.75)), url("${url}")`;
    $("screen-title").style.backgroundSize = "cover";
    $("screen-title").style.backgroundPosition = "center";
  };
  const img = new Image();
  img.onload = () => apply(ASSET_DIR.bg + file);
  img.onerror = () => apply(placeholderImage(file)); // 無ければプレースホルダ
  img.src = ASSET_DIR.bg + file;
}

/* 到達可能な .txt を先読みして、CG/シーン/エンディング一覧を完成させる */
function collectTargets(parsed) {
  const out = [];
  for (const n of parsed.nodes) {
    if (n.type === "cmd") {
      if (n.cmd === "jump" && /\.txt$/i.test(n.arg)) out.push(n.arg.split(/\s+/)[0]);
      if (n.cmd === "if") { const m = n.arg.match(/(\S+\.txt)\s*$/i); if (m) out.push(m[1]); }
    } else if (n.type === "choice") {
      for (const o of n.options) for (const e of o.effects) if (e.type === "jump") out.push(e.file);
    }
  }
  return out;
}

async function crawlFiles() {
  const seen = new Set();
  const queue = [ENTRY_FILE];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    const parsed = await loadFile(f);
    if (!parsed) continue;
    for (const t of collectTargets(parsed)) if (!seen.has(t)) queue.push(t);
  }
}

async function boot() {
  await initStorage();
  loadPersistent();
  syncSettingsUI();
  updateContinueButton();
  const parsed = await loadFile(ENTRY_FILE);
  if (!parsed) {
    $("overlay-file").classList.remove("hidden");
    return;
  }
  await crawlFiles();        // CG/シーン/エンディング一覧を先に揃える
  updateContinueButton();
  if (parsed.warnings.length) {
    showToast(`⚠ シナリオ警告 ${parsed.warnings.length}件(F9で確認)`);
  }
}

/* =========================================================
 * アセット(存在しない場合はプレースホルダを自動生成)
 * ========================================================= */
const PH_CACHE = {};

function hueOf(str) {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

function placeholderImage(label) {
  const key = "bg:" + label;
  if (PH_CACHE[key]) return PH_CACHE[key];
  const hue = hueOf(label);
  const cv = document.createElement("canvas");
  cv.width = 1280; cv.height = 720;
  const ctx = cv.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, 1280, 720);
  grad.addColorStop(0, `hsl(${hue}, 40%, 22%)`);
  grad.addColorStop(1, `hsl(${(hue + 60) % 360}, 45%, 12%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1280, 720);
  ctx.fillStyle = "rgba(255,255,255,.55)";
  ctx.font = "40px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(label, 640, 372);
  return (PH_CACHE[key] = cv.toDataURL());
}

function placeholderSprite(name, expr) {
  const key = "chara:" + name + "|" + expr;
  if (PH_CACHE[key]) return PH_CACHE[key];
  const cv = document.createElement("canvas");
  cv.width = 600; cv.height = 1000;
  const ctx = cv.getContext("2d");
  const hue = hueOf(name);
  const rr = (x, y, w, h, r) => {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else { ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
           ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
           ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  };
  if (!expr) {
    ctx.fillStyle = `hsl(${hue}, 45%, 45%)`;
    rr(150, 300, 300, 700, 70); ctx.fill();
    ctx.beginPath(); ctx.arc(300, 230, 140, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${hue}, 40%, 62%)`; ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.92)";
    ctx.font = "bold 56px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(name, 300, 640);
  } else {
    ctx.fillStyle = `hsl(${hue}, 70%, 32%)`;
    rr(170, 300, 260, 90, 18); ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 46px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(expr, 300, 362);
  }
  return (PH_CACHE[key] = cv.toDataURL());
}

function setImage(imgEl, dir, file) {
  imgEl.onerror = () => { imgEl.onerror = null; imgEl.src = placeholderImage(file); };
  imgEl.src = ASSET_DIR[dir] + file;
}

/* 背景変更(オプションでクロスフェード) */
function changeBg(file, fadeMs) {
  G.curBg = file;
  const cur = $("bg-img");
  if (!fadeMs || G.skipHeld) { setImage(cur, "bg", file); return; }

  const next = $("bg-next");
  next.onerror = () => { next.onerror = null; next.src = placeholderImage(file); };
  next.style.transition = "none";
  next.style.opacity = "0";
  next.classList.remove("hidden");
  next.src = ASSET_DIR.bg + file;

  requestAnimationFrame(() => {
    next.style.transition = `opacity ${fadeMs}ms ease`;
    next.style.opacity = "1";
  });
  const done = () => {
    cur.src = next.src;
    next.classList.add("hidden");
    next.removeEventListener("transitionend", done);
  };
  next.addEventListener("transitionend", done);
  setTimeout(done, fadeMs + 120); // フォールバック
}

/* ---------- 音声 ---------- */
function playBGM(file, fade) {
  if (file === G.bgmName) return;
  clearInterval(G.bgmFadeTimer);
  const target = (!file || file.toLowerCase() === "stop") ? null : file;

  if (!target) { stopBGM(fade); return; }

  const startNew = () => {
    const a = new Audio(ASSET_DIR.bgm + target);
    a.loop = true;
    const maxVol = G.settings.bgmVol / 100;
    a.volume = fade && !G.skipHeld ? 0 : maxVol;
    a.play().catch(() => {});
    G.bgm = a;
    G.bgmName = target;
    if (fade && !G.skipHeld) rampVolume(a, maxVol, FADE_MS);
  };

  if (G.bgm && fade && !G.skipHeld) {
    const old = G.bgm;
    rampVolume(old, 0, FADE_MS, () => old.pause());
    G.bgm = null;
    startNew();
  } else {
    stopBGM(false);
    startNew();
  }
}

function rampVolume(audio, to, ms, done) {
  const from = audio.volume;
  const steps = Math.max(1, Math.round(ms / 40));
  let n = 0;
  const t = setInterval(() => {
    n++;
    audio.volume = Math.max(0, Math.min(1, from + (to - from) * (n / steps)));
    if (n >= steps) { clearInterval(t); if (done) done(); }
  }, 40);
  if (audio === G.bgm) G.bgmFadeTimer = t;
}

function stopBGM(fade) {
  clearInterval(G.bgmFadeTimer);
  if (G.bgm) {
    if (fade && !G.skipHeld) { const a = G.bgm; rampVolume(a, 0, FADE_MS, () => a.pause()); }
    else G.bgm.pause();
    G.bgm = null;
  }
  G.bgmName = "";
}

function playSE(file) {
  if (!file) return;
  const a = new Audio(ASSET_DIR.se + file);
  a.volume = G.settings.seVol / 100;
  a.play().catch(() => {});
}

function playVoice(file) {
  stopVoice();
  if (!file) return;
  const a = new Audio(ASSET_DIR.voice + file);
  a.volume = G.settings.voiceVol / 100;
  a.play().catch(() => {});
  G.voice = a;
}
function stopVoice() { if (G.voice) { G.voice.pause(); G.voice = null; } }

/* 環境音(BGMと別レイヤーでループ) */
function playAmb(file) {
  if (file === G.ambName) return;
  stopAmb();
  if (!file || file.toLowerCase() === "stop") return;
  const a = new Audio(ASSET_DIR.bgm + file);
  a.loop = true;
  a.volume = (G.settings.bgmVol / 100) * 0.85;
  a.play().catch(() => {});
  G.amb = a; G.ambName = file;
}
function stopAmb() { if (G.amb) { G.amb.pause(); G.amb = null; } G.ambName = ""; }

/* =========================================================
 * 画面演出(揺れ・フラッシュ・暗転/明転)
 * ========================================================= */
function screenShake(ms) {
  const g = $("screen-game");
  g.classList.remove("fx-shake");
  void g.offsetWidth; // リフロー
  g.classList.add("fx-shake");
  setTimeout(() => g.classList.remove("fx-shake"), ms);
}

function screenFlash(arg) {
  const parts = arg.split(/\s+/);
  let color = "#ffffff", ms = 300;
  for (const p of parts) { if (/^#|^rgb/.test(p)) color = p; else if (/^\d+$/.test(p)) ms = parseInt(p, 10); }
  const el = $("fx-flash");
  el.style.transition = "none";
  el.style.background = color;
  el.style.opacity = "1";
  void el.offsetWidth;
  el.style.transition = `opacity ${ms}ms ease`;
  el.style.opacity = "0";
}

/* 暗転(to=1)/明転(to=0)。完了までゲーム進行を止める */
function screenFade(to, arg) {
  const ms = parseInt(arg, 10) || FADE_MS;
  const el = $("fx-fade");
  if (G.skipHeld) { el.style.transition = "none"; el.style.opacity = String(to); return false; }
  el.style.transition = `opacity ${ms}ms ease`;
  el.style.opacity = String(to);
  G.waiting = true;
  clearTimeout(G.waitTimer);
  G.waitTimer = setTimeout(() => { G.waiting = false; advance(); }, ms);
  return true;
}

/* =========================================================
 * 名前入力(@input フラグ [プロンプト])
 * ========================================================= */
function askInput(arg) {
  const sp = arg.search(/\s/);
  const name = (sp === -1 ? arg : arg.slice(0, sp)).trim();
  const prompt = sp === -1 ? "名前を入力してください" : expandVars(arg.slice(sp + 1).trim());
  if (!name) return false;

  $("input-prompt").textContent = prompt;
  const field = $("input-field");
  field.value = typeof G.flags[name] === "string" ? G.flags[name] : "";
  $("overlay-input").classList.remove("hidden");
  G.waiting = true;
  setTimeout(() => field.focus(), 30);

  const submit = () => {
    const v = field.value.trim();
    G.flags[name] = v || name; // 空なら変数名を仮の名前にする
    $("overlay-input").classList.add("hidden");
    field.onkeydown = null;
    $("input-ok").onclick = null;
    G.waiting = false;
    advance();
  };
  $("input-ok").onclick = submit;
  field.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } };
  return true;
}

/* 本文中の {フラグ名} を値に展開する */
function expandVars(text) {
  if (text.indexOf("{") === -1) return text;
  return text.replace(/\{([^}]+)\}/g, (m, key) => {
    const v = G.flags[key.trim()];
    return v === undefined || v === null ? m : String(v);
  });
}

/* =========================================================
 * 立ち絵(背景と別レイヤー・差分・フェード/スライド)
 * ========================================================= */
function showChara(arg) {
  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  const name = tokens[0];
  if (!name) return;
  let pos = null, expr = null;
  for (const tok of tokens.slice(1)) {
    if (tok.toLowerCase() === "fade") continue; // 明示 fade は既定で有効なので無視
    const p = CHARA_POS[tok.toLowerCase()] || CHARA_POS[tok];
    if (p) pos = p;
    else expr = tok;
  }
  const cur = G.chara[name] || {};
  G.chara[name] = {
    pos: pos || cur.pos || "center",
    expr: expr !== null ? expr : (cur.expr || ""),
  };
  renderChara();
}

function faceChara(arg) {
  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  const name = tokens[0];
  if (!name) return;
  const cur = G.chara[name] || { pos: "center" };
  G.chara[name] = { pos: cur.pos, expr: tokens[1] || "" };
  renderChara();
}

function hideChara(arg) {
  const name = arg.trim().replace(/\s+fade$/i, "");
  if (!name || name.toLowerCase() === "all" || name === "全員") G.chara = {};
  else delete G.chara[name];
  renderChara();
}

/* G.chara の状態に合わせてレイヤーを差分更新(追加=フェードイン、削除=フェードアウト) */
function renderChara() {
  const layer = $("chara-layer");
  const existing = {};
  for (const el of [...layer.children]) existing[el.dataset.name] = el;

  // 追加・更新
  for (const [name, st] of Object.entries(G.chara)) {
    let slot = existing[name];
    if (!slot) {
      slot = document.createElement("div");
      slot.className = "chara-slot pos-" + st.pos;
      slot.dataset.name = name;

      const base = document.createElement("img");
      base.className = "chara-base";
      base.onerror = () => { base.onerror = null; base.src = placeholderSprite(name, ""); };
      base.src = ASSET_DIR.chara + name + ".png";
      slot.appendChild(base);

      const face = document.createElement("img");
      face.className = "chara-face";
      slot.appendChild(face);

      layer.appendChild(slot);
      // フェードイン + スライドイン
      slot.classList.add("enter");
      if (!G.skipHeld) requestAnimationFrame(() => slot.classList.remove("enter"));
      else slot.classList.remove("enter");
    } else {
      slot.className = "chara-slot pos-" + st.pos;
      slot.dataset.name = name;
    }
    // 表情差分
    const face = slot.querySelector(".chara-face");
    if (st.expr) {
      const src = ASSET_DIR.chara + name + "_" + st.expr + ".png";
      if (face.dataset.expr !== st.expr) {
        face.dataset.expr = st.expr;
        face.onerror = () => { face.onerror = null; face.src = placeholderSprite(name, st.expr); };
        face.src = src;
        face.classList.remove("hidden");
      }
    } else {
      face.classList.add("hidden");
      face.removeAttribute("data-expr");
      face.removeAttribute("src");
    }
    delete existing[name];
  }

  // 退場(フェードアウト後に削除)
  for (const name in existing) {
    const slot = existing[name];
    if (G.skipHeld) { slot.remove(); continue; }
    slot.classList.add("leave");
    slot.addEventListener("transitionend", () => slot.remove(), { once: true });
    setTimeout(() => slot.remove(), FADE_MS + 120);
  }

  applyCharaHighlight();
}

function applyCharaHighlight() {
  const speaker = G.lastSpeaker;
  const active = speaker && G.chara[speaker];
  for (const slot of $("chara-layer").children) {
    if (slot.classList.contains("leave")) continue;
    slot.classList.toggle("dim", !!active && slot.dataset.name !== speaker);
  }
}

/* =========================================================
 * 画面遷移
 * ========================================================= */
function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle("hidden", key !== name);
  }
}

function resetFx() {
  const f = $("fx-fade"), fl = $("fx-flash");
  f.style.transition = "none"; f.style.opacity = "0";
  fl.style.transition = "none"; fl.style.opacity = "0";
  $("screen-game").classList.remove("fx-shake");
}

function toTitle() {
  stopAuto();
  endSkip();
  stopBGM(false);
  stopAmb();
  stopVoice();
  resetFx();
  clearTimeout(G.waitTimer);
  G.waiting = false;
  G.inGame = false;
  G.choosing = false;
  G.chara = {};
  G.lastSpeaker = null;
  renderChara();
  $("cg-img").classList.add("hidden");
  $("choice-box").classList.add("hidden");
  $("debug-overlay").classList.add("hidden");
  updateContinueButton();
  showScreen("title");
}

function updateContinueButton() {
  $("btn-continue").disabled = latestSlot() === null;
}

/* =========================================================
 * スナップショット
 * ========================================================= */
function makeSnapshot(index) {
  return {
    file: G.file,
    index,
    bg: G.curBg,
    cg: G.curCg,
    bgm: G.bgmName,
    amb: G.ambName,
    flags: { ...G.flags },
    chara: JSON.parse(JSON.stringify(G.chara)),
    speaker: G.lastSpeaker,
    scene: G.currentScene,
    savedAt: new Date().toISOString(),
  };
}

async function restoreSnapshot(snap) {
  const parsed = await loadFile(snap.file);
  if (!parsed) { showToast("ファイルが見つかりません: " + snap.file); return false; }

  stopAuto();
  endSkip();
  stopVoice();
  clearTimeout(G.waitTimer);
  clearInterval(G.typeTimer);
  G.typing = false;
  G.waiting = false;
  G.choosing = false;
  $("choice-box").classList.add("hidden");

  G.file = snap.file;
  G.nodes = parsed.nodes;
  G.flags = { ...snap.flags };
  G.pos = snap.index;
  G.shownIndex = -1;
  G.backlog = [];
  G.uiHidden = false;
  G.autoMode = false;
  G.currentScene = snap.scene || "";
  updateModeIndicator();

  G.curBg = snap.bg;
  G.curCg = snap.cg;
  if (snap.bg) setImage($("bg-img"), "bg", snap.bg);
  else $("bg-img").src = placeholderImage("背景未設定");
  $("bg-next").classList.add("hidden");
  if (snap.cg) { setImage($("cg-img"), "cg", snap.cg); $("cg-img").classList.remove("hidden"); }
  else $("cg-img").classList.add("hidden");
  stopBGM(false);
  if (snap.bgm) playBGM(snap.bgm, false);
  stopAmb();
  if (snap.amb) playAmb(snap.amb);
  resetFx();
  G.chara = snap.chara ? JSON.parse(JSON.stringify(snap.chara)) : {};
  G.lastSpeaker = snap.speaker || null;
  $("chara-layer").innerHTML = "";
  renderChara();

  $("message-window").classList.remove("hidden");
  $("text-area").textContent = "";
  $("name-plate").classList.add("hidden");
  $("next-indicator").classList.add("hidden");

  G.inGame = true;
  showScreen("game");
  advance();
  return true;
}

function startGame() {
  restoreSnapshot({ file: ENTRY_FILE, index: 0, bg: "", cg: "", bgm: "", flags: {}, chara: {}, scene: "" });
}

/* =========================================================
 * ゲーム進行
 * ========================================================= */
function advance() {
  if (!G.inGame || G.waiting || G.choosing) return;
  if (G.typing) { finishTyping(); return; }

  while (G.pos < G.nodes.length) {
    const idx = G.pos;
    const node = G.nodes[idx];
    G.pos = idx + 1;

    if (node.type === "cmd") {
      if (execCommand(node, idx)) return;
      continue;
    }
    if (node.type === "choice") {
      showChoices(node);
      return;
    }
    G.shownIndex = idx;
    showText(node, idx);
    return;
  }
  endStory();
}

function execCommand(node, idx) {
  const { cmd, arg } = node;
  switch (cmd) {
    case "bg": {
      const parts = arg.split(/\s+/);
      const file = parts[0];
      const fade = /fade/i.test(arg);
      const ms = (arg.match(/(\d+)/) || [])[1];
      if (file) changeBg(file, fade ? (ms ? parseInt(ms, 10) : FADE_MS) : 0);
      break;
    }
    case "cg":
      if (arg.toLowerCase() === "off") {
        G.curCg = "";
        $("cg-img").classList.add("hidden");
      } else if (arg) {
        const file = arg.split(/\s+/)[0];
        G.curCg = file;
        setImage($("cg-img"), "cg", file);
        $("cg-img").classList.remove("hidden");
        if (!G.unlockedCG.has(file)) { G.unlockedCG.add(file); savePersistent(); }
      }
      break;
    case "chara": case "show": case "sprite": showChara(arg); break;
    case "face": case "expr": faceChara(arg); break;
    case "hide": hideChara(arg); break;
    case "bgm": {
      const file = arg.split(/\s+/)[0];
      playBGM(file, /fade/i.test(arg));
      break;
    }
    case "se": playSE(arg.split(/\s+/)[0]); break;
    case "voice": G.pendingVoice = arg.split(/\s+/)[0]; playVoice(G.pendingVoice); break;
    case "amb": playAmb(arg.split(/\s+/)[0]); break;
    case "shake": screenShake(parseInt(arg, 10) || 500); break;
    case "flash": screenFlash(arg); break;
    case "fadeout": return screenFade(1, arg);
    case "fadein": return screenFade(0, arg);
    case "input": return askInput(arg);
    case "scene": {
      G.currentScene = arg || G.currentScene;
      const scene = G.parsedFiles[G.file].scenes.find((s) => s.index === idx);
      if (scene) {
        G.sceneSnaps[G.file + "|" + scene.title] = makeSnapshot(idx + 1);
        savePersistent();
      }
      break;
    }
    case "set": applyEffect(parseEffect(arg)); break;
    case "goto": doGoto(arg); return true;
    case "jump": doJump(arg); return true;
    case "if": {
      const m = arg.match(/^(.*\S)\s+(\S+)$/);
      if (!m) { console.warn("@if の書式が不正:", arg); break; }
      if (evalCond(m[1])) { doGoto(m[2]); return true; }
      break;
    }
    case "ending":
      markEnding(arg || "エンディング");
      endStory();
      return true;
    case "end": endStory(); return true;
    case "wait": {
      if (G.skipHeld) break;
      const ms = parseInt(arg, 10) || 0;
      if (ms > 0) {
        G.waiting = true;
        G.waitTimer = setTimeout(() => { G.waiting = false; advance(); }, ms);
        return true;
      }
      break;
    }
    case "title": case "titlebg": break; // 起動時に処理済み
    default: console.warn("未知のコマンド: @" + cmd);
  }
  return false;
}

/* ラベル goto / ファイル jump 共通の遷移解決 */
function doGoto(target) {
  target = target.replace(/^>/, "");
  if (/\.txt$/i.test(target)) { doJump(target); return; }
  const labels = G.parsedFiles[G.file].labels || {};
  if (target in labels) { G.pos = labels[target]; advance(); }
  else { showToast("ラベルが見つかりません: " + target); advance(); }
}

async function doJump(file) {
  G.waiting = true;
  const parsed = await loadFile(file);
  G.waiting = false;
  if (!parsed) { showToast("シナリオファイルが見つかりません: " + file); return; }
  G.file = file;
  G.nodes = parsed.nodes;
  G.pos = 0;
  advance();
}

function markEnding(name) {
  const key = G.file + "|" + name;
  if (!G.endingRegistry.some((e) => e.file === G.file && e.name === name)) {
    G.endingRegistry.push({ file: G.file, name });
  }
  if (!G.unlockedEndings.has(key)) { G.unlockedEndings.add(key); savePersistent(); }
}

function endStory() {
  if (!G.inGame) return;
  G.inGame = false;
  clearInterval(G.typeTimer);
  G.typing = false;
  stopVoice();
  showToast("― おしまい ―");
  setTimeout(toTitle, 1600);
}

/* ---------- 選択肢 ---------- */
function showChoices(node) {
  endSkip();
  clearTimeout(G.autoTimer);

  // 表示条件でフィルタ
  const visible = node.options.filter((o) => !o.cond || evalCond(o.cond));
  if (visible.length === 0) { advance(); return; } // 出せる選択肢が無ければスルー

  G.choosing = true;
  G.choiceOptions = visible;
  $("next-indicator").classList.add("hidden");

  const box = $("choice-box");
  box.innerHTML = "";
  visible.forEach((opt, i) => {
    const btn = document.createElement("button");
    btn.textContent = expandVars(opt.text);
    if (G.chosenSet.has(G.file + "|" + opt.text)) btn.classList.add("chosen"); // 選択済みの印
    btn.addEventListener("click", (e) => { e.stopPropagation(); selectChoice(i); });
    box.appendChild(btn);
  });
  box.classList.remove("hidden");
}

function selectChoice(i) {
  const opt = G.choiceOptions[i];
  if (!opt || !G.choosing) return;
  G.choosing = false;
  $("choice-box").classList.add("hidden");
  G.chosenSet.add(G.file + "|" + opt.text);
  store("chosenSet", [...G.chosenSet]);
  G.backlog.push({ name: "", text: "▶ " + expandVars(opt.text), choice: true });

  let goto = null;
  for (const eff of opt.effects) {
    if (eff.type === "jump") goto = eff.file;
    else if (eff.type === "goto") goto = eff.label;
    else applyEffect(eff);
  }
  if (goto) doGoto(goto);
  else advance();
}

/* ---------- テキスト表示 ---------- */
function nameColor(name) {
  if (!G.nameColors[name]) {
    const used = Object.keys(G.nameColors).length;
    G.nameColors[name] = NAME_COLORS[used % NAME_COLORS.length];
  }
  return G.nameColors[name];
}

function showText(node, idx) {
  const namePlate = $("name-plate");
  const textArea = $("text-area");
  $("next-indicator").classList.add("hidden");

  const dispName = node.type === "say" ? expandVars(node.name) : "";
  const dispText = expandVars(node.text);

  if (node.type === "say") {
    namePlate.textContent = dispName;
    namePlate.style.color = nameColor(node.name);
    namePlate.classList.remove("hidden");
    textArea.classList.remove("narration");
    G.lastSpeaker = node.name;
    applyCharaHighlight();
  } else {
    namePlate.classList.add("hidden");
    textArea.classList.add("narration");
  }

  // 既読管理 + 既読テキストの色変え
  const readKey = G.file + "#" + idx;
  G.lastLineRead = G.readSet.has(readKey);
  if (!G.lastLineRead) { G.readSet.add(readKey); saveRead(); }
  textArea.classList.toggle("read", G.lastLineRead);

  // このセリフに紐づくボイス(直前の @voice)をバックログにも残す
  G.lastLineVoice = G.pendingVoice;
  G.pendingVoice = null;

  G.backlog.push({ name: dispName, text: dispText, voice: G.lastLineVoice });
  if (G.backlog.length > 400) G.backlog.shift();

  // 整形 + 文字送り
  G.units = formatUnits(dispText);
  G.totalSteps = G.units.reduce((a, u) => a + u.steps, 0);
  clearInterval(G.typeTimer);
  const speed = G.skipHeld ? 0 : G.settings.textSpeed;

  if (speed <= 0) {
    renderUnits(textArea, G.units, G.totalSteps);
    G.typing = false;
    onTextComplete();
  } else {
    G.typing = true;
    let i = 0;
    textArea.textContent = "";
    G.typeTimer = setInterval(() => {
      i++;
      renderUnits(textArea, G.units, i);
      if (i >= G.totalSteps) { clearInterval(G.typeTimer); G.typing = false; onTextComplete(); }
    }, speed);
  }
  updateDebug();
}

function finishTyping() {
  clearInterval(G.typeTimer);
  G.typing = false;
  renderUnits($("text-area"), G.units, G.totalSteps);
  onTextComplete();
}

function onTextComplete() {
  $("next-indicator").classList.remove("hidden");
  if (G.autoMode && !G.skipHeld) {
    clearTimeout(G.autoTimer);
    const go = () => {
      clearTimeout(G.autoTimer);
      G.autoTimer = setTimeout(() => {
        if (G.autoMode && G.inGame && !isOverlayOpen()) advance();
      }, G.settings.autoWait);
    };
    // ボイス再生中はその終了を待ってからオート送り
    if (G.voice && !G.voice.ended && !G.voice.paused) {
      G.voice.onended = () => { G.voice.onended = null; if (G.autoMode) go(); };
    } else {
      go();
    }
  }
}

/* ---------- オート / スキップ ---------- */
function toggleAuto() {
  G.autoMode = !G.autoMode;
  updateModeIndicator();
  if (G.autoMode && !G.typing && !G.choosing) onTextComplete();
  else clearTimeout(G.autoTimer);
}

function stopAuto() {
  G.autoMode = false;
  clearTimeout(G.autoTimer);
  updateModeIndicator();
}

function startSkip() {
  if (G.skipHeld || !G.inGame || G.choosing || isOverlayOpen()) return;
  G.skipHeld = true;
  updateModeIndicator();
  G.skipTimer = setInterval(() => {
    if (!G.inGame || G.choosing || isOverlayOpen()) return;
    // 既読のみスキップ: 直近に出した行が未読なら止める
    if (!G.settings.skipUnread && !G.lastLineRead) { endSkip(); return; }
    if (G.typing) finishTyping();
    else advance();
  }, 55);
}

function endSkip() {
  if (!G.skipHeld) return;
  G.skipHeld = false;
  clearInterval(G.skipTimer);
  updateModeIndicator();
}

function updateModeIndicator() {
  const el = $("mode-indicator");
  if (G.skipHeld) { el.textContent = "▶▶ SKIP"; el.classList.remove("hidden"); }
  else if (G.autoMode) { el.textContent = "▶ AUTO"; el.classList.remove("hidden"); }
  else el.classList.add("hidden");
}

/* ---------- ウィンドウ非表示 ---------- */
function toggleUI(forceShow) {
  G.uiHidden = forceShow === true ? false : !G.uiHidden;
  $("message-window").classList.toggle("hidden", G.uiHidden);
  $("mode-indicator").classList.toggle("hidden", G.uiHidden || (!G.autoMode && !G.skipHeld));
  $("btn-game-menu").classList.toggle("hidden", G.uiHidden);
  if (G.choosing) $("choice-box").classList.toggle("hidden", G.uiHidden);
}

/* ---------- デバッグ表示 ---------- */
function toggleDebug() {
  G.debugOn = !G.debugOn;
  $("debug-overlay").classList.toggle("hidden", !G.debugOn || !G.inGame);
  updateDebug();
  if (G.debugOn) startDevReload(); else stopDevReload();
  showToast(G.debugOn ? "デバッグ表示 ON(自動リロード有効)" : "デバッグ表示 OFF");
}

/* 開発モード: scenario の変更を検知して同じ位置のまま再読込(ブラウザのみ) */
function startDevReload() {
  if (FS || G.devTimer) return;
  G.devRaw = {};
  for (const f of Object.keys(G.parsedFiles)) {
    if (f in G.rawFiles) continue;
    fetch(f + "?_=" + Date.now(), { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : null))
      .then((t) => { if (t != null) G.devRaw[f] = t; })
      .catch(() => {});
  }
  G.devTimer = setInterval(devPoll, 1500);
}
function stopDevReload() { clearInterval(G.devTimer); G.devTimer = null; }

async function devPoll() {
  for (const f of Object.keys(G.parsedFiles)) {
    if (f in G.rawFiles) continue;
    let t;
    try { const r = await fetch(f + "?_=" + Date.now(), { cache: "no-store" }); if (!r.ok) continue; t = await r.text(); }
    catch (e) { continue; }
    if (G.devRaw[f] === undefined) { G.devRaw[f] = t; continue; }
    if (t === G.devRaw[f]) continue;
    G.devRaw[f] = t;
    const parsed = parseScenario(t);
    G.parsedFiles[f] = parsed;
    registerContent(f, parsed);
    if (f === G.file) { G.nodes = parsed.nodes; if (G.pos > G.nodes.length) G.pos = G.nodes.length; }
    showToast("⟳ " + f + " を再読込");
    updateDebug();
  }
}

function updateDebug() {
  if (!G.debugOn) return;
  const el = $("debug-overlay");
  el.classList.toggle("hidden", !G.inGame);
  if (!G.inGame) return;
  const parsed = G.parsedFiles[G.file] || {};
  const flags = Object.entries(G.flags).map(([k, v]) => `${k}=${v}`).join(", ") || "(なし)";
  const chara = Object.entries(G.chara).map(([k, v]) => `${k}[${v.pos}/${v.expr || "-"}]`).join(" ") || "(なし)";
  const warn = (parsed.warnings || []).length;
  el.innerHTML =
    `<b>DEBUG</b> (F9)<br>` +
    `file: ${G.file}<br>` +
    `node: ${G.shownIndex} / ${G.nodes.length}<br>` +
    `scene: ${G.currentScene || "-"}<br>` +
    `read: ${G.lastLineRead ? "既読" : "未読"}<br>` +
    `flags: ${flags}<br>` +
    `chara: ${chara}<br>` +
    (warn ? `<span class="dbg-warn">⚠ 警告 ${warn}件</span>` : "");
}

/* ---------- セーブ / ロード(複数スロット) ---------- */
function slotKey(id) { return "slot_" + id; }
function readSlot(id) { return restore(slotKey(id), null); }

function latestSlot() {
  let best = null;
  for (const id of SAVE_SLOTS) {
    const s = readSlot(id);
    if (s && (!best || s.savedAt > best.savedAt)) best = s;
  }
  return best;
}

function quickSave() {
  if (!G.inGame || G.shownIndex < 0) return;
  store(slotKey("q"), makeSnapshot(G.shownIndex));
  updateContinueButton();
  showToast("クイックセーブしました");
}

function quickLoad() {
  const data = readSlot("q") || latestSlot();
  if (data === null) { showToast("セーブデータがありません"); return; }
  closeAllOverlays();
  restoreSnapshot(data).then((ok) => { if (ok) showToast("ロードしました"); });
}

function loadLatest() {
  const data = latestSlot();
  if (data === null) { showToast("セーブデータがありません"); return; }
  closeAllOverlays();
  restoreSnapshot(data);
}

function openSaveLoad(saveMode) {
  if (saveMode && !G.inGame) return;
  G.saveMode = saveMode;
  stopAuto();
  $("overlay-menu").classList.add("hidden");
  $("saveload-title").textContent = saveMode ? "セーブ" : "ロード";
  buildSlotGrid();
  $("overlay-saveload").classList.remove("hidden");
}

function buildSlotGrid() {
  const grid = $("slot-grid");
  grid.innerHTML = "";
  for (const id of SAVE_SLOTS) {
    const s = readSlot(id);
    const cell = document.createElement("div");
    cell.className = "slot" + (s ? "" : " empty");
    const label = id === "q" ? "クイック" : "スロット " + id;

    let inner = `<div class="slot-name">${label}</div>`;
    if (s) {
      const d = new Date(s.savedAt);
      const dstr = isNaN(d) ? "" : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      inner += `<div class="slot-scene">${escapeHtml(s.scene || "(シーン不明)")}</div><div class="slot-date">${dstr}</div>`;
    } else {
      inner += `<div class="slot-scene slot-dim">― 空き ―</div>`;
    }
    cell.innerHTML = inner;

    if (G.saveMode) {
      if (!G.inGame) { cell.classList.add("disabled"); }
      else cell.addEventListener("click", () => {
        store(slotKey(id), makeSnapshot(G.shownIndex));
        updateContinueButton();
        buildSlotGrid();
        showToast(label + " にセーブしました");
      });
    } else {
      if (s) {
        cell.addEventListener("click", () => {
          $("overlay-saveload").classList.add("hidden");
          restoreSnapshot(s);
        });
        const del = document.createElement("button");
        del.className = "slot-del";
        del.textContent = "×";
        del.title = "削除";
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          removeKey(slotKey(id));
          updateContinueButton();
          buildSlotGrid();
        });
        cell.appendChild(del);
      } else {
        cell.classList.add("disabled");
      }
    }
    grid.appendChild(cell);
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* =========================================================
 * ギャラリー / シーン鑑賞 / エンディング
 * ========================================================= */
function openGallery() {
  const grid = $("gallery-grid");
  grid.innerHTML = "";
  if (G.cgRegistry.length === 0) {
    grid.innerHTML = '<div class="empty">このシナリオに CG はありません (@cg で登録されます)</div>';
  }
  for (const file of G.cgRegistry) {
    const div = document.createElement("div");
    div.className = "thumb";
    if (G.unlockedCG.has(file)) {
      const img = document.createElement("img");
      img.onerror = () => { img.onerror = null; img.src = placeholderImage(file); };
      img.src = ASSET_DIR.cg + file;
      div.appendChild(img);
      div.addEventListener("click", () => {
        $("viewer-img").src = img.src;
        $("overlay-viewer").classList.remove("hidden");
      });
    } else {
      div.classList.add("locked");
      div.textContent = "?";
    }
    grid.appendChild(div);
  }
  showScreen("gallery");
}

function openScenes() {
  const list = $("scene-list");
  list.innerHTML = "";
  if (G.sceneRegistry.length === 0) {
    list.innerHTML = '<div class="empty">このシナリオにシーンはありません (@scene で登録されます)</div>';
  }
  G.sceneRegistry.forEach((scene, i) => {
    const btn = document.createElement("button");
    btn.className = "scene-item";
    const snap = G.sceneSnaps[scene.file + "|" + scene.title];
    if (snap) {
      btn.textContent = `${String(i + 1).padStart(2, "0")}. ${scene.title}`;
      btn.addEventListener("click", () => restoreSnapshot(snap));
    } else {
      btn.classList.add("locked");
      btn.textContent = `${String(i + 1).padStart(2, "0")}. ？？？`;
    }
    list.appendChild(btn);
  });
  showScreen("scenes");
}

function openEndings() {
  const list = $("ending-list");
  list.innerHTML = "";
  const total = G.endingRegistry.length;
  const got = G.endingRegistry.filter((e) => G.unlockedEndings.has(e.file + "|" + e.name)).length;
  $("ending-rate").textContent = total ? `(${got}/${total})` : "";
  if (total === 0) {
    list.innerHTML = '<div class="empty">このシナリオにエンディングはありません (@ending 名前 で登録されます)</div>';
  }
  G.endingRegistry.forEach((e, i) => {
    const row = document.createElement("div");
    const unlocked = G.unlockedEndings.has(e.file + "|" + e.name);
    row.className = "scene-item" + (unlocked ? "" : " locked");
    row.textContent = `${String(i + 1).padStart(2, "0")}. ${unlocked ? e.name : "？？？"}`;
    list.appendChild(row);
  });
  showScreen("endings");
}

/* =========================================================
 * 設定画面
 * ========================================================= */
function openSettings(returnTo) {
  G.settingsReturn = returnTo;
  syncSettingsUI();
  buildKeyConfig();
  showScreen("settings");
}

function closeSettings() {
  savePersistent();
  showScreen(G.settingsReturn === "game" ? "game" : "title");
}

function syncSettingsUI() {
  const s = G.settings;
  $("opt-text-speed").value = s.textSpeed;
  $("opt-auto-wait").value = s.autoWait;
  $("opt-bgm-vol").value = s.bgmVol;
  $("opt-se-vol").value = s.seVol;
  $("opt-voice-vol").value = s.voiceVol;
  $("opt-skip-unread").checked = !!s.skipUnread;
  updateSettingLabels();
}

function updateSettingLabels() {
  const s = G.settings;
  $("val-text-speed").textContent = s.textSpeed === 0 ? "瞬間表示" : s.textSpeed + "ms/字";
  $("val-auto-wait").textContent = (s.autoWait / 1000).toFixed(1) + "秒";
  $("val-bgm-vol").textContent = s.bgmVol + "%";
  $("val-se-vol").textContent = s.seVol + "%";
  $("val-voice-vol").textContent = s.voiceVol + "%";
}

function keyDisplayName(code) {
  return code
    .replace(/^Key/, "").replace(/^Digit/, "").replace(/^Arrow/, "→ ")
    .replace("ControlLeft", "左Ctrl").replace("ControlRight", "右Ctrl")
    .replace("ShiftLeft", "左Shift").replace("ShiftRight", "右Shift")
    .replace("Escape", "Esc").replace("Space", "スペース");
}

function buildKeyConfig() {
  const wrap = $("key-config");
  wrap.innerHTML = "";
  for (const action of Object.keys(DEFAULT_KEYS)) {
    const row = document.createElement("div");
    row.className = "key-row";
    const label = document.createElement("span");
    label.className = "key-label";
    label.textContent = KEY_LABELS[action];
    const current = document.createElement("span");
    current.className = "key-current";
    current.id = "keycur-" + action;
    current.textContent = keyDisplayName(G.keys[action]);
    const btn = document.createElement("button");
    btn.textContent = "変更";
    btn.addEventListener("click", () => {
      document.querySelectorAll(".key-current.waiting").forEach((el) => {
        el.classList.remove("waiting");
        el.textContent = keyDisplayName(G.keys[el.id.replace("keycur-", "")]);
      });
      G.keyCapture = action;
      current.classList.add("waiting");
      current.textContent = "キー入力待ち…";
    });
    row.append(label, current, btn);
    wrap.appendChild(row);
  }
}

function captureKey(code) {
  const action = G.keyCapture;
  G.keyCapture = null;
  for (const [a, c] of Object.entries(G.keys)) {
    if (c === code && a !== action) G.keys[a] = G.keys[action];
  }
  G.keys[action] = code;
  savePersistent();
  buildKeyConfig();
}

/* =========================================================
 * オーバーレイ
 * ========================================================= */
function isOverlayOpen() {
  return ["overlay-menu", "overlay-backlog", "overlay-saveload", "overlay-viewer", "overlay-file", "overlay-input"]
    .some((id) => !$(id).classList.contains("hidden"));
}

function closeAllOverlays() {
  ["overlay-menu", "overlay-backlog", "overlay-saveload", "overlay-viewer"].forEach((id) =>
    $(id).classList.add("hidden"));
}

function toggleMenu() {
  if (!G.inGame) return;
  stopAuto();
  $("overlay-menu").classList.toggle("hidden");
}

function openBacklog() {
  if (!G.inGame) return;
  stopAuto();
  const list = $("backlog-list");
  list.innerHTML = "";
  for (const entry of G.backlog) {
    const div = document.createElement("div");
    div.className = "backlog-entry";
    if (entry.name) {
      const n = document.createElement("div");
      n.className = "bl-name";
      n.style.color = nameColor(entry.name);
      n.textContent = entry.name;
      div.appendChild(n);
    }
    const t = document.createElement("div");
    t.className = "bl-text" + (entry.choice ? " bl-choice" : "");
    t.textContent = entry.text;
    div.appendChild(t);
    if (entry.voice) {
      const vb = document.createElement("button");
      vb.className = "bl-voice";
      vb.textContent = "♪";
      vb.title = "ボイス再生";
      vb.addEventListener("click", () => playVoice(entry.voice));
      div.appendChild(vb);
    }
    list.appendChild(div);
  }
  $("overlay-menu").classList.add("hidden");
  $("overlay-backlog").classList.remove("hidden");
  list.scrollTop = list.scrollHeight;
}

let toastTimer = null;
function showToast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 1800);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

/* =========================================================
 * 入力ハンドリング
 * ========================================================= */
document.addEventListener("keydown", (e) => {
  if (G.keyCapture) { e.preventDefault(); captureKey(e.code); return; }
  // 名前入力中はテキスト欄に任せる(Enter は askInput 側で処理)
  if (!$("overlay-input").classList.contains("hidden")) return;

  const k = G.keys;
  const code = e.code;
  if (["Space", "Enter", "ArrowUp", "ArrowDown"].includes(code)) e.preventDefault();

  if (code === k.fullscreen) { toggleFullscreen(); return; }
  if (code === k.debug) { toggleDebug(); return; }

  if (!screens.settings.classList.contains("hidden")) {
    if (code === k.menu) closeSettings();
    return;
  }
  if (!screens.gallery.classList.contains("hidden") ||
      !screens.scenes.classList.contains("hidden") ||
      !screens.endings.classList.contains("hidden")) {
    if (code === k.menu) showScreen("title");
    return;
  }

  if (!$("overlay-viewer").classList.contains("hidden")) {
    if (code === k.menu || code === k.advance) $("overlay-viewer").classList.add("hidden");
    return;
  }
  if (!$("overlay-saveload").classList.contains("hidden")) {
    if (code === k.menu) $("overlay-saveload").classList.add("hidden");
    return;
  }
  if (!$("overlay-backlog").classList.contains("hidden")) {
    if (code === k.menu || code === k.backlog) $("overlay-backlog").classList.add("hidden");
    return;
  }
  if (!$("overlay-menu").classList.contains("hidden")) {
    if (code === k.menu) $("overlay-menu").classList.add("hidden");
    return;
  }

  if (!G.inGame) return;

  if (G.uiHidden && code !== k.hide) { toggleUI(true); return; }

  if (G.choosing) {
    const num = code.match(/^(?:Digit|Numpad)([1-9])$/);
    if (num) { selectChoice(parseInt(num[1], 10) - 1); return; }
    if (code === k.backlog) openBacklog();
    else if (code === k.menu) toggleMenu();
    else if (code === k.save) openSaveLoad(true);
    else if (code === k.load) quickLoad();
    return;
  }

  if (code === k.advance || code === "Space") { stopAuto(); advance(); }
  else if (code === k.skip) startSkip();
  else if (code === k.auto) toggleAuto();
  else if (code === k.hide) toggleUI();
  else if (code === k.backlog) openBacklog();
  else if (code === k.save) quickSave();
  else if (code === k.load) quickLoad();
  else if (code === k.menu) toggleMenu();
});

document.addEventListener("keyup", (e) => {
  if (e.code === G.keys.skip) endSkip();
});

$("screen-game").addEventListener("click", (e) => {
  if (e.target.closest("#btn-game-menu") || e.target.closest("#choice-box")) return;
  if (isOverlayOpen()) return;
  if (G.uiHidden) { toggleUI(true); return; }
  if (G.choosing) return;
  stopAuto();
  advance();
});

$("screen-game").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (!isOverlayOpen()) toggleUI();
});

document.addEventListener("wheel", (e) => {
  if (!G.inGame || isOverlayOpen()) return;
  if (screens.game.classList.contains("hidden")) return;
  if (e.deltaY < 0) openBacklog();
  else if (!G.choosing) { stopAuto(); advance(); }
}, { passive: true });

/* =========================================================
 * ボタン類
 * ========================================================= */
$("screen-title").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  switch (btn.dataset.action) {
    case "start": startGame(); break;
    case "continue": loadLatest(); break;
    case "gallery": openGallery(); break;
    case "scenes": openScenes(); break;
    case "endings": openEndings(); break;
    case "settings": openSettings("title"); break;
  }
});

$("btn-game-menu").addEventListener("click", toggleMenu);

$("overlay-menu").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) { $("overlay-menu").classList.add("hidden"); return; }
  switch (btn.dataset.menu) {
    case "save": openSaveLoad(true); break;
    case "load": openSaveLoad(false); break;
    case "auto": toggleAuto(); $("overlay-menu").classList.add("hidden"); break;
    case "backlog": openBacklog(); break;
    case "settings": $("overlay-menu").classList.add("hidden"); openSettings("game"); break;
    case "title": closeAllOverlays(); toTitle(); break;
    case "close": $("overlay-menu").classList.add("hidden"); break;
  }
});

$("btn-backlog-close").addEventListener("click", () => $("overlay-backlog").classList.add("hidden"));
$("btn-saveload-close").addEventListener("click", () => $("overlay-saveload").classList.add("hidden"));
$("btn-export").addEventListener("click", exportAll);
$("import-file").addEventListener("change", (e) => { if (e.target.files[0]) importAll(e.target.files[0]); e.target.value = ""; });
$("overlay-viewer").addEventListener("click", () => $("overlay-viewer").classList.add("hidden"));

document.querySelectorAll(".btn-back").forEach((btn) =>
  btn.addEventListener("click", () => {
    if (!screens.settings.classList.contains("hidden")) closeSettings();
    else showScreen("title");
  }));

$("btn-reset-keys").addEventListener("click", () => {
  G.keys = { ...DEFAULT_KEYS };
  savePersistent();
  buildKeyConfig();
  showToast("キー設定を初期化しました");
});

[["opt-text-speed", "textSpeed"], ["opt-auto-wait", "autoWait"],
 ["opt-bgm-vol", "bgmVol"], ["opt-se-vol", "seVol"], ["opt-voice-vol", "voiceVol"]].forEach(([id, prop]) => {
  $(id).addEventListener("input", (e) => {
    G.settings[prop] = parseInt(e.target.value, 10);
    updateSettingLabels();
    if (prop === "bgmVol" && G.bgm) G.bgm.volume = G.settings.bgmVol / 100;
    savePersistent();
  });
});

$("opt-skip-unread").addEventListener("change", (e) => {
  G.settings.skipUnread = e.target.checked ? 1 : 0;
  savePersistent();
});

/* ファイル読み込みフォールバック */
function importFiles(fileList) {
  const files = [...fileList].filter((f) => f.name.endsWith(".txt"));
  if (files.length === 0) return;
  Promise.all(files.map((f) => f.text().then((text) => ({ name: f.name, text }))))
    .then(async (results) => {
      for (const r of results) { G.rawFiles[r.name] = r.text; delete G.parsedFiles[r.name]; }
      const entry = results.some((r) => r.name === ENTRY_FILE) ? ENTRY_FILE : results[0].name;
      if (entry !== ENTRY_FILE) { G.rawFiles[ENTRY_FILE] = G.rawFiles[entry]; delete G.parsedFiles[ENTRY_FILE]; }
      await loadFile(ENTRY_FILE);
      $("overlay-file").classList.add("hidden");
      showToast(results.length + " 個のファイルを読み込みました");
      toTitle();
    });
}

$("file-input").addEventListener("change", (e) => importFiles(e.target.files));
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => { e.preventDefault(); importFiles(e.dataTransfer.files); });

/* =========================================================
 * 起動
 * ========================================================= */
boot();
