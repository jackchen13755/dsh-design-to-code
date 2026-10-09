/**
 * 变更模式（改现有页面）：设计稿多代共存，需求往往只是"在现有页面上动几处"。
 * 这时不该生成整页骨架，而应该产出**变更清单**：
 *   1. 旧稿 vs 新稿的设计差异（哪些节点新增/删除/改了尺寸/描边/圆角/字体/文案）
 *   2. 代码落点候选（在目标仓库里按设计文案/关键字定位现有实现）
 *   3. 逐条变更计划（设计 X → 现状 Y → 改法 → 验证方式）
 *
 * 注意：设计稿里**同名画板多代共存**是常态（实测同一文件里 132:7415 与 132:8008 两代抽屉、
 * anchor 132:7644 与 132:8239 两代导航，逐项规格相同、只有容器高度不同）。
 * 所以做差异前必须拿准 node-id，并用"结构 + 尺寸"双维度匹配，不能只按名字。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DesignModel, DesignNode } from './design.js'

export interface DiffItem {
  kind: 'added' | 'removed' | 'changed'
  key: string
  name: string
  type: string
  fields?: Array<{ field: string; from: string; to: string }>
  newNode?: DesignNode
  oldNode?: DesignNode
}

export interface CodeHit {
  file: string
  line: number
  text: string
  keyword: string
}

function flat(model: DesignModel): DesignNode[] {
  const out: DesignNode[] = []
  const walk = (n: DesignNode): void => {
    if (n.raw.visible === false) return
    out.push(n)
    for (const c of n.children) walk(c)
  }
  walk(model.tree)
  return out.filter((n) => n.kind !== 'root')
}

/**
 * 匹配键：类型 + 图层名（同名多代时用出现序号区分）。
 * **故意不带尺寸**：带了尺寸的话，"改大/改小"会被算成"删一个 + 加一个"，
 * 而尺寸变化恰恰是改现有页面时最需要看到的差异。
 */
function keyOf(n: DesignNode, seq: Map<string, number>): string {
  const base = `${n.type}|${n.name}`
  const i = seq.get(base) ?? 0
  seq.set(base, i + 1)
  return `${base}#${i}`
}

function sig(n: DesignNode): Record<string, string> {
  return {
    位置: `${n.x},${n.y}`,
    尺寸: `${n.w}x${n.h}`,
    背景: n.background ?? '',
    描边: n.border ? `${n.border.color} ${n.border.top}/${n.border.right}/${n.border.bottom}/${n.border.left}` : '',
    圆角: n.radius ?? '',
    字体: n.text ? `${n.text.family} ${n.text.weight} ${n.text.size}px${n.text.lineHeight ? `/${n.text.lineHeight}` : ''} ${n.text.color ?? ''}` : '',
    文案: n.kind === 'text' || n.type === 'INSTANCE' ? (n.value ?? '') : '',
    布局: n.layout ? `${n.layout.mode ?? '-'} spacing=${n.layout.spacing ?? '-'}` : '',
    阴影: n.shadow ?? '',
  }
}

export function diffModels(oldModel: DesignModel | null, newModel: DesignModel): DiffItem[] {
  const items: DiffItem[] = []
  if (!oldModel) return items
  const oldSeq = new Map<string, number>()
  const newSeq = new Map<string, number>()
  const oldMap = new Map<string, DesignNode>()
  for (const n of flat(oldModel)) oldMap.set(keyOf(n, oldSeq), n)
  const seen = new Set<string>()

  for (const n of flat(newModel)) {
    const k = keyOf(n, newSeq)
    seen.add(k)
    const o = oldMap.get(k)
    if (!o) {
      items.push({ kind: 'added', key: k, name: n.name, type: n.type, newNode: n })
      continue
    }
    const a = sig(o)
    const b = sig(n)
    const fields = Object.keys(b)
      .filter((f) => a[f] !== b[f])
      .map((f) => ({ field: f, from: a[f], to: b[f] }))
    if (fields.length) items.push({ kind: 'changed', key: k, name: n.name, type: n.type, fields, newNode: n, oldNode: o })
  }
  for (const [k, o] of oldMap) {
    if (!seen.has(k)) items.push({ kind: 'removed', key: k, name: o.name, type: o.type, oldNode: o })
  }
  return items
}

const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|out|__snapshots__|\.cache)(\/|$)/
const CODE_EXT = /\.(ts|tsx|js|jsx|less|css|scss|vue|svelte|json|html)$/

/** 从设计稿里提取"可以被 grep 到"的关键字：可见文案（中文/英文标签）优先 */
/** 过于通用的词，拿去 grep 只会命中一堆无关代码（实测 "ID"/"Type" 一个词就能刷满 300 条） */
const GENERIC = new Set([
  'id', 'type', 'name', 'add', 'save', 'cancel', 'ok', 'yes', 'no', 'new', 'edit', 'delete',
  'mobile', 'email', 'address', 'language', 'gender', 'nation', 'company', 'position', 'postal',
  'detail', 'statement', 'partner', 'promo', 'sl', 'input', 'select', 'button', 'radio', 'text',
  'title', 'header', 'body', 'row', 'content', 'container', 'frame', 'label', 'value', 'status',
])

export function keywordsOf(model: DesignModel, limit = 30): string[] {
  const out: string[] = []
  const push = (s?: string): void => {
    const v = String(s ?? '').trim()
    if (!v || v.length < 2) return
    if (/^[\d\s.,:;()\[\]{}<>/*+=—-]+$/.test(v)) return // 纯符号/数字不要
    if (v.length > 24) return
    if (GENERIC.has(v.toLowerCase())) return
    // 纯 ASCII 的词至少 4 个字符才算有区分度（ID/Type/Add 这种直接跳过）
    if (/^[\x20-\x7e]+$/.test(v) && v.length < 4) return
    if (!out.includes(v)) out.push(v)
  }
  // 先收"有区分度的长文案"，再收短的：这样截断时留下的都是好关键词
  const texts = [
    ...model.spec.filter((r) => r.text && !r.text.startsWith('（实例文案）')).map((r) => r.text!),
    ...model.texts.map((t) => t.text),
    ...model.spec.filter((r) => r.text?.startsWith('（实例文案）')).map((r) => r.text!.replace('（实例文案）', '')),
  ]
  const scored = [...new Set(texts)].sort((a, b) => b.length - a.length)
  for (const t of scored) push(t)
  return out.slice(0, limit)
}

/** 在目标仓库里找设计文案/关键字的落点（有界遍历，跳过产物目录） */
export function findCodeHits(
  codeDir: string,
  keywords: string[],
  opts: { maxFiles?: number; maxHits?: number; extra?: string[] } = {},
): { hits: CodeHit[]; scanned: number; truncated: boolean } {
  const maxFiles = opts.maxFiles ?? 4000
  const maxHits = opts.maxHits ?? 300
  const needles = [...keywords, ...(opts.extra ?? [])].filter((k) => k && k.length >= 2)
  const hits: CodeHit[] = []
  let scanned = 0
  let truncated = false

  const stack: string[] = [codeDir]
  while (stack.length) {
    if (scanned >= maxFiles || hits.length >= maxHits) { truncated = true; break }
    const dir = stack.pop()!
    let entries: string[]
    try { entries = readdirSync(dir) } catch { continue }
    for (const e of entries) {
      const p = join(dir, e)
      if (SKIP_DIR.test(p)) continue
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { stack.push(p); continue }
      if (!CODE_EXT.test(p) || st.size > 512 * 1024) continue
      scanned++
      let text = ''
      try { text = readFileSync(p, 'utf8') } catch { continue }
      if (!text) continue
      const lines = text.split('\n')
      for (const kw of needles) {
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(kw)) {
            hits.push({ file: p, line: i + 1, text: lines[i].trim().slice(0, 200), keyword: kw })
            if (hits.length >= maxHits) { truncated = true; break }
          }
        }
        if (hits.length >= maxHits) break
      }
      if (hits.length >= maxHits) break
    }
  }
  return { hits, scanned, truncated }
}

export interface ChangeBriefInput {
  newModel: DesignModel
  oldModel: DesignModel | null
  project?: string
  codeDir?: string
  codeHits?: { hits: CodeHit[]; scanned: number; truncated: boolean }
  keywords: string[]
  staticPagePath?: string
  specPath?: string
}

export function renderChangeMarkdown(input: ChangeBriefInput): string {
  const { newModel, oldModel, project, codeDir, codeHits, keywords } = input
  const diff = diffModels(oldModel, newModel)
  const L: string[] = []
  L.push(`# 变更简报：${newModel.componentName}（${newModel.fileKey} · ${newModel.nodeId}）`)
  L.push('')
  L.push(`- 新稿节点：${newModel.spec.length} · 画布 ${newModel.width}×${newModel.height}`)
  if (oldModel) {
    L.push(`- 旧稿：${oldModel.nodeId}（${oldModel.componentName}）${oldModel.width}×${oldModel.height}`)
    if (oldModel.width !== newModel.width || oldModel.height !== newModel.height) {
      L.push('')
      L.push(`> ⚠️ 两稿根节点尺寸不同（旧 ${oldModel.width}×${oldModel.height} vs 新 ${newModel.width}×${newModel.height}），`)
      L.push('> 说明它们的坐标原点/包裹层级可能不一样（例如旧稿给的是 content-wrapper、新稿给的是整屏画板）。')
      L.push('> 此时"位置"差异会大面积出现，属于坐标空间不同，**不要逐条去改位置**；')
      L.push('> 请换成同一层级的节点再比一次（例如都取抽屉的 content-wrapper），或只看尺寸/描边/圆角/字体/文案差异。')
      L.push('')
    }
    const c = diff.filter((d) => d.kind === 'changed').length
    const a = diff.filter((d) => d.kind === 'added').length
    const r = diff.filter((d) => d.kind === 'removed').length
    L.push(`- 设计差异：**改动 ${c} · 新增 ${a} · 删除 ${r}**`)
  } else {
    L.push('- 未提供旧稿：按"新稿全量规格"对现有实现逐项核对（见 §3 落点 + §4 计划模板）')
  }
  if (project) L.push(`- 目标项目：${project}`)
  if (input.specPath) L.push(`- 设计规格/映射表：${input.specPath}`)
  if (input.staticPagePath) L.push(`- 视觉基准页（改造后要与它对照）：${input.staticPagePath}`)
  L.push('')
  L.push('> 改现有页面的原则：**不重画已有组件**，只在既有结构上做最小改动；')
  L.push('> 差异逐条落到"哪个文件哪一行"，并用 computed style 实测核对（逐边描边/逐角圆角/控件高度/字体大小）。')
  L.push('')

  L.push('## 1. 设计差异（旧稿 → 新稿）')
  L.push('')
  if (!oldModel) {
    L.push('（未给旧稿，跳过；可传 old_node_id / old_design_json 拿到逐字段差异）')
  } else if (!diff.length) {
    L.push('（两稿逐字段一致——注意这可能意味着"选错了旧稿"，同名画板多代共存，请核对 node-id）')
  } else {
    L.push('| 类型 | 节点 | 字段 | 旧 | 新 |')
    L.push('|---|---|---|---|---|')
    const order = { changed: 0, added: 1, removed: 2 } as const
    const sorted = [...diff].sort((a, b) => order[a.kind] - order[b.kind])
    for (const d of sorted.slice(0, 300)) {
      if (d.kind === 'changed') {
        for (const f of d.fields ?? []) {
          L.push(`| 改动 | ${d.name} (${d.type}) | ${f.field} | ${f.from || '—'} | ${f.to || '—'} |`)
        }
      } else {
        const n = d.newNode ?? d.oldNode
        L.push(`| ${d.kind === 'added' ? '新增' : '删除'} | ${d.name} (${d.type}) | — | ${d.kind === 'removed' ? `${n?.w}×${n?.h} @(${n?.x},${n?.y})` : '—'} | ${d.kind === 'added' ? `${n?.w}×${n?.h} @(${n?.x},${n?.y})` : '—'} |`)
      }
    }
    if (diff.length > 300) L.push(`| … | 共 ${diff.length} 条，已截断 | | | |`)
  }
  L.push('')

  L.push('## 2. 用于定位代码的关键字（从设计文案提取）')
  L.push('')
  L.push('```')
  L.push(keywords.join(' | '))
  L.push('```')
  L.push('')

  L.push('## 3. 代码落点候选')
  L.push('')
  if (!codeDir) {
    L.push('（未传 code_dir，跳过。传入目标仓库目录可自动 grep 出候选落点）')
  } else if (!codeHits || !codeHits.hits.length) {
    L.push(`（在 ${codeDir} 扫描 ${codeHits?.scanned ?? 0} 个文件，没命中关键字——可能文案走 i18n 资源文件，或该区域尚未实现）`)
  } else {
    L.push(`扫描 ${codeHits.scanned} 个文件，命中 ${codeHits.hits.length} 条${codeHits.truncated ? '（已截断）' : ''}：`)
    L.push('')
    L.push('| 文件 | 行 | 关键字 | 内容 |')
    L.push('|---|---|---|---|')
    for (const h of codeHits.hits.slice(0, 200)) {
      L.push(`| ${h.file} | ${h.line} | ${h.keyword} | ${h.text.replace(/\|/g, '\\|')} |`)
    }
  }
  L.push('')

  L.push('## 4. 变更计划模板（逐条填完再动手）')
  L.push('')
  L.push('| # | 设计（新稿） | 现状（代码实测） | 改法（文件:行） | 验证方式 |')
  L.push('|---|---|---|---|---|')
  const rows = oldModel && diff.length
    ? diff.filter((d) => d.kind === 'changed' || d.kind === 'added').slice(0, 60)
    : newModel.spec.filter((r) => r.borderEdges || r.radius || r.font).slice(0, 60)
  rows.forEach((r, i) => {
    if ('kind' in r) {
      const d = r as DiffItem
      if (d.kind === 'changed') {
        const f = (d.fields ?? []).map((x) => `${x.field}: ${x.from || '—'} → ${x.to}`).join('；')
        L.push(`| ${i + 1} | ${d.name}（${f}） | | | computed style 实测 |`)
      } else {
        const n = d.newNode
        L.push(`| ${i + 1} | 新增 ${d.name} ${n ? `${n.w}×${n.h} @(${n.x},${n.y})` : ''} | | | computed style 实测 |`)
      }
    } else {
      const row = r as (typeof newModel.spec)[number]
      L.push(`| ${i + 1} | ${row.name} ${row.w}×${row.h} @(${row.x},${row.y}) 描边${row.borderEdges ?? '-'} 圆角${row.radius ?? '-'} 字体${row.font ?? '-'} | | | computed style 实测 |`)
    }
  })
  L.push('')
  L.push('## 5. 收尾检查')
  L.push('')
  L.push('- [ ] 每一行"设计差异"都有对应改动，或写明"不改（并说明原因）"')
  L.push('- [ ] 没有顺手重画/重构无关区域（改现有页面最容易犯的错）')
  L.push('- [ ] 逐边描边、逐角圆角、控件高度、字体大小用 computed style 实测值对过，不是肉眼判断')
  L.push('- [ ] 色值若走主题令牌，确认在目标主题下仍与设计一致（不同主题会换色值，需产品确认口径）')
  L.push('- [ ] 视觉基准页对照通过（结构/尺寸/描边/圆角/字体）')
  L.push('')
  return L.join('\n')
}
