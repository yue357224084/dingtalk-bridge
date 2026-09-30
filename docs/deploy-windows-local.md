# 部署：与 OpenChamber 同机（Windows 任务计划）

适用于不想额外引入主机的场景：桥接服务与 OpenChamber 跑在同一台 Windows 机器上。

## 1. 插件

把 `plugin/dingtalk.ts`、`plugin/dingtalk-bridge.ts` 复制到：

```
C:\Users\<用户>\.config\opencode\plugins\
```

按 `plugin/.env.example` 在同目录建 `.env`。同机模式下桥接只从本机访问，可保持最简配置：

```
# 只监听本机（默认）
# DD_BIND=127.0.0.1
# DD_BRIDGE_PORT=7839
# 同机可选：设置令牌更安全
# DD_ASK_TOKEN=<随机 32 位 hex>
```

## 2. 桥接配置

```cmd
cd <仓库>\bridge
copy config.env.example config.env
notepad config.env
```

同机模式下地址用回环：

```
DD_APP_CLIENT_ID=dingxxxxxxxxxxxxxxx
DD_APP_CLIENT_SECRET=<应用密钥>

DD_BRIDGE_ASK_URL=http://127.0.0.1:7839/ask
DD_BRIDGE_NEW_URL=http://127.0.0.1:7839/newsession
DD_ASK_TOKEN=<与插件 .env 一致；插件未设则留空>
DD_SESSION_DIR=D:\yu_work
```

## 3. Python 与依赖

```cmd
python -m pip install -r requirements.txt
:: 或: python -m pip install dingtalk-stream requests
```

## 4. 常驻运行（二选一）

**A. 手动/临时**：双击 `deploy\windows\start-bridge.cmd`（崩溃会自动拉起，窗口可最小化）。

**B. 登录自启 + 崩溃重启（推荐）**：

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\setup-task.ps1
```

脚本会注册任务计划 `dingtalk-bridge`（登录时启动、失败每分钟重启、隐藏窗口），并立即启动。

卸载：

```powershell
Unregister-ScheduledTask -TaskName "dingtalk-bridge" -Confirm:$false
```

## 5. 验证

- 日志：`bridge\bridge.log`（服务日志）、`bridge\bridge.stdout.log`（进程输出）
- 期望：`bridge start ...` → `endpoint is wss://...`
- 群里 `@机器人 你好` 应收到回复；OpenChamber 出现新会话

## 说明

- 同机模式下无需开放防火墙 7839（仅回环访问）
- OpenChamber 关闭时，群内会收到 ⚠️（`/ask` 不可达）
- 若同时存在多台桥接（如本机 + 服务器），**必须只保留一个**：同一钉钉应用多个 Stream 连接会随机分发消息
