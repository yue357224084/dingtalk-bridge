// dingtalk-bridge.ts — OpenCode V2 本地插件（B 通道 PoC：本地 /ask 桥接接口）
// 用途：本机桥接进程（钉钉 Stream 客户端）调用本接口：把一条消息送进指定 OpenCode 会话，等待并取回最终回复。
// 端点：
//   GET  /health                        → {ok, plugin, pid, ts}
//   POST /ask {sessionID,text,timeoutSec?} → {ok, reply, detail, ms}
// 说明：HTTP 服务每进程只启动一次（globalThis 守卫）；插件文件改动只触发模块重载，不影响已启动实例。
// 配置：同目录 .env —— DD_BRIDGE_PORT（默认 7837）
// 日志：同目录 .dingtalk-bridge.log
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// ---------- .env（与 dingtalk.ts 同款） ----------
function loadDotEnv(): void {
  let txt = ""
  try {
    txt = readFileSync(join(dirname(fileURLToPath(import.meta.url)), ".env"), "utf8")
  } catch {
    return
  }
  for (const line of txt.split(/\r?\n/)) {
    let s = line.trim()
    if (!s || s.startsWith("#")) continue
    if (s.startsWith("export ")) s = s.slice(7)
    const i = s.indexOf("=")
    if (i <= 0) continue
    let v = s.slice(i + 1).trim()
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1)
    process.env[s.slice(0, i).trim()] = v
  }
}

function flog(msg: string): void {
  try {
    appendFileSync(
      join(dirname(fileURLToPath(import.meta.url)), ".dingtalk-bridge.log"),
      `${new Date().toISOString()} ${msg}\n`,
    )
  } catch {
    /* 忽略 */
  }
}
loadDotEnv()
flog("module loaded")

// ---------- 消息读取（复用 dingtalk.ts 已验证的投影处理） ----------
function kindOf(entry: any): string | undefined {
  return entry?.type ?? entry?.role ?? entry?.info?.type ?? entry?.info?.role ?? entry?.message?.role
}

function isTextPart(p: any): boolean {
  return (
    !!p &&
    typeof p === "object" &&
    p.type === "text" &&
    typeof p.text === "string" &&
    p.synthetic !== true &&
    p.ignored !== true
  )
}

function extractTextFromEntry(entry: any): string {
  if (typeof entry === "string") return entry.trim()
  if (!entry || typeof entry !== "object") return ""
  const arrays = [
    entry.content,
    entry.parts,
    entry.info?.content,
    entry.info?.parts,
    entry.message?.content,
    entry.message?.parts,
  ]
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue
    const t = arr
      .filter(isTextPart)
      .map((p: any) => p.text)
      .join("\n\n")
      .trim()
    if (t) return t
  }
  if (
    typeof entry.text === "string" &&
    entry.synthetic !== true &&
    entry.ignored !== true &&
    !Array.isArray(entry.content) &&
    !Array.isArray(entry.parts)
  ) {
    return entry.text.trim()
  }
  for (const sub of [entry.info, entry.message]) {
    if (sub && sub !== entry && typeof sub === "object") {
      const t = extractTextFromEntry(sub)
      if (t) return t
    }
  }
  return ""
}

function readContext(ctx: any, sessionID: string): Promise<any[]> {
  return ctx.session.context({ sessionID }).then((r: any) => {
    if (Array.isArray(r)) return r
    if (Array.isArray(r?.data)) return r.data
    return []
  })
}

function lastAssistantIdx(items: any[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (kindOf(items[i]) === "assistant" && extractTextFromEntry(items[i])) return i
  }
  return -1
}

function lastIdleIdx(items: any[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (kindOf(items[i]) === "idle") return i
  }
  return -1
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------- 占位符还原（复用 dingtalk.ts 的映射文件逻辑） ----------
const PLACEHOLDER_ANY = /\[(?:SECRET|IDCARD|PHONE|BANKCARD|EMAIL|IPV4)_\d+\]/g
const PLACEHOLDER_ONE = /^\[[A-Z][A-Z0-9]*_\d+\]$/

function tokenLookup(): Map<string, string> {
  const dir = process.env.SF_MAP_DIR || tmpdir()
  const tok2val = new Map<string, string>()
  try {
    const files = readdirSync(dir)
      .filter((n) => n.startsWith("sensitive_filter_map_") && n.endsWith(".json"))
      .map((n) => ({ n, m: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
    for (const f of files) {
      try {
        const tokens = JSON.parse(readFileSync(join(dir, f.n), "utf8"))?.tokens
        if (!tokens || typeof tokens !== "object") continue
        for (const [k, v] of Object.entries(tokens)) {
          if (typeof k === "string" && typeof v === "string" && PLACEHOLDER_ONE.test(k) && !tok2val.has(k)) {
            tok2val.set(k, v)
          }
        }
      } catch {
        /* 坏文件跳过 */
      }
    }
  } catch {
    /* 目录不可读 */
  }
  return tok2val
}

function rehydrate(text: string): { text: string; before: number; after: number } {
  const before = (text.match(PLACEHOLDER_ANY) || []).length
  if (!before) return { text, before: 0, after: 0 }
  const map = tokenLookup()
  if (!map.size) return { text, before, after: 0 }
  let after = 0
  const out = text.replace(PLACEHOLDER_ANY, (t) => {
    const v = map.get(t)
    if (v === undefined) return t
    after++
    return v
  })
  return { text: out, before, after }
}

// ---------- /ask 核心 ----------
let busy = false

async function askSession(
  ctx: any,
  sessionID: string,
  text: string,
  timeoutSec: number,
): Promise<{ ok: boolean; reply: string; detail: string; ms: number }> {
  const t0 = Date.now()
  const deadline = t0 + Math.max(5, Math.min(300, timeoutSec)) * 1000
  const baseItems = await readContext(ctx, sessionID)
  const bA = lastAssistantIdx(baseItems)
  const bId = bA >= 0 ? String(baseItems[bA]?.id ?? "") : ""
  flog(`/ask start session=${sessionID} chars=${text.length} baseItems=${baseItems.length} baseAssistantId=${bId || "-"}`)

  try {
    const pr = await ctx.session.prompt({ sessionID, text })
    flog(`/ask prompt ok r=${pr === undefined ? "undefined" : JSON.stringify(pr)?.slice(0, 160)}`)
  } catch (e: any) {
    flog(`/ask prompt 异常 ${e?.stack ?? e}`)
    return { ok: false, reply: "", detail: `prompt 失败：${e?.message ?? String(e)}`, ms: Date.now() - t0 }
  }

  let lastText = ""
  for (;;) {
    if (Date.now() > deadline) {
      return {
        ok: false,
        reply: lastText,
        detail: lastText ? "timeout（已见新回复但回合未结束）" : "timeout",
        ms: Date.now() - t0,
      }
    }
    await sleep(1500)
    let items: any[]
    try {
      items = await readContext(ctx, sessionID)
    } catch (e: any) {
      flog(`/ask read 异常 ${e?.message ?? e}`)
      continue
    }
    const aIdx = lastAssistantIdx(items)
    if (aIdx < 0) continue
    const aId = String(items[aIdx]?.id ?? "")
    const isNew = aId && bId ? aId !== bId : items.length > baseItems.length
    if (!isNew) continue
    const t = extractTextFromEntry(items[aIdx])
    if (!t) continue
    lastText = t
    const iIdx = lastIdleIdx(items)
    if (iIdx > aIdx) {
      let out = t
      let phInfo = ""
      if (process.env.DD_REHYDRATE !== "0") {
        const rh = rehydrate(out)
        out = rh.text
        if (rh.before > 0) phInfo = ` placeholders=${rh.before}/${rh.after}`
      }
      flog(`/ask done session=${sessionID} chars=${t.length} ms=${Date.now() - t0}${phInfo}`)
      return { ok: true, reply: out, detail: "ok", ms: Date.now() - t0 }
    }
  }
}

// ---------- HTTP 服务 ----------
function startServer(ctx: any, cfg: { bind: string; port: number; token: string }) {
  const port = cfg.port
  const srv = createServer((req, res) => {
    const send = (code: number, obj: any) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" })
      res.end(JSON.stringify(obj))
    }
    const path = (req.url || "").split("?")[0]
    if (req.method === "GET" && path === "/health") {
      send(200, { ok: true, plugin: "dingtalk-bridge", pid: process.pid, ts: Date.now() })
      return
    }
    if (cfg.token && req.headers["x-dd-token"] !== cfg.token) {
      send(401, { ok: false, detail: "unauthorized" })
      return
    }
    if (req.method === "POST" && path === "/ask") {
      let raw = ""
      let over = false
      req.on("data", (c) => {
        raw += c
        if (raw.length > 512 * 1024) {
          over = true
          req.destroy()
        }
      })
      req.on("end", () => {
        if (over) {
          send(413, { ok: false, detail: "body too large" })
          return
        }
        void (async () => {
          let payload: any
          try {
            payload = JSON.parse(raw || "{}")
          } catch {
            send(400, { ok: false, detail: "bad json" })
            return
          }
          const sessionID = String(payload?.sessionID || "").trim()
          const text = String(payload?.text || "")
          const timeoutSec = Number(payload?.timeoutSec || 120)
          if (!sessionID || !text) {
            send(400, { ok: false, detail: "缺少 sessionID 或 text" })
            return
          }
          if (busy) {
            send(409, { ok: false, detail: "busy（已有请求处理中）" })
            return
          }
          busy = true
          try {
            flog(`/ask http session=${sessionID} chars=${text.length} timeout=${timeoutSec}s`)
            const r = await askSession(ctx, sessionID, text, timeoutSec)
            send(200, r)
          } catch (e: any) {
            flog(`/ask http 异常 ${e?.stack ?? e}`)
            send(500, { ok: false, detail: `异常：${e?.message ?? String(e)}` })
          } finally {
            busy = false
          }
        })()
      })
      req.on("error", () => {
        /* 忽略 */
      })
      return
    }
    if (req.method === "POST" && path === "/newsession") {
      let raw = ""
      req.on("data", (c) => {
        raw += c
      })
      req.on("end", () => {
        void (async () => {
          let payload: any = {}
          try {
            payload = JSON.parse(raw || "{}")
          } catch {
            /* ignore */
          }
          const title = String(payload?.title || "钉钉会话").trim() || "钉钉会话"
          const directory = String(payload?.directory || "").trim()
          const norm = (p: any) => String(p ?? "").replace(/[\\/]+$/, "").toLowerCase()
          const attempts: Array<Record<string, any>> = []
          const tries: Array<Record<string, any>> = directory
            ? [{ title, location: { directory } }, { title, location: { type: "directory", directory } }, { title }]
            : [{ title }]
          for (const arg of tries) {
            try {
              const created: any = await ctx.session.create(arg)
              const sid: string =
                created?.id ?? created?.sessionID ?? created?.session?.id ?? created?.info?.id ?? ""
              const projectID = String(created?.projectID ?? "")
              const locOut = JSON.stringify(created?.location ?? null)
              const keys =
                created && typeof created === "object"
                  ? Object.keys(created).slice(0, 20).join(",")
                  : String(created)
              const locOk = !directory || norm(created?.location?.directory) === norm(directory)
              flog(
                `/newsession attempt arg=${JSON.stringify(arg)} sid=${sid || "-"} project=${projectID || "-"} location=${locOut} ok=${locOk}`,
              )
              if (!locOk) {
                attempts.push({ arg, err: `location mismatch: ${locOut}` })
                continue
              }
              res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
              res.end(
                JSON.stringify({ ok: true, sessionID: sid, projectID, location: created?.location ?? null, shape: keys }),
              )
              return
            } catch (e: any) {
              attempts.push({ arg, err: String(e?.message ?? e) })
              flog(`/newsession fail arg=${JSON.stringify(arg)} err=${e?.message ?? e}`)
            }
          }
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" })
          res.end(JSON.stringify({ ok: false, attempts }))
        })()
      })
      req.on("error", () => {
        /* 忽略 */
      })
      return
    }
    if (req.method === "POST" && path === "/sessioninfo") {
      let raw = ""
      req.on("data", (c) => {
        raw += c
      })
      req.on("end", () => {
        void (async () => {
          let payload: any = {}
          try {
            payload = JSON.parse(raw || "{}")
          } catch {
            /* ignore */
          }
          const sessionID = String(payload?.sessionID || "").trim()
          try {
            const info: any = await ctx.session.get({ sessionID })
            const out = {
              ok: true,
              sessionID,
              projectID: String(info?.projectID ?? ""),
              location: info?.location ?? null,
              title: info?.title ?? null,
            }
            flog(`/sessioninfo ${JSON.stringify(out)}`)
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
            res.end(JSON.stringify(out))
          } catch (e: any) {
            flog(`/sessioninfo fail ${e?.message ?? e}`)
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" })
            res.end(JSON.stringify({ ok: false, detail: String(e?.message ?? e) }))
          }
        })()
      })
      req.on("error", () => {
        /* 忽略 */
      })
      return
    }
    send(404, { ok: false, detail: "not found" })
  })
  srv.on("error", (e: any) => flog(`server error: ${e?.message ?? e}`))
  srv.listen(port, cfg.bind, () => {
    console.log(`[dingtalk-bridge] listening on http://${cfg.bind}:${port} pid=${process.pid}`)
    flog(`bridge listening on http://${cfg.bind}:${port} pid=${process.pid}`)
  })
  return srv
}

// ---------- 注册 ----------
const BRIDGE_VERSION = "2026-09-30c" // 代码/配置变更时递增（支持热切换）

function bridgeConfig(): { bind: string; port: number; token: string } {
  return {
    bind: (process.env.DD_BIND || "127.0.0.1").trim() || "127.0.0.1",
    port: parseInt(process.env.DD_BRIDGE_PORT || "7839", 10) || 7839,
    token: (process.env.DD_ASK_TOKEN || "").trim(),
  }
}

function setupBridge(ctx: any): void {
  const g = globalThis as any
  const cfg = bridgeConfig()
  const conf = `${cfg.bind}:${cfg.port}:${cfg.token ? "t" : "-"}`
  if (g.__ddBridge && g.__ddBridge.version === BRIDGE_VERSION && g.__ddBridge.conf === conf) {
    flog("setup: 版本与配置未变，跳过")
    return
  }
  if (g.__ddBridge?.server) {
    try {
      g.__ddBridge.server.close()
      flog("setup: 旧实例已关闭（热切换）")
    } catch {
      /* ignore */
    }
  }
  try {
    const srv = startServer(ctx, cfg)
    g.__ddBridge = { version: BRIDGE_VERSION, conf, server: srv }
    flog(`setup: 已启动 version=${BRIDGE_VERSION} conf=${conf}`)
  } catch (e: any) {
    flog(`startServer 异常 ${e?.stack ?? e}`)
  }
}

export default {
  id: "dingtalk-bridge",
  setup: setupBridge,
  server: async () => ({}),
}
