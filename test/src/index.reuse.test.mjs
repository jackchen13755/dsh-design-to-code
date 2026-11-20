/**
 * 组件复用接线与机器门禁单测（镜像 src/index.ts）。
 * 运行：node test/src/index.reuse.test.mjs
 *
 * 沿用 index.test.mjs 的 harness：把 src/*.ts 转译到 node_modules 下的临时缓存目录，
 * 从真实 node_modules 解析裸依赖；不触发 tsc 全量类型检查。
 * 席位A 的 reuse-contract.ts 尚未落地时，index.ts 用动态 import 容错，显式契约仍可直接落盘。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SRC = join(ROOT, 'src')

const CACHE = join(ROOT, 'node_modules', `.dsh-d2c-reuse-test-cache-${process.pid}`)
mkdirSync(CACHE, { recursive: true })
for (const f of readdirSync(SRC)) {
  if (!f.endsWith('.ts') || f.endsWith('.d.ts')) continue
  const js = ts.transpileModule(readFileSync(join(SRC, f), 'utf8'), {
    fileName: f,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  writeFileSync(join(CACHE, f.replace(/\.ts$/, '.js')), js, 'utf8')
}
const indexMod = await import(pathToFileURL(join(CACHE, 'index.js')).href)
const { apply, parseReuseContractInput, normalizeReusePolicy, isConfirmedReuseContract, verifyReuseImports } = indexMod
process.on('beforeExit', () => { try { rmSync(CACHE, { recursive: true, force: true }) } catch { /* ignore */ } })

function captureTools(config = {}) {
  const tools = []
  const ctx = { effect(fn) { fn(); return () => {} }, tools: { register(def) { tools.push(def); return { dispose() {} } } } }
  apply(ctx, config)
  return tools
}
function toolByName(tools, name) {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`未注册工具 ${name}`)
  return t
}

function contract(name, status = 'confirmed') {
  return {
    id: name, designNodeId: '51:2', designName: name, level: 'control', role: 'control',
    projectComponent: name,
    match: { source: 'explicit', confidence: 1, status, evidence: 'test' },
    verify: { nodeId: '51:2', note: '' },
  }
}

function writeJson(file, obj) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8')
  return file
}

// 合成 node JSON（buildDesignModel 的真实输入形态，取自 codegen.test.mjs）
const WS = {
  fileKey: 'TEST', nodeId: '51:1',
  node: {
    guid: { sessionID: 51, localID: 1 }, type: 'FRAME', name: '筛选',
    transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
    size: { x: 300, y: 200 }, visible: true,
    fillPaints: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true, blendMode: 'NORMAL' }],
    strokes: [], strokeWeight: 0, cornerRadius: 8,
  },
  descendants: [{
    guid: { sessionID: 51, localID: 2 }, type: 'TEXT', name: 'Label',
    transform: { m00: 1, m01: 0, m02: 10, m10: 0, m11: 1, m12: 10 },
    size: { x: 120, y: 20 }, visible: true,
    parentIndex: { guid: { sessionID: 51, localID: 1 } }, characters: '日期范围',
    style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 14, lineHeightPx: 20 },
    fillPaints: [{ type: 'SOLID', color: { r: 0.4, g: 0.4, b: 0.4, a: 1 }, opacity: 1, visible: true }],
  }],
}

function makeGenWorkdir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-d2c-reuse-gen-'))
  mkdirSync(join(dir, 'static'), { recursive: true })
  writeFileSync(join(dir, 'static', 'index.html'), '<html></html>', 'utf8')
  const designJson = join(dir, 'design.json')
  writeJson(designJson, WS)
  return { dir, designJson }
}

function gateCompliantFlow(dir, { withVisualDiff = true } = {}) {
  const staticPage = join(dir, 'static', 'index.html')
  mkdirSync(join(dir, 'static'), { recursive: true })
  writeFileSync(staticPage, '<html></html>', 'utf8')
  writeFileSync(join(dir, 'static', 'spec.json'), JSON.stringify({ width: 300, height: 200, rows: [] }), 'utf8')
  mkdirSync(join(dir, 'gen'), { recursive: true })
  writeFileSync(join(dir, 'gen', 'CODEGEN_PROMPT.md'), '# prompt\n', 'utf8')
  const flow = {
    stage: 'skeleton_generated', nodeId: '51:1', fileKey: 'TEST',
    confirmed: true, confirmedVia: 'human', gateVersion: 3, baselineRenderer: 2,
    expertReviewRequired: false, staticPage,
    ...(withVisualDiff ? { visualDiff: { at: new Date().toISOString(), checked: true, findings: 0, clean: true, reportPath: '/r' } } : {}),
    updatedAt: new Date().toISOString(),
  }
  writeJson(join(dir, 'flow.json'), flow)
  return flow
}

// ── ① 三参解析 / 接线 ────────────────────────────────────────────────
test('参数面：gen_component / codegen_round 含三参，新增 figma_verify_reuse', () => {
  const tools = captureTools()
  for (const name of ['figma_gen_component', 'figma_codegen_round']) {
    const t = toolByName(tools, name)
    for (const p of ['reuse_contract', 'reuse_policy', 'component_catalog']) {
      assert.ok(t.parameters.properties?.[p], `${name} 缺少参数 ${p}`)
    }
  }
  const v = toolByName(tools, 'figma_verify_reuse')
  assert.ok(v.parameters.properties?.output_dir, 'verify 缺 output_dir')
  assert.ok(v.parameters.properties?.impl_src, 'verify 缺 impl_src')
})

test('parseReuseContractInput：JSON 串 / 文件路径都解析，包裹形状兼容', () => {
  const c = [contract('Button')]
  assert.equal(parseReuseContractInput(JSON.stringify(c))[0].projectComponent, 'Button')
  const p = writeJson(join(mkdtempSync(join(tmpdir(), 'dsh-d2c-parse-')), 'c.json'), c)
  assert.equal(parseReuseContractInput(p)[0].projectComponent, 'Button')
  assert.equal(parseReuseContractInput(JSON.stringify({ contracts: c }))[0].projectComponent, 'Button')
  assert.equal(parseReuseContractInput(JSON.stringify(contract('Single')))[0].projectComponent, 'Single')
  assert.equal(parseReuseContractInput('   '), undefined)
  rmSync(dirname(p), { recursive: true, force: true })
})

test('parseReuseContractInput：非法输入抛明确错误（fail-closed）', () => {
  assert.throws(() => parseReuseContractInput('{"bad"'), /JSON|reuse_contract/)
  assert.throws(() => parseReuseContractInput('/definitely/not/here.json'), /不存在|reuse_contract/)
  assert.throws(() => parseReuseContractInput('"just-a-string"'), /reuse_contract|顶层/)
})

test('normalizeReusePolicy / isConfirmedReuseContract 边界', () => {
  assert.equal(normalizeReusePolicy(), 'auto')
  assert.equal(normalizeReusePolicy('off'), 'off')
  assert.equal(normalizeReusePolicy('explicit'), 'explicit')
  assert.throws(() => normalizeReusePolicy('bogus'), /reuse_policy/)
  assert.equal(isConfirmedReuseContract(contract('A')), true)          // match.status
  assert.equal(isConfirmedReuseContract({ projectComponent: 'A', status: 'confirmed' }), true) // 顶层兼容
  assert.equal(isConfirmedReuseContract(contract('A', 'suspected')), false)
  assert.equal(isConfirmedReuseContract({ projectComponent: 'A' }), false)
})

test('figma_gen_component：reuse_contract JSON 串与文件路径都落盘 component-reuse.json', async () => {
  const { dir, designJson } = makeGenWorkdir()
  try {
    const tool = toolByName(captureTools(), 'figma_gen_component')
    // JSON 串
    await tool.execute({ design_json: designJson, file_key: 'TEST', node_id: '51:1', output_dir: dir, reuse_contract: JSON.stringify([contract('Button')]) })
    const p = join(dir, 'gen', 'component-reuse.json')
    assert.ok(existsSync(p), '应落盘 gen/component-reuse.json')
    assert.equal(JSON.parse(readFileSync(p, 'utf8'))[0].projectComponent, 'Button')
    // 文件路径
    const cpath = writeJson(join(dir, 'contract.json'), [contract('Modal')])
    await tool.execute({ design_json: designJson, file_key: 'TEST', node_id: '51:1', output_dir: dir, reuse_contract: cpath })
    assert.equal(JSON.parse(readFileSync(p, 'utf8'))[0].projectComponent, 'Modal')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('figma_gen_component：reuse_contract 解析失败抛明确错误', async () => {
  const { dir, designJson } = makeGenWorkdir()
  try {
    const tool = toolByName(captureTools(), 'figma_gen_component')
    await assert.rejects(
      () => tool.execute({ design_json: designJson, file_key: 'TEST', node_id: '51:1', output_dir: dir, reuse_contract: '{"bad"' }),
      /reuse_contract|JSON/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── ② policy=off 跳过 ────────────────────────────────────────────────
test('reuse_policy=off：gen_component 不生成 component-reuse.json', async () => {
  const { dir, designJson } = makeGenWorkdir()
  try {
    const tool = toolByName(captureTools(), 'figma_gen_component')
    const out = await tool.execute({ design_json: designJson, file_key: 'TEST', node_id: '51:1', output_dir: dir, reuse_contract: JSON.stringify([contract('Button')]), reuse_policy: 'off' })
    assert.match(out, /reuse_policy=off/)
    assert.equal(existsSync(join(dir, 'gen', 'component-reuse.json')), false, 'off 不应落盘契约')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── ③ verify_reuse 命中 / 缺失 ──────────────────────────────────────
test('verifyReuseImports：命中→clean=true；缺 import→clean=false 且列出 missingImports（suspected 不计）', () => {
  const srcDir = mkdtempSync(join(tmpdir(), 'dsh-d2c-verify-src-'))
  try {
    writeFileSync(join(srcDir, 'Impl.tsx'), `import { Button } from '@/ui/Button'; export const X = () => <Button />;`)
    const contracts = [contract('Button'), contract('Modal'), contract('Card', 'suspected')]
    const r = verifyReuseImports(contracts, srcDir)
    assert.equal(r.clean, false)
    assert.deepEqual(r.hits, ['Button'])
    assert.deepEqual(r.missingImports, ['Modal'])
    // import 路径命中也算（require + JSX）
    writeFileSync(join(srcDir, 'Impl.tsx'), `const M = require('@/ui/Modal'); export const X = () => <M />;`)
    const r2 = verifyReuseImports([contract('Modal')], srcDir)
    assert.equal(r2.clean, true)
    assert.deepEqual(r2.hits, ['Modal'])
  } finally {
    rmSync(srcDir, { recursive: true, force: true })
  }
})

test('figma_verify_reuse：命中写回 clean=true；缺失写回 clean=false；impl_src 不存在抛错；无契约跳过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-d2c-verify-tool-'))
  const srcDir = mkdtempSync(join(tmpdir(), 'dsh-d2c-verify-src-'))
  try {
    gateCompliantFlow(dir)
    writeJson(join(dir, 'gen', 'component-reuse.json'), [contract('Button'), contract('Card', 'suspected')])
    writeFileSync(join(srcDir, 'Impl.tsx'), `import { Button } from '@/ui/Button'; export const X = () => <Button/>;`)
    const tool = toolByName(captureTools(), 'figma_verify_reuse')

    const out1 = await tool.execute({ output_dir: dir, impl_src: srcDir })
    assert.match(out1, /通过/)
    assert.match(out1, /未确认/)
    let flow = JSON.parse(readFileSync(join(dir, 'flow.json'), 'utf8'))
    assert.equal(flow.reuseVerification.clean, true)
    assert.deepEqual(flow.reuseVerification.missingImports, [])

    writeFileSync(join(srcDir, 'Impl.tsx'), `export const X = 1;`)
    const out2 = await tool.execute({ output_dir: dir, impl_src: srcDir })
    assert.match(out2, /未通过/)
    flow = JSON.parse(readFileSync(join(dir, 'flow.json'), 'utf8'))
    assert.equal(flow.reuseVerification.clean, false)
    assert.deepEqual(flow.reuseVerification.missingImports, ['Button'])

    await assert.rejects(() => tool.execute({ output_dir: dir, impl_src: join(srcDir, 'nope') }), /impl_src 不存在/)

    const empty = mkdtempSync(join(tmpdir(), 'dsh-d2c-verify-empty-'))
    try {
      const skip = await tool.execute({ output_dir: empty, impl_src: srcDir })
      assert.match(skip, /跳过/)
    } finally { rmSync(empty, { recursive: true, force: true }) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(srcDir, { recursive: true, force: true })
  }
})

// ── ④ 门禁经 codegen_round 生效 ─────────────────────────────────────
test('codegen_round：有 confirmed 契约无 verification → 拒绝；clean → 放行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-d2c-reuse-gate-'))
  try {
    gateCompliantFlow(dir)
    writeJson(join(dir, 'gen', 'component-reuse.json'), [contract('Button')])
    const tool = toolByName(captureTools(), 'figma_codegen_round')
    await assert.rejects(
      () => tool.execute({ output_dir: dir, round_feedback: 'x' }),
      /复用|reuseVerification/,
    )
    // 写回 clean 的 verification 后放行
    const flow = JSON.parse(readFileSync(join(dir, 'flow.json'), 'utf8'))
    flow.reuseVerification = { at: new Date().toISOString(), checked: true, clean: true, missingImports: [] }
    writeJson(join(dir, 'flow.json'), flow)
    const out = await tool.execute({ output_dir: dir, round_feedback: 'ok' })
    assert.match(out, /已追加/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── ⑤ GATE_VERSION=3 视觉回归旧测试不回退 ───────────────────────────
test('GATE_VERSION=3 视觉回归：缺 visualDiff 仍被 codegen_round 拒绝（旧测试不回退）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-d2c-reuse-vd-'))
  try {
    gateCompliantFlow(dir, { withVisualDiff: false })
    const tool = toolByName(captureTools(), 'figma_codegen_round')
    await assert.rejects(
      () => tool.execute({ output_dir: dir, round_feedback: 'x' }),
      /visualDiff|视觉回归/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
