/**
 * gate.ts 复用机器门禁单测（镜像 src/gate.ts）。
 * 运行：node test/src/gate.reuse.test.mjs
 *
 * 用 ts.transpileModule + data: URL 直接加载源码（同 gate.test.mjs）。
 * 覆盖：有 confirmed 契约时 reuseVerification 的 fail-closed；与 visualDiff 并列；
 * GATE_VERSION=3 旧视觉回归用例不回退。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
const transpile = (file) => ts.transpileModule(
  readFileSync(resolve(ROOT, 'src', file), 'utf8'),
  { fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText

const flowJs = transpile('flow.ts')
const reviewJs = transpile('review.ts')
const gateJs = transpile('gate.ts')
  .replace(/from ['"]\.\/flow\.js['"]/, `from '${dataUrl(flowJs)}'`)
  .replace(/from ['"]\.\/review\.js['"]/, `from '${dataUrl(reviewJs)}'`)
const { evaluateCloseGate, GATE_VERSION } = await import(dataUrl(gateJs))

function cleanFlow(overrides = {}) {
  return {
    stage: 'skeleton_generated', nodeId: '110:854', fileKey: 'ABC',
    confirmed: true, confirmedVia: 'human', gateVersion: GATE_VERSION,
    baselineRenderer: 2, staticPage: '/nonexistent/static/index.html',
    expertReviewRequired: false,
    visualDiff: { at: 'x', checked: true, findings: 0, clean: true, reportPath: '/r' },
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}
function input(flow, { reuse, artifacts = { staticPage: true, spec: true } } = {}) {
  return { flow, gateVersion: GATE_VERSION, artifacts, ...(reuse ? { reuse } : {}) }
}

// ── 版本不升（避免作废旧 flow） ──
test('GATE_VERSION 仍为 3（复用门禁不升版本）', () => {
  assert.equal(GATE_VERSION, 3)
})

// ── ⑤ 视觉回归旧断言不回退 ──
test('[旧] 缺 visualDiff → 拒绝', () => {
  const f = cleanFlow({ visualDiff: undefined })
  const r = evaluateCloseGate(input(f))
  assert.equal(r.ok, false)
  assert.match(r.reason, /visualDiff|视觉回归/)
})
test('[旧] visualDiff.clean=false → 拒绝', () => {
  const r = evaluateCloseGate(input(cleanFlow({ visualDiff: { at: 'x', checked: true, findings: 2, clean: false, reportPath: '/r' } })))
  assert.equal(r.ok, false)
  assert.match(r.reason, /clean=false|差异/)
})
test('[旧] force=true 仍需基准产物', () => {
  const r = evaluateCloseGate({ flow: cleanFlow(), gateVersion: GATE_VERSION, force: true, forceReason: 'x', artifacts: { staticPage: false, spec: true } })
  assert.equal(r.ok, false)
  assert.match(r.reason, /基准产物/)
})

// ── 复用门禁：无契约时向后兼容 ──
test('无 confirmed 契约（hasConfirmed=false）→ 不要求 reuseVerification，放行', () => {
  const f = cleanFlow({ reuseVerification: undefined })
  const r = evaluateCloseGate(input(f, { reuse: { hasConfirmed: false } }))
  assert.equal(r.ok, true, r.reason)
})

// ── 复用门禁 fail-closed ──
test('有 confirmed 契约但无 reuseVerification → 拒绝（fail-closed）', () => {
  const f = cleanFlow({ reuseVerification: undefined })
  const r = evaluateCloseGate(input(f, { reuse: { hasConfirmed: true } }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /复用|reuseVerification/)
})

test('有 confirmed 契约且 reuseVerification.clean=false → 拒绝', () => {
  const f = cleanFlow({ reuseVerification: { at: 'x', checked: true, clean: false, missingImports: ['Button'] } })
  const r = evaluateCloseGate(input(f, { reuse: { hasConfirmed: true } }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /clean=false|缺失 import/)
})

test('有 confirmed 契约且 reuseVerification.clean=true → 放行', () => {
  const f = cleanFlow({ reuseVerification: { at: 'x', checked: true, clean: true, missingImports: [] } })
  const r = evaluateCloseGate(input(f, { reuse: { hasConfirmed: true } }))
  assert.equal(r.ok, true, r.reason)
})

test('reuseVerification.clean=false 但 knownDiffs 已接受 → 放行（与 visualDiff 同口径）', () => {
  const f = cleanFlow({
    reuseVerification: { at: 'x', checked: true, clean: false, missingImports: ['Button'] },
    knownDiffs: [{ nodeId: '110:854', property: 'reuse', note: '显式接受' }],
  })
  const r = evaluateCloseGate(input(f, { reuse: { hasConfirmed: true } }))
  assert.equal(r.ok, true, r.reason)
})

test('复用门禁与视觉回归并列：两者都不干净时先报 visualDiff（顺序）', () => {
  const f = cleanFlow({
    visualDiff: { at: 'x', checked: true, findings: 1, clean: false, reportPath: '/r' },
    reuseVerification: undefined,
  })
  const r = evaluateCloseGate(input(f, { reuse: { hasConfirmed: true } }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /视觉回归|visualDiff/)
})
