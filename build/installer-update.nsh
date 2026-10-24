# ClerkBox NSIS 自定义脚本：仅自动更新（--updated）路径生效。
# 首次安装保持 electron-builder 默认向导（安装模式 + 安装目录 + 完成页）。

# 更新时沿用注册表里检测到的既有安装模式，跳过「为谁安装」选择页。
!macro customInstallMode
  ${if} ${isUpdated}
    ${if} $hasPerMachineInstallation == "1"
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endif}
  ${endif}
!macroend

# 更新装完直接拉起新版本并退出安装器，跳过完成页。
# 这里不用 StartApp 宏：它会重复声明 $startAppArgs 全局变量，导致 NSIS 编译失败。
!macro customInstall
  ${if} ${isUpdated}
    HideWindow
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
    Quit
  ${endif}
!macroend
