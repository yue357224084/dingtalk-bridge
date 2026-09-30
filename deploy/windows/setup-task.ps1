# 同机模式：注册/更新“钉钉桥接”登录自启任务（含崩溃自动重启兜底）
# 用法: powershell -ExecutionPolicy Bypass -File deploy\windows\setup-task.ps1
# 卸载: Unregister-ScheduledTask -TaskName "dingtalk-bridge" -Confirm:$false
$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # 仓库根目录
$vbs  = Join-Path $repo "deploy\windows\start-bridge.vbs"
$wd   = Join-Path $repo "bridge"

$action = New-ScheduledTaskAction -Execute "wscript.exe" `
    -Argument "`"$vbs`"" -WorkingDirectory $wd

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Days 3650)

Register-ScheduledTask -TaskName "dingtalk-bridge" -Action $action -Trigger $trigger `
    -Settings $settings -Description "钉钉<->OpenChamber 桥接（Stream 常驻）" -Force | Out-Null

Start-ScheduledTask -TaskName "dingtalk-bridge"
Write-Output "task registered & started"
