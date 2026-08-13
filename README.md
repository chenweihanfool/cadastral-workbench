# CadastralWorkbench

整合地籍圖套圖（fit-cadastral）與地籍圖調整（cadaadjust）的純前端 WebApp。

**GitHub Pages 線上版**：https://chenweihanfool.github.io/cadastral-workbench/

---

## 功能模組

### 📐 套圖模組（Phase 1–5）
- 上傳 KC 格式地籍資料（D14/D2B/D2C/D2D）與現況點 CSV
- Pyodide 在瀏覽器內執行 scipy L-BFGS-B 最佳化套合
- Leaflet 即時顯示套合前後對比（灰色原始 / 橘色套合）
- 匯出放樣座標 TXT（點號,N,E）供 GPS / 全站儀使用
- 匯出 GeoPackage（EPSG:3826）供 QGIS 管理歷史套合紀錄
- AI 套合品質說明（OpenAI / Gemini，Key 存 localStorage）

### 📏 調整模組（Phase 6）
- 接收套圖成果或獨立上傳 GeoJSON
- 對超出法定公差的地籍線進行微調（30–50 cm 範圍）
- Leaflet 對比顯示調整前（紅虛線）/ 調整後（綠實線）
- 匯出含 `tolerance_check` 屬性表的 GeoPackage

---

## 技術架構

| 層次 | 套件 |
|------|------|
| 地圖視覺化 | Leaflet.js + leaflet-geoman |
| Python 演算法 | Pyodide 0.26 (scipy 內建) |
| GeoPackage 輸出 | sql.js (SQLite WASM) |
| UI | Tailwind CSS CDN + Alpine.js |
| 部署 | GitHub Pages (Actions 自動部署) |

---

## 使用流程

```
接到複丈案件 → 輸入案號地號
  ↓
上傳 KC 地籍檔 + 現況點 CSV
  ↓
執行套合運算（Pyodide）
  ↓
即時地圖預覽套合成果
  ↓
匯出 TXT → USB → GPS 放樣
匯出 GeoPackage → QGIS 管理
  ↓
（選用）送入調整模組處理超差地籍線
```

---

## 開發進度

- [x] Phase 1：框架 + Leaflet 地圖基礎
- [x] Phase 2：Pyodide Worker 整合（fit_cadastral.py）
- [x] Phase 3：Leaflet 即時顯圖（套合前後疊圖）
- [x] Phase 4：sql.js GeoPackage 輸出
- [x] Phase 5：AI 說明功能
- [x] Phase 6：cadaadjust 模組整合
- [ ] Phase 7：UI 美化 + 整合測試

---

## 單機執行檔（免安裝）

除了 GitHub Pages 線上版，也提供 Windows 單一 .exe，免安裝 Python，雙擊即可使用：

- 從 [Releases](https://github.com/chenweihanfool/cadastral-workbench/releases) 下載最新的 `CadastralWorkbench.exe`
- 雙擊執行：會在本機開啟一個小型伺服器（僅限 127.0.0.1），並自動開啟瀏覽器分頁
- 每次啟動會在背景檢查 GitHub 上是否有更新版本；有的話會自動下載、取代自己並重新啟動（離線或檢查失敗時安靜略過，不影響照常使用）
- 保留視窗開啟中的黑色主控台視窗即為伺服器；關閉該視窗或按 Ctrl-C 即可結束

### 建置 / 發布新版 exe

```bash
pip install pyinstaller
pyinstaller CadastralWorkbench.spec
```

發布流程：
1. 更新 `version.py` 的 `APP_VERSION`，並同步更新 `js/version.js` 的 `CW_VERSION`（含開發日誌）
2. `git tag v{APP_VERSION}` 後 `git push --tags`
3. GitHub Actions（`.github/workflows/release.yml`）會自動建置並發佈 Release，含 `CadastralWorkbench.exe`
4. 舊版 exe 下次啟動時會自動偵測到新版並自我更新

---

## 相關專案

- [fit-cadastral](https://github.com/chenweihanfool/fit-cadastral) — 地籍圖自動套圖演算法
- [cadaadjust](https://github.com/chenweihanfool/cadaadjust) — 地籍圖調整演算法
