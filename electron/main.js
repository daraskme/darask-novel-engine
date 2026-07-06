/* Darask Novel Engine - Electron ランチャー */
"use strict";

const { app, BrowserWindow, Menu, protocol, net } = require("electron");
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

app.whenReady().then(() => {
  const userRoot = resolveUserRoot();

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
    webPreferences: { contextIsolation: true },
  });
  win.loadURL("app://game/index.html");
});

app.on("window-all-closed", () => app.quit());
