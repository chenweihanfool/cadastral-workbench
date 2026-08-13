# -*- mode: python ; coding: utf-8 -*-
# 建置：pyinstaller CadastralWorkbench.spec
# 產出單一免安裝執行檔 dist/CadastralWorkbench.exe（內嵌 index.html/css/js/python/workers）

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('index.html', '.'),
        ('css', 'css'),
        ('js', 'js'),
        ('python', 'python'),
        ('workers', 'workers'),
    ],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='CadastralWorkbench',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
