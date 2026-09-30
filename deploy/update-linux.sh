#!/usr/bin/env bash
# update-linux.sh — 一键更新远端 Linux 主机上的钉钉桥接服务
#
# 用法（在仓库根目录执行）：
#   ./deploy/update-linux.sh -H <user@host> [-P <ssh端口>] [-d /opt/dingtalk-bridge] [-s dingtalk-bridge]
#
# 行为：
#   1. 打印本地提交号（可追溯）
#   2. 备份远端 bridge.py（bridge.py.bak.<时间戳>）
#   3. 上传 bridge/bridge.py 与 deploy/dingtalk-bridge.service
#   4. 安装/刷新 systemd 单元并重启服务
#   5. 校验服务状态并打印日志尾部；失败时给出回滚命令
#
# 注意：不会覆盖远端的 config.env 与 state.json（配置与会话映射）。
set -euo pipefail

HOST=""; PORT=22; DEST="/opt/dingtalk-bridge"; SERVICE="dingtalk-bridge"
while getopts "H:P:d:s:h" opt; do
  case "$opt" in
    H) HOST="$OPTARG" ;;
    P) PORT="$OPTARG" ;;
    d) DEST="$OPTARG" ;;
    s) SERVICE="$OPTARG" ;;
    h) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "参数错误，-h 查看用法"; exit 2 ;;
  esac
done
[ -n "$HOST" ] || { echo "缺少 -H <user@host>（-h 查看用法）"; exit 2; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/bridge/bridge.py"
UNIT="$ROOT/deploy/dingtalk-bridge.service"
[ -f "$SRC" ] || { echo "找不到 $SRC"; exit 1; }

SSH=(ssh -p "$PORT" -o ConnectTimeout=10 "$HOST")
SCP=(scp -P "$PORT" -o ConnectTimeout=10)

echo "==> 本地提交: $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '(非 git 目录)')"
echo "==> 目标: $HOST:$DEST （服务 $SERVICE, ssh 端口 $PORT）"

STAMP="$(date +%Y%m%d%H%M%S)"
echo "==> 备份远端 bridge.py -> bridge.py.bak.$STAMP"
"${SSH[@]}" "cp -a '$DEST/bridge.py' '$DEST/bridge.py.bak.$STAMP' 2>/dev/null || true"

echo "==> 上传 bridge.py"
"${SCP[@]}" "$SRC" "$HOST:$DEST/bridge.py"

if [ -f "$UNIT" ]; then
  echo "==> 上传 systemd 单元并刷新"
  "${SCP[@]}" "$UNIT" "$HOST:$DEST/dingtalk-bridge.service"
  "${SSH[@]}" "cp '$DEST/dingtalk-bridge.service' /etc/systemd/system/$SERVICE.service && systemctl daemon-reload"
fi

echo "==> 重启服务 $SERVICE"
"${SSH[@]}" "systemctl restart $SERVICE"
sleep 5

if "${SSH[@]}" "systemctl is-active --quiet $SERVICE"; then
  echo "✅ 服务运行中"
  "${SSH[@]}" "tail -n 6 '$DEST/bridge.log' 2>/dev/null || true"
  echo "==> 如需回滚:"
  echo "    ssh -p $PORT $HOST 'cp $DEST/bridge.py.bak.$STAMP $DEST/bridge.py && systemctl restart $SERVICE'"
else
  echo "❌ 服务未启动，最近日志："
  "${SSH[@]}" "journalctl -u $SERVICE -n 20 --no-pager 2>/dev/null || tail -n 20 '$DEST/bridge.log' 2>/dev/null || true"
  exit 1
fi
