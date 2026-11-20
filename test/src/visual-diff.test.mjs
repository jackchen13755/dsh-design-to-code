/**
 * visual-diff.ts 自动视觉回归单测（镜像 src/visual-diff.ts）。
 * 运行：node test/src/visual-diff.test.mjs
 *
 * visual-diff.ts 只依赖 node:fs / node:path（data: URL 可解析）和 ./screenshot.js 的 dumpDom。
 * 把 ./screenshot.js 换成一个可控 stub（读 globalThis.__PROBE__），让探针结果可断言，
 * 不真的起无头 Chrome。产物写到 os.tmpdir()，不入库。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
const transpile = (file) => ts.transpileModule(
  readFileSync(resolve(ROOT, 'src', file), 'utf8'),
  { fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText

// dumpDom stub：把 globalThis.__PROBE__ 序列化进探针页期望的 <pre> 结构
const stub = dataUrl(`
  export async function dumpDom() {
    return { ok: true, html: '<pre id="probe">PROBE_RESULT=' + JSON.stringify(globalThis.__PROBE__) + '</pre>' };
  }
`)
const vdJs = transpile('visual-diff.ts')
  .replace(/from ['"]\.\/screenshot\.js['"]/, `from '${stub}'`)
const { visualDiff, compareProbe } = await import(dataUrl(vdJs))

const ROWS = [
  { id: '1:2', name: '按钮', kind: 'node', x: 10, y: 20, w: 100, h: 50 },
]
const CANVAS = { width: 375, height: 812 }
function probeResult(nodes) {
  return { ok: true, nodes, root: { left: 0, top: 0, width: CANVAS.width, height: CANVAS.height } }
}
function node(overrides = {}) {
  return {
    id: '1:2', left: 10, top: 20, width: 100, height: 50,
    color: 'rgb(0,0,0)', backgroundColor: 'rgba(0,0,0,0)', borderRadius: '0px',
    borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
    borderTopStyle: 'none', fontSize: '16px', fontWeight: '400', lineHeight: 'normal',
    display: 'block', flexDirection: 'row', gap: '0px', opacity: '1',
    boxShadow: 'none', outlineStyle: 'none', outlineWidth: '0px', guessed: '',
    ...overrides,
  }
}
function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-d2c-vd-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('compareProbe：零差异 → findings=[]', () => {
  const r = compareProbe(ROWS, [node()], 1.5, probeResult([]).root, CANVAS)
  assert.equal(r.findings.length, 0, JSON.stringify(r.findings))
  assert.equal(r.checked, 1)
})

test('compareProbe：x 偏移 20px → 产生 blocker finding', () => {
  const r = compareProbe(ROWS, [node({ left: 30 })], 1.5, probeResult([]).root, CANVAS)
  assert.ok(r.findings.length >= 1)
  assert.equal(r.findings[0].property, 'x')
  assert.equal(r.findings[0].severity, 'blocker')
})

test('visualDiff：干净实现 → clean=true，且写入 visual-diff.json 的 clean 字段', async () => {
  await withTmp(async (dir) => {
    globalThis.__PROBE__ = probeResult([node()])
    const res = await visualDiff({ implPathOrUrl: 'file:///fake', width: CANVAS.width, height: CANVAS.height, outDir: dir, rows: ROWS })
    assert.equal(res.ok, true, res.error)
    assert.equal(res.findings.length, 0)
    assert.equal(res.clean, true)
    const json = JSON.parse(readFileSync(join(dir, 'visual-diff.json'), 'utf8'))
    assert.equal(json.clean, true)
    assert.equal(json.checked, 1)
    assert.ok(Array.isArray(json.findings))
  })
})

test('visualDiff：有位移差异 → clean=false，落盘 clean=false', async () => {
  await withTmp(async (dir) => {
    globalThis.__PROBE__ = probeResult([node({ left: 30 })])
    const res = await visualDiff({ implPathOrUrl: 'file:///fake', width: CANVAS.width, height: CANVAS.height, outDir: dir, rows: ROWS })
    assert.equal(res.ok, true, res.error)
    assert.equal(res.findings.length, 1)
    assert.equal(res.clean, false)
    const json = JSON.parse(readFileSync(join(dir, 'visual-diff.json'), 'utf8'))
    assert.equal(json.clean, false)
    assert.equal(json.findings[0].property, 'x')
  })
})

test('visualDiff：实现页缺失节点 → clean=false（缺失即未接受差异）', async () => {
  await withTmp(async (dir) => {
    globalThis.__PROBE__ = probeResult([]) // 没有 1:2 节点
    const res = await visualDiff({ implPathOrUrl: 'file:///fake', width: CANVAS.width, height: CANVAS.height, outDir: dir, rows: ROWS })
    assert.equal(res.ok, true, res.error)
    assert.equal(res.missing.length, 1)
    assert.equal(res.clean, false)
  })
})

test('visualDiff：探针执行失败 → ok=false 且 clean=false', async () => {
  await withTmp(async (dir) => {
    globalThis.__PROBE__ = { ok: false, error: 'cross-origin' }
    const res = await visualDiff({ implPathOrUrl: 'file:///fake', width: CANVAS.width, height: CANVAS.height, outDir: dir, rows: ROWS })
    assert.equal(res.ok, false)
    assert.equal(res.clean, false)
  })
})
