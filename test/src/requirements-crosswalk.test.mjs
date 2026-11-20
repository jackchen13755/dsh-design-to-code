/**
 * requirements-crosswalk.ts 单测（镜像 src/requirements-crosswalk.ts）。
 *
 * 运行（package.json 的 test 脚本不覆盖 test/，且不改 package.json）：
 *   node test/src/requirements-crosswalk.test.mjs
 *
 * 与本仓 design.test.mjs 同款：直接转译 src/*.ts 源码 + data: URL 导入，
 * 跑的是本席位写的源码，而非别的席位尚未 rebuild 的 lib/ 产物。
 * 本模块只 import type 设计类型，转译后被擦除，无需 design.ts 的运行期实现。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..') // 仓根 dsh-design-to-code

const src = readFileSync(resolve(ROOT, 'src', 'requirements-crosswalk.ts'), 'utf8')
const js = ts.transpileModule(src, {
  fileName: 'requirements-crosswalk.ts',
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
const { renderRequirementsCrosswalk, CROSSWALK_TITLE, CROSSWALK_HEADER, CROSSWALK_GUIDANCE } = mod

// ── 契约字面量：在测试里独立写死，避免"源码自证" ──────────────────────
const TITLE = '## 需求交互点 ↔ UI 交互标注 对照表（逐条落实）'
const HEADER = '| 需求交互点 | UI标注(备注N) | 对照状态 | 承载 props/state | 事件 | 真实控件/行为 | 文件 | 验证 |'
const GUIDANCE = "每一条需求交互点与每一条 UI 标注都必须登记；两侧不许静默遗漏。对照状态为'未覆盖'的也要按对应来源实现并在验证列说明。"

/** 造一条 DesignAnnotation（本函数只读 title/text，其余字段给合法占位） */
function ann(title, text) {
  return {
    id: title, title, text, x: 0, y: 0, w: 0, h: 0,
    detectedBy: [], variantIds: [], variantNames: [], signals: [],
    confidence: 1, disposition: 'auto', scope: 'single',
  }
}

/** 只取真正的数据行（排除标题、表头、分隔行） */
function dataRows(out) {
  return out.split('\n').filter(
    (l) => l.startsWith('| ') && !l.startsWith('| 需求交互点 ') && !l.startsWith('|---'),
  )
}

// ── 接口契约：标题/表头/指引逐字一致 ──────────────────────────────────
test('契约：导出函数与固定标题/表头/指引逐字一致', () => {
  assert.equal(typeof renderRequirementsCrosswalk, 'function', '缺少 renderRequirementsCrosswalk')
  const out = renderRequirementsCrosswalk('点击日期筛选弹出选择器', [ann('日期范围', '选2个日期后收起')])
  assert.ok(out.startsWith(TITLE + '\n'), '标题必须是首行且逐字一致')
  assert.ok(out.includes(HEADER), '表头必须逐字一致')
  assert.ok(out.includes(GUIDANCE), '段末指引必须逐字一致')
  assert.equal(CROSSWALK_TITLE, TITLE)
  assert.equal(CROSSWALK_HEADER, HEADER)
  assert.equal(CROSSWALK_GUIDANCE, GUIDANCE)
})

// ── 需求行 + 备注共享关键词 → 已对应 ──────────────────────────────────
test('需求行与备注共享关键词 → 已对应，两侧原文都保留，备注按序号', () => {
  const out = renderRequirementsCrosswalk(
    '点击日期筛选弹出选择器',
    [ann('日期范围', '选2个日期后收起选择器')],
  )
  const rows = dataRows(out)
  assert.equal(rows.length, 1, `期望 1 行，实际 ${rows.length}`)
  assert.match(rows[0], /点击日期筛选弹出选择器/, '需求原文须保留')
  assert.match(rows[0], /备注1/, 'UI 标注须编号 备注1')
  assert.match(rows[0], /日期范围/, '备注 title 须出现')
  assert.match(rows[0], /已对应/)
})

// ── 只有需求：UI 列写 UI未覆盖 ────────────────────────────────────────
test('只有需求交互点：UI 列写 UI未覆盖，状态为按需求实现', () => {
  const out = renderRequirementsCrosswalk('点击筛选弹出选择器', [])
  const rows = dataRows(out)
  assert.equal(rows.length, 1)
  assert.match(rows[0], /\| UI未覆盖 \|/)
  assert.match(rows[0], /UI未覆盖→按需求实现/)
  assert.ok(!out.includes('备注1'), '无备注时不应出现备注编号')
})

// ── 只有备注：需求列写 需求未提及 ──────────────────────────────────────
test('只有 UI 标注：需求列写 需求未提及，状态为按设计实现', () => {
  const out = renderRequirementsCrosswalk('', [ann('日期范围', '选2个日期后收起')])
  const rows = dataRows(out)
  assert.equal(rows.length, 1)
  assert.match(rows[0], /\| 需求未提及 \|/)
  assert.match(rows[0], /需求未提及→按设计实现/)
  assert.match(rows[0], /备注1/)
})

// ── 都空 → 空字符串 ────────────────────────────────────────────────────
test('两侧都空返回空字符串（不生成空表）', () => {
  assert.equal(renderRequirementsCrosswalk('', []), '')
  assert.equal(renderRequirementsCrosswalk('   \n  ', []), '')
  assert.equal(renderRequirementsCrosswalk('', null), '')
})

// ── 需求无动作句 → 只列 UI 标注 ────────────────────────────────────────
test('需求文本无动作句：只列 UI 标注，需求列写 需求未提及', () => {
  const out = renderRequirementsCrosswalk(
    '这是一段没有任何交互动词的描述文本',
    [ann('日期范围', '选2个日期后收起')],
  )
  const rows = dataRows(out)
  assert.equal(rows.length, 1, '不应为无动作句的需求生成行')
  assert.match(rows[0], /需求未提及→按设计实现/)
})

// ── 关键词粗匹配保守性 ─────────────────────────────────────────────────
test('粗匹配保守：两侧都有行为动词但无共享内容词 → 不标已对应', () => {
  const out = renderRequirementsCrosswalk(
    '点击提交按钮后跳转到成功页',
    [ann('输入焦点', '输入手机号时显示校验提示')],
  )
  assert.equal(dataRows(out).length, 2, '需求与备注应各自成行')
  assert.ok(!out.includes('已对应'), '仅有动作动词不构成匹配，不得错配')
  assert.match(out, /UI未覆盖→按需求实现/)
  assert.match(out, /需求未提及→按设计实现/)
})

// ── 多对多：编号稳定 + 原文保留 ────────────────────────────────────────
test('多需求 vs 多备注：一对一匹配、备注编号稳定、原文逐字保留', () => {
  const out = renderRequirementsCrosswalk(
    '点击日期筛选弹出选择器\n切换语言显示中文\n拖动滑块调整数值',
    [ann('日期范围', '选2个日期后收起'), ann('语言切换', '点击语言按钮切换中英文')],
  )
  assert.equal(dataRows(out).length, 3)
  assert.ok(out.includes('备注1'), '应含 备注1')
  assert.ok(out.includes('备注2'), '应含 备注2')
  assert.equal((out.match(/已对应/g) || []).length, 2, '应有 2 行已对应')
  assert.match(out, /UI未覆盖→按需求实现/, '第 3 条需求无对应备注')
  assert.ok(out.includes('切换语言显示中文'), '需求原文须逐字保留')
  assert.ok(out.includes('拖动滑块调整数值'), '需求原文须逐字保留')
})

// ── 单元格转义 ─────────────────────────────────────────────────────────
test('单元格中的竖线被转义，不撑破表格', () => {
  const out = renderRequirementsCrosswalk('点击 A|B 按钮', [])
  assert.ok(out.includes('A\\|B'), '竖线应转义为 \\|')
})

// ── 通用 UI 名词不得构成匹配（评审 P2）──────────────────────────────────
test('共享通用名词「按钮」不算对应：提交按钮 vs 删除按钮不得错配', () => {
  const out = renderRequirementsCrosswalk(
    '点击提交按钮后跳转到成功页',
    [ann('删除确认', '长按删除按钮确认移除')],
  )
  // 需求行与备注行都应标"未覆盖/未提及"，绝不出现"已对应"
  assert.ok(!out.includes('已对应'), `共享"按钮"这种通用名词不得判为已对应，实际：\n${out}`)
})
