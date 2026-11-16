/**
 * gewu —— 往轮的思考不进上下文
 *
 * 问题：DSH 把 reasoning 当成 assistant 消息的一个 block，而历史以 message 为单位。
 * 所以每一轮请求都会把过去所有轮的思考重新上传一遍。后果有三：
 *   1) 风格自我复制（"做。做。做。"这类单字步骤戳越滚越牢）
 *   2) 未校验的猜测被下一轮当成事实
 *   3) 20%~45% 的上下文被草稿占着（实测 6 个会话，中位数 20~27%）
 *
 * 做法：每步开始前，把「往轮」assistant 消息里的 reasoning 块摘掉，
 * 用 surfaceOp: replace 在 surface 层换一条不含草稿的副本。
 * 原文仍在会话日志里（可审计、可回放），只是模型看不到了。
 *
 * 边界（写死，别改）：
 *   - 只删 type === 'reasoning'；text / tool-call 一个字节不动
 *   - 保留最近 keepLast 条（当前轮的工具循环要接得上）
 *   - 任何一条失败都不影响对话
 *   - 不碰 tool/result、不碰 user/developer/system 消息
 *
 * 为什么改 surface 而不是拦请求：
 *   llm/stream 的 options 是 deepFreeze 的，且 waterfall 的 next() 捕获的是原对象，
 *   改不动（2026-11-07、2026-11-16 两次实测）。模型输入是从 session.surface 派生的
 *   （dsh-agent-loop buildRequest → session.deriveMessages），所以改 surface 才有效。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'gewu'

const DEFAULTS = {
  enabled: true,
  // 保留最近几条 assistant 消息的思考。当前轮的工具循环要靠它接上。
  keepLast: 3,
  // 单步最多摘几条：清历史积压时分批做，不要把一步拖长
  maxStripsPerStep: 12,
  // 只统计、不替换
  dryRun: false,
}

const STATE_DIR = process.env.GEWU_DIR || path.join(os.homedir(), '.dsh', 'gewu')
const STATS_PATH = path.join(STATE_DIR, 'stats.json')

// ── 纯函数（单测直接调）─────────────────────────────────

/** 这条消息里有没有推理块 */
export function hasReasoning(message) {
  const content = message && Array.isArray(message.content) ? message.content : null
  if (!content) return false
  return content.some((b) => b && b.type === 'reasoning')
}

/** 推理块的数量与字符数 */
export function reasoningSize(message) {
  const content = message && Array.isArray(message.content) ? message.content : []
  let blocks = 0
  let chars = 0
  for (const b of content) {
    if (!b || b.type !== 'reasoning') continue
    blocks++
    if (typeof b.text === 'string') chars += b.text.length
  }
  return { blocks, chars }
}

/**
 * 生成一条去掉推理块的副本。
 * 没有可摘的、或摘完变空消息，返回 null（空 assistant 消息会被投影成 null，宁可不动）。
 * replayState 一并去掉：块数变了，旧签名必然失配；留着只会触发静默降级。
 */
export function stripReasoning(message, newId) {
  if (!message || !Array.isArray(message.content)) return null
  const kept = message.content.filter((b) => !(b && b.type === 'reasoning'))
  if (kept.length === 0 || kept.length === message.content.length) return null
  const source = { ...(message.source || {}) }
  delete source.replayState
  return {
    ...message,
    id: newId || randomUUID(),
    content: kept,
    source,
  }
}

/** 从 surface 节点里挑出 assistant 消息的 seq（保持顺序） */
export function collectAssistantSeqs(nodes, eventAt) {
  const out = []
  for (const seq of nodes || []) {
    let ev
    try { ev = eventAt(seq) } catch { continue }
    if (ev && String(ev.type) === 'assistant/message') out.push(seq)
  }
  return out
}

/** 选出该摘的 seq：去掉最近 keepLast 条，新的先摘（最近的样本影响最大） */
export function pickTargets(assistantSeqs, keepLast) {
  const keep = Math.max(0, Number(keepLast) || 0)
  if (assistantSeqs.length <= keep) return []
  return assistantSeqs.slice(0, assistantSeqs.length - keep).reverse()
}

// ── 统计 ──────────────────────────────────────────────

function loadStats() {
  try {
    const raw = fs.readFileSync(STATS_PATH, 'utf8')
    const o = JSON.parse(raw)
    if (o && typeof o === 'object' && o.sessions) return o
  } catch { /* 没有就是新的 */ }
  return { version: 1, updatedAt: '', sessions: {} }
}

function saveStats(stats) {
  try {
    stats.updatedAt = new Date().toISOString()
    const rows = Object.entries(stats.sessions)
      .sort((a, b) => String(b[1].updatedAt || '').localeCompare(String(a[1].updatedAt || '')))
      .slice(0, 40)
    stats.sessions = Object.fromEntries(rows)
    fs.mkdirSync(STATE_DIR, { recursive: true })
    const tmp = STATS_PATH + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 2), 'utf8')
    fs.renameSync(tmp, STATS_PATH)
  } catch { /* 统计写不进去不影响对话 */ }
}

function sessionIdOf(agent) {
  try {
    return String((agent && agent.session && agent.session.id) || 'unknown')
  } catch {
    return 'unknown'
  }
}

// ── 主逻辑 ────────────────────────────────────────────

function sweep(agent, cfg) {
  const sess = agent && agent.session
  if (!sess || !sess.surface || !Array.isArray(sess.surface.nodes)) return null
  if (typeof sess.eventAt !== 'function' || typeof sess.append !== 'function') return null

  const nodes = sess.surface.nodes.slice()
  const all = collectAssistantSeqs(nodes, (seq) => sess.eventAt(seq))
  const targets = pickTargets(all, cfg.keepLast)
  if (targets.length === 0) return null

  let stripped = 0
  let failed = 0
  let blocks = 0
  let chars = 0

  for (const seq of targets) {
    if (stripped + failed >= cfg.maxStripsPerStep) break
    let ev
    try { ev = sess.eventAt(seq) } catch { continue }
    if (!ev || String(ev.type) !== 'assistant/message') continue
    const msg = ev.data && ev.data.message
    if (!hasReasoning(msg)) continue

    const size = reasoningSize(msg)
    if (cfg.dryRun) {
      stripped++
      blocks += size.blocks
      chars += size.chars
      continue
    }

    const replacement = stripReasoning(msg, randomUUID())
    if (!replacement) continue

    try {
      sess.append('assistant/message', { ...ev.data, message: replacement }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      })
      stripped++
      blocks += size.blocks
      chars += size.chars
    } catch (e) {
      failed++
      if (failed === 1) {
        console.warn('[gewu] 替换失败（跳过，不影响对话）：', String((e && e.message) || e).slice(0, 160))
      }
    }
  }

  if (!stripped && !failed) return null
  return { stripped, failed, blocks, chars }
}

export function apply(ctx, rawConfig = {}) {
  const cfg = { ...DEFAULTS, ...(rawConfig || {}) }
  if (!cfg.enabled) {
    console.log('[gewu] 已禁用（enabled=false）')
    return
  }

  const stats = loadStats()

  // 放在 next() 之前：让本步的请求构建读到已经摘干净的 surface
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const agent = payload && payload.agent
      const signal = payload && payload.signal
      if (!signal || !signal.aborted) {
        const r = sweep(agent, cfg)
        if (r) {
          const sid = sessionIdOf(agent)
          const s = stats.sessions[sid] || (stats.sessions[sid] = { stripped: 0, blocks: 0, chars: 0, failed: 0, updatedAt: '' })
          s.stripped += r.stripped
          s.failed += r.failed
          s.blocks += r.blocks
          s.chars += r.chars
          s.updatedAt = new Date().toISOString()
          saveStats(stats)
          console.log(
            '[gewu] ' + (cfg.dryRun ? '可摘' : '已摘') + ' ' + r.stripped + ' 条 / ' + r.chars + ' 字 / ' +
            r.blocks + ' 块（保留最近 ' + cfg.keepLast + ' 条；本会话累计 ' + s.stripped + ' 条 / ' + s.chars + ' 字）'
          )
        }
      }
    } catch (e) {
      console.warn('[gewu] 巡检失败（不影响对话）：', String((e && e.message) || e).slice(0, 160))
    }
    return next()
  })

  console.log(
    '[gewu] 已启用：保留最近 ' + cfg.keepLast + ' 条思考，单步最多摘 ' + cfg.maxStripsPerStep + ' 条' +
    (cfg.dryRun ? '（dryRun：只统计不替换）' : '')
  )
}
