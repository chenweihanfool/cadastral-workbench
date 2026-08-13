"""版本與更新來源設定（單機執行檔用）。

發布新版時請同步更新：
  1. 這裡的 APP_VERSION
  2. js/version.js 的 window.CW_VERSION（網頁版版號 / 開發日誌）
  3. 打 git tag：v{APP_VERSION}，push tag 後 GitHub Actions 會自動建置 exe 並發佈 Release
"""

APP_TITLE = 'CadastralWorkbench'
APP_VERSION = '0.9.3'

GITHUB_OWNER = 'chenweihanfool'
GITHUB_REPO = 'cadastral-workbench'
