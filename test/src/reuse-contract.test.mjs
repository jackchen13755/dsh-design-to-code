/**
 * reuse-contract.ts 单测（镜像 src/reuse-contract.ts）：
 *  ① 壳层 role=shell、遮罩入 omit、body/header 入 content
 *  ② 控件层 Input/Select/Tag 命中（catalog → code-dir confirmed）
 *  ③ 无 catalog → confirmed=0、全 suspected
 *  ④ 显式 contracts → confirmed
 *  ⑤ 同一 planner 跑 Modal/Card 合成树也得 shell/content（非特化）
 *  ⑥ 源码无具体组件名硬编码（抽屉/drawer）
 *  + 真实样本 51-1245：suspected 契约（51:1247 shell / 51:1246 omit / 51:1248 symbol-instance）
 *
 * 运行：node test/src/reuse-contract.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const TMP = mkdtempSync(join(tmpdir(), 'd2c-reuse-test-'))
for (const m of ['design', 'reuse-contract']) {
  const js = ts.transpileModule(readFileSync(join(ROOT, 'src', m + '.ts'), 'utf8'), {
    fileName: m + '.ts',
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  writeFileSync(join(TMP, m + '.js'), js, 'utf8')
}
const { buildDesignModel } = await import('file://' + join(TMP, 'design.js'))
const { planComponentReuse, writeComponentCatalog, readComponentCatalog } = await import('file://' + join(TMP, 'reuse-contract.js'))

/* ── 合成 DesignNode 工厂 ─────────────────────────────────── */
function mk(id, name, type, w, h, children = [], extra = {}) {
  const raw = { visible: true, type, name, ...(extra.raw || {}) }
  return {
    id, type, name,
    kind: type === 'TEXT' ? 'text' : type === 'INSTANCE' ? 'instance' : 'frame',
    rx: extra.rx ?? 0, ry: extra.ry ?? 0, x: extra.x ?? 0, y: extra.y ?? 0,
    w, h, children, raw,
  }
}
const symRaw = (sid, lid) => ({ symbolData: { symbolID: { sessionID: sid, localID: lid } } })

const catalog = [
  { name: 'Input', importPath: '@/components/Input', props: ['value', 'onChange'], slots: [], sourceFile: 'src/components/Input.tsx' },
  { name: 'Select', importPath: '@/components/Select', props: ['options', 'value', 'onChange'], slots: [], sourceFile: 'src/components/Select.tsx' },
  { name: 'Tag', importPath: '@/components/Tag', props: ['text', 'color'], slots: [], sourceFile: 'src/components/Tag.tsx' },
]

function shellTree() {
  const mask = mk('1:2', 'BG', 'RECTANGLE', 1000, 800)
  const titlebar = mk('1:4', 'Titlebar', 'INSTANCE', 600, 50, [], { raw: symRaw(9, 9) })
  const header = mk('1:5', 'Header', 'FRAME', 600, 60)
  const body = mk('1:6', 'Body', 'FRAME', 600, 690)
  const shell = mk('1:3', 'Settings Panel', 'FRAME', 600, 800, [titlebar, header, body])
  const root = mk('1:1', 'Canvas', 'FRAME', 1000, 800, [mask, shell])
  return { root, mask, shell, titlebar, header, body }
}

/* ── ① 壳层 ──────────────────────────────────────────────── */
test('① 壳层 role=shell、遮罩入 omit、body/header 入 content', () => {
  const { root, mask, shell, titlebar, header, body } = shellTree()
  const cs = planComponentReuse(root, { policy: 'auto' })
  const sh = cs.find((c) => c.designNodeId === shell.id)
  assert.ok(sh, '应产出壳层契约')
  assert.equal(sh.role, 'shell')
  assert.equal(sh.level, 'shell')
  assert.ok(sh.slot.omitDesignNodeIds.includes(mask.id), '满画布遮罩应入 omit')
  assert.ok(sh.slot.omitDesignNodeIds.includes(titlebar.id), '标题栏应入 omit')
  assert.ok(sh.slot.contentDesignNodeIds.includes(header.id), 'header 应入 content')
  assert.ok(sh.slot.contentDesignNodeIds.includes(body.id), 'body 应入 content')
})

/* ── ② 控件层 ────────────────────────────────────────────── */
test('② 控件层 Input/Select/Tag 命中（catalog code-dir confirmed）', () => {
  const input = mk('2:2', 'Input', 'FRAME', 300, 40)
  const select = mk('2:3', 'Select', 'FRAME', 300, 40)
  const tag = mk('2:4', 'Tag', 'FRAME', 100, 30)
  const root = mk('2:1', 'Canvas', 'FRAME', 1000, 800, [input, select, tag])
  const cs = planComponentReuse(root, { policy: 'auto', catalog })
  for (const [n, nm] of [[input, 'Input'], [select, 'Select'], [tag, 'Tag']]) {
    const c = cs.find((x) => x.designNodeId === n.id)
    assert.ok(c, `${nm} 应命中`)
    assert.equal(c.role, 'control')
    assert.equal(c.level, 'control')
    assert.equal(c.match.source, 'code-dir')
    assert.equal(c.match.status, 'confirmed')
    assert.equal(c.projectComponent, nm)
    assert.deepEqual(c.slot.omitDesignNodeIds, [], '控件层整节点替换、无 omit')
  }
})

/* ── ③ 无 catalog → 全 suspected ─────────────────────────── */
test('③ 无 catalog 时 confirmed=0、全 suspected', () => {
  const { root } = shellTree()
  const cs = planComponentReuse(root, { policy: 'auto' })
  assert.ok(cs.length >= 2, '仍应产出疑似契约')
  assert.equal(cs.filter((c) => c.match.status === 'confirmed').length, 0, '无 catalog 不应有 confirmed')
  assert.ok(cs.every((c) => c.match.status === 'suspected'), '全部 suspected')
  assert.ok(cs.every((c) => c.match.source !== 'code-dir' && c.match.source !== 'explicit'))
})

/* ── ④ 显式契约 → confirmed ──────────────────────────────── */
test('④ 显式 contracts 标 confirmed', () => {
  const { root } = shellTree()
  const explicit = [{
    id: 'exp-1', designNodeId: 'custom:99', designName: 'Custom', level: 'business', role: 'content',
    projectComponent: 'ProjectCustom', match: { source: 'explicit', confidence: 1, status: 'suspected', evidence: 'author-specified' },
    slot: { contentDesignNodeIds: [], omitDesignNodeIds: [] }, verify: { nodeId: 'custom:99', note: 'explicit' },
  }]
  const cs = planComponentReuse(root, { policy: 'auto', contracts: explicit })
  const e = cs.find((c) => c.id === 'exp-1')
  assert.ok(e)
  assert.equal(e.match.status, 'confirmed', '显式契约应被标 confirmed')
  assert.equal(e.match.source, 'explicit')
})

/* ── ⑤ 非特化：Modal/Card 合成树也得 shell/content ───────── */
test('⑤ 同一 planner 跑 Modal/Card 合成树也得 shell/content', () => {
  for (const [name, frameName, w, h] of [
    ['Modal', 'Confirm Modal', 600, 500],
    ['Card', 'User Card', 400, 300],
  ]) {
    const h1 = mk('3:' + name + ':h', name + ' Header', 'FRAME', w, 40)
    const b1 = mk('3:' + name + ':b', name + ' Body', 'FRAME', w, h - 40)
    const panel = mk('3:' + name + ':p', frameName, 'FRAME', w, h, [h1, b1])
    const root = mk('3:' + name + ':r', 'Canvas', 'FRAME', 1000, 800, [panel])
    const cs = planComponentReuse(root, { policy: 'auto' })
    const sh = cs.find((c) => c.role === 'shell' && c.designNodeId === panel.id)
    assert.ok(sh, `${name} 应识别出 shell`)
    assert.ok(sh.slot.contentDesignNodeIds.includes(h1.id), `${name} header 应入 content`)
    assert.ok(sh.slot.contentDesignNodeIds.includes(b1.id), `${name} body 应入 content`)
  }
})

/* ── ⑥ 无具体组件名硬编码 ────────────────────────────────── */
test('⑥ 源码无具体组件名硬编码（抽屉/drawer）', () => {
  for (const f of ['reuse-contract.ts', 'componentize.ts', 'types.d.ts']) {
    const src = readFileSync(join(ROOT, 'src', f), 'utf8')
    assert.ok(!/抽屉|drawer/i.test(src), `${f} 不应含 抽屉/drawer 硬编码`)
  }
})

/* ── catalog 持久化往返 ──────────────────────────────────── */
test('writeComponentCatalog/readComponentCatalog 往返 + 损坏文件兜底', () => {
  const p = join(TMP, 'gen', 'component-catalog.json')
  writeComponentCatalog(catalog, p)
  assert.deepEqual(readComponentCatalog(p), catalog)
  const bad = join(TMP, 'bad.json')
  writeFileSync(bad, '{broken')
  assert.deepEqual(readComponentCatalog(bad), [], '损坏文件返回空数组')
  assert.deepEqual(readComponentCatalog(join(TMP, 'missing.json')), [], '缺失文件返回空数组')
})

/* ── 真实样本只读核对 ────────────────────────────────────── */
test('真实样本 51-1245：suspected 契约（51:1247 shell / 51:1246 omit / 51:1248 symbol-instance）', () => {
  // 真实样本不入库；路径由调用方通过 D2C_REAL_WS_DIR 提供，默认取仓库父目录的 .verify-d2c（本机布局），
  // 文件不存在就 skip——绝不把绝对本机路径写进公开仓库。
  const dir = process.env.D2C_REAL_WS_DIR
    ?? resolve(ROOT, '..', '.verify-d2c', 'verify-effect-51-1245', '.decode')
  const file = join(dir, 'figma_OfZXdKXERGyMGqkwgWOueg_51-1245.ws.json')
  if (!existsSync(file)) {
    console.log('  [skip] 真实样本文件不存在：' + file)
    return
  }
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const model = buildDesignModel(raw)
  const cs = planComponentReuse(model.tree, { policy: 'auto' })
  const sh = cs.find((c) => c.designNodeId === '51:1247')
  assert.ok(sh, '51:1247 应产出契约')
  assert.equal(sh.role, 'shell', '51:1247 应为 shell')
  assert.equal(sh.match.status, 'suspected', '无 catalog 应 suspected')
  assert.ok(sh.slot.omitDesignNodeIds.includes('51:1246'), '满画布 BG(51:1246) 应入 omit')
  const sym = cs.find((c) => c.designNodeId === '51:1248')
  assert.ok(sym, '51:1248 应产出契约')
  assert.equal(sym.match.source, 'symbol-instance', '51:1248 应为 symbol-instance')
  assert.equal(sym.match.status, 'suspected')
})

test.after(() => rmSync(TMP, { recursive: true, force: true }))
