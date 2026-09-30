# 排障手册

> 症状 → 原因 → 处理。日志位置：
> 插件：`~/.config/opencode/plugins/.dingtalk-bridge.log`、`.dingtalk.log`
> 桥接：`bridge/bridge.log`（Linux 默认 `/opt/dingtalk-bridge/bridge.log`）

## 1. 群里 @机器人 完全没反应

- 机器人是否已加入该群，且群是**应用同组织的内部群**
- 应用「机器人」能力的**消息接收模式**是否为 **Stream 模式**，且**已发布**
- 桥接服务是否在跑：`systemctl status dingtalk-bridge` / `bridge.log` 有无 `MSG` 记录
- 群里必须 **@机器人** 才会推送（平台限制）；单聊不受限
- 若日志无 `MSG`：检查 Stream 连接是否建立（`endpoint is wss://...`）；掉线会自动重连

## 2. 收到消息但回复是 `⚠️ 调用本机 OpenCode 失败`

- 桥接主机 → OpenChamber 主机 `:7839` 不通：`curl http://<OPENCHAMBER_HOST>:7839/health`
- OpenChamber 未运行（`/ask` 由它提供）
- 令牌不一致：桥接 `DD_ASK_TOKEN` ≠ 插件 `.env` 的 `DD_ASK_TOKEN`（表现为 `401 unauthorized`）
- 插件绑定地址为 `127.0.0.1`（跨主机时需改为 `0.0.0.0` 或局域网 IP，并放行防火墙）
- 改了插件配置后未生效：编辑 `plugin/dingtalk-bridge.ts` 顶部 `BRIDGE_VERSION` 触发热切换，或重启 OpenChamber

## 3. 会话创建了，但 OpenChamber 界面里看不到

**根因**：OpenCode V2 的建会话接口没有 `directory` 字段，必须传：

```json
{ "title": "钉钉·某群", "location": { "directory": "D:\\yu_work" } }
```

传错字段时会话会落在**插件进程的默认位置**（界面里看不到）。可在插件日志确认：

```
/newsession attempt arg=... project=<期望的 40 位 projectID> location={"directory":"..."} ok=true
```

## 4. `401 authFailed`（启动时 open connection failed）

- `DD_APP_CLIENT_ID` / `DD_APP_CLIENT_SECRET` 错误或已被重置（开发者后台重新生成后需同步更新）

## 5. 消息时有时无 / 丢消息

- 同一钉钉应用存在**多个 Stream 连接**（例如旧进程未退出、又起了一个）——钉钉按**随机策略**向多个连接分发消息
- 处理：确保单实例。本桥接内置单实例锁（`DD_LOCK_PORT`，默认 7838）并在启动时拒绝重复实例；同时检查是否有旧的 `python bridge.py` 进程
- 该应用不要同时被其它机器人框架（如 OpenClaw 等）使用

## 6. 每个问题都是"新会话"、没有上下文

- `state.json` 丢失或不可写（无权限/被清理）；确认工作目录可写
- 权限或路径变更导致 `conversationId` 变化（换群/重建群会得到新的 conversationId）

## 7. `/dd` 发送失败：`errcode 310000 ip 不在白名单中`

- 自定义机器人安全设置是「IP 地址（段）」白名单：把发送出口 IP 加入白名单
- 出口 IP 会漂移（多 WAN/重播）→ 补新 IP，或改用「加签」方式的新机器人
- **不要**把正在服务其它生产告警的机器人安全模式改成「加签/关键词」，会影响既有链路

## 8. 长任务回复超时 / 回复中断

- `sessionWebhook` 是临时凭证（约 90 分钟），且**每条消息**都会带新的；本项目"收到即回"
- 处理超长任务：调大 `DD_ASK_TIMEOUT`；或让提问方拆小问题
- 回复超长被截断：调大 `DD_REPLY_MAX_CHARS`（注意钉钉 markdown 消息长度上限）

## 9. 插件改动不生效

- OpenCode 插件目录的文件变更会自动重载；但**已运行中的 HTTP 服务**受 `BRIDGE_VERSION` 守卫控制
- 改动监听地址/端口/令牌后：递增 `BRIDGE_VERSION`（如 `2026-09-30c` → `-d`），日志出现
  `setup: 旧实例已关闭（热切换）` 与 `已启动 version=... conf=...` 即生效
- 端口被旧实例占用（`server error: EADDRINUSE`）：换 `DD_BRIDGE_PORT`，或在方便时重启 OpenChamber

## 10. 额度与频率

- 标准版组织级共享：API 1 万次/月 + Webhook&Stream 5000 次/月
- 避免使用：主动推送（`robot/groupMessages/send` 等）、**互动卡片流式更新**（额度消耗大户）
- 自定义群机器人：20 条/分钟限流
- 以开发者后台「资源管理」实际用量为准

## 11. 安全提醒

- `config.env` / 插件 `.env` / `*.log` / `state.json` 均含敏感信息，**不要提交到版本库或外发**
- 插件接口跨主机暴露时务必设置 `DD_ASK_TOKEN`，并限制来源网段
