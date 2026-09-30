#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""钉钉 × OpenChamber 桥接（B 通道 v1：会话映射 + 占位符还原 + 单实例锁）

链路：钉钉 @机器人 → Stream → 本机桥接 → 本地 /ask 接口（OpenCode 插件）→ 回复回群（sessionWebhook）

- 会话映射：每个钉钉会话（群/单聊）→ 一个独立 OpenCode 会话，映射持久化在 state.json
- 快速 ACK：AsyncChatbotHandler 先 ack，再在线程池处理
- 单实例锁：127.0.0.1:7838（DD_LOCK_PORT），防重复实例抢消息

配置：同目录 config.env；日志：同目录 bridge.log
用法：python -u bridge.py（日常由 start-bridge.cmd / 任务计划托管）
"""
import json
import logging
import os
import socket
import sys
import time
import traceback
from pathlib import Path

import requests

from dingtalk_stream import (
    AckMessage,
    AsyncChatbotHandler,
    ChatbotMessage,
    Credential,
    DingTalkStreamClient,
)

BASE = Path(__file__).resolve().parent
LOG_PATH = BASE / "bridge.log"
STATE_PATH = BASE / "state.json"
_lock_socket = None  # 单实例锁（进程存活期间持有）


def load_env() -> None:
    p = BASE / "config.env"
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if s.startswith("export "):
            s = s[7:]
        i = s.find("=")
        if i <= 0:
            continue
        k, v = s[:i].strip(), s[i + 1:].strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        os.environ.setdefault(k, v)


def setup_logging() -> None:
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    if not any(isinstance(h, logging.FileHandler) for h in root.handlers):
        fh = logging.FileHandler(LOG_PATH, encoding="utf-8")
        fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
        root.addHandler(fh)
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    root.addHandler(sh)


log = logging.getLogger("bridge")


# ---------- 会话映射 ----------
def load_state() -> dict:
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(state: dict) -> None:
    try:
        STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        log.error("state.json 写入失败: %s", e)


def ask_headers() -> dict:
    t = os.environ.get("DD_ASK_TOKEN", "").strip()
    return {"x-dd-token": t} if t else {}


class BridgeHandler(AsyncChatbotHandler):
    """继承 AsyncChatbotHandler：先 ack，再在线程池执行 process（同步）。"""

    def process(self, callback_message) -> tuple:
        t0 = time.time()
        try:
            data = callback_message.data
            msg = ChatbotMessage.from_dict(data)
            text = ""
            try:
                lst = msg.get_text_list()
                text = "".join(lst or [])
            except Exception:
                text = (msg.text.content if msg.text else "") or ""
            log.info(
                "MSG type=%s conv=%s(%s) from=%s(@%s) robot=%s inAtList=%s text=%r webhook=%s",
                msg.message_type,
                msg.conversation_title,
                msg.conversation_id,
                msg.sender_nick,
                msg.sender_staff_id,
                msg.robot_code,
                msg.is_in_at_list,
                text[:200],
                "yes" if msg.session_webhook else "no",
            )
            if os.environ.get("DD_LOG_RAW") == "1":
                log.info("RAW %s", json.dumps(data, ensure_ascii=False))
            if msg.session_webhook:
                title = os.environ.get("DD_REPLY_TITLE", "OpenCode 答复") or "OpenCode 答复"
                question = (text or "").strip()
                if not question:
                    body = "请发送文字内容再试（当前只支持文本问题）。"
                else:
                    sid = self.resolve_session(msg)
                    body = (
                        self.ask_opencode(sid, question)
                        if sid
                        else "⚠️ 无法创建/找到对应会话，请查看本机 bridge.log。"
                    )
                r = self.reply_markdown(title, body, msg)
                log.info("REPLY ok=%s %s", bool(r), json.dumps(r, ensure_ascii=False)[:200] if r else "")
            log.info("DONE %.2fs", time.time() - t0)
        except Exception:
            log.error("process 异常: %s", traceback.format_exc())
        return AckMessage.STATUS_OK, "OK"

    def resolve_session(self, msg) -> str:
        """按钉钉会话取（或新建）对应的 OpenCode 会话。"""
        conv_id = msg.conversation_id or ""
        if not conv_id:
            return ""
        state = load_state()
        m = state.setdefault("map", {})
        sid = m.get(conv_id)
        if sid:
            return sid
        if msg.conversation_type == "2":
            title = "钉钉·" + (msg.conversation_title or conv_id[:12])
        else:
            title = "钉钉单聊·" + (msg.sender_nick or msg.sender_staff_id or "未知")
        url = os.environ.get("DD_BRIDGE_NEW_URL", "http://127.0.0.1:7837/newsession").strip()
        directory = os.environ.get("DD_SESSION_DIR", r"D:\yu_work")
        try:
            r = requests.post(url, json={"title": title, "directory": directory}, timeout=30, headers=ask_headers())
            data = r.json()
        except Exception as e:
            log.error("建会话请求异常: %s", e)
            return ""
        sid = (data.get("sessionID") or "").strip()
        log.info("NEW session conv=%s title=%s sid=%s ok=%s", conv_id, title, sid or "-", data.get("ok"))
        if sid:
            m[conv_id] = sid
            save_state(state)
        return sid

    def ask_opencode(self, session_id: str, text: str) -> str:
        """把消息送进本机 OpenCode 会话（插件 /ask 接口），返回助手回复文本。"""
        url = os.environ.get("DD_BRIDGE_ASK_URL", "http://127.0.0.1:7837/ask").strip()
        timeout = int(os.environ.get("DD_ASK_TIMEOUT", "120") or "120")
        max_chars = int(os.environ.get("DD_REPLY_MAX_CHARS", "15000") or "15000")
        t0 = time.time()
        try:
            r = requests.post(
                url,
                json={"sessionID": session_id, "text": text, "timeoutSec": timeout},
                timeout=timeout + 20,
                headers=ask_headers(),
            )
            data = r.json()
        except Exception as e:
            log.error("ask 请求异常: %s", e)
            return f"⚠️ 调用本机 OpenCode 失败：{e}"
        log.info(
            "ASK ok=%s detail=%s ms=%s wall=%.1fs",
            data.get("ok"),
            data.get("detail"),
            data.get("ms"),
            time.time() - t0,
        )
        if not data.get("ok"):
            return f"⚠️ OpenCode 处理失败：{data.get('detail') or data}"
        reply = (data.get("reply") or "").strip()
        if not reply:
            return "⚠️ OpenCode 返回空回复"
        if len(reply) > max_chars:
            reply = reply[:max_chars] + "\n\n> （内容过长，已截断）"
        return reply


def acquire_lock() -> bool:
    """单实例锁：绑定本地端口，进程退出自动释放。"""
    global _lock_socket
    port = int(os.environ.get("DD_LOCK_PORT", "7838") or "7838")
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
        s.listen(1)
    except OSError:
        return False
    _lock_socket = s
    return True


def main() -> None:
    load_env()
    setup_logging()
    cid = os.environ.get("DD_APP_CLIENT_ID", "").strip()
    sec = os.environ.get("DD_APP_CLIENT_SECRET", "").strip()
    if not cid or not sec:
        log.error("缺少 DD_APP_CLIENT_ID / DD_APP_CLIENT_SECRET（config.env）")
        sys.exit(1)
    if not acquire_lock():
        log.error("已有实例在运行（单实例锁被占用），本进程退出")
        sys.exit(0)
    log.info("bridge start client_id=%s...%s pid=%s", cid[:6], cid[-4:], os.getpid())
    credential = Credential(cid, sec)
    client = DingTalkStreamClient(credential)
    client.register_callback_handler(ChatbotMessage.TOPIC, BridgeHandler())
    log.info("subscribed topic=%s, connecting stream ...", ChatbotMessage.TOPIC)
    client.start_forever()


if __name__ == "__main__":
    main()
