// dingtalk.ts — OpenCode V2 本地插件（P1：会话总结 → 钉钉群）
// 用法：在任意会话输入 /dd → 把本会话最后一条助手回复以 markdown 发送到钉钉群（自定义机器人 webhook）。
// 配置：同目录 .env
//   DD_WEBHOOK_URL  必填，目标群 webhook
//   DD_TITLE        可选，消息标题（默认「会话总结」）
//   DD_DRY_RUN=1    可选，只演练不发送（联调用）
//   DD_AT_ALL=1     可选，消息 @所有人（默认关闭）
//   DD_MAX_CHARS    可选，单条正文最大字符数（默认 18000，超出截断）
//   DD_REHYDRATE=0  可选，关闭占位符还原（默认开启：把 [IPV4_n] 等还原为真值后发送）
//   DD_RECEIPT      可选，synthetic=会话内合成回执（默认）；off=不写回执（仅日志）
//   DD_DEBUG=1      可选，输出诊断日志
// 说明：会话库中的助手文本可能含 sensitive-filter 占位符，发送前按本机映射文件还原为真值。
// 运行日志：同目录 .dingtalk.log
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// ---------- .env（与 sensitive-filter.ts 同款：脚本同目录；.env 值优先于系统环境变量） ----------
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
loadDotEnv()

// ---------- 简易运行日志 ----------
function flog(msg: string): void {
  try {
    appendFileSync(
      join(dirname(fileURLToPath(import.meta.url)), ".dingtalk.log"),
      `${new Date().toISOString()} ${msg}\n`,
    )
  } catch {
    /* 忽略 */
  }
}
flog("module loaded")

// ---------- 占位符还原（读 sensitive-filter 的映射文件；缺映射时原样保留） ----------
const PLACEHOLDER_ANY = /\[(?:SECRET|IDCARD|PHONE|BANKCARD|EMAIL|IPV4)_\d+\]/g
const PLACEHOLDER_ONE = /^\[[A-Z][A-Z0-9]*_\d+\]$/

function tokenLookup(): Map<string, string> {
  const dir = process.env.SF_MAP_DIR || tmpdir()
  const tok2val = new Map<string, string>()
  try {
    const files = readdirSync(dir)
      .filter((n) => n.startsWith("sensitive_filter_map_") && n.endsWith(".json"))
      .map((n) => ({ n, m: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.m - a.m) // 新文件优先
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

// ---------- 消息提取（session.context 返回 V2 消息投影列表：以 type 区分消息种类） ----------
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

function kindOf(entry: any): string | undefined {
  return entry?.type ?? entry?.role ?? entry?.info?.type ?? entry?.info?.role ?? entry?.message?.role
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

function pickLastAssistantText(messages: any[]): string {
  const cands: Array<{ text: string; t: number; hasTime: boolean }> = []
  for (const entry of messages) {
    if (kindOf(entry) !== "assistant") continue
    const text = extractTextFromEntry(entry)
    if (!text) continue
    const tm: any = entry?.time
    const created = tm && typeof tm === "object" ? Number(tm.created ?? 0) : typeof tm === "number" ? tm : 0
    const completed = tm && typeof tm === "object" ? Number(tm.completed ?? 0) : 0
    const t = completed || created
    cands.push({ text, t, hasTime: t > 0 })
  }
  if (!cands.length) return ""
  const timed = cands.filter((c) => c.hasTime)
  if (timed.length) return timed.reduce((a, b) => (b.t >= a.t ? b : a)).text
  return cands[cands.length - 1].text
}

function dumpShapes(items: any[]): void {
  const lines: string[] = []
  items.slice(0, 16).forEach((it, i) => {
    const topKeys = it && typeof it === "object" ? Object.keys(it).slice(0, 16).join(",") : typeof it
    const kind = kindOf(it) ?? "-"
    const t = extractTextFromEntry(it)
    lines.push(`#${i}[keys=${topKeys}] type=${kind} txt=${t.length}`)
  })
  flog(`shapes: ${lines.join(" | ")}`)
}

async function findLastAssistantText(ctx: any, sessionID: string): Promise<string> {
  let arr: any[] | null = null
  try {
    const r = await ctx?.session?.context?.({ sessionID })
    arr = Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : null
  } catch (e: any) {
    flog(`read session.context: 异常 ${e?.message ?? String(e)}`)
    return ""
  }
  if (!arr) {
    flog("read session.context: 无数组结果")
    return ""
  }
  flog(`read session.context: ${arr.length} 条`)
  const text = pickLastAssistantText(arr)
  if (text) {
    flog(`命中最后一条助手文本（${text.length} 字）`)
    return text
  }
  flog("未命中助手文本")
  if (process.env.DD_DEBUG === "1") dumpShapes(arr)
  return ""
}

// ---------- 发送 ----------
async function sendDingtalk(text: string): Promise<{ ok: boolean; detail: string }> {
  const url = (process.env.DD_WEBHOOK_URL || "").trim()
  if (!url) return { ok: false, detail: "未配置 DD_WEBHOOK_URL（plugins/.env）" }
  const title = (process.env.DD_TITLE || "会话总结").trim() || "会话总结"
  const max = Math.max(1000, parseInt(process.env.DD_MAX_CHARS || "18000", 10) || 18000)
  let body = text
  let truncated = false
  if (body.length > max) {
    body = body.slice(0, max) + "\n\n> （内容过长，已截断）"
    truncated = true
  }
  if (process.env.DD_DRY_RUN === "1") {
    return { ok: true, detail: `dry-run 未发送（${body.length} 字${truncated ? "，已截断" : ""}）` }
  }
  const payload = {
    msgtype: "markdown",
    markdown: { title, text: `### ${title}\n${body}` },
    at: { isAtAll: process.env.DD_AT_ALL === "1" },
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=utf-8" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    })
    const data: any = await res.json().catch(() => null)
    if (res.ok && data?.errcode === 0) return { ok: true, detail: `发送成功（${body.length} 字）` }
    return { ok: false, detail: `钉钉返回异常：HTTP ${res.status} ${data ? JSON.stringify(data) : ""}`.trim() }
  } catch (e: any) {
    return { ok: false, detail: `请求异常：${e?.message ?? String(e)}` }
  }
}

// ---------- 命令处理 ----------
async function handleDd(ctx: any, sessionID: string): Promise<void> {
  loadDotEnv() // 每次执行重读 .env（改配置无需重启；插件文件本身变更需重载）
  flog(`/dd invoked session=${sessionID}`)
  if (process.env.DD_DEBUG === "1") {
    try {
      flog(
        `ctx keys: top=[${Object.keys(ctx || {}).join(",")}] session=[${Object.keys(ctx?.session || {}).join(",")}]`,
      )
    } catch {
      /* ignore */
    }
  }
  let receipt: string
  try {
    const raw = await findLastAssistantText(ctx, sessionID)
    if (!raw) {
      receipt = "未找到可发送的助手回复（本会话尚无已完成的回答）"
      flog(`no-assistant-message session=${sessionID}`)
    } else {
      let text = raw
      let ph = ""
      if (process.env.DD_REHYDRATE !== "0") {
        const r = rehydrate(text)
        text = r.text
        if (r.before > 0) ph = `｜占位符 ${r.before} 个，已还原 ${r.after} 个`
      }
      const res = await sendDingtalk(text)
      receipt = res.ok ? `钉钉发送完成：${res.detail}${ph}` : `钉钉发送失败：${res.detail}${ph}`
      flog(`${res.ok ? "OK" : "FAIL"} session=${sessionID} chars=${text.length} ${res.detail}${ph}`)
    }
  } catch (e: any) {
    receipt = `执行异常：${e?.message ?? String(e)}`
    flog(`EXCEPTION ${e?.stack ?? e}`)
  }
  if ((process.env.DD_RECEIPT || "synthetic") !== "off") {
    try {
      await ctx.session?.synthetic?.({ sessionID, text: `[dd] ${receipt}` })
    } catch {
      /* synthetic 不可用时静默 */
    }
  } else {
    flog(`receipt(off): ${receipt}`)
  }
}

// ---------- 注册 ----------
async function setupDingtalk(ctx: any): Promise<void> {
  try {
    if (!ctx?.command?.transform) {
      console.error("[dingtalk] ctx.command.transform 不可用，未注册命令")
      flog("ctx.command.transform 不可用，未注册命令")
      return
    }
    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "dd",
        description: "把本会话最后一条回复发送到钉钉群（markdown）",
        execute: async ({ sessionID }: any) => {
          await handleDd(ctx, sessionID)
        },
      })
    })
    console.log("[dingtalk] 命令 /dd 注册完成")
    flog("命令 /dd 注册完成")
  } catch (e: any) {
    console.error(`[dingtalk] 命令注册失败: ${e?.stack ?? e}`)
    flog(`命令注册失败 ${e?.stack ?? e}`)
  }
}

export default {
  id: "dingtalk",
  setup: setupDingtalk,
  server: async () => ({}),
}
