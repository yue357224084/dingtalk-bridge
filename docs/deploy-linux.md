# 部署：独立 Linux 主机 + systemd（推荐）

> 约定：`<OPENCHAMBER_HOST>` = 运行 OpenChamber 的机器（Windows/Linux 均可）；
> `<BRIDGE_HOST>` = 本桥接服务所在主机；示例 IP 仅为占位。

## 0. 前置条件

| 项 | 要求 |
|---|---|
| Python | ≥ 3.8（推荐 3.10+），可访问 PyPI（国内可换源） |
| 出网 | `api.dingtalk.com`、`wss-open-connection*.dingtalk.com:443` |
| 入/出向 | 能访问 `<OPENCHAMBER_HOST>:7839`（局域网） |
| OpenChamber | 正在运行；插件已按下文安装并配置好 `DD_BIND` / `DD_ASK_TOKEN` |

## 1. OpenChamber 侧（插件）准备

1. 把 `plugin/dingtalk.ts`、`plugin/dingtalk-bridge.ts` 复制到 OpenChamber 主机的插件目录：

   ```
   Linux/macOS : ~/.config/opencode/plugins/
   Windows     : C:\Users\<用户>\.config\opencode\plugins\
   ```

2. 在该目录按 `plugin/.env.example` 建 `.env`，**跨主机部署需设置**：

   ```
   DD_BIND=0.0.0.0
   DD_BRIDGE_PORT=7839
   DD_ASK_TOKEN=<同一串随机 32 位 hex，与桥接 config.env 一致>
   ```

3. 放行防火墙：允许局域网访问 7839（Windows 首次监听会弹窗，选择"允许"并勾选专用网络）。
4. 验证（在桥接主机上执行）：

   ```
   curl http://<OPENCHAMBER_HOST>:7839/health
   # {"ok":true,"plugin":"dingtalk-bridge",...}
   ```

   > 注意：插件文件或 `.env` 变更后需要 OpenCode 重载插件；若监听地址/端口未生效，
   > 编辑 `plugin/dingtalk-bridge.ts` 顶部的 `BRIDGE_VERSION`（如 `2026-09-30c` → `-d`）触发热切换。

## 2. 桥接主机：安装依赖

```bash
sudo mkdir -p /opt/dingtalk-bridge
sudo apt-get install -y python3-venv          # 如已具备可跳过
cd /opt/dingtalk-bridge
python3 -m venv venv
venv/bin/pip install -U pip
venv/bin/pip install -r requirements.txt       # 或: venv/bin/pip install dingtalk-stream requests
# 国内网络可加: -i https://pypi.tuna.tsinghua.edu.cn/simple
```

## 3. 放置文件与配置

把仓库中的 `bridge/bridge.py`、`deploy/dingtalk-bridge.service` 上传到 `/opt/dingtalk-bridge/`：

```bash
scp -P <ssh端口> bridge/bridge.py deploy/dingtalk-bridge.service user@<BRIDGE_HOST>:/opt/dingtalk-bridge/
```

创建配置（**不要提交到任何版本库**）：

```bash
cd /opt/dingtalk-bridge
cp /path/to/bridge/config.env.example config.env
vi config.env
```

关键项：

- `DD_APP_CLIENT_ID` / `DD_APP_CLIENT_SECRET`：企业内部应用凭证
- `DD_BRIDGE_ASK_URL` / `DD_BRIDGE_NEW_URL`：`http://<OPENCHAMBER_HOST>:7839/...`
- `DD_ASK_TOKEN`：与插件 `.env` 完全一致
- `DD_SESSION_DIR`：**OpenChamber 主机上的路径**（新建会话归属目录，例如 `D:\yu_work`）

## 4. systemd 服务

`deploy/dingtalk-bridge.service` 默认路径即 `/opt/dingtalk-bridge`：

```bash
sudo cp /opt/dingtalk-bridge/dingtalk-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dingtalk-bridge
systemctl status dingtalk-bridge --no-pager
tail -n 20 /opt/dingtalk-bridge/bridge.log
```

期望日志：

```
bridge start client_id=xxxxx...xxxx pid=...
subscribed topic=/v1.0/im/bot/messages/get, connecting stream ...
endpoint is {'endpoint': 'wss://wss-open-connection-union.dingtalk.com:443/connect', ...}
```

### 更新（推荐用脚本）

在仓库根目录执行（上传新代码 → 备份 → 重启 → 校验；**不会**覆盖 `config.env` / `state.json`）：

```bash
./deploy/update-linux.sh -H root@<BRIDGE_HOST> [-P 22] [-d /opt/dingtalk-bridge] [-s dingtalk-bridge]
```

手动方式：替换 `bridge.py` 后 `sudo systemctl restart dingtalk-bridge`；出错可用脚本提示的回滚命令（`bridge.py.bak.<时间戳>`）。

## 5. 验收

1. 在已加入机器人的群里 **@机器人 你好**
2. 群内几秒～几十秒收到回复（标题「OpenCode 答复」）
3. OpenChamber 对应项目中出现新会话（标题 `钉钉·<群名>`），后续消息进同一会话
4. 桥接侧日志：`MSG ... → NEW session ... → ASK ok=... → REPLY ok=True`
5. 会话映射持久化在 `/opt/dingtalk-bridge/state.json`

## 6. 卸载 / 回滚

```bash
sudo systemctl disable --now dingtalk-bridge
sudo rm /etc/systemd/system/dingtalk-bridge.service
sudo systemctl daemon-reload
```

## 附：网络与安全清单

- 出网白名单：`api.dingtalk.com:443`、`wss-open-connection.dingtalk.com:443`、`wss-open-connection-union.dingtalk.com:443`
- 桥接 → OpenChamber：`<OPENCHAMBER_HOST>:7839`（建议仅限内网网段）
- 插件接口带 `x-dd-token` 令牌校验；`/health` 免令牌
- 日志含群/用户标识，注意访问控制与轮转
