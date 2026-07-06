/* レンダラー(ゲーム本体)から save/ フォルダのファイルを読み書きするための橋渡し。
 * contextIsolation 下で ipcRenderer 経由でメインプロセスの fs を呼ぶ。 */
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("daraskFS", {
  list:   ()            => ipcRenderer.invoke("dfs:list"),
  read:   (name)        => ipcRenderer.invoke("dfs:read", name),
  write:  (name, data)  => ipcRenderer.invoke("dfs:write", name, data),
  remove: (name)        => ipcRenderer.invoke("dfs:remove", name),
  dir:    ()            => ipcRenderer.invoke("dfs:dir"),
});
