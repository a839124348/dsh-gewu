/**
 * gewu 单测：纯函数 + 一次假会话的端到端
 * 跑法：node test.js
 */

import assert from 'node:assert'
import os from 'node:os'
import path from 'node:path'

// 统计写到临时目录，别污染 ~/.dsh
process.env.GEWU_DIR = path.join(os.tmpdir(), 'gewu-test-' + Date.now())

const mod = await import('./gewu.js')
const { apply, name, hasReasoning, reasoningSize, stripReasoning, collectAssistantSeqs, pickTargets } = mod

let pass = 0
let fail = 0
function ok(label, fn) {
  try {
    fn()
    pass++
    console.log('PASS ' + label)
  } catch (e) {
    fail++
    console.log('FAIL ' + label + ' —— ' + (e && e.message))
  }
}
async function okAsync(label, fn) {
  try {
    await fn()
    pass++
    console.log('PASS ' + label)
  } catch (e) {
    fail++
    console.log('FAIL ' + label + ' —— ' + (e && e.message))
  }
}

function msg(content, extra = {}) {
  return {
    id: 'm-' + Math.random().toString(36).slice(2, 8),
    role: 'assistant',
    content,
    source: { kind: 'model', provider: 'p', model: 'm', replayState: { blocks: content.map((b) => ({ type: b.type })) } },
    ...extra,
  }
}

const t = (s) => ({ type: 'text', text: s })
const r = (s) => ({ type: 'reasoning', text: s })
const call = (id) => ({ type: 'tool-call', id, name: 'x', arguments: '{}' })

// ── 纯函数 ────────────────────────────────────────────
ok('name', () => assert.equal(name, 'gewu'))
ok('hasReasoning: 有', () => assert.equal(hasReasoning(msg([r('a'), t('b')])), true))
ok('hasReasoning: 无', () => assert.equal(hasReasoning(msg([t('b')])), false))
ok('hasReasoning: 非数组', () => assert.equal(hasReasoning({ content: 'x' }), false))

ok('reasoningSize', () => {
  const s = reasoningSize(msg([r('abc'), r('de'), t('xyz')]))
  assert.deepEqual(s, { blocks: 2, chars: 5 })
})

ok('stripReasoning: 只删 reasoning', () => {
  const src = msg([r('草稿草稿'), t('正文'), call('c1')])
  const out = stripReasoning(src, 'new-id')
  assert.equal(out.id, 'new-id')
  assert.deepEqual(out.content.map((b) => b.type), ['text', 'tool-call'])
  assert.equal(out.content[0].text, '正文')
  assert.equal(out.content[1].id, 'c1')
})

ok('stripReasoning: 去掉 replayState', () => {
  const out = stripReasoning(msg([r('a'), t('b')]), 'x')
  assert.equal('replayState' in out.source, false)
  assert.equal(out.source.provider, 'p')
})

ok('stripReasoning: 不动原对象', () => {
  const src = msg([r('a'), t('b')])
  const before = JSON.stringify(src)
  stripReasoning(src, 'x')
  assert.equal(JSON.stringify(src), before)
})

ok('stripReasoning: 没有可摘的返回 null', () => assert.equal(stripReasoning(msg([t('b')]), 'x'), null))
ok('stripReasoning: 摘完为空返回 null', () => assert.equal(stripReasoning(msg([r('a')]), 'x'), null))

ok('collectAssistantSeqs: 只收 assistant', () => {
  const events = {
    1: { type: 'user/message' },
    2: { type: 'assistant/message' },
    3: { type: 'tool/result' },
    4: { type: 'assistant/message' },
  }
  assert.deepEqual(collectAssistantSeqs([1, 2, 3, 4], (s) => events[s]), [2, 4])
})

ok('collectAssistantSeqs: eventAt 抛错不影响其它', () => {
  const events = { 2: { type: 'assistant/message' } }
  assert.deepEqual(collectAssistantSeqs([1, 2], (s) => { if (s === 1) throw new Error('x'); return events[s] }), [2])
})

ok('pickTargets: 去掉最近 keepLast，新的先摘', () => {
  assert.deepEqual(pickTargets([11, 12, 13, 14, 15], 3), [12, 11])
})
ok('pickTargets: 不够 keepLast 就不摘', () => assert.deepEqual(pickTargets([1, 2], 3), []))
ok('pickTargets: keepLast=0 全摘（新的先）', () => assert.deepEqual(pickTargets([1, 2, 3], 0), [3, 2, 1]))

// ── 假会话 ────────────────────────────────────────────
function makeSession(rows) {
  const events = new Map()
  const nodes = []
  let nextSeq = 900
  const appended = []
  for (const row of rows) {
    events.set(row.seq, row)
    nodes.push(row.seq)
  }
  return {
    id: 'test-session',
    surface: { nodes },
    eventAt(seq) { return events.get(seq) },
    append(type, data, opts) {
      const seq = nextSeq++
      events.set(seq, { seq, type, data })
      if (opts && opts.surfaceOp && opts.surfaceOp.op === 'replace') {
        const i = nodes.indexOf(opts.surfaceOp.startSeq)
        if (i === -1) throw new Error('surface replace: start seq not found')
        nodes[i] = seq
      } else {
        nodes.push(seq)
      }
      appended.push({ seq, type, data, opts })
      return { seq }
    },
    _nodes: nodes,
    _events: events,
    _appended: appended,
  }
}

function rowsOf(n) {
  const out = []
  for (let i = 1; i <= n; i++) {
    out.push({ seq: i, type: 'assistant/message', data: { turn: i, step: 1, message: msg([r('草稿' + i + '号'), t('正文' + i), call('c' + i)]) } })
  }
  return out
}

function handlerOf(ctx) { return ctx.handlers['agent/pre-step'] }

function makeCtx() {
  const handlers = {}
  return { handlers, on(ev, h) { handlers[ev] = h } }
}

await okAsync('端到端：只摘往轮，保留最近 1 条', async () => {
  const sess = makeSession(rowsOf(4))
  const ctx = makeCtx()
  apply(ctx, { keepLast: 1, maxStripsPerStep: 10 })
  const out = await handlerOf(ctx)({ agent: { session: sess }, signal: { aborted: false } }, async () => 'DECISION')

  assert.equal(out, 'DECISION')
  // 3 条被摘（序号 3、2、1 的顺序），第 4 条保留
  assert.equal(sess._appended.length, 3)
  const replacedSeqs = sess._appended.map((a) => a.opts.surfaceOp.startSeq)
  assert.deepEqual(replacedSeqs, [3, 2, 1])

  for (const a of sess._appended) {
    assert.equal(a.type, 'assistant/message')
    assert.deepEqual(a.opts.sourceEventSeqs, [a.opts.surfaceOp.startSeq])
    assert.equal(a.data.message.content.some((b) => b.type === 'reasoning'), false)
    assert.equal(a.data.message.content[0].type, 'text')
    assert.equal(a.data.message.content[1].type, 'tool-call')
    assert.equal('replayState' in a.data.message.source, false)
  }

  // 最近那条（seq 4）原文未动
  const last = sess._events.get(4)
  assert.equal(last.data.message.content.some((b) => b.type === 'reasoning'), true)
})

await okAsync('端到端：跑第二遍不再重复摘', async () => {
  const sess = makeSession(rowsOf(4))
  const ctx = makeCtx()
  apply(ctx, { keepLast: 1, maxStripsPerStep: 10 })
  const h = handlerOf(ctx)
  await h({ agent: { session: sess }, signal: { aborted: false } }, async () => 'D')
  const n1 = sess._appended.length
  await h({ agent: { session: sess }, signal: { aborted: false } }, async () => 'D')
  assert.equal(sess._appended.length, n1)
})

await okAsync('端到端：单步上限', async () => {
  const sess = makeSession(rowsOf(6))
  const ctx = makeCtx()
  apply(ctx, { keepLast: 1, maxStripsPerStep: 2 })
  await handlerOf(ctx)({ agent: { session: sess }, signal: { aborted: false } }, async () => 'D')
  assert.equal(sess._appended.length, 2)
})

await okAsync('端到端：dryRun 不写 surface', async () => {
  const sess = makeSession(rowsOf(4))
  const ctx = makeCtx()
  apply(ctx, { keepLast: 1, maxStripsPerStep: 10, dryRun: true })
  await handlerOf(ctx)({ agent: { session: sess }, signal: { aborted: false } }, async () => 'D')
  assert.equal(sess._appended.length, 0)
  assert.deepEqual(sess._nodes, [1, 2, 3, 4])
})

await okAsync('端到端：一条失败不影响其它', async () => {
  const sess = makeSession(rowsOf(4))
  const originalAppend = sess.append.bind(sess)
  sess.append = (type, data, opts) => {
    if (opts && opts.surfaceOp && opts.surfaceOp.startSeq === 3) throw new Error('boom')
    return originalAppend(type, data, opts)
  }
  const ctx = makeCtx()
  apply(ctx, { keepLast: 1, maxStripsPerStep: 10 })
  const out = await handlerOf(ctx)({ agent: { session: sess }, signal: { aborted: false } }, async () => 'D')
  assert.equal(out, 'D')
  assert.equal(sess._appended.length, 2) // 2 和 1 成功，3 失败
})

await okAsync('端到端：没有 session 也不炸', async () => {
  const ctx = makeCtx()
  apply(ctx, {})
  const out = await handlerOf(ctx)({ agent: {}, signal: { aborted: false } }, async () => 'D')
  assert.equal(out, 'D')
})

await okAsync('端到端：aborted 不动手', async () => {
  const sess = makeSession(rowsOf(4))
  const ctx = makeCtx()
  apply(ctx, { keepLast: 1 })
  await handlerOf(ctx)({ agent: { session: sess }, signal: { aborted: true } }, async () => 'D')
  assert.equal(sess._appended.length, 0)
})

ok('enabled=false 不注册钩子', () => {
  const ctx = makeCtx()
  apply(ctx, { enabled: false })
  assert.equal(ctx.handlers['agent/pre-step'], undefined)
})

console.log('\n' + pass + '/' + (pass + fail) + ' PASS' + (fail ? '，' + fail + ' FAIL' : ''))
process.exit(fail ? 1 : 0)
