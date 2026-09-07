"""版本與更新來源設定（單機執行檔用）。

發布新版時請同步更新：
  1. 這裡的 APP_VERSION
  2. js/version.js 的 window.CW_VERSION（網頁版版號 / 開發日誌）
之後 merge 進 master：.github/workflows/release.yml 會自動偵測
APP_VERSION 變動、建立 tag v{APP_VERSION} 並在同一次執行內建置 exe、
發佈 Release，不需要手動打 tag或手動跑 workflow。
"""

APP_TITLE = 'CadastralWorkbench'
APP_VERSION = '0.9.10'

GITHUB_OWNER = 'chenweihanfool'
GITHUB_REPO = 'cadastral-workbench'
