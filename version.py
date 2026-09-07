"""版本與更新來源設定（單機執行檔用）。

發布新版時請同步更新：
  1. 這裡的 APP_VERSION
  2. js/version.js 的 window.CW_VERSION（網頁版版號 / 開發日誌）
之後 merge 進 master：.github/workflows/auto-tag.yml 會自動偵測
APP_VERSION 變動、建立並 push tag v{APP_VERSION}，觸發 release.yml
自動建置 exe 並發佈 Release，不需要手動打 tag。
"""

APP_TITLE = 'CadastralWorkbench'
APP_VERSION = '0.9.8'

GITHUB_OWNER = 'chenweihanfool'
GITHUB_REPO = 'cadastral-workbench'
