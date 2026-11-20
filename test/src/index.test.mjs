/**
 * index.ts 工具层单测（镜像 src/index.ts）：
 *  - C6 node-id 归一化边界（dash / colon / 尾空格 / URL 编码 / 非法格式）
 *  - R7 figma_codegen_round 用 findGenDir 找 gen/CODEGEN_PROMPT（output_dir 传父目录也能成功）
 *  - R2 门禁在 codegen_round 上生效：缺 visualDiff 拒绝 / clean 放行
 * 运行：node test/src/index.test.mjs
 *
 * index.ts 依赖裸模块（@deepseek-ai/*, schemastery）与大量相对 src 模块，data: URL 无法解析裸模块，
 * 故把 src/*.ts 全部 transpile 到 node_modules 下的缓存目录（node_modules 已被 .gitignore 忽略），
 * 从真实 node_modules 解析依赖；不触发 tsc 全量类型检查（transpileModule 只去类型）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SRC = join(ROOT, 'src')

// ── 一次性：把 src/*.ts 转译到 node_modules 下的缓存目录，加载真实 index.js ──
const CACHE = join(ROOT, 'node_modules', `.dsh-d2c-test-cache-${process.pid}`)
mkdirSync(CACHE, { recursive: true })
for (const f of readdirSync(SRC)) {
  if (!f.endsWith('.ts') || f.endsWith('.d.ts')) continue
  const js = ts.transpileModule(readFileSync(join(SRC, f), 'utf8'), {
    fileName: f,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  writeFileSync(join(CACHE, f.replace(/\.ts$/, '.js')), js, 'utf8')
}
// 把 visual-diff.js 换成可控 stub：记录传入的 rows，不跑无头 Chrome。
// descendantDesignIds 保留真实实现（单组件 node_id 过滤的核心逻辑要真跑）。
writeFileSync(join(CACHE, 'visual-diff.js'), `
export function descendantDesignIds(tree, nodeId) {
  if (!tree) return null;
  const find = (n) => { if (String(n.id) === nodeId) return n; for (const c of (n.children || [])) { const h = find(c); if (h) return h; } return undefined; };
  const t = find(tree);
  if (!t) return null;
  const ids = [];
  const walk = (n) => { if (n.raw && n.raw.visible === false) return; ids.push(String(n.id)); for (const c of (n.children || [])) walk(c); };
  walk(t);
  return [...new Set(ids)];
}
export async function visualDiff(opts) {
  globalThis.__LAST_VD_ROWS__ = (opts.rows || []).map(r => String(r.id));
  return { ok: true, findings: [], checked: (opts.rows || []).length, missing: [], clean: true, reportPath: '/r', jsonPath: '/j' };
}
`, 'utf8')
const indexMod = await import(pathToFileURL(join(CACHE, 'index.js')).href)
const { normalizeNodeId, apply } = indexMod

process.on('beforeExit', () => { try { rmSync(CACHE, { recursive: true, force: true }) } catch { /* ignore */ } })

// ── 用 stub ctx 捕获注册的工具 ──
function captureTools(config = {}) {
  const tools = []
  const ctx = {
    effect(fn) { fn(); return () => {} },
    tools: { register(def) { tools.push(def); return { dispose() {} } } },
  }
  apply(ctx, config)
  return tools
}
function toolByName(tools, name) {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`未注册工具 ${name}（共 ${tools.length}: ${tools.map((x) => x.name).join(',')}）`)
  return t
}

// ── C6: normalizeNodeId 边界 ──
test('normalizeNodeId：dash → colon', () => {
  assert.equal(normalizeNodeId('110-854'), '110:854')
})
test('normalizeNodeId：colon 原样', () => {
  assert.equal(normalizeNodeId('110:854'), '110:854')
})
test('normalizeNodeId：首尾空格 trim 掉', () => {
  assert.equal(normalizeNodeId('  110:854  '), '110:854')
  assert.equal(normalizeNodeId('\t110-854\n'), '110:854')
})
test('normalizeNodeId：URL 编码（%3A 冒号 / %20 空格）', () => {
  assert.equal(normalizeNodeId('110%3A854'), '110:854')
  assert.equal(normalizeNodeId('110%3A854%20'), '110:854')
  assert.equal(normalizeNodeId('%20110-854'), '110:854')
})
test('normalizeNodeId：非法格式一律抛明确错误（绝不猜节点）', () => {
  for (const bad of ['', '   ', '110', 'abc', '11a:854', '110:854:1', '110_854', '1-2-3', '110%ZZ854']) {
    assert.throws(() => normalizeNodeId(bad), /node-id|node_id|非法/i, `应拒绝 ${JSON.stringify(bad)}`)
  }
})

// ── 工具注册面 ──
test('apply 注册了 figma_codegen_round / figma_visual_diff / figma_change_brief', () => {
  const tools = captureTools()
  for (const n of ['figma_codegen_round', 'figma_visual_diff', 'figma_change_brief']) {
    assert.ok(tools.some((t) => t.name === n), `缺少工具 ${n}`)
  }
})

// ── 公共：搭一个门禁合规的 flow 目录（除 visualDiff 可开关） ──
function makeWorkdir({ withVisualDiff = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-d2c-idx-'))
  const staticDir = join(dir, 'static')
  const genDir = join(dir, 'gen')
  mkdirSync(staticDir, { recursive: true })
  mkdirSync(genDir, { recursive: true })
  const page = join(staticDir, 'index.html')
  writeFileSync(page, '<html></html>', 'utf8')
  writeFileSync(join(staticDir, 'spec.json'), JSON.stringify({ width: 375, height: 812, rows: [] }), 'utf8')
  // 关键：CODEGEN_PROMPT 只在 gen/ 下，output_dir 传父目录 dir
  writeFileSync(join(genDir, 'CODEGEN_PROMPT.md'), '# prompt\n', 'utf8')
  const flow = {
    stage: 'skeleton_generated', nodeId: '110:854', fileKey: 'ABC',
    confirmed: true, confirmedVia: 'human', gateVersion: 3, baselineRenderer: 2,
    expertReviewRequired: false, staticPage: page,
    ...(withVisualDiff ? { visualDiff: { at: new Date().toISOString(), checked: true, findings: 0, clean: true, reportPath: '/r' } } : {}),
    updatedAt: new Date().toISOString(),
  }
  writeFileSync(join(dir, 'flow.json'), JSON.stringify(flow, null, 2), 'utf8')
  return dir
}

// ── R7: findGenDir 拿到 gen/ 下的 CODEGEN_PROMPT ──
test('codegen_round：output_dir 传父目录，gen/ 下有 CODEGEN_PROMPT → 成功，round 文件落 gen/review', async () => {
  const dir = makeWorkdir()
  try {
    const tool = toolByName(captureTools(), 'figma_codegen_round')
    const out = await tool.execute({ output_dir: dir, round_feedback: '第一轮对照' })
    assert.match(out, /第 1 轮|第 2 轮|已追加/)
    const roundFile = join(dir, 'gen', 'review', '.codegen-round')
    assert.ok(existsSync(roundFile), `round 文件应落在 gen/review：${roundFile}`)
    assert.ok(Number(readFileSync(roundFile, 'utf8')) >= 1)
    // CODEGEN_PROMPT 被追加了迭代指令
    assert.match(readFileSync(join(dir, 'gen', 'CODEGEN_PROMPT.md'), 'utf8'), /第 \d+ 轮迭代/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── R2: 门禁经 codegen_round 生效 ──
test('codegen_round：缺 visualDiff 的 confirmed flow → 拒绝收尾', async () => {
  const dir = makeWorkdir({ withVisualDiff: false })
  try {
    const tool = toolByName(captureTools(), 'figma_codegen_round')
    await assert.rejects(
      () => tool.execute({ output_dir: dir, round_feedback: 'x' }),
      /visualDiff|视觉回归/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('codegen_round：visualDiff.clean=true → 放行', async () => {
  const dir = makeWorkdir({ withVisualDiff: true })
  try {
    const tool = toolByName(captureTools(), 'figma_codegen_round')
    const out = await tool.execute({ output_dir: dir, round_feedback: 'ok' })
    assert.match(out, /已追加/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 新需求：figma_visual_diff 的 node_id 单组件过滤 ──
function makeVisualWorkdir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-d2c-vdidx-'))
  const staticDir = join(dir, 'static')
  mkdirSync(staticDir, { recursive: true })
  writeFileSync(join(staticDir, 'index.html'), '<html></html>', 'utf8')
  const rows = [
    { id: '1:1', name: 'Root', kind: 'root', x: 0, y: 0, w: 400, h: 600 },
    { id: '1:10', name: 'Section Alpha', kind: 'frame', x: 0, y: 0, w: 350, h: 150 },
    { id: '1:11', name: 'T11', kind: 'text', x: 10, y: 20, w: 300, h: 20 },
    { id: '1:12', name: 'T12', kind: 'text', x: 10, y: 50, w: 300, h: 20 },
    { id: '1:20', name: 'Section Beta', kind: 'frame', x: 0, y: 200, w: 350, h: 150 },
    { id: '1:21', name: 'T21', kind: 'text', x: 10, y: 220, w: 300, h: 20 },
  ]
  writeFileSync(join(staticDir, 'spec.json'), JSON.stringify({ width: 400, height: 600, rows }), 'utf8')
  const tree = {
    id: '1:1', children: [
      { id: '1:10', children: [{ id: '1:11', children: [] }, { id: '1:12', children: [] }] },
      { id: '1:20', children: [{ id: '1:21', children: [] }] },
    ],
  }
  // 一个"树里有、spec.rows 里没有"的节点，用来触发空 rows 抛错
  tree.children.push({ id: '9:9', children: [{ id: '9:10', children: [] }] })
  writeFileSync(join(dir, 'design-spec.json'), JSON.stringify({ tree }), 'utf8')
  writeFileSync(join(dir, 'flow.json'), JSON.stringify({
    stage: 'skeleton_generated', nodeId: '1:1', fileKey: 'TEST',
    confirmed: true, confirmedVia: 'human', gateVersion: 3, baselineRenderer: 2,
    expertReviewRequired: false, staticPage: join(staticDir, 'index.html'),
    updatedAt: new Date().toISOString(),
  }), 'utf8')
  writeFileSync(join(dir, 'impl.html'), '<html></html>', 'utf8')
  return dir
}
function toolVd() { return toolByName(captureTools(), 'figma_visual_diff') }

test('figma_visual_diff：不传 node_id → 整页 rows 原样传给 visualDiff（行为不变）', async () => {
  const dir = makeVisualWorkdir()
  try {
    globalThis.__LAST_VD_ROWS__ = null
    const out = await toolVd().execute({ output_dir: dir, impl: join(dir, 'impl.html') })
    assert.match(out, /自动视觉回归/)
    assert.deepEqual(globalThis.__LAST_VD_ROWS__, ['1:1', '1:10', '1:11', '1:12', '1:20', '1:21'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('figma_visual_diff：node_id dash（1-10）→ 只比对该组件子树 rows', async () => {
  const dir = makeVisualWorkdir()
  try {
    globalThis.__LAST_VD_ROWS__ = null
    const out = await toolVd().execute({ output_dir: dir, impl: join(dir, 'impl.html'), node_id: '1-10' })
    assert.match(out, /单组件 node_id=1:10/)
    assert.deepEqual(globalThis.__LAST_VD_ROWS__, ['1:10', '1:11', '1:12'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('figma_visual_diff：node_id colon（1:20）→ 只比对该组件子树 rows', async () => {
  const dir = makeVisualWorkdir()
  try {
    globalThis.__LAST_VD_ROWS__ = null
    await toolVd().execute({ output_dir: dir, impl: join(dir, 'impl.html'), node_id: '1:20' })
    assert.deepEqual(globalThis.__LAST_VD_ROWS__, ['1:20', '1:21'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('figma_visual_diff：node_id 找不到节点 → 抛明确错误（不静默整页对比）', async () => {
  const dir = makeVisualWorkdir()
  try {
    await assert.rejects(
      () => toolVd().execute({ output_dir: dir, impl: join(dir, 'impl.html'), node_id: '8-8' }),
      /找不到|node_id/,
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('figma_visual_diff：node_id 过滤后 rows 为空 → 抛明确错误（不静默 clean:true）', async () => {
  const dir = makeVisualWorkdir()
  try {
    await assert.rejects(
      () => toolVd().execute({ output_dir: dir, impl: join(dir, 'impl.html'), node_id: '9-9' }),
      /rows 为空|spec\.rows|clean:true/,
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('figma_visual_diff：工具参数面含 node_id（dash/colon 说明）', () => {
  const t = toolVd()
  const nodeIdParam = t.parameters.properties?.node_id
  assert.ok(nodeIdParam, '参数面应有 node_id')
  assert.match(nodeIdParam.description, /dash\/colon/)
})
