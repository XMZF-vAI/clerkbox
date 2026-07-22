#Requires AutoHotkey v2.0
#SingleInstance Force

; ============================================================
; TRAE 自动点“继续”脚本
; 用途：当 TRAE 因 429 / "和Kimi聊天的人太多啦" 停住时，自动点击“继续”按钮
; 或在输入框发送“继续”。
; ============================================================

; ---------- 配置 ----------
global INTERVAL_MS := 2000       ; 检测间隔
global DEBOUNCE_MS := 5000       ; 点击后继续按钮后，多久内不再重复点击
global CONTINUE_IMAGE := A_ScriptDir "\continue.png"
global ERROR_IMAGE := A_ScriptDir "\error_429.png"

; ---------- 状态 ----------
global running := false
global lastClickTime := 0

; ---------- 托盘与热键 ----------
TraySetIcon("shell32.dll", 14)
A_TrayMenu.Delete()
A_TrayMenu.Add("开始监控 (F9)", Toggle)
A_TrayMenu.Add("退出", ExitApp)
A_TrayMenu.Default := "开始监控 (F9)"

Hotkey("F9", Toggle)

ShowTip("TRAE 自动继续脚本已启动`n按 F9 开始/停止监控")

; ============================================================
Toggle(*) {
    global running := !running
    if (running) {
        A_TrayMenu.Rename("开始监控 (F9)", "停止监控 (F9)")
        ShowTip("已开始监控 TRAE")
        SetTimer(CheckLoop, INTERVAL_MS)
    } else {
        A_TrayMenu.Rename("停止监控 (F9)", "开始监控 (F9)")
        ShowTip("已停止监控")
        SetTimer(CheckLoop, 0)
    }
}

CheckLoop() {
    global lastClickTime

    ; 只在 TRAE 窗口存在时操作
    if (!WinExist("ahk_exe trae.exe") && !WinExist("ahk_class Chrome_WidgetWin_1")) {
        ShowTip("未找到 TRAE 窗口，继续等待...")
        return
    }

    ; 获取 TRAE 窗口位置
    hwnd := WinExist("ahk_exe trae.exe") ? WinExist("ahk_exe trae.exe") : WinExist("ahk_class Chrome_WidgetWin_1")
    if (!hwnd) {
        return
    }

    WinGetPos(&winX, &winY, &winW, &winH, hwnd)

    ; 防抖
    if (A_TickCount - lastClickTime < DEBOUNCE_MS) {
        return
    }

    ; 1) 优先找“继续”按钮
    if (FileExist(CONTINUE_IMAGE)) {
        if (found := ImageSearch(&x, &y, winX, winY, winX + winW, winY + winH, "*150 " CONTINUE_IMAGE)) {
            ClickAt(x, y, "点击“继续”按钮")
            lastClickTime := A_TickCount
            return
        }
    }

    ; 2) 兜底：检测到 429 / 繁忙提示，就向输入框发“继续”
    if (FileExist(ERROR_IMAGE)) {
        if (ImageSearch(&x, &y, winX, winY, winX + winW, winY + winH, "*150 " ERROR_IMAGE)) {
            SendContinue()
            lastClickTime := A_TickCount
            return
        }
    }

    ShowTip("监控中... 未触发")
}

ClickAt(x, y, actionText) {
    ; 保存原鼠标位置
    MouseGetPos(&oldX, &oldY)

    ; 激活窗口并点击
    WinActivate
    MouseClick("left", x, y, 1, 0)

    ; 恢复鼠标位置
    MouseMove(oldX, oldY, 0)

    ShowTip(actionText " @ " x "," y)
}

SendContinue() {
    ; 兜底方案：向当前窗口发送 Ctrl+End 回到底部，再输入“继续”并回车
    WinActivate
    Send("^{End}")
    Sleep(200)
    Send("{Text}继续")
    Sleep(200)
    Send("{Enter}")

    ShowTip("未找到按钮，已发送“继续”消息")
}

ShowTip(msg) {
    ToolTip(msg)
    SetTimer () => ToolTip(), -3000
}

ExitApp(*) {
    ExitApp()
}
