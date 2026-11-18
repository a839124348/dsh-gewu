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
 *   - 按「轮」切，不按「条数」切：当前轮（以及 keepTurns 指定的近几轮）的思考全部保留
 *   - 任何异常都返回原结果，绝不影响对话
 *   - 不写 session、不碰 surface、不改原文
 *
 * v0.3.0 的关键修正（为什么不再用 keepLast 条数）：
 *   v0.2.x 用「保留最近 N 条」的滑动窗口。每来一条新 assistant 消息，窗口就往前挪一格，
 *   于是有一条原本「保留」的变成「摘掉」。这一格就是缓存前缀的断点：从它往后全部按未命中重算。
 *   实测 12 个真实会话 236 步：滑动窗口把输入费用抬到 ×1.58（缓存单价 0.1x 口径）。
 *   改成按轮切之后，摘掉的集合只增不减，前缀只在「换轮」那一刻断一次，费用回到 ×1.00。
 *
 * 已知局限：
 *   - 依赖 DSH 内部方法名（deriveMessages / deriveEventMessage），升版可能失效；
 *     失效时只在日志里报一行，不会影响对话
 *   - token-meter 用的是模块级 deriveEventMessage，不经过这层补丁，
 *     它算出来的上下文水位可能偏高（真实计费以 provider 回执为准）
 *   - 它省的是上下文，不是账单：缓存单价 0.1x 时费用基本持平；只有折扣更小的中转才省钱
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'gewu'

const DEFAULTS = {
  enabled: true,
  // 保留最近几「轮」的思考（按轮，不按条数）。当前轮的工具循环要接得上。
  keepTurns: 1,
  // 兼容 v0.2.x 的配置名：一旦写了 keepLast，就按旧语义换算成 keepTurns=1 并告警
  keepLast: undefined,
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
 * 从 surface 节点里挑出「该摘」的 assistant seq。
 *
 * 按「轮」切（v0.3.0）：
 *   - 取每条 assistant/message 事件上的 data.turn（DSH 自己写的轮号）
 *   - 保留最后 keepTurns 个轮次里的全部思考
 *   - 更早轮次的思考一律摘掉
 *
 * 为什么不用「保留最后 N 条」：那样每来一条新消息窗口就往前挪，原本保留的会变成摘掉，
 * 前缀在每步都断一次，缓存全失效。按轮切之后，同一个轮内摘掉的集合是常量，
 * 只有换轮那一刻才变化一次。
 *
 * turn 缺失时的退化路径：按「位置」兜底 —— 从末尾往前，把连续的 assistant/tool 段
 * 当作当前轮。这样即使 DSH 以后不再写 data.turn，也不会退回到滑动窗口。
 */
export function pickStrippableSeqs(session, keepTurns) {
  const nodes = session && session.surface && Array.isArray(session.surface.nodes) ? session.surface.nodes : []
  const withR = [] // { seq, turn }
  for (const seq of nodes) {
    let ev
    try { ev = session.eventAt(seq) } catch { continue }
    if (!ev || String(ev.type) !== 'assistant/message') continue
    if (!hasReasoning(ev.data && ev.data.message)) continue
    const t = ev.data && ev.data.turn
    withR.push({ seq, turn: Number.isFinite(t) ? t : null })
  }
  if (!withR.length) return new Set()

  const keep = Math.max(1, Number(keepTurns) || 1)

  // 有多数事件带 turn → 按轮号切
  const withTurn = withR.filter((x) => x.turn !== null)
  if (withTurn.length >= withR.length * 0.5) {
    const turns = [...new Set(withTurn.map((x) => x.turn))].sort((a, b) => a - b)
    const keepSet = new Set(turns.slice(Math.max(0, turns.length - keep)))
    // 没有 turn 的信息一律当作老轮次处理（保守：能摘就摘，但与同轮次的一致性由 turn 保证）
    return new Set(withR.filter((x) => x.turn === null || !keepSet.has(x.turn)).map((x) => x.seq))
  }

  // 退化：没有 turn 可用，按位置兜底（从末尾往前数 keep 段 assistant 链）
  const seqs = withR.map((x) => x.seq)
  const nodeIndex = new Map(nodes.map((s, i) => [s, i]))
  // 从末尾往前扫 surface，遇到 user/message 就认为进入上一轮
  let seenTurns = 0
  let cut = -1
  let prevType = ''
  for (let i = nodes.length - 1; i >= 0; i--) {
    const seq = nodes[i]
    let ev
    try { ev = session.eventAt(seq) } catch { continue }
    const type = ev ? String(ev.type) : ''
    if (type === 'user/message' && prevType === 'assistant/message') {
      seenTurns++
      if (seenTurns >= keep) { cut = i; break }
    }
    if (type === 'assistant/message') prevType = 'assistant/message'
    else if (type === 'user/message' || type === 'tool/result') prevType = type
  }
  const cutPos = cut >= 0 ? cut : 0
  return new Set(seqs.filter((s) => (nodeIndex.get(s) ?? -1) < cutPos))
}

/**
 * 从一组消息里挑出「该摘」的：当前位置在 keepFrom 之前的那些。
 * 消息数组里拿不到轮号，只能按位置；调用方负责给出轮边界。
 */
export function pickStrippable(messages, keepFrom) {
  const list = Array.isArray(messages) ? messages : []
  const from = Math.max(0, Number(keepFrom) || 0)
  const drop = new Set()
  for (let i = 0; i < Math.min(from, list.length); i++) {
    const m = list[i]
    if (hasReasoning(m)) drop.add(m)
  }
  return drop
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

function strippableSeqsOf(session, st, keepTurns) {
  const nodes = session && session.surface && Array.isArray(session.surface.nodes) ? session.surface.nodes : []
  const key = nodes.length + ':' + String(session && session.surface && session.surface.contentGeneration)
  if (st.seqKey === key && st.seqSet) return st.seqSet
  st.seqKey = key
  st.seqSet = pickStrippableSeqs(session, keepTurns)
  return st.seqSet
}

/**
 * deriveMessages 返回的是消息数组，不带 seq、不带 turn。
 * 它和 surface.nodes 不是严格一一对应（空消息会被跳过），所以不能按下标对齐。
 *
 * 可靠办法：按「消息对象身份」匹配。
 * DSH 的 deriveMessages 内部逐节点调用 deriveEventMessage，返回的就是 event.data.message
 * 这个对象本身（不是拷贝），所以这里直接从事件上取同一个对象来比身份。
 */
function stripFromDerived(session, st, out) {
  if (!Array.isArray(out) || !out.length) return out
  const nodes = session && session.surface && Array.isArray(session.surface.nodes) ? session.surface.nodes : []
  const strippable = st.seqSet
  if (!strippable || !strippable.size) return out

  // 该摘的「消息对象」集合
  const drop = new WeakSet()
  for (const seq of strippable) {
    let ev
    try { ev = session.eventAt(seq) } catch { continue }
    const msg = ev && ev.data && ev.data.message
    if (msg && hasReasoning(msg)) drop.add(msg)
  }
  if (!drop.size) return out

  let changed = false
  const mapped = out.map((m) => {
    if (!m || !drop.has(m)) return m
    changed = true
    return copyFor(m, st)
  })
  return changed ? mapped : out
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
 * 记一次 provider 名（每个会话只记一次），并判断是否在跳过名单里。
 * provider 从 request/header 读；首步可能还没有，等第二步就会出来。
 */
function noteProvider(session, st, cfg) {
  const p = providerOf(session)
  if (!p || p === st.lastProvider) return p
  st.lastProvider = p
  const list = Array.isArray(cfg.skipProviders) ? cfg.skipProviders : []
  appendLog('[gewu] provider=' + p + (list.includes(p) ? '（在 skipProviders 里，跳过）' : ''))
  return p
}

/**
 * 第三方中转可能靠“回放文本”恢复上游的思考签名：
 * 把旧的 reasoning 摘掉，它会查无此签名，重建出的历史和原始记录分叉，偶发故障。
 * 所以给一个 skipProviders 白名单，命中的 provider 一律不动。
 */
function shouldSkip(session, st, cfg) {
  const list = Array.isArray(cfg.skipProviders) ? cfg.skipProviders : []
  const p = noteProvider(session, st, cfg)
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
  appendLog('[gewu] ' + (counts.dryRun ? '可摘' : '已摘') + ' ' + counts.stripped + ' 条 / ' + counts.chars + ' 字（保留最近 ' + counts.keepTurns + ' 轮）')
}

/**
 * 给一个 session 挂上两处只读投影。
 * 失败只记日志，不抛。
 */
export function patchSession(session, cfg, stats) {
  if (!session || typeof session !== 'object') return false
  // keepTurns 下限 1：当前轮的工具循环那条 assistant 消息的 thinking 必须留着
  const asked = Number(cfg.keepTurns)
  cfg = { ...cfg, keepTurns: Math.max(1, Number.isFinite(asked) ? asked : DEFAULTS.keepTurns) }
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
        const seqSet = strippableSeqsOf(session, st, cfg.keepTurns)
        let chars = 0
        for (const seq of seqSet) {
          let ev
          try { ev = session.eventAt(seq) } catch { continue }
          chars += reasoningSize(ev && ev.data && ev.data.message).chars
        }
        if (seqSet.size) {
          report(session, st, stats, { stripped: seqSet.size, chars, keepTurns: cfg.keepTurns, dryRun: cfg.dryRun })
        }
        if (cfg.dryRun || seqSet.size === 0) return out

        return stripFromDerived(session, st, out)
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
        const set = strippableSeqsOf(session, st, cfg.keepTurns)
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
    appendLog('[gewu] 已挂载 session=' + String(session.id || 'unknown') + ' keepTurns=' + cfg.keepTurns + (cfg.dryRun ? ' dryRun' : ''))
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

  // 兼容 v0.2.x：老配置写的 keepLast 是「条数」，语义已废弃。
  // 直接换算成 keepTurns=1（等价于「只留当前轮」），并明确告警，不静默改行为。
  if (cfg.keepLast !== undefined) {
    appendLog('[gewu] 配置里还有 keepLast=' + cfg.keepLast + '（v0.2.x 旧字段，已废弃）→ 按 keepTurns=' + DEFAULTS.keepTurns + ' 处理，请从配置里删掉它')
  }

  // keepTurns 不能是 0：当前轮里带 tool_use 的那条 assistant 消息，thinking 必须原样回传。
  // 摘到 0 会把当前工具循环的签名一起摘掉，官方 provider 可能直接 400。
  const asked = Number(cfg.keepTurns)
  cfg.keepTurns = Math.max(1, Number.isFinite(asked) ? asked : DEFAULTS.keepTurns)
  if (Number.isFinite(asked) && asked < 1) appendLog('[gewu] keepTurns=' + asked + ' 不安全，已按 1 处理')

  const stats = loadStats()
  appendLog('[gewu] 启动：keepTurns=' + cfg.keepTurns + (cfg.dryRun ? ' dryRun' : ''))

  // pre-step 里挂载：此时 session 一定已存在，且早于本步的 buildRequest
  try {
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
  } catch (e) {
    // 注册不上就安静退出，不把宿主带崩
    appendLog('[gewu] 注册失败：' + String((e && e.message) || e).slice(0, 200))
  }
}
