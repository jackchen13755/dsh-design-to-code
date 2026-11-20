/**
 * 评审闭环：把「UI 专家 / 验收专家」的整改清单变成**可追踪的轮次任务**。
 *
 * 为什么需要它：probe 能测出"逐边描边/逐角圆角/高度/字号"这类**可量化**差异，
 * 但测不出"视觉层级、信息密度、文案、一致性"这类**需要人味判断**的问题。
 * 这类问题由专家子 agent 出整改清单，然后必须能：
 *   ① 结构化进 CODEGEN_PROMPT.md（下一轮按条目改，而不是"看着办"）；
 *   ② 逐条记状态（open / closed），**未关闭的项不允许收尾**；
 *   ③ 留下"谁在什么时候提的、什么时候关的"，可审计。
 *
 * ── 这一版修掉的解析缺陷（实测：三行标准专家表格全部被判成 info → verdict=pass）──
 * 旧实现把表格行拆开后**丢掉了"级别"列**（被当噪声过滤），只拿"最长的那一格"去匹配严重级关键词，
 * 于是「锚点项应为只有左边框…」这种不含关键词的描述一律变 info，含 blocker 的一轮被判定"通过"。
 * 现在：先识别表头 → 按列名定位"级别/问题/位置/期望/实际" → 级别优先取显式列，列缺失才退回正文关键词。
 *
 * ── 作用域（scope）分区 ──
 * baseline（设计基准本身）与 implementation（实现 vs 基准）的条目分开记、分开算未关闭，
 * 避免"基准页的遗留项阻塞实现收尾"或反过来。
 */

export type ReviewSeverity = 'blocker' | 'major' | 'minor' | 'info'

export interface ReviewItem {
  id: string
  severity: ReviewSeverity
  /** 级别来自哪里：column（显式级别列）/ text（正文关键词）/ default */
  severitySource?: 'column' | 'text' | 'default'
  text: string
  location?: string
  expected?: string
  actual?: string
  /** 设计稿节点 id（如 132:8240）——用于在基准图上钉框 */
  nodeId?: string
  /** 设计稿内坐标 [x,y,w,h]（由 nodeId 解析或直接给） */
  box?: [number, number, number, number] | null
}

export type ReviewStatus = 'open' | 'closed' | 'accepted'

export interface ReviewItemState extends ReviewItem {
  /** accepted = 命中 known-diffs（已确认接受的差异），不阻塞收尾、也不再重复提出 */
  status: ReviewStatus
  closedBy?: string
  closedAt?: string
  closedNote?: string
}

export interface ReviewRoundState {
  round: number
  reviewer: string
  at: string
  source?: string
  /** 审计对象：baseline（设计基准本身）| implementation（组件实现 vs 基准） */
  scope?: 'baseline' | 'implementation'
  /** 判定：有 blocker/major → reject（打回）；否则 pass */
  verdict?: 'pass' | 'reject'
  annotatedImage?: string
  items: ReviewItemState[]
  /** 本轮没有任何问题（干净的 pass）：允许落盘，且仍然算"审计发生过" */
  emptyRound?: boolean
}

/** 已确认接受的差异（figma_confirm_static 的 diffs 落成结构化条目） */
export interface KnownDiff {
  /** 可选：只对这一条评审条目 id 生效 */
  id?: string
  /** 设计稿节点 id（命中即视为同一条） */
  nodeId?: string
  /** 属性/关键词（如 "radius" / "虚线" / "字体"），出现在条目正文里即视为同一条 */
  property?: string
  /** 自由说明 */
  note?: string
  at?: string
}

/**
 * 严重级关键词（含 UI 专家常用的 emoji / 方括号前缀 / "级别:major" 写法）。
 * 顺序：blocker → major → minor；先匹配到的算数。
 */
const SEVERITY_RULES: Array<[RegExp, ReviewSeverity]> = [
  [/🔴|\[\s*blocker\s*\]|级别\s*[:：]\s*blocker|阻断|严重|致命|blocker|critical|must.?fix|p0/i, 'blocker'],
  [/🟠|\[\s*major\s*\]|级别\s*[:：]\s*major|主要|重要|不满足|不符合|错误|major|should.?fix|p1/i, 'major'],
  [/🟡|\[\s*minor\s*\]|级别\s*[:：]\s*minor|次要|建议|优化|polish|minor|nice.?to.?have|p2|nit/i, 'minor'],
]

function severityOf(line: string): { severity: ReviewSeverity; source: 'text' | 'default' } {
  for (const [re, sev] of SEVERITY_RULES) if (re.test(line)) return { severity: sev, source: 'text' }
  return { severity: 'info', source: 'default' }
}

/** 显式级别列的值 → 严重级（认中英文，也认 P0/P1/P2 与高中低） */
function severityFromCell(cell: string): ReviewSeverity | undefined {
  const c = String(cell ?? '').trim().toLowerCase().replace(/[\s_-]/g, '')
  if (!c) return undefined
  if (/^(🔴|blocker|阻断|严重|致命|critical|p0|mustfix|高)$/.test(c)) return 'blocker'
  if (/^(🟠|major|主要|重要|p1|中)$/.test(c)) return 'major'
  if (/^(🟡|minor|次要|建议|p2|低|nit|polish)$/.test(c)) return 'minor'
  if (/^(info|提示|参考|p3)$/.test(c)) return 'info'
  return undefined
}

/** 从一行里抽文件位置：`a/b/c.tsx:12` / `a/b/c.less` / 「文件:行」 */
function locationOf(line: string): string | undefined {
  const m = line.match(/([\w@./-]+\.(?:tsx?|jsx?|less|css|scss|vue|svelte|json|html))(?::(\d+))?/)
  if (!m) return undefined
  return m[2] ? `${m[1]}:${m[2]}` : m[1]
}

function cleanCell(s: string): string {
  return s.replace(/\*\*/g, '').replace(/`/g, '').replace(/^\s*[-*+]\s+/, '').trim()
}

function isNoise(s: string): boolean {
  const t = cleanCell(s)
  if (!t || t.length < 4) return true
  if (/^[-|\s:]+$/.test(t)) return true
  if (/^#+\s/.test(t)) return true // 标题行
  if (/^(问题|序号|期望|实际|位置|改法|验证|描述|severity|item|级别|等级|备注)\s*$/i.test(t)) return true
  if (/^(结论|总结|汇总|说明|备注)[:：]?$/.test(t)) return true
  return false
}

interface TableCols {
  severity?: number
  text?: number
  location?: number
  expected?: number
  actual?: number
}

/**
 * 表头 → 列下标。识别"级别/severity"、"问题/描述/issue"、"位置/文件"、"期望"、"实际"。
 * 表头是评审表格唯一可靠的列语义来源；不认表头就只能靠"最长格"猜（旧 bug 的根源）。
 */
function tableColumns(header: string): TableCols | null {
  const cells = header.split('|').map(cleanCell)
  const idx: TableCols = {}
  let hits = 0
  cells.forEach((c, i) => {
    const k = c.toLowerCase().replace(/\s/g, '')
    // 表头单元格是短标签；长句一定是数据行（否则"位置偏移…"这类正文会被误判成表头并整行丢弃）
    if (!k || k.length > 12) return
    if (/^(级别|等级|严重级|严重程度|severity|level|优先级)/.test(k)) { idx.severity = i; hits++ }
    else if (/^(问题|描述|现象|issue|problem|description)/.test(k)) { idx.text = i; hits++ }
    else if (/^(位置|文件|代码位置|location|file|where)/.test(k)) { idx.location = i; hits++ }
    else if (/^(期望|expected|should)/.test(k)) { idx.expected = i; hits++ }
    else if (/^(实际|actual|now)/.test(k)) { idx.actual = i; hits++ }
  })
  return hits >= 2 ? idx : null
}

/** 无表头时的兜底：取"像问题描述"的那一列（跳过序号/严重级别/纯数字） */
function fromTableRow(row: string): string | undefined {
  const cells = row.split('|').map(cleanCell).filter(Boolean)
  if (cells.length < 2) return undefined
  const bad = /^(阻断|严重|主要|次要|建议|info|minor|major|blocker|critical|低|中|高|p[0-3])$/i
  const cand = cells.filter((c) => c.length >= 6 && !bad.test(c) && !/^\d+$/.test(c))
  return cand.sort((a, b) => b.length - a.length)[0]
}

/**
 * 解析专家整改清单。启发式但保守：
 * - 有表头就按列取（级别列是权威）；
 * - 没表头退回"最长格 + 整行关键词"；
 * - 结果会原样回显给调用方核对。
 */
export function parseReview(
  text: string,
  opts: { maxItems?: number; resolveBox?: (nodeId: string) => [number, number, number, number] | null } = {},
): ReviewItem[] {
  const maxItems = opts.maxItems ?? 80
  const out: ReviewItem[] = []
  const seen = new Set<string>()
  const lines = String(text ?? '').split('\n')
  let cols: TableCols | null = null

  const push = (
    raw: string,
    extra?: { expected?: string; actual?: string; severity?: ReviewSeverity; severitySource?: ReviewItem['severitySource']; location?: string },
  ): void => {
    const body = cleanCell(raw)
    if (isNoise(body)) return
    const derived = severityOf(raw)
    const sev = extra?.severity ?? derived.severity
    const source: ReviewItem['severitySource'] = extra?.severitySource ?? derived.source
    // 正文里出现的 "132:8240" 这种节点 id，自动认领 → 能在基准图上钉框
    const nodeMatch = raw.match(/(\d{1,6}:\d{1,6})/)
    const nodeId = nodeMatch ? nodeMatch[1] : undefined
    const location = extra?.location ?? locationOf(raw)
    // 去重键 = 位置 + 节点 + 正文前 60。
    // 只拿正文前 60 会把"同一条结构化评审"在不同行（列表项 / 纯文本规则）各解析一遍 →
    // 一条被拆成多条 info，info 又可被 known-diff 吞掉，造成假绿；带上位置+节点后能认出是同一条。
    const key = `${location ?? ''}|${nodeId ?? ''}|${body.slice(0, 60)}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      id: '',
      severity: sev,
      severitySource: source,
      text: body.slice(0, 400),
      location,
      expected: extra?.expected,
      actual: extra?.actual,
      nodeId,
      box: nodeId && opts.resolveBox ? opts.resolveBox(nodeId) : undefined,
    })
  }

  for (let li = 0; li < lines.length; li++) {
    if (out.length >= maxItems) break
    const line = lines[li]
    const t = line.trim()
    if (!t) continue

    // 表格行：| a | b | c |
    if (t.startsWith('|') && t.endsWith('|')) {
      if (/^\|[\s:|-]+\|$/.test(t)) continue // 分隔行
      // 表头必须紧跟分隔行（|---|---|）：否则数据行里出现"位置/期望"字样就会被误判成表头而整行丢失
      const nextLine = lines[li + 1]?.trim() ?? ''
      const header = /^\|[\s:|-]+\|$/.test(nextLine) ? tableColumns(t) : null
      if (header) { cols = header; continue }
      const cells = t.split('|').map(cleanCell)
      if (cols) {
        const pick = (i?: number): string | undefined => (i == null ? undefined : cells[i])
        const body = pick(cols.text) ?? fromTableRow(t)
        if (!body || isNoise(body)) continue
        const explicit = pick(cols.severity)
        const sev = explicit ? severityFromCell(explicit) : undefined
        // 级别列优先；列缺失或无法识别时，用**整行**关键词兜底（不是只用正文那一格）
        const fallback = severityOf(t)
        push(body, {
          expected: pick(cols.expected),
          actual: pick(cols.actual),
          severity: sev ?? fallback.severity,
          severitySource: sev ? 'column' : fallback.source,
          location: pick(cols.location),
        })
        continue
      }
      const cell = fromTableRow(t)
      if (cell) push(cell)
      continue
    }

    // 非表格行：列映射失效（同一份报告里的另一张表不能沿用上一张的列下标）
    cols = null

    // 列表项 / 编号项
    if (/^([-*+]|\d+[.)])\s+/.test(t)) {
      const exp = t.match(/期望[:：]\s*([^。；;|]+)/)
      const act = t.match(/实际[:：]\s*([^。；;|]+)/)
      push(t, { expected: exp?.[1]?.trim(), actual: act?.[1]?.trim() })
      continue
    }

    // 纯文本里带"应为/应该是/改成/不对/不一致"的句子也算一条
    if (/应为|应该(是|为)|改成|不一致|不对|不符|差距|偏差|缺少|多了|少了/.test(t)) {
      push(t)
    }
  }

  return out.map((it, i) => ({ ...it, id: `R${i + 1}` }))
}

/** 专家整改清单 → 追加进 CODEGEN_PROMPT.md 的轮次内容 */
export function renderReviewRound(items: ReviewItem[], meta: { round: number; reviewer: string; at: string; source?: string; extra?: string }): string {
  const L: string[] = []
  L.push('')
  L.push(`## 第 ${meta.round} 轮迭代 · 专家整改清单（由 figma_review_to_round 注入）`)
  L.push('')
  L.push(`- 评审人：${meta.reviewer} · 时间：${meta.at}${meta.source ? ` · 来源：${meta.source}` : ''}`)
  L.push(`- 条目：${items.length}（阻断 ${items.filter((i) => i.severity === 'blocker').length} · 主要 ${items.filter((i) => i.severity === 'major').length} · 次要 ${items.filter((i) => i.severity === 'minor').length}）`)
  L.push('')
  L.push('> 按 id 逐条处理；每条都要写"改在哪个文件哪一行 + 用什么实测数值验证"。')
  L.push('> **未关闭的条目不允许收尾**（figma_codegen_round 会拒绝）。')
  L.push('')
  L.push('| id | 级别 | 问题 | 位置 | 期望 | 实际 | 处理结果（待填：文件:行 + 实测值） |')
  L.push('|---|---|---|---|---|---|---|')
  for (const it of items) {
    L.push(`| ${it.id} | ${it.severity} | ${it.text.replace(/\|/g, '\\|')} | ${it.location ?? ''} | ${it.expected ?? ''} | ${it.actual ?? ''} | |`)
  }
  if (meta.extra) {
    L.push('')
    L.push('### 评审原文/补充（供上下文，不要逐字照做）')
    L.push('')
    L.push('```')
    L.push(meta.extra.slice(0, 4000))
    L.push('```')
  }
  L.push('')
  return L.join('\n')
}

const scopeOf = (r: ReviewRoundState): 'baseline' | 'implementation' => (r.scope === 'baseline' ? 'baseline' : 'implementation')

/** 未关闭条目（收尾门禁用）。scope 省略 = 不过滤 */
export function openItems(rounds: ReviewRoundState[] | undefined, scope?: 'baseline' | 'implementation'): ReviewItemState[] {
  const out: ReviewItemState[] = []
  for (const r of rounds ?? []) {
    if (scope && scopeOf(r) !== scope) continue
    for (const it of r.items) if (it.status === 'open') out.push(it)
  }
  return out
}

/** 已接受（命中 known-diffs）的条目 */
export function acceptedItems(rounds: ReviewRoundState[] | undefined, scope?: 'baseline' | 'implementation'): ReviewItemState[] {
  const out: ReviewItemState[] = []
  for (const r of rounds ?? []) {
    if (scope && scopeOf(r) !== scope) continue
    for (const it of r.items) if (it.status === 'accepted') out.push(it)
  }
  return out
}

export function summarizeRounds(rounds: ReviewRoundState[] | undefined): string {
  if (!rounds?.length) return '尚无专家评审'
  const all = rounds.flatMap((r) => r.items)
  const open = all.filter((i) => i.status === 'open')
  const accepted = all.filter((i) => i.status === 'accepted')
  return `${rounds.length} 轮评审 / 共 ${all.length} 条 / 未关闭 ${open.length} 条${accepted.length ? ` / 已接受差异 ${accepted.length} 条` : ''}`
}

/**
 * 是否已经过至少一轮**有效**专家审计。
 * 旧实现只看"有记录"，导致一轮只解析出 1 条 minor（或只做了 baseline 审计）也算"实现已审计"。
 */
export function hasExpertReview(rounds: ReviewRoundState[] | undefined, scope: 'baseline' | 'implementation' = 'implementation'): boolean {
  return (rounds ?? []).some((r) => scopeOf(r) === scope && (r.items.length > 0 || r.emptyRound === true))
}

/**
 * baseline 审计的 fail-closed 级别归一：解析不出级别的条目按 major 处理。
 * 必须在"抑制 → 落盘 → 判定"**之前**调用：
 * 旧顺序是先抑制后提升，导致 ① 落盘仍是 info（基准债务门禁看不到）② 无级别条目被 known-diff 吞掉。
 * 同时：来自 default（无级别）的条目不参与 known-diffs 抑制。
 */
export function normalizeBaselineSeverity(items: ReviewItem[], scope: 'baseline' | 'implementation'): ReviewItem[] {
  if (scope !== 'baseline') return items
  for (const it of items) {
    if (it.severitySource === 'default' && (it.severity === 'info' || it.severity === 'minor')) {
      it.severity = 'major'
      it.severitySource = 'default'
    }
  }
  return items
}

/** 该条目是否允许被 known-diffs 抑制（blocker 与"无级别"条目永不抑制） */
export function isSuppressible(it: ReviewItem): boolean {
  if (it.severity === 'blocker') return false
  if (it.severitySource === 'default') return false
  return it.severity === 'minor' || it.severity === 'info'
}

export function openBySeverity(rounds: ReviewRoundState[] | undefined, scope?: 'baseline' | 'implementation'): { blocker: number; major: number; minor: number } {
  const open = openItems(rounds, scope)
  return {
    blocker: open.filter((i) => i.severity === 'blocker').length,
    major: open.filter((i) => i.severity === 'major').length,
    minor: open.filter((i) => i.severity === 'minor').length,
  }
}

/**
 * known-diffs 抑制：命中已确认接受的差异 → 该条不再算"新发现"。
 * 匹配规则（任一命中）：条目 id 相同 / nodeId 相同 / property 关键词出现在正文里。
 */
export function matchKnownDiff(item: ReviewItem, known: KnownDiff[] | undefined): KnownDiff | undefined {
  if (!known?.length) return undefined
  const text = `${item.text} ${item.location ?? ''}`.toLowerCase()
  for (const k of known) {
    if (k.id && k.id === item.id) return k
    if (k.nodeId && item.nodeId && k.nodeId === item.nodeId) return k
    const key = String(k.property ?? '').toLowerCase().trim()
    if (key && text.includes(key)) return k
  }
  return undefined
}
