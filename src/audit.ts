/**
 * 设计审计（Design Audit）：全量遍历目标节点，逐节点输出完整视觉属性，
 * 并自动生成「实现前核对清单」（checklist）。
 *
 * 记忆 mem_88d6b6f0（ARS 教训）：
 * - 不要只读“看着像容器”的节点，要全量遍历（背景/边框常藏在子容器）；
 * - Kiwi 用 guid(sessionID:localID)，fills 字段是 fillPaints；
 * - 虚线边框在 dashPattern（如 [4]），不是 strokeDashes；
 * - fill visible=false 或 strokeWeight>0 但 strokePaints 为空 → 标记“待人工确认”，不要猜。
 */

type Any = Record<string, any>

export interface AuditEntry {
  guid: string
  name: string
  type: string
  x: number
  y: number
  w: number
  h: number
  fillPaints: Array<{ visible: boolean; rgba: string; type: string }>
  strokePaints: Array<{ visible: boolean; rgba: string; type: string }>
  strokeWeight: number | null
  strokeAlign: string | null
  dashPattern: number[]
  padding: { top: number | null; right: number | null; bottom: number | null; left: number | null }
  text: {
    characters: string
    fontSize: number | null
    fontWeight: string | null
    lineHeight: number | null
    letterSpacing: number | null
    color: string | null
    alignHorizontal: string | null
  } | null
  effects: Array<{ type: string; visible: boolean; css: string }>
  ambiguous: string[]
}

export interface AuditResult {
  fileKey: string
  nodeId: string
  componentName: string
  width: number
  height: number
  entries: AuditEntry[]
  checklist: string[]
  ambiguousCount: number
}

function rgba(p: Any | undefined): string {
  if (!p || p.type !== 'SOLID' || !p.color) return ''
  const c = p.color
  const a = p.opacity ?? c.a ?? 1
  return `rgba(${Math.round((c.r ?? 0) * 255)},${Math.round((c.g ?? 0) * 255)},${Math.round((c.b ?? 0) * 255)},${a})`
}

function paints(list: Any[] | undefined, key: 'fillPaints' | 'strokePaints') {
  return (list ?? []).map((p) => ({
    visible: p.visible !== false,
    rgba: rgba(p),
    type: p.type ?? '',
  }))
}

function effectsCss(e: Any): string {
  if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
    const c = e.color ?? {}
    const a = e.opacity ?? c.a ?? 1
    return `inset=${e.type === 'INNER_SHADOW'} ${e.offset?.x ?? 0}px ${e.offset?.y ?? 0}px ${e.radius ?? 0}px ${e.spread ?? 0}px rgba(${Math.round((c.r ?? 0) * 255)},${Math.round((c.g ?? 0) * 255)},${Math.round((c.b ?? 0) * 255)},${a})`
  }
  if (e.type === 'LAYER_BLUR') return `blur(${e.radius ?? 0}px)`
  return JSON.stringify(e)
}

export function auditNode(nodeJson: Any): AuditResult {
  const node = nodeJson.node as Any
  const descendants = (nodeJson.descendants ?? []) as Any[]

  const byId = new Map<string, Any>()
  for (const n of [node, ...descendants]) {
    if (n?.guid) byId.set(`${Number(n.guid.sessionID)}:${Number(n.guid.localID)}`, n)
  }
  const childrenMap = new Map<string, Any[]>()
  for (const n of descendants) {
    const p = n?.parentIndex?.guid
    if (!p) continue
    const pk = `${Number(p.sessionID)}:${Number(p.localID)}`
    if (!childrenMap.has(pk)) childrenMap.set(pk, [])
    childrenMap.get(pk)!.push(n)
  }

  const entries: AuditEntry[] = []
  const checklist = new Set<string>()
  const ambiguous: string[] = []

  const walk = (n: Any, absX = 0, absY = 0, depth = 0): void => {
    const t = n.transform ?? {}
    const s = n.size ?? {}
    const x = absX + Number(t.m02 ?? 0)
    const y = absY + Number(t.m12 ?? 0)
    const guid = `${Number(n.guid?.sessionID ?? 0)}:${Number(n.guid?.localID ?? 0)}`
    const name = String(n.name ?? '')
    const type = String(n.type ?? '')

    const fill = paints(n.fillPaints, 'fillPaints')
    const stroke = paints(n.strokePaints, 'strokePaints')
    const strokeWeight = typeof n.strokeWeight === 'number' ? n.strokeWeight : null
    const dashPattern = Array.isArray(n.dashPattern) ? n.dashPattern.map(Number) : []
    const padding = {
      top: typeof n.paddingTop === 'number' ? n.paddingTop : null,
      right: typeof n.paddingRight === 'number' ? n.paddingRight : null,
      bottom: typeof n.paddingBottom === 'number' ? n.paddingBottom : null,
      left: typeof n.paddingLeft === 'number' ? n.paddingLeft : null,
    }
    const effects = (n.effects ?? [])
      .filter((e: Any) => e && e.visible !== false)
      .map((e: Any) => ({ type: e.type ?? '', visible: e.visible !== false, css: effectsCss(e) }))

    const textNode = type === 'TEXT'
    const text = textNode
      ? {
          characters: String(n.textData?.characters ?? ''),
          fontSize: typeof n.fontSize === 'number' ? n.fontSize : null,
          fontWeight: n.fontName?.style ? String(n.fontName.style) : null,
          lineHeight: typeof n.lineHeight?.value === 'number' ? n.lineHeight.value : null,
          letterSpacing: typeof n.letterSpacing?.value === 'number' ? n.letterSpacing.value : null,
          color: rgba((n.fillPaints ?? []).find((p: Any) => p.type === 'SOLID')),
          alignHorizontal: n.textAlignHorizontal ? String(n.textAlignHorizontal) : null,
        }
      : null

    const entry: AuditEntry = {
      guid, name, type,
      x: Math.round(x), y: Math.round(y), w: Math.round(Number(s.x ?? 0)), h: Math.round(Number(s.y ?? 0)),
      fillPaints: fill, strokePaints: stroke, strokeWeight, strokeAlign: n.strokeAlign ? String(n.strokeAlign) : null,
      dashPattern, padding, text, effects, ambiguous: [],
    }

    // ── 歧义标记（不猜） ──
    const hiddenFills = fill.filter((p) => !p.visible)
    if (hiddenFills.length) entry.ambiguous.push(`fill visible=false: ${hiddenFills.map((p) => p.rgba || p.type).join(', ')}`)
    if (strokeWeight && strokeWeight > 0 && stroke.length === 0) {
      entry.ambiguous.push(`strokeWeight=${strokeWeight} 但 strokePaints 为空（可能隐藏边框，需人工确认）`)
    }
    if (dashPattern.length && stroke.length === 0) {
      entry.ambiguous.push(`dashPattern=${JSON.stringify(dashPattern)} 但无 strokePaints（虚线需要人工确认颜色）`)
    }

    // ── checklist 归纳 ──
    if (fill.some((p) => p.visible && p.rgba)) {
      checklist.add(`${type} "${name}" 背景 ${fill.find((p) => p.visible)?.rgba}`)
    }
    if (stroke.some((p) => p.visible)) {
      const sc = stroke.find((p) => p.visible)?.rgba
      const dash = dashPattern.length ? ` dashed ${JSON.stringify(dashPattern)}` : ''
      checklist.add(`${type} "${name}" 边框 ${sc}${strokeWeight ? ` ${strokeWeight}px` : ''}${dash}`)
    }
    if (textNode && text?.characters) {
      checklist.add(`文本 "${text.characters}" ${text.fontSize}px/${text.fontWeight} ${text.color}`)
    }
    if (padding.top != null || padding.left != null) {
      checklist.add(`${type} "${name}" padding ${padding.top}/${padding.right}/${padding.bottom}/${padding.left}`)
    }
    if (effects.length) {
      for (const e of effects) checklist.add(`${type} "${name}" effect ${e.type} ${e.css}`)
    }
    for (const a of entry.ambiguous) ambiguous.push(`[${guid}] ${name}: ${a}`)

    entries.push(entry)

    const kids = childrenMap.get(guid) ?? []
    for (const k of kids) walk(k, x, y, depth + 1)
  }

  walk(node)

  const size = node.size ?? {}
  return {
    fileKey: String(nodeJson.fileKey ?? ''),
    nodeId: String(nodeJson.nodeId ?? ''),
    componentName: String(node.name ?? '设计组件'),
    width: Math.round(Number(size.x ?? 0)),
    height: Math.round(Number(size.y ?? 0)),
    entries,
    checklist: [...checklist],
    ambiguousCount: ambiguous.length,
  }
}

/** 生成「实现前核对清单」markdown。 */
export function auditToMarkdown(a: AuditResult): string {
  const lines: string[] = []
  lines.push(`# 设计审计：${a.componentName}（${a.fileKey} · ${a.nodeId}）`)
  lines.push('')
  lines.push(`- 画布：${a.width}×${a.height} · 节点数：${a.entries.length} · 歧义数：${a.ambiguousCount}`)
  lines.push('')
  lines.push('## 实现前核对清单')
  lines.push('')
  for (const c of a.checklist) lines.push(`- [ ] ${c}`)
  const ambiguousLines = a.entries.flatMap((e) => e.ambiguous.map((x) => `[${e.guid}] ${e.name}: ${x}`))
  if (ambiguousLines.length) {
    lines.push('')
    lines.push('## ⚠️ 待人工确认（不要猜）')
    lines.push('')
    for (const am of ambiguousLines) lines.push(`- [ ] ${am}`)
  }
  lines.push('')
  lines.push('## 全量节点清单')
  lines.push('')
  lines.push('| guid | name | type | x | y | w | h | 背景 | 边框 | strokeWeight | dashPattern | padding | 文本 | 阴影 |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const e of a.entries) {
    const bg = e.fillPaints.find((p) => p.visible && p.rgba)?.rgba ?? ''
    const sc = e.strokePaints.find((p) => p.visible)?.rgba ?? ''
    const txt = e.text ? `${e.text.characters.replace(/\|/g, '\\|')} ${e.text.fontSize ?? ''}px/${e.text.fontWeight ?? ''}` : ''
    lines.push(
      `| ${e.guid} | ${e.name.replace(/\|/g, '\\|')} | ${e.type} | ${e.x} | ${e.y} | ${e.w} | ${e.h} | ${bg} | ${sc} | ${e.strokeWeight ?? ''} | ${e.dashPattern.length ? JSON.stringify(e.dashPattern) : ''} | ${e.padding.top ?? ''}/${e.padding.right ?? ''}/${e.padding.bottom ?? ''}/${e.padding.left ?? ''} | ${txt} | ${e.effects.map((f) => f.type).join(', ')} |`,
    )
  }
  lines.push('')
  return lines.join('\n')
}
