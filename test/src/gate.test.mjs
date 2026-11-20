/**
 * gate.ts 收尾门禁单测（镜像 src/gate.ts）。
 * 运行：node test/src/gate.test.mjs
 *
 * 用 ts.transpileModule + data: URL 直接加载源码（不依赖 lib/ 构建产物）：
 * gate.ts 的两个相对依赖 flow.ts / review.ts 先各自转译，再把 import 说明符改写成 data: URL。
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
const gate = await import(dataUrl(gateJs))
const { evaluateCloseGate, GATE_VERSION } = gate

/** 一份"除 visualDiff 外全部合规"的 flow（fail-closed 用例的基线） */
function cleanFlow(overrides = {}) {
  return {
    stage: 'skeleton_generated', nodeId: '110:854', fileKey: 'ABC',
    confirmed: true, confirmedVia: 'human', gateVersion: GATE_VERSION,
    baselineRenderer: 2,
    staticPage: '/nonexistent/static/index.html',
    expertReviewRequired: false,
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}
// 产物检查：把 staticPage 指向真实存在的文件（这里用本测试文件自身），spec 目录由 artifacts 显式给 true
function withArtifacts(flow, artifacts = { staticPage: true, spec: true }) {
  return { flow, gateVersion: GATE_VERSION, artifacts }
}

test('GATE_VERSION 已升到 3（旧 flow 必须重渲染确认）', () => {
  assert.equal(GATE_VERSION, 3)
})

test('缺 visualDiff 的 confirmed flow → 拒绝（fail-closed）', () => {
  const f = cleanFlow()
  assert.equal(f.visualDiff, undefined)
  const r = evaluateCloseGate(withArtifacts(f))
  assert.equal(r.ok, false)
  assert.match(r.reason, /visualDiff|视觉回归/)
})

test('visualDiff.clean=false 且无 knownDiffs → 拒绝', () => {
  const f = cleanFlow({ visualDiff: { at: 'x', checked: true, findings: 2, clean: false, reportPath: '/r' } })
  const r = evaluateCloseGate(withArtifacts(f))
  assert.equal(r.ok, false)
  assert.match(r.reason, /clean=false|差异/)
})

test('visualDiff.clean=true → 放行', () => {
  const f = cleanFlow({ visualDiff: { at: 'x', checked: true, findings: 0, clean: true, reportPath: '/r' } })
  const r = evaluateCloseGate(withArtifacts(f))
  assert.equal(r.ok, true, r.reason)
})

test('visualDiff.clean=false 但有 knownDiffs 接受 → 放行', () => {
  const f = cleanFlow({
    visualDiff: { at: 'x', checked: true, findings: 1, clean: false, reportPath: '/r' },
    knownDiffs: [{ nodeId: '110:854', property: 'radius', note: '接受' }],
  })
  const r = evaluateCloseGate(withArtifacts(f))
  assert.equal(r.ok, true, r.reason)
})

test('confirmedVia=expert_review 不得丢失/不得因此被拒', () => {
  const f = cleanFlow({
    confirmedVia: 'expert_review',
    visualDiff: { at: 'x', checked: true, findings: 0, clean: true, reportPath: '/r' },
  })
  const r = evaluateCloseGate(withArtifacts(f))
  assert.equal(r.ok, true, r.reason)
  // 门禁只读不写：确认来源原样保留
  assert.equal(f.confirmedVia, 'expert_review')
})

test('force=true 仍需基准产物（不能凭 force 越过产物缺失）', () => {
  const f = cleanFlow()
  const r = evaluateCloseGate({
    flow: f, gateVersion: GATE_VERSION, force: true, forceReason: '测试越过',
    artifacts: { staticPage: false, spec: true },
  })
  assert.equal(r.ok, false)
  assert.match(r.reason, /基准产物/)
})

test('旧 gateVersion（2）无 visualDiff → 先被版本门禁拦下（fail-closed）', () => {
  const f = cleanFlow({ gateVersion: 2 })
  const r = evaluateCloseGate(withArtifacts(f))
  assert.equal(r.ok, false)
  assert.match(r.reason, /旧版本|gateVersion/)
})

test('未确认（confirmed=false）→ 拒绝', () => {
  const f = cleanFlow({ confirmed: false })
  const r = evaluateCloseGate(withArtifacts(f))
  assert.equal(r.ok, false)
})
