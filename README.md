# dingtalk-bridge — 钉钉 ↔ OpenChamber / OpenCode 双向桥

把钉钉和本机的 [OpenChamber](https://openchamber.dev)（OpenCode 的桌面 GUI）接起来：

- **群内 @机器人 → 本机 OpenCode 作答 → 回复到群**（钉钉 Stream 模式，无需公网 IP）
- **会话总结 → 钉钉群**：在 OpenChamber 会话里输入 `/dd`，把当前会话最后一条回复（markdown）发到群

> OpenCode/OpenChamber plugin + a lightweight Stream bridge that connects DingTalk groups to your local coding agent. No public IP required.

## 架构

```
钉钉群 @机器人
   │  Stream（出站长连接，无需公网 IP）
   ▼
桥接服务 bridge/bridge.py（任意可常驻主机，Python ≥3.8）
   │  ① 3 秒内 ACK（先应答，再异步处理）
   │  ② 按钉钉会话映射到独立 OpenCode 会话（state.json 持久化）
   │  ③ 带令牌的 HTTP → OpenChamber 主机
   ▼
OpenChamber 插件接口 plugin/dingtalk-bridge.ts
   │  POST /ask        把消息送进指定会话并等待回复
   │  POST /newsession 新建 OpenCode 会话（指定归属目录）
   │  POST /sessioninfo 查询会话信息
   ▼
OpenCode 会话（在 OpenChamber 界面可见、可接管）
   │
   ▼
sessionWebhook 回复钉钉群（markdown，自动 @提问者）
```

另含一个独立小功能：**会话总结发送**（`plugin/dingtalk.ts`，命令 `/dd`）。

## 目录结构

```
dingtalk-bridge/
├── plugin/                      # OpenCode V2 本地插件（放到 ~/.config/opencode/plugins/）
│   ├── dingtalk.ts              # 命令 /dd：会话总结发送到钉钉群
│   ├── dingtalk-bridge.ts       # 桥接接口：/ask、/newsession、/sessioninfo
│   └── .env.example             # 插件配置模板（复制为 .env）
├── bridge/                      # 桥接服务（接钉钉 Stream）
│   ├── bridge.py
│   └── config.env.example       # 桥接配置模板（复制为 config.env）
├── deploy/
│   ├── dingtalk-bridge.service  # Linux systemd 单元
│   ├── update-linux.sh          # 一键更新：上传新代码 → 重启 → 校验（不覆盖配置/映射）
│   └── windows/                 # 同机（Windows）模式：常驻脚本 + 任务计划
├── docs/
│   ├── deploy-linux.md          # 推荐部署方式（独立 Linux 主机 + systemd）
│   ├── deploy-windows-local.md  # 同机部署（Windows 任务计划）
│   └── troubleshooting.md       # 排障手册（含若干踩坑记录）
├── requirements.txt
├── LICENSE
└── .gitignore
```

## 快速开始

### 1. 安装插件（OpenChamber 所在机器）

复制 `plugin/dingtalk.ts`、`plugin/dingtalk-bridge.ts` 到 OpenCode 插件目录：

```
Linux/macOS : ~/.config/opencode/plugins/
Windows     : C:\Users\<用户>\.config\opencode\plugins\
```

按 `plugin/.env.example` 在同目录创建 `.env`（两个插件共用）。改完插件文件/配置后 OpenCode 会自动重载。

### 2. 准备钉钉应用

1. [钉钉开发者后台](https://open-dev.dingtalk.com) → 创建**企业内部应用**
2. 「应用信息」页记录 **Client ID / Client Secret**
3. 「机器人与消息推送」→ 开启**机器人** → **消息接收模式 = Stream 模式** → 保存并**发布**
4. 把机器人添加到一个**组织内部群**（群设置 → 机器人）
   - 群聊中机器人只能收到 **@它** 的消息；单聊消息全收
5. 若要用 `/dd` 的默认通道（企业应用机器人发送）：在应用「权限管理」开通「**企业内机器人发送消息权限**」

### 3. 部署桥接服务

复制 `bridge/config.env.example` → `bridge/config.env` 并填写（应用凭证、OpenChamber 主机地址、令牌等），然后任选一种：

| 方式 | 适用 | 文档 |
|---|---|---|
| **独立 Linux 主机 + systemd**（推荐） | 服务与 OpenChamber 分机部署，长期稳定 | [docs/deploy-linux.md](docs/deploy-linux.md) |
| **与 OpenChamber 同机（Windows）** | 不想引入额外主机 | [docs/deploy-windows-local.md](docs/deploy-windows-local.md) |

> **后续更新**：仓库根目录执行 `./deploy/update-linux.sh -H root@<BRIDGE_HOST> -P <ssh端口>`（自动备份、重启并校验；不覆盖 `config.env` 与 `state.json`）。详见 [docs/deploy-linux.md](docs/deploy-linux.md)。

## 配置项

### 插件 `.env`（`plugin/.env.example`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DD_SEND_MODE` | `robot` | `/dd` 发送通道：`robot`=企业应用机器人（默认）/ `webhook`=自定义群机器人 |
| `DD_APP_CLIENT_ID` / `DD_APP_CLIENT_SECRET` | — | robot 模式：企业应用凭证（与 Stream 桥接同一个应用） |
| `DD_ROBOT_CONVERSATION_ID` | — | robot 模式：目标群 `openConversationId`（形如 `cid…==`） |
| `DD_ROBOT_CODE` | clientId | robot 模式：机器人编码（一般免填） |
| `DD_WEBHOOK_URL` | — | webhook 模式：目标群 webhook |
| `DD_TITLE` | `会话总结` | `/dd` 消息标题 |
| `DD_DRY_RUN` | — | `1` 时只演练不发送 |
| `DD_AT_ALL` | — | webhook 模式 `1` 时 @所有人（robot 模式不支持 @） |
| `DD_MAX_CHARS` | `18000` | `/dd` 正文截断长度 |
| `DD_RECEIPT` | `synthetic` | `/dd` 回执；`off` 关闭 |
| `DD_BIND` | `127.0.0.1` | 桥接接口监听地址；跨主机需 `0.0.0.0` |
| `DD_BRIDGE_PORT` | `7839` | 桥接接口端口 |
| `DD_ASK_TOKEN` | — | 接口访问令牌（请求头 `x-dd-token`），跨主机必设 |
| `DD_REHYDRATE` | 开 | `0` 关闭占位符还原（sensitive-filter 映射） |
| `SF_MAP_DIR` | 系统临时目录 | sensitive-filter 映射文件目录 |

### 桥接 `config.env`（`bridge/config.env.example`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DD_APP_CLIENT_ID` / `DD_APP_CLIENT_SECRET` | — | 企业内部应用凭证 |
| `DD_BRIDGE_ASK_URL` | — | 如 `http://<OpenChamber主机>:7839/ask` |
| `DD_BRIDGE_NEW_URL` | — | 如 `http://<OpenChamber主机>:7839/newsession` |
| `DD_ASK_TOKEN` | — | 与插件一致 |
| `DD_SESSION_DIR` | — | 新建会话的归属目录（**OpenChamber 主机上的路径**） |
| `DD_ASK_TIMEOUT` | `120` | 单次提问等待秒数 |
| `DD_REPLY_TITLE` | `OpenCode 答复` | 群回复标题 |
| `DD_REPLY_MAX_CHARS` | `15000` | 回复截断长度 |
| `DD_LOCK_PORT` | `7838` | 单实例锁端口 |
| `DD_LOG_RAW` | — | `1` 记录原始入站消息 JSON（调试） |

## 使用

- **群里提问**：`@机器人 你的问题` → 稍候收到回复；每个群/单聊自动对应一个独立 OpenCode 会话，上下文连续
- **发总结**：在 OpenChamber 任意会话输入 `/dd` → 该会话最后一条回复以 markdown 发到钉钉群（默认经**企业应用机器人**发送；`.env` 里 `DD_SEND_MODE=webhook` 则改用自定义群机器人）

## 运行要求

- OpenCode V2（插件 API）+ OpenChamber 2.x；桥接 Python ≥3.8
- 桥接主机出网：`api.dingtalk.com`、`wss-open-connection*.dingtalk.com:443`
- 桥接主机 → OpenChamber 主机插件端口（默认 7839）**局域网可达**（注意 Windows 防火墙）
- OpenChamber 需保持运行（`/ask` 由它提供；关闭时群内会收到 ⚠️ 提示）

## 安全

- 凭据只存本机 `config.env` / 插件 `.env`；本仓库只含示例，`.gitignore` 已排除真实配置与日志
- 插件接口默认仅监听 `127.0.0.1`；**跨主机部署务必设置 `DD_ASK_TOKEN`** 并限制来源网络
- 运行日志含群/用户标识与消息内容，注意保密

## 已知限制（钉钉平台侧）

- 群聊中机器人**只能收到 @它**的消息；无法读取群内全部消息
- `sessionWebhook` 是临时凭证（约 90 分钟有效）→ 本项目"收到即回"；失效即放弃该条
- 同一应用同时只应有**一个** Stream 连接：钉钉按随机策略向多个连接分发消息，多开会互相抢消息（本项目含单实例锁）
- 自定义群机器人：20 条/分钟限流 + IP 白名单（`310000` 错误）
- 标准版组织级额度：API 1 万次/月、Webhook&Stream 5000 次/月；本项目**不使用**主动推送与互动卡片流式更新（额度消耗大户）
- 更多见 [docs/troubleshooting.md](docs/troubleshooting.md)

## License

[MIT](LICENSE)（可自行更改）
