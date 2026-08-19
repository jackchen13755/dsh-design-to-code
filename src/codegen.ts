/**
 * 代码生成器：DesignModel + 选项 → React/TS/CSS Modules 文件（无外部依赖）。
 *
 * 生成的是“设计准确的骨架 + 交互挂载点”：布局/令牌/文本来自设计数据（确定性），
 * 业务交互由 `CODEGEN_PROMPT.md` 引导会话 LLM 按需求补全。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { DesignModel, DesignNode } from './design.js'

export interface CodegenOptions {
  componentName: string
  requirements: string
  conventions: string
  outputDir: string
  /** figma_audit_node 生成的核对清单 markdown（内联进 Codegen Prompt） */
  auditMd?: string
  /** 当前轮次（多轮生成） */
  round?: number
  /** 上一轮反馈（round>1 时） */
  roundFeedback?: string
}

function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '').replace(/^(\d)/, '_$1')
  return cleaned || 'DesignComponent'
}

function collectFlat(nodes: DesignNode[], out: DesignNode[] = []): DesignNode[] {
  for (const n of nodes) {
    out.push(n)
    collectFlat(n.children, out)
  }
  return out
}

const ACTION_RE = /复制|制新卡|取消|确定|保存|提交|关闭|confirm|ok|cancel/i

function descendantText(n: DesignNode, re: RegExp): string | undefined {
  if (n.kind === 'text' && n.value && re.test(n.value)) return n.value
  for (const c of n.children) {
    const v = descendantText(c, re)
    if (v) return v
  }
  return undefined
}

/** 输入框默认值：同行的右侧文本（如 2 / 2026-01-01 周一 / 16:00）。 */
function rowValue(n: DesignNode, flat: DesignNode[]): string | undefined {
  const cands = flat
    .filter((t) => t.kind === 'text' && t.value)
    .filter((t) => Math.abs(t.y - n.y) <= 14 && t.x >= n.x + 10)
    .sort((a, b) => a.x - b.x)
  return cands[0]?.value
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/&/g, '&amp;')
}

/** 节点边框：strokePaints + strokeWeight + dashPattern（虚线坑：用 dashPattern 不是 strokeDashes）。 */
function strokeCss(n: DesignNode): string | undefined {
  const r = n.raw
  const sp = Array.isArray(r.strokePaints) ? r.strokePaints.find((p: any) => p.visible !== false && p.color) : undefined
  if (!sp?.color) return undefined
  const c = sp.color
  const a = sp.opacity ?? c.a ?? 1
  const color = `rgba(${Math.round((c.r ?? 0) * 255)},${Math.round((c.g ?? 0) * 255)},${Math.round((c.b ?? 0) * 255)},${a})`
  const w = typeof r.strokeWeight === 'number' ? r.strokeWeight : 1
  const dash = Array.isArray(r.dashPattern) && r.dashPattern.length ? 'dashed' : 'solid'
  return `${w}px ${dash} ${color}`
}

/** 节点阴影：effects（含 visible）。 */
function shadowCss(n: DesignNode): string | undefined {
  const r = n.raw
  const e = (r.effects ?? []).find((x: any) => x && x.visible !== false && (x.type === 'DROP_SHADOW' || x.type === 'INNER_SHADOW'))
  if (!e) return undefined
  const c = e.color ?? {}
  const a = e.opacity ?? c.a ?? 1
  const inset = e.type === 'INNER_SHADOW' ? ' inset' : ''
  return `${e.offset?.x ?? 0}px ${e.offset?.y ?? 0}px ${e.radius ?? 0}px ${e.spread ?? 0}px rgba(${Math.round((c.r ?? 0) * 255)},${Math.round((c.g ?? 0) * 255)},${Math.round((c.b ?? 0) * 255)},${a})${inset}`.trim()
}

function baseStyle(n: DesignNode): string {
  const parts: string[] = [`left: ${n.x}`, `top: ${n.y}`, `width: ${n.w}`, `height: ${n.h}`]
  if (n.background) parts.push(`background: '${n.background}'`)
  const border = strokeCss(n)
  if (border) parts.push(`border: '${border}'`)
  const shadow = shadowCss(n)
  if (shadow) parts.push(`boxShadow: '${shadow}'`)
  return `{ ${parts.join(', ')} }`
}

function renderNode(n: DesignNode, flat: DesignNode[], index: number): string {
  const style = baseStyle(n)
  const pos = `style={${style}}`
  switch (n.kind) {
    case 'text': {
      const color = n.color ? `, color: '${n.color}'` : ''
      return `      <span className={styles.text} style={{ left: ${n.x}, top: ${n.y}, width: ${n.w}, height: ${n.h}${color} }}>${escapeText(n.value ?? n.name)}</span>`
    }
    case 'input': {
      const def = rowValue(n, flat) ?? ''
      const label = (n.name || 'input').replace(/"/g, '\\"')
      return `      <input className={styles.input} ${pos} defaultValue="${escapeAttr(def)}" aria-label="${escapeAttr(label)}" data-key="${escapeAttr(label)}" onChange={(e) => handleChange("${escapeAttr(label)}", e.target.value)} />`
    }
    case 'button': {
      const label = descendantText(n, ACTION_RE) ?? n.name
      return `      <button className={styles.button} ${pos} onClick={() => onAction?.("${escapeAttr(label)}", data)}>${escapeText(label)}</button>`
    }
    case 'icon-close':
      return `      <button className={styles.close} ${pos} aria-label="关闭" onClick={onClose}>×</button>`
    case 'frame':
    case 'root':
    case 'instance':
    default:
      return `      <div className={styles.${n.kind === 'root' ? 'root' : 'frame'}} ${pos}>${n.kind === 'instance' ? escapeText(n.name) : ''}</div>`
  }
}

export function generateCode(model: DesignModel, opts: CodegenOptions): string[] {
  const name = safeName(opts.componentName)
  const flat = collectFlat([model.tree]).filter((n) => n.kind !== 'root')
  const outDir = resolve(opts.outputDir)
  mkdirSync(join(outDir, 'src'), { recursive: true })

  // ── tokens.ts ──
  const colors = Object.entries(model.tokens.colors)
    .map(([k, v]) => `  '${k}': '${v}',`)
    .join('\n')
  const fonts = Object.entries(model.tokens.fonts)
    .map(
      ([k, v]) =>
        `  '${k}': { family: '${v.family}', weight: '${v.weight}', size: ${v.size}${v.lineHeight ? `, lineHeight: '${v.lineHeight}'` : ''}${v.letterSpacing ? `, letterSpacing: '${v.letterSpacing}'` : ''} },`,
    )
    .join('\n')
  writeFileSync(
    join(outDir, 'src', 'tokens.ts'),
    `// 由设计稿自动生成的设计令牌（dsh-design-to-code）\n\nexport const designTokens = {\n  colors: {\n${colors}\n  },\n  fonts: {\n${fonts}\n  },\n  spacing: [${model.tokens.spacing.join(', ')}],\n  shadows: [${model.tokens.shadows.map((s) => `'${s}'`).join(', ')}],\n};\n`,
    'utf8',
  )

  // ── types.ts ──
  writeFileSync(
    join(outDir, 'src', 'types.ts'),
    `// 组件契约（骨架版）：业务语义由需求 → CODEGEN_PROMPT.md 补全\n\nexport interface ${name}Props {\n  /** 初始表单值，key 为设计稿控件标签 */\n  initialData?: Record<string, string>;\n  /** 按钮动作：action 为按钮文本，data 为当前表单值 */\n  onAction?: (action: string, data: Record<string, string>) => void;\n  /** 关闭 */\n  onClose?: () => void;\n}\n`,
    'utf8',
  )

  // ── Component.tsx ──
  const body = flat.map((n, i) => renderNode(n, flat, i)).join('\n')
  writeFileSync(
    join(outDir, 'src', `${name}.tsx`),
    `import { useState } from 'react';\nimport type { ${name}Props } from './types.js';\nimport styles from './${name}.module.css';\n\nexport function ${name}({ initialData = {}, onAction, onClose }: ${name}Props) {\n  const [data, setData] = useState<Record<string, string>>(initialData);\n\n  const handleChange = (key: string, value: string) => {\n    setData((prev) => ({ ...prev, [key]: value }));\n  };\n\n  return (\n    <div className={styles.root} style={{ width: ${model.width}, height: ${model.height}, background: '${model.tree.background ?? '#fff'}' }}>\n${body}\n    </div>\n  );\n}\n\nexport default ${name};\n`,
    'utf8',
  )

  // ── module.css ──
  const borderColor =
    Object.values(model.tokens.colors).find((c) => /204|cc|d/.test(c.toLowerCase().replace('#', ''))) ?? '#ccc'
  writeFileSync(
    join(outDir, 'src', `${name}.module.css`),
    `.root {\n  position: relative;\n  overflow: hidden;\n  font-family: 'Noto Sans SC', 'Noto Sans CJK SC', system-ui, sans-serif;\n}\n.text {\n  position: absolute;\n  white-space: pre-wrap;\n  line-height: 1.4;\n}\n.input {\n  position: absolute;\n  box-sizing: border-box;\n  border: 1px solid ${borderColor};\n  background: #fff;\n  padding: 8px 12px;\n  font-size: 16px;\n}\n.button {\n  position: absolute;\n  box-sizing: border-box;\n  border: 1px solid ${borderColor};\n  background: #fff;\n  cursor: pointer;\n  font-size: 16px;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n}\n.close {\n  position: absolute;\n  background: transparent;\n  border: none;\n  cursor: pointer;\n  font-size: 18px;\n  line-height: 1;\n}\n.frame {\n  position: absolute;\n  box-sizing: border-box;\n}\n`,
    'utf8',
  )

  // ── index.ts ──
  writeFileSync(
    join(outDir, 'src', 'index.ts'),
    `export { ${name} } from './${name}.js';\nexport type { ${name}Props } from './types.js';\n`,
    'utf8',
  )

  // ── design-spec.json ──
  writeFileSync(join(outDir, 'design-spec.json'), JSON.stringify(model, null, 2), 'utf8')

  // ── CODEGEN_PROMPT.md ──
  const round = Math.max(1, opts.round ?? 1)
  const promptParts = [
    `# Codegen Prompt（需求 → 最终代码）· 第 ${round} 轮`,
    '',
    `设计稿已提取为 \`design-spec.json\`（令牌/树/文本），骨架见 \`src/${name}.tsx\`。`,
    '',
    '请按以下要求把骨架补全为高质量实现：',
    '',
    '## 需求',
    opts.requirements,
    '',
    '## 项目约定',
    opts.conventions,
    '',
  ]
  if (opts.auditMd) {
    promptParts.push(
      '## 设计审计核对清单（实现前逐项勾选，歧义项不要猜）',
      '',
      '```markdown',
      opts.auditMd.trim(),
      '```',
      '',
    )
  }
  if (round > 1 && opts.roundFeedback) {
    promptParts.push(
      `## 第 ${round} 轮反馈（上一轮差异/评审）`,
      '',
      opts.roundFeedback,
      '',
    )
  }
  promptParts.push(
    `## 必做`,
    `1. 依据需求把控件标签映射成语义字段（如“房号”→ roomNumber），重写 \`types.ts\` 的 Props；`,
    `2. 补全交互：受控表单、校验、按钮动作、关闭（Esc/遮罩）、可访问性；`,
    `3. 保持 \`tokens.ts\` 的设计值，不改样式数字；边框虚线用设计稿的 \`dashPattern\`；`,
    `4. 复用项目已有的 Button/Input/Modal 原子组件（若有）；没有则保持零外部依赖；`,
    `5. 输出：\`src/${name}.tsx\`、\`src/types.ts\`、\`src/use${name}.ts\`（逻辑 hooks）、必要测试；`,
    `6. 代码简洁、可扩展、类型安全，不引入第三方运行时依赖。`,
    '',
    '## 运行时行为：先查项目既有实现，再写代码（不要自己发明）',
    '',
    '在目标仓库内 grep 以下关键词，找到对应组件后读源码照抄既有模式：',
    '',
    '```bash',
    '# 固定/吸底相关',
    'grep -rn "position: fixed" src --include="*.less" --include="*.css"',
    'grep -rn "position: sticky" src --include="*.less" --include="*.css"',
    'grep -rn "bottom: 0" src --include="*.less" --include="*.css"',
    '',
    '# 现有 footer/操作栏实现',
    'grep -rn "footer-wrap\\|profile-footer-wrap\\|ant-row-flex-end" src --include="*.tsx" --include="*.less"',
    '',
    '# 侧边栏展开/收起',
    'grep -rn "collapsed\\|is-collapse\\|menu-collapsed\\|side.*bar" src --include="*.tsx" --include="*.less" | head -50',
    '',
    '# 布局宽度',
    'grep -rn "220px\\|width: 220" src --include="*.less"',
    '```',
    '',
    '例如：若项目已有底部操作栏约定（如 \`profile-footer-wrap\`：position: fixed; width: 100%; left: 0; bottom: 0; z-index: 20），',
    '就照抄该模式（靠侧边栏遮挡自适应展开/收起），不要自己写死 left:220px。',
    '',
    '## 验证闭环',
    '1. 本地 WS 解码 JSON → 审计清单逐项勾选；',
    '2. 有歧义节点（fill visible=false / strokeWeight>0 但无 strokePaints）标记“待人工确认”，不要猜；',
    '3. 视觉参照：REST 可用时用 figma_read_node 渲染 PNG；429 时用 figma_read_node_ws 截浏览器视口对照；',
    '4. 全部 checklist 勾选 + 截图对照无差异后才算完成。',
    '',
    '## 沉淀可复用事实',
    '把查到的既有模式（如“本应用底部操作栏统一用 profile-footer-wrap：fixed + width 100% + left 0”）记入 Noema，',
    '下次同类页面直接复用，不再重新踩坑。',
  )
  writeFileSync(join(outDir, 'CODEGEN_PROMPT.md'), promptParts.join('\n'), 'utf8')

  // ── README.md ──
  writeFileSync(
    join(outDir, 'README.md'),
    `# ${name}

由 dsh-design-to-code 从 Figma 节点 \`${model.nodeId}\` 生成（零 REST API）。

- 设计令牌：\`src/tokens.ts\`
- 组件骨架：\`src/${name}.tsx\`
- 契约：\`src/types.ts\`
- 补全指引：\`CODEGEN_PROMPT.md\`

## 运行
\`\`\`bash
npm i && npm run dev   # 按项目约定调整
\`\`\`
`,
    'utf8',
  )

  return [
    join(outDir, 'design-spec.json'),
    join(outDir, 'src', 'tokens.ts'),
    join(outDir, 'src', 'types.ts'),
    join(outDir, 'src', `${name}.tsx`),
    join(outDir, 'src', `${name}.module.css`),
    join(outDir, 'src', 'index.ts'),
    join(outDir, 'CODEGEN_PROMPT.md'),
    join(outDir, 'README.md'),
  ]
}
