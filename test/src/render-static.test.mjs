/**
 * render-static.ts 单测（镜像 src/render-static.ts）。
 *
 * 运行（不依赖 lib/ 构建产物，直接转译本席位的源码）：
 *   node test/src/render-static.test.mjs
 *
 * 覆盖：mismatch 节点注入 data-inferred-geometry + 绝对定位覆盖 CSS + HUD 强制归位横幅、
 *       geometry-truth.json 内容（C3）、SPEC 0.3/0.4/0.5 与空数据省略、保留 0.1/0.2。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')            // 仓根 dsh-design-to-code
const SRC = resolve(ROOT, 'src')

// TypeScript 解析：优先项目依赖；本机无 node_modules 时回落到同 workspace 兄弟仓库。
const require = createRequire(import.meta.url)
let ts
try {
  ts = require('typescript')
} catch {
  const cands = [resolve(ROOT, '..', 'dsh-figma-reader', 'node_modules', 'typescript'), process.env.TS_LIB].filter(Boolean)
  for (const c of cands) { try { ts = require(c); break } catch { /* next */ } }
  if (!ts) throw new Error('typescript 不可用：请 npm install 或设置 TS_LIB')
}

// 把需要的模块转译成临时 .js（保持相对目录结构），这样 './design.js' 等相对 import 天然可解析。
const TMP = mkdtempSync(join(tmpdir(), 'dsh-d2c-render-'))
const MODULES = ['design.ts', 'layout.ts', 'icons.ts', 'render-static.ts']
for (const name of MODULES) {
  const src = readFileSync(resolve(SRC, name), 'utf8')
  const js = ts.transpileModule(src, {
    fileName: name,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  writeFileSync(join(TMP, name.replace(/\.ts$/, '.js')), js, 'utf8')
}
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }) } catch { /* noop */ } })

const { renderStatic } = await import(pathToFileURL(join(TMP, 'render-static.js')).href)
const { verifyFlexPlan } = await import(pathToFileURL(join(TMP, 'layout.js')).href)

// 设计模型合成器：容器 C:1 内一个流内子项 CH:1。
// 容器的 flex 推演会把 CH:1 放在 (n.x+padL, n.y+padT) = (20,20)；
// 设计坐标给 (35,25) → 产生一条确定性 mismatch，便于断言。
function mkNode(id, x, y, w, h, extra = {}) {
  return { id, type: 'FRAME', name: id, kind: 'frame', rx: x, ry: y, x, y, w, h, children: [], raw: {}, ...extra }
}
function mkModel({ mismatch = true, suspects = true, colors = true, annos = true, titles = true } = {}) {
  const cx = mismatch ? 35 : 20
  const cy = mismatch ? 25 : 20
  const child = mkNode('CH:1', cx, cy, 50, 20)
  const container = mkNode('C:1', 10, 10, 300, 100, {
    layout: { mode: 'HORIZONTAL', paddingLeft: 10, paddingTop: 10, spacing: 0, primaryAlign: 'MIN', counterAlign: 'MIN' },
    children: [child],
  })
  const root = mkNode('root', 0, 0, 400, 300, { kind: 'root', type: 'ROOT', children: [container] })
  return {
    fileKey: 'FK', nodeId: '110:854', componentName: 'Synthetic', width: 400, height: 300,
    tokens: {
      colors: colors ? { '#ff0000': '#ff0000' } : {},
      fonts: {}, spacing: [], shadows: [],
    },
    texts: [], tree: root,
    spec: [
      { id: 'C:1', name: 'C', type: 'FRAME', kind: 'frame', x: 10, y: 10, w: 300, h: 100 },
      { id: 'CH:1', name: 'CH', type: 'FRAME', kind: 'frame', x: cx, y: cy, w: 50, h: 20 },
    ],
    coverage: { nodes: 2, counts: { design: 2, inferred: 0, placeholder: 0 }, placeholderRatio: 0, entries: [], fonts: [], summary: 'synthetic' },
    annotations: annos ? [{ id: 'AN:1', title: 'note', targetName: null, targetId: null, variantIds: [], detectedBy: [], signals: [], confidence: 1, disposition: 'auto', scope: 'single', text: 'do it', color: '#f00', x: 0, y: 0, w: 10, h: 10 }] : [],
    titles: titles ? [{ text: 'Title', source: 'frameName', nodeId: 'C:1', x: 10, y: 10, w: 300, h: 100, fontSize: 14, weight: 700, level: 'page', confidence: 1, signals: [] }] : [],
    suspects: suspects ? [{ nodeId: 'CH:1', name: 'CH', property: 'fill', guessedValue: '#cccccc', basis: 'no-paint', evidence: 'no fill paint', action: 'confirm color' }] : [],
    colorSources: colors ? { '#ff0000': 'CH:1' } : {},
  }
}
function render(model, t) {
  const out = mkdtempSync(join(tmpdir(), 'dsh-d2c-out-'))
  t.after(() => { try { rmSync(out, { recursive: true, force: true }) } catch { /* noop */ } })
  const r = renderStatic(model, { outputDir: out, title: 'Synth' })
  return {
    r, out,
    html: readFileSync(r.htmlPath, 'utf8'),
    spec: readFileSync(r.specPath, 'utf8'),
    truth: JSON.parse(readFileSync(r.geometryTruthPath, 'utf8')),
  }
}

// ── R1：坐标失真治理的渲染产物 ─────────────────────────────────────────
test('mismatch 节点被注入 data-inferred-geometry + 绝对定位覆盖 CSS + HUD 横幅', (t) => {
  const model = mkModel()
  assert.equal(verifyFlexPlan(model).mismatches.length, 1, '合成模型应产生恰好 1 条 mismatch')
  const { html, r } = render(model, t)
  assert.match(html, /data-design-id="CH:1"[^>]*data-inferred-geometry="1"/, 'index.html 应给 mismatch 节点打标记')
  assert.match(html, /\[data-inferred-geometry="1"\]\[data-design-id="CH:1"\]\s*\{[^}]*position:absolute!important/, '应注入绝对定位覆盖 CSS')
  assert.match(html, /left:35px!important;top:25px!important;width:50px!important;height:20px!important/, '覆盖 CSS 应使用 spec 设计坐标')
  assert.match(html, /1 个节点几何已按设计坐标强制归位/, 'HUD 应写强制归位计数')
  assert.ok(r.geometryTruthPath.endsWith('geometry-truth.json'), 'result 应带 geometryTruthPath')
  assert.ok(r.absPngPath.endsWith('abs@2x.png'), 'result 应带 abs@2x.png 路径')
})

test('geometry-truth.json 内容符合 C3 结构（designTruth/flexInferred/chosen）', (t) => {
  const { truth } = render(mkModel(), t)
  assert.equal(truth.length, 1)
  assert.deepEqual(truth[0], {
    nodeId: 'CH:1',
    flexInferred: { x: 20, y: 20, w: 50, h: 20 },
    designTruth: { x: 35, y: 25, w: 50, h: 20 },
    chosen: 'design',
  })
})

test('无 mismatch 时 geometry-truth.json 为空数组、index.html 不打标记', (t) => {
  const { html, truth } = render(mkModel({ mismatch: false, suspects: false, colors: false }), t)
  assert.deepEqual(truth, [], '无 mismatch 时清单为空数组（文件仍落盘）')
  assert.doesNotMatch(html, /data-inferred-geometry="1"/, '无 mismatch 时不应有强制归位标记')
  assert.doesNotMatch(html, /个节点几何已按设计坐标强制归位/, '无 mismatch 时 HUD 不写横幅')
})

// ── R2：SPEC 新增 0.3/0.4/0.5 且保留 0.1/0.2 ───────────────────────────
test('SPEC 含 0.1/0.2/0.3/0.4/0.5，且 0.3/0.4/0.5 内容正确', (t) => {
  const { spec } = render(mkModel(), t)
  for (const h of ['## 0.1', '## 0.2', '## 0.3', '## 0.4', '## 0.5']) {
    assert.ok(spec.includes(h), `SPEC 应含 ${h}`)
  }
  assert.match(spec, /## 0\.3[\s\S]*CH:1[\s\S]*design/, '0.3 应逐条列 mismatch 节点 + chosen=design')
  assert.match(spec, /## 0\.4[\s\S]*#cccccc[\s\S]*no-paint[\s\S]*confirm color/, '0.4 应列 suspects 全部字段')
  assert.match(spec, /## 0\.5[\s\S]*#ff0000[\s\S]*CH:1/, '0.5 应列颜色 literal + 来源节点 id')
  assert.ok(spec.indexOf('## 0.3') < spec.indexOf('## 1.'), '0.3/0.4/0.5 应位于 0.2 之后、1 之前')
})

test('空数据时省略 0.3/0.4/0.5，但保留 0.1/0.2', (t) => {
  // 用无 mismatch/无 suspects/无 colors 的模型，但保留 annotations/titles。
  const { spec } = render(mkModel({ mismatch: false, suspects: false, colors: false, annos: true, titles: true }), t)
  assert.ok(spec.includes('## 0.1') && spec.includes('## 0.2'), '0.1/0.2 必须保留')
  for (const h of ['## 0.3', '## 0.4', '## 0.5']) {
    assert.ok(!spec.includes(h), `无数据时不应输出 ${h}`)
  }
})

// ── 边界输入：undefined / 空串 / 特殊字符 ───────────────────────────────
test('边界输入：suspects/colorSources 为 undefined 时不抛错、不输出空段', (t) => {
  const model = mkModel({ mismatch: false, suspects: true, colors: true })
  model.suspects = undefined
  model.colorSources = undefined
  const { spec } = render(model, t)
  assert.ok(!spec.includes('## 0.4'), 'suspects=undefined 时省略 0.4')
  assert.match(spec, /## 0\.5[\s\S]*#ff0000[\s\S]*-/, 'colorSources=undefined 时来源回落为 -')
})

test('边界输入：Figma 节点 id 含冒号时 CSS 选择器仍合法（带引号的属性选择器）', (t) => {
  const { html } = render(mkModel(), t)
  assert.match(html, /\[data-design-id="CH:1"\]/, '冒号在带引号的属性选择器里应原样保留')
})
