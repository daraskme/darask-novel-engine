/* =========================================================
 * Darask Novel Engine
 * scenario.txt を置くだけで動くシンプルなノベルゲームエンジン
 * ========================================================= */
"use strict";

/* ---------- 定数 ---------- */
const STORAGE_PREFIX = "dne_";
const ASSET_DIR = { bg: "bg/", cg: "cg/", bgm: "bgm/", se: "se/", chara: "chara/" };
const ENTRY_FILE = "scenario.txt";

// 立ち絵の表示位置キーワード → 内部位置
const CHARA_POS = {
  left: "left", l: "left", "左": "left",
  center: "center", c: "center", "中": "center", "中央": "center",
  right: "right", r: "right", "右": "right",
};

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
};

const DEFAULT_SETTINGS = {
  textSpeed: 30,   // 1文字あたりms (0=瞬間表示)
  autoWait: 1800,  // オートモードの待ち時間ms
  bgmVol: 60,
  seVol: 80,
};

const NAME_COLORS = [
  "#8ecbff", "#ffb3c1", "#b6f2a8", "#ffd88a",
  "#d3b3ff", "#8affe2", "#ffab8a", "#c9d4ff",
];

/* ---------- 状態 ---------- */
const G = {
  file: ENTRY_FILE, // 現在のシナリオファイル名
  nodes: [],        // 現在のファイルのパース済みノード
  rawFiles: {},     // ドラッグ&ドロップで渡された生テキスト { name: text }
  parsedFiles: {},  // パース済みキャッシュ { name: {nodes, scenes, cgList} }
  nameColors: {},   // キャラ名 → 色

  flags: {},        // シナリオフラグ { 名前: 数値 or 真偽値 }
  pos: 0,           // 次に処理するノード番号
  shownIndex: -1,   // いま表示中のテキストノード番号(セーブ用)
  curBg: "",
  curCg: "",
  chara: {},        // 表示中の立ち絵 { 名前: { pos, expr } }
  lastSpeaker: null,// 直近に喋ったキャラ名(立ち絵ハイライト用)

  typing: false,
  typeTimer: null,
  fullText: "",
  waiting: false,   // @wait やファイル読込中
  waitTimer: null,
  choosing: false,  // 選択肢表示中
  choiceOptions: [],

  autoMode: false,
  autoTimer: null,
  skipHeld: false,
  skipTimer: null,
  uiHidden: false,

  inGame: false,
  keyCapture: null,

  backlog: [],
  settingsReturn: "title",

  keys: { ...DEFAULT_KEYS },
  settings: { ...DEFAULT_SETTINGS },
  unlockedCG: new Set(),
  cgRegistry: [],    // これまでに発見した CG (ギャラリーの枠)
  sceneRegistry: [], // これまでに発見したシーン [{file, title}]
  sceneSnaps: {},    // 解放済みシーンのスナップショット { "file|title": snap }

  bgm: null,
  bgmName: "",
};

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const screens = {
  title: $("screen-title"),
  game: $("screen-game"),
  gallery: $("screen-gallery"),
  scenes: $("screen-scenes"),
  settings: $("screen-settings"),
};

/* =========================================================
 * ストレージ
 * ========================================================= */
function store(key, val) {
  try { localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(val)); } catch (e) {}
}
function restore(key, fallback) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (e) { return fallback; }
}

function loadPersistent() {
  G.keys = { ...DEFAULT_KEYS, ...restore("keys", {}) };
  G.settings = { ...DEFAULT_SETTINGS, ...restore("settings", {}) };
  G.unlockedCG = new Set(restore("unlockedCG", []));
  G.cgRegistry = restore("cgRegistry", []);
  G.sceneRegistry = restore("sceneRegistry", []);
  G.sceneSnaps = restore("sceneSnaps", {});
}

function savePersistent() {
  store("keys", G.keys);
  store("settings", G.settings);
  store("unlockedCG", [...G.unlockedCG]);
  store("cgRegistry", G.cgRegistry);
  store("sceneRegistry", G.sceneRegistry);
  store("sceneSnaps", G.sceneSnaps);
}

/* =========================================================
 * シナリオのパース
 * ========================================================= */
function parseScenario(text) {
  const nodes = [];
  const scenes = [];
  const cgList = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (isComment(line)) continue;

    // 選択肢ブロック: 「選択肢」の行に続く行が選択肢になる(空行/@コマンドで終了)
    if (line === "選択肢" || line.toLowerCase() === "@choice") {
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
    if (line.startsWith("@")) {
      const sp = line.search(/\s/);
      const cmd = (sp === -1 ? line.slice(1) : line.slice(1, sp)).toLowerCase();
      const arg = sp === -1 ? "" : line.slice(sp + 1).trim();

      if (cmd === "scene") {
        scenes.push({ title: arg || `シーン${scenes.length + 1}`, index: nodes.length });
      }
      if (cmd === "cg" && arg && arg.toLowerCase() !== "off" && !cgList.includes(arg)) {
        cgList.push(arg);
      }
      nodes.push({ type: "cmd", cmd, arg });
      continue;
    }

    // 「名前:セリフ」(コロンは半角/全角どちらでも可。名前は12文字以内・空白なし)
    const m = line.match(/^([^:：\s]{1,12})[:：](.*)$/);
    if (m) {
      nodes.push({ type: "say", name: m[1], text: m[2].trim() });
    } else {
      nodes.push({ type: "text", text: line }); // 地の文
    }
  }

  return { nodes, scenes, cgList };
}

function isComment(line) {
  return line.startsWith("#") || line.startsWith("//") ||
         line.startsWith(";") || line.startsWith("；");
}

/* 「テキスト -> 効果, 効果, ...」を解釈する */
function parseChoiceLine(line) {
  const m = line.split(/->|→/);
  const text = m[0].trim();
  const effects = [];
  if (m.length > 1) {
    for (const part of m.slice(1).join("").split(/[,、]/)) {
      const eff = parseEffect(part);
      if (eff) effects.push(eff);
    }
  }
  return { text, effects };
}

/* 効果: "file.txt"(ジャンプ) / "flag=値" / "flag+1" / "flag-1" */
function parseEffect(s) {
  s = s.trim();
  if (!s) return null;
  if (/\.txt$/i.test(s)) return { type: "jump", file: s };

  let m = s.match(/^(.+?)\s*=\s*(.+)$/);
  if (m) return { type: "set", name: m[1].trim(), value: parseValue(m[2].trim()) };

  m = s.match(/^(.+?)\s*([+-])\s*(\d+)$/);
  if (m) return { type: "add", name: m[1].trim(), delta: (m[2] === "-" ? -1 : 1) * parseInt(m[3], 10) };

  console.warn("解釈できない効果:", s);
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

/* 条件式: "flag>=2" "flag==true" "flag<3" など */
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
 * シナリオファイルの読み込み (複数ファイル対応)
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
  return parsed;
}

/* パースしたファイルの CG / シーンをギャラリー・鑑賞モードの枠として登録 */
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
  if (changed) savePersistent();

  // エントリーファイルの @title をゲームタイトルに反映
  if (file === ENTRY_FILE) {
    const titleNode = parsed.nodes.find((n) => n.type === "cmd" && n.cmd === "title");
    if (titleNode && titleNode.arg) {
      $("game-title").textContent = titleNode.arg;
      document.title = titleNode.arg;
    }
  }
}

async function boot() {
  loadPersistent();
  updateContinueButton();
  const parsed = await loadFile(ENTRY_FILE);
  if (!parsed) {
    // file:// 直開きなどで fetch できない場合はファイル選択にフォールバック
    $("overlay-file").classList.remove("hidden");
  }
}

/* =========================================================
 * アセット (存在しない場合はプレースホルダを自動生成)
 * ========================================================= */
const PH_CACHE = {}; // 生成済みプレースホルダ画像を使い回してチラつきを防ぐ

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

/* 立ち絵のプレースホルダ。expr が空ならベース(体+名前)、
 * expr 指定時は顔の位置に表情ラベルだけを描いた差分(それ以外は透過)を返す。 */
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
    rr(150, 300, 300, 700, 70); ctx.fill();                 // 胴体
    ctx.beginPath(); ctx.arc(300, 230, 140, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${hue}, 40%, 62%)`; ctx.fill();     // 頭
    ctx.fillStyle = "rgba(255,255,255,.92)";
    ctx.font = "bold 56px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(name, 300, 640);
  } else {
    ctx.fillStyle = `hsl(${hue}, 70%, 32%)`;
    rr(170, 300, 260, 90, 18); ctx.fill();                  // 表情バッジ(顔付近)
    ctx.fillStyle = "#fff";
    ctx.font = "bold 46px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(expr, 300, 362);
  }
  return (PH_CACHE[key] = cv.toDataURL());
}

function setImage(imgEl, dir, file) {
  imgEl.onerror = () => {
    imgEl.onerror = null;
    imgEl.src = placeholderImage(file);
  };
  imgEl.src = ASSET_DIR[dir] + file;
}

function playBGM(file) {
  if (file === G.bgmName) return;
  stopBGM();
  if (!file || file.toLowerCase() === "stop") return;
  const a = new Audio(ASSET_DIR.bgm + file);
  a.loop = true;
  a.volume = G.settings.bgmVol / 100;
  a.play().catch(() => {}); // ファイルなし・自動再生制限は無視
  G.bgm = a;
  G.bgmName = file;
}

function stopBGM() {
  if (G.bgm) { G.bgm.pause(); G.bgm = null; }
  G.bgmName = "";
}

function playSE(file) {
  if (!file) return;
  const a = new Audio(ASSET_DIR.se + file);
  a.volume = G.settings.seVol / 100;
  a.play().catch(() => {});
}

/* =========================================================
 * 立ち絵 (背景とは別レイヤー。ベース画像 + 表情差分を重ねる)
 *   ファイル規約: chara/名前.png (ベース) と chara/名前_表情.png (差分)
 * ========================================================= */
function showChara(arg) {
  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  const name = tokens[0];
  if (!name) return;
  let pos = null, expr = null;
  for (const tok of tokens.slice(1)) {
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

/* 表情だけを差し替える (立ち絵はそのまま) */
function faceChara(arg) {
  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  const name = tokens[0];
  if (!name) return;
  const cur = G.chara[name] || { pos: "center" };
  G.chara[name] = { pos: cur.pos, expr: tokens[1] || "" };
  renderChara();
}

function hideChara(arg) {
  const name = arg.trim();
  if (!name || name.toLowerCase() === "all" || name === "全員") G.chara = {};
  else delete G.chara[name];
  renderChara();
}

/* G.chara の状態からレイヤーを組み立て直す */
function renderChara() {
  const layer = $("chara-layer");
  layer.innerHTML = "";
  for (const [name, st] of Object.entries(G.chara)) {
    const slot = document.createElement("div");
    slot.className = "chara-slot pos-" + st.pos;
    slot.dataset.name = name;

    const base = document.createElement("img");
    base.className = "chara-base";
    base.onerror = () => { base.onerror = null; base.src = placeholderSprite(name, ""); };
    base.src = ASSET_DIR.chara + name + ".png";
    slot.appendChild(base);

    if (st.expr) {
      const face = document.createElement("img");
      face.className = "chara-face";
      face.onerror = () => { face.onerror = null; face.src = placeholderSprite(name, st.expr); };
      face.src = ASSET_DIR.chara + name + "_" + st.expr + ".png";
      slot.appendChild(face);
    }
    layer.appendChild(slot);
  }
  applyCharaHighlight();
}

/* 喋っているキャラを明るく、それ以外を少し暗くする */
function applyCharaHighlight() {
  const speaker = G.lastSpeaker;
  const active = speaker && G.chara[speaker];
  for (const slot of $("chara-layer").children) {
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

function toTitle() {
  stopAuto();
  endSkip();
  stopBGM();
  clearTimeout(G.waitTimer);
  G.waiting = false;
  G.inGame = false;
  G.choosing = false;
  G.chara = {};
  G.lastSpeaker = null;
  renderChara();
  $("cg-img").classList.add("hidden");
  $("choice-box").classList.add("hidden");
  updateContinueButton();
  showScreen("title");
}

function updateContinueButton() {
  $("btn-continue").disabled = restore("save", null) === null;
}

/* =========================================================
 * スナップショット (セーブ / シーン鑑賞の復元に使う)
 * ========================================================= */
function makeSnapshot(index) {
  return {
    file: G.file,
    index,
    bg: G.curBg,
    cg: G.curCg,
    bgm: G.bgmName,
    flags: { ...G.flags },
    chara: JSON.parse(JSON.stringify(G.chara)),
    speaker: G.lastSpeaker,
  };
}

async function restoreSnapshot(snap) {
  const parsed = await loadFile(snap.file);
  if (!parsed) { showToast("ファイルが見つかりません: " + snap.file); return false; }

  stopAuto();
  endSkip();
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
  updateModeIndicator();

  // 画面状態の復元
  G.curBg = snap.bg;
  G.curCg = snap.cg;
  if (snap.bg) setImage($("bg-img"), "bg", snap.bg);
  else $("bg-img").src = placeholderImage("背景未設定");
  if (snap.cg) { setImage($("cg-img"), "cg", snap.cg); $("cg-img").classList.remove("hidden"); }
  else $("cg-img").classList.add("hidden");
  if (snap.bgm) playBGM(snap.bgm); else stopBGM();
  G.chara = snap.chara ? JSON.parse(JSON.stringify(snap.chara)) : {};
  G.lastSpeaker = snap.speaker || null;
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
  restoreSnapshot({ file: ENTRY_FILE, index: 0, bg: "", cg: "", bgm: "", flags: {} });
}

/* =========================================================
 * ゲーム進行
 * ========================================================= */
function advance() {
  if (!G.inGame || G.waiting || G.choosing) return;

  // 文字送り中なら全文表示で確定
  if (G.typing) { finishTyping(); return; }

  while (G.pos < G.nodes.length) {
    const idx = G.pos;
    const node = G.nodes[idx];
    G.pos = idx + 1;

    if (node.type === "cmd") {
      if (execCommand(node, idx)) return; // @wait / @jump / @if 成立は一旦停止
      continue;
    }

    if (node.type === "choice") {
      showChoices(node);
      return;
    }

    // say / text
    G.shownIndex = idx;
    showText(node);
    return;
  }

  // シナリオ終端 → タイトルへ戻る
  endStory();
}

/* 物語の終了。必ずタイトル画面へ戻す (@end / シナリオ終端 / エンディング到達) */
function endStory() {
  if (!G.inGame) return;
  G.inGame = false;
  clearInterval(G.typeTimer);
  G.typing = false;
  showToast("― おしまい ―");
  setTimeout(toTitle, 1600);
}

/* コマンド実行。true を返すと advance を中断する */
function execCommand(node, idx) {
  const { cmd, arg } = node;
  switch (cmd) {
    case "bg":
      if (arg) { G.curBg = arg; setImage($("bg-img"), "bg", arg); }
      break;
    case "cg":
      if (arg.toLowerCase() === "off") {
        G.curCg = "";
        $("cg-img").classList.add("hidden");
      } else if (arg) {
        G.curCg = arg;
        setImage($("cg-img"), "cg", arg);
        $("cg-img").classList.remove("hidden");
        if (!G.unlockedCG.has(arg)) {
          G.unlockedCG.add(arg);
          savePersistent();
        }
      }
      break;
    case "bgm":
      playBGM(arg);
      break;
    case "se":
      playSE(arg);
      break;
    case "chara":
    case "show":
    case "sprite":
      showChara(arg);
      break;
    case "face":
    case "expr":
      faceChara(arg);
      break;
    case "hide":
      hideChara(arg);
      break;
    case "end":
      endStory();
      return true;
    case "scene": {
      const scene = G.parsedFiles[G.file].scenes.find((s) => s.index === idx);
      if (scene) {
        // 到達した時点の状態を保存 → シーン鑑賞から同じ状態で再生できる
        G.sceneSnaps[G.file + "|" + scene.title] = makeSnapshot(idx + 1);
        savePersistent();
      }
      break;
    }
    case "set":
      applyEffect(parseEffect(arg));
      break;
    case "jump":
      doJump(arg);
      return true;
    case "if": {
      const m = arg.match(/^(.*\S)\s+(\S+)$/);
      if (!m) { console.warn("@if の書式が不正:", arg); break; }
      if (evalCond(m[1])) { doJump(m[2]); return true; }
      break;
    }
    case "wait": {
      if (G.skipHeld) break; // スキップ中は待たない
      const ms = parseInt(arg, 10) || 0;
      if (ms > 0) {
        G.waiting = true;
        G.waitTimer = setTimeout(() => { G.waiting = false; advance(); }, ms);
        return true;
      }
      break;
    }
    case "title":
      break; // 起動時に処理済み
    default:
      console.warn("未知のコマンド: @" + cmd);
  }
  return false;
}

/* 別のシナリオファイルへ遷移 */
async function doJump(file) {
  G.waiting = true;
  const parsed = await loadFile(file);
  G.waiting = false;
  if (!parsed) {
    showToast("シナリオファイルが見つかりません: " + file);
    return;
  }
  G.file = file;
  G.nodes = parsed.nodes;
  G.pos = 0;
  advance();
}

/* ---------- 選択肢 ---------- */
function showChoices(node) {
  endSkip();
  clearTimeout(G.autoTimer);
  G.choosing = true;
  G.choiceOptions = node.options;
  $("next-indicator").classList.add("hidden");

  const box = $("choice-box");
  box.innerHTML = "";
  node.options.forEach((opt, i) => {
    const btn = document.createElement("button");
    btn.textContent = opt.text;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      selectChoice(i);
    });
    box.appendChild(btn);
  });
  box.classList.remove("hidden");
}

function selectChoice(i) {
  const opt = G.choiceOptions[i];
  if (!opt || !G.choosing) return;
  G.choosing = false;
  $("choice-box").classList.add("hidden");

  G.backlog.push({ name: "", text: "▶ " + opt.text, choice: true });

  let jump = null;
  for (const eff of opt.effects) {
    if (eff.type === "jump") jump = eff.file;
    else applyEffect(eff);
  }
  if (jump) doJump(jump);
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

function showText(node) {
  const namePlate = $("name-plate");
  const textArea = $("text-area");
  $("next-indicator").classList.add("hidden");

  if (node.type === "say") {
    namePlate.textContent = node.name;
    namePlate.style.color = nameColor(node.name);
    namePlate.classList.remove("hidden");
    textArea.classList.remove("narration");
    G.lastSpeaker = node.name;
    applyCharaHighlight();
  } else {
    namePlate.classList.add("hidden");
    textArea.classList.add("narration");
  }

  G.backlog.push({ name: node.type === "say" ? node.name : "", text: node.text });
  if (G.backlog.length > 300) G.backlog.shift();

  // 文字送り
  G.fullText = node.text;
  clearInterval(G.typeTimer);
  const speed = G.skipHeld ? 0 : G.settings.textSpeed;

  if (speed <= 0) {
    textArea.textContent = G.fullText;
    G.typing = false;
    onTextComplete();
  } else {
    G.typing = true;
    let i = 0;
    textArea.textContent = "";
    G.typeTimer = setInterval(() => {
      i++;
      textArea.textContent = G.fullText.slice(0, i);
      if (i >= G.fullText.length) {
        clearInterval(G.typeTimer);
        G.typing = false;
        onTextComplete();
      }
    }, speed);
  }
}

function finishTyping() {
  clearInterval(G.typeTimer);
  G.typing = false;
  $("text-area").textContent = G.fullText;
  onTextComplete();
}

function onTextComplete() {
  $("next-indicator").classList.remove("hidden");
  if (G.autoMode && !G.skipHeld) {
    clearTimeout(G.autoTimer);
    G.autoTimer = setTimeout(() => {
      if (G.autoMode && G.inGame && !isOverlayOpen()) advance();
    }, G.settings.autoWait);
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
    if (G.typing) finishTyping();
    else advance();
  }, 60);
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

/* ---------- セーブ / ロード ---------- */
function quickSave() {
  if (!G.inGame || G.shownIndex < 0) return;
  store("save", makeSnapshot(G.shownIndex));
  updateContinueButton();
  showToast("セーブしました");
}

function quickLoad() {
  const data = restore("save", null);
  if (data === null) { showToast("セーブデータがありません"); return; }
  closeAllOverlays();
  restoreSnapshot(data).then((ok) => { if (ok) showToast("ロードしました"); });
}

/* =========================================================
 * ギャラリー / シーン鑑賞
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
  updateSettingLabels();
}

function updateSettingLabels() {
  const s = G.settings;
  $("val-text-speed").textContent = s.textSpeed === 0 ? "瞬間表示" : s.textSpeed + "ms/字";
  $("val-auto-wait").textContent = (s.autoWait / 1000).toFixed(1) + "秒";
  $("val-bgm-vol").textContent = s.bgmVol + "%";
  $("val-se-vol").textContent = s.seVol + "%";
}

function keyDisplayName(code) {
  return code
    .replace(/^Key/, "")
    .replace(/^Digit/, "")
    .replace(/^Arrow/, "→ ")
    .replace("ControlLeft", "左Ctrl")
    .replace("ControlRight", "右Ctrl")
    .replace("ShiftLeft", "左Shift")
    .replace("ShiftRight", "右Shift")
    .replace("Escape", "Esc")
    .replace("Space", "スペース");
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
  // 他のアクションと重複していたら入れ替え
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
  return ["overlay-menu", "overlay-backlog", "overlay-viewer", "overlay-file"]
    .some((id) => !$(id).classList.contains("hidden"));
}

function closeAllOverlays() {
  ["overlay-menu", "overlay-backlog", "overlay-viewer"].forEach((id) =>
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
  // キー割当キャプチャ中
  if (G.keyCapture) {
    e.preventDefault();
    captureKey(e.code);
    return;
  }

  const k = G.keys;
  const code = e.code;

  if (["Space", "Enter", "ArrowUp", "ArrowDown"].includes(code)) e.preventDefault();

  if (code === k.fullscreen) { toggleFullscreen(); return; }

  // サブ画面では Esc で戻る
  if (!screens.settings.classList.contains("hidden")) {
    if (code === k.menu) closeSettings();
    return;
  }
  if (!screens.gallery.classList.contains("hidden") || !screens.scenes.classList.contains("hidden")) {
    if (code === k.menu) showScreen("title");
    return;
  }

  // オーバーレイが開いていたら閉じる操作のみ
  if (!$("overlay-viewer").classList.contains("hidden")) {
    if (code === k.menu || code === k.advance) $("overlay-viewer").classList.add("hidden");
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

  // ウィンドウ非表示中は何かキーを押すと再表示
  if (G.uiHidden && code !== k.hide) { toggleUI(true); return; }

  // 選択肢表示中: 数字キーで選択
  if (G.choosing) {
    const num = code.match(/^(?:Digit|Numpad)([1-9])$/);
    if (num) { selectChoice(parseInt(num[1], 10) - 1); return; }
    if (code === k.backlog) openBacklog();
    else if (code === k.menu) toggleMenu();
    else if (code === k.save) quickSave();
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

/* ゲーム画面のクリック / ホイール */
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
  if (!isOverlayOpen()) toggleUI(); // 右クリックでウィンドウ非表示切替
});

document.addEventListener("wheel", (e) => {
  if (!G.inGame || isOverlayOpen()) return;
  if (screens.game.classList.contains("hidden")) return;
  if (e.deltaY < 0) openBacklog();                        // 上スクロールでバックログ
  else if (!G.choosing) { stopAuto(); advance(); }        // 下スクロールで読み進め
}, { passive: true });

/* =========================================================
 * ボタン類
 * ========================================================= */
$("screen-title").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  switch (btn.dataset.action) {
    case "start": startGame(); break;
    case "continue": quickLoad(); break;
    case "gallery": openGallery(); break;
    case "scenes": openScenes(); break;
    case "settings": openSettings("title"); break;
  }
});

$("btn-game-menu").addEventListener("click", toggleMenu);

$("overlay-menu").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) { $("overlay-menu").classList.add("hidden"); return; }
  switch (btn.dataset.menu) {
    case "save": quickSave(); $("overlay-menu").classList.add("hidden"); break;
    case "load": quickLoad(); break;
    case "auto": toggleAuto(); $("overlay-menu").classList.add("hidden"); break;
    case "backlog": openBacklog(); break;
    case "settings": $("overlay-menu").classList.add("hidden"); openSettings("game"); break;
    case "title": closeAllOverlays(); toTitle(); break;
    case "close": $("overlay-menu").classList.add("hidden"); break;
  }
});

$("btn-backlog-close").addEventListener("click", () =>
  $("overlay-backlog").classList.add("hidden"));

$("overlay-viewer").addEventListener("click", () =>
  $("overlay-viewer").classList.add("hidden"));

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

/* 設定スライダー */
[["opt-text-speed", "textSpeed"], ["opt-auto-wait", "autoWait"],
 ["opt-bgm-vol", "bgmVol"], ["opt-se-vol", "seVol"]].forEach(([id, prop]) => {
  $(id).addEventListener("input", (e) => {
    G.settings[prop] = parseInt(e.target.value, 10);
    updateSettingLabels();
    if (prop === "bgmVol" && G.bgm) G.bgm.volume = G.settings.bgmVol / 100;
    savePersistent();
  });
});

/* ファイル読み込みフォールバック (file:// 直開き用。複数ファイル対応) */
function importFiles(fileList) {
  const files = [...fileList].filter((f) => f.name.endsWith(".txt"));
  if (files.length === 0) return;
  Promise.all(files.map((f) => f.text().then((text) => ({ name: f.name, text }))))
    .then(async (results) => {
      for (const r of results) {
        G.rawFiles[r.name] = r.text;
        delete G.parsedFiles[r.name]; // 再読込に対応
      }
      const entry = results.some((r) => r.name === ENTRY_FILE) ? ENTRY_FILE : results[0].name;
      if (entry !== ENTRY_FILE) {
        G.rawFiles[ENTRY_FILE] = G.rawFiles[entry];
        delete G.parsedFiles[ENTRY_FILE];
      }
      await loadFile(ENTRY_FILE);
      $("overlay-file").classList.add("hidden");
      showToast(results.length + " 個のファイルを読み込みました");
      toTitle();
    });
}

$("file-input").addEventListener("change", (e) => importFiles(e.target.files));

document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  importFiles(e.dataTransfer.files);
});

/* =========================================================
 * 起動
 * ========================================================= */
boot();
