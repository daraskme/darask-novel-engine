/* Darask Novel Engine - Electron ランチャー */
"use strict";

const { app, BrowserWindow, Menu, protocol, net, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

// fetch() で scenario.txt などを読めるよう、専用スキームを登録する
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const APP_ROOT = path.join(__dirname, "..");

/* ポータブル exe の隣に scenario.txt を置くと、同梱シナリオより優先して読み込む。
 * (exe と同じフォルダに scenario.txt / bg / bgm などを置くだけで差し替え可能) */
function resolveUserRoot() {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir && fs.existsSync(path.join(portableDir, "scenario.txt"))) {
    return portableDir;
  }
  return APP_ROOT;
}

function insideRoot(root, target) {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/* セーブは exe(ポータブル)と同じ階層の save/ フォルダに JSON で保存する。
 * 開発実行時はプロジェクト直下の save/ を使う。 */
function resolveSaveDir() {
  const base = process.env.PORTABLE_EXECUTABLE_DIR || APP_ROOT;
  const dir = path.join(base, "save");
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  return dir;
}

function registerSaveIPC() {
  const saveDir = resolveSaveDir();
  // ファイル名は basename のみ許可(ディレクトリ外への書き込みを防ぐ)
  const safe = (name) => path.join(saveDir, path.basename(String(name || "")));
  ipcMain.handle("dfs:dir", () => saveDir);
  ipcMain.handle("dfs:list", () => {
    try { return fs.readdirSync(saveDir).filter((f) => f.endsWith(".json")); }
    catch (e) { return []; }
  });
  ipcMain.handle("dfs:read", (e, name) => {
    try { return fs.readFileSync(safe(name), "utf8"); } catch (err) { return null; }
  });
  ipcMain.handle("dfs:write", (e, name, data) => {
    try { fs.writeFileSync(safe(name), String(data), "utf8"); return true; } catch (err) { return false; }
  });
  ipcMain.handle("dfs:remove", (e, name) => {
    try { fs.unlinkSync(safe(name)); return true; } catch (err) { return false; }
  });
}

app.whenReady().then(() => {
  const userRoot = resolveUserRoot();
  registerSaveIPC();

  protocol.handle("app", (req) => {
    const { pathname } = new URL(req.url);
    let rel = decodeURIComponent(pathname).replace(/^\/+/, "");
    if (!rel) rel = "index.html";

    // ユーザーフォルダ優先 → 同梱ファイルにフォールバック
    for (const root of [userRoot, APP_ROOT]) {
      const target = path.normalize(path.join(root, rel));
      if (!insideRoot(root, target)) continue; // ルート外へのアクセスは禁止
      if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        return net.fetch(pathToFileURL(target).toString());
      }
    }
    return new Response("not found", { status: 404 });
  });

  Menu.setApplicationMenu(null);
  // 開発実行(npm run start)時のウィンドウ/タスクバーアイコン。
  // パッケージ済み exe では exe 埋め込みアイコンが自動的に使われる。
  const iconPath = path.join(APP_ROOT, "build", "icon.png");
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    useContentSize: true,
    backgroundColor: "#0b0d12",
    title: "Darask Novel Engine",
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  win.loadURL("app://game/index.html");
});

app.on("window-all-closed", () => app.quit());
