' 同机模式：隐藏窗口启动桥接（由任务计划调用，避免常驻控制台窗口）
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
repo = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))
sh.CurrentDirectory = repo & "\deploy\windows"
sh.Run "cmd /c start-bridge.cmd", 0, False
