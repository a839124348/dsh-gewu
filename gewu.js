/**
 * 格物 / gewu —— 往轮的思考不进上下文
 *
 * 问题：DSH 把 reasoning 当成 assistant 消息的一个 block，而历史以 message 为单位。
 * 每一轮请求都会把过去所有轮的思考重新上传：风格自我复制、旧猜测变成事实、20%~45% 的上下文被草稿占着。
 *
 * 做法：不碰会话记录，只改「读出来的视图」。
 *   - 请求路径：包 session.deriveMessages()（buildRequest 取模型输入的唯一入口）
 *   - 压缩路径：包 session.deriveEventMessage()（compaction 摘要读取消息的入口）
 * 两条都只返回「去掉 reasoning 的副本」，原文仍在本机日志里，可审计、可回放。
 *
 * 为什么不用 surfaceOp 替换：
 *   DSH 0.1.3+ 在 assertSourceEventReferences 里写了死锁：
 *   带 sourceEventSeqs → "assistant/message ... cannot carry sourceEventSeqs"
 *   不带 → "must include every shadowed surface node"
 *   assistant 消息结构上不允许整条替换。
 *
 * 边界（写死，别改）：
 *   - 只删 type === 'reasoning'；text / tool-call 一个字节不动
 *   - 保留最近 keepLast 条 assistant 消息的思考，当前轮接得上
 *   - 任何异常都返回原结果，绝不影响对话
 *   - 不写 session、不碰 surface、不改原文
 *
 * 已知局限：
 *   - 依赖 DSH 内部方法名（deriveMessages / deriveEventMessage），升版可能失效；
 *     失效时只在日志里报一行，不会影响对话
 *   - token-meter 用的是模块级 deriveEventMessage，不经过这层补丁，
 *     它算出来的上下文水位可能偏高（真实计费以 provider 回执为准）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'gewu'

const DEFAULTS = {
  enabled: true,
  // 保留最近几条 assistant 消息的思考（当前轮的工具循环要接得上）
  keepLast: 3,
  // 只统计、不改视图
  dryRun: false,
  // 跳过这些 provider（第三方中转可能靠回放文本恢复思考签名，摘了会偶发故障）
  skipProviders: [],
}

const STATE_DIR = process.env.GEWU_DIR || path.join(os.homedir(), '.dsh', 'gewu')
const LOG_PATH = path.join(STATE_DIR, 'gewu.log')
const STATS_PATH = path.join(STATE_DIR, 'stats.json')

// session -> 状态（副本缓存、挂载标记、上次日志时间）
const STATES = new WeakMap()

// ── 日志与统计 ─────────────────────────────────────────

function appendLog(line) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.appendFileSync(LOG_PATH, new Date().toISOString() + ' ' + line + '\n')
  } catch { /* 日志写不进去不影响对话 */ }
}

function loadStats() {
  try {
    const o = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'))
    if (o && typeof o === 'object' && o.sessions) return o
  } catch { /* 没有就是新的 */ }
  return { version: 2, updatedAt: '', sessions: {} }
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

// ── 纯函数（单测直接调）────────────────────────────────

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
 * replayState 一并去掉：块数变了，旧签名必然失配，留着只会触发静默降级。
 */
export function stripMessage(message) {
  if (!message || !Array.isArray(message.content)) return null
  if (message.role !== 'assistant') return null
  const kept = message.content.filter((b) => !(b && b.type === 'reasoning'))
  if (kept.length === 0 || kept.length === message.content.length) return null
  const source = { ...(message.source || {}) }
  delete source.replayState
  return { ...message, content: kept, source }
}

/**
 * 从一组消息里挑出「该摘」的：按出现顺序，保留最后 keepLast 条带思考的 assistant 消息。
 * 返回 Set<message>，方便按对象身份过滤。
 */
export function pickStrippable(messages, keepLast) {
  const list = Array.isArray(messages) ? messages : []
  const keep = Math.max(0, Number(keepLast) || 0)
  const withReasoning = list.filter((m) => hasReasoning(m))
  if (withReasoning.length <= keep) return new Set()
  return new Set(withReasoning.slice(0, withReasoning.length - keep))
}

/** 从 surface 节点里挑出「该摘」的 assistant seq（按顺序，保留最后 keepLast 条） */
export function pickStrippableSeqs(session, keepLast) {
  const nodes = session && session.surface && Array.isArray(session.surface.nodes) ? session.surface.nodes : []
  const seqs = []
  for (const seq of nodes) {
    let ev
    try { ev = session.eventAt(seq) } catch { continue }
    if (ev && String(ev.type) === 'assistant/message' && hasReasoning(ev.data && ev.data.message)) seqs.push(seq)
  }
  const keep = Math.max(0, Number(keepLast) || 0)
  if (seqs.length <= keep) return new Set()
  return new Set(seqs.slice(0, seqs.length - keep))
}

// ── 会话挂载 ───────────────────────────────────────────

function stateOf(session) {
  let st = STATES.get(session)
  if (!st) {
    st = {
      patched: false,
      // 原消息对象 -> 去掉思考的副本（WeakMap 保证身份稳定、不泄漏）
      copies: new WeakMap(),
      // 派生消息对象 -> 副本
      seqCopies: new WeakMap(),
      // 该摘的 seq 集合 + 缓存键
      seqSet: null,
      seqKey: '',
      lastLogAt: 0,
      lastReport: null,
      lastProvider: '',
    }
    STATES.set(session, st)
  }
  return st
}

function strippableSeqsOf(session, st, keepLast) {
  const nodes = session && session.surface && Array.isArray(session.surface.nodes) ? session.surface.nodes : []
  const key = nodes.length + ':' + String(session && session.surface && session.surface.contentGeneration)
  if (st.seqKey === key && st.seqSet) return st.seqSet
  st.seqKey = key
  st.seqSet = pickStrippableSeqs(session, keepLast)
  return st.seqSet
}

function copyFor(message, st) {
  let copy = st.copies.get(message)
  if (!copy) {
    copy = stripMessage(message)
    if (!copy) return message
    st.copies.set(message, copy)
  }
  return copy
}

/** 当前会话用的 provider 名（request/header 里有；首步可能还没有） */
function providerOf(session) {
  try {
    const h = session.requestHeader()
    return String((h && h.config && h.config.provider) || '')
  } catch {
    return ''
  }
}

/**
 * 第三方中转可能靠“回放文本”恢复上游的思考签名：
 * 把旧的 reasoning 摘掉，它会查无此签名，重建出的历史和原始记录分叉，偶发故障。
 * 所以给一个 skipProviders 白名单，命中的 provider 一律不动。
 */
function shouldSkip(session, st, cfg) {
  const list = Array.isArray(cfg.skipProviders) ? cfg.skipProviders : []
  if (!list.length) return false
  const p = providerOf(session)
  if (p && st.lastProvider !== p) {
    st.lastProvider = p
    appendLog('[gewu] provider=' + p + (list.includes(p) ? '（在 skipProviders 里，跳过）' : ''))
  }
  return !!p && list.includes(p)
}

function report(session, st, stats, counts) {
  st.lastReport = counts
  const sid = String((session && session.id) || 'unknown')
  const s = stats.sessions[sid] || (stats.sessions[sid] = { stripped: 0, chars: 0, updatedAt: '' })
  s.stripped = counts.stripped
  s.chars = counts.chars
  s.updatedAt = new Date().toISOString()
  saveStats(stats)

  const now = Date.now()
  if (now - st.lastLogAt < 5000) return
  st.lastLogAt = now
  appendLog('[gewu] ' + (counts.dryRun ? '可摘' : '已摘') + ' ' + counts.stripped + ' 条 / ' + counts.chars + ' 字（保留最近 ' + counts.keepLast + ' 条）')
}

/**
 * 给一个 session 挂上两处只读投影。
 * 失败只记日志，不抛。
 */
export function patchSession(session, cfg, stats) {
  if (!session || typeof session !== 'object') return false
  const st = stateOf(session)
  if (st.patched) return true

  const origDeriveMessages = session.deriveMessages
  const origDeriveEvent = session.deriveEventMessage
  if (typeof origDeriveMessages !== 'function' || typeof origDeriveEvent !== 'function') {
    appendLog('[gewu] 挂载失败：deriveMessages=' + typeof origDeriveMessages + ' deriveEventMessage=' + typeof origDeriveEvent)
    return false
  }

  try {
    // 1) 请求路径：buildRequest 拿到的整份消息
    session.deriveMessages = function (...args) {
      const out = origDeriveMessages.apply(session, args)
      try {
        if (!Array.isArray(out)) return out
        if (shouldSkip(session, st, cfg)) return out

        // 计数以 surface 为准：不管这一层有没有真正动手（可能已被事件层摘过），
        // 水位都要如实记下来。
        const seqSet = strippableSeqsOf(session, st, cfg.keepLast)
        let chars = 0
        for (const seq of seqSet) {
          let ev
          try { ev = session.eventAt(seq) } catch { continue }
          chars += reasoningSize(ev && ev.data && ev.data.message).chars
        }
        if (seqSet.size) {
          report(session, st, stats, { stripped: seqSet.size, chars, keepLast: cfg.keepLast, dryRun: cfg.dryRun })
        }
        if (cfg.dryRun || seqSet.size === 0) return out

        const drop = pickStrippable(out, cfg.keepLast)
        if (!drop.size) return out
        return out.map((m) => (drop.has(m) ? copyFor(m, st) : m))
      } catch (e) {
        appendLog('[gewu] 投影失败（返回原消息）：' + String((e && e.message) || e).slice(0, 160))
        return out
      }
    }

    // 2) 压缩路径：compaction 逐条读消息时也走这里
    session.deriveEventMessage = function (event) {
      const out = origDeriveEvent.apply(session, arguments)
      try {
        if (!out || !event || String(event.type) !== 'assistant/message') return out
        if (cfg.dryRun) return out
        if (shouldSkip(session, st, cfg)) return out
        const set = strippableSeqsOf(session, st, cfg.keepLast)
        if (!set.has(event.seq)) return out
        let copy = st.seqCopies.get(out)
        if (!copy) {
          copy = stripMessage(out)
          if (!copy) return out
          st.seqCopies.set(out, copy)
        }
        return copy
      } catch (e) {
        appendLog('[gewu] 事件投影失败（返回原消息）：' + String((e && e.message) || e).slice(0, 160))
        return out
      }
    }

    st.patched = true
    appendLog('[gewu] 已挂载 session=' + String(session.id || 'unknown') + ' keepLast=' + cfg.keepLast + (cfg.dryRun ? ' dryRun' : ''))
    return true
  } catch (e) {
    appendLog('[gewu] 挂载异常：' + String((e && e.message) || e).slice(0, 200))
    return false
  }
}

export function apply(ctx, rawConfig = {}) {
  const cfg = { ...DEFAULTS, ...(rawConfig || {}) }
  if (!cfg.enabled) {
    appendLog('[gewu] 已禁用（enabled=false）')
    return
  }

  const stats = loadStats()
  appendLog('[gewu] 启动：keepLast=' + cfg.keepLast + (cfg.dryRun ? ' dryRun' : ''))

  // pre-step 里挂载：此时 session 一定已存在，且早于本步的 buildRequest
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const agent = payload && payload.agent
      const session = agent && agent.session
      if (session) patchSession(session, cfg, stats)
    } catch (e) {
      appendLog('[gewu] pre-step 挂载失败：' + String((e && e.message) || e).slice(0, 160))
    }
    return next()
  })
}
