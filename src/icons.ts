/** Figma 节点 → 图标库标识；禁止用路径数据自行重画 SVG。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { paintToCss } from './design.js'
import type { DesignModel, DesignNode } from './design.js'

export interface DesignIconRef {
  /** 如 akar-icons:sound-on */
  name: string
  source: 'iconify'
  color?: string
  size?: number
}

export function iconRefOf(node: DesignNode): DesignIconRef | undefined {
  for (const entry of node.raw.pluginData ?? []) {
    if (String(entry?.key) !== 'iconify-props') continue
    try {
      const data = JSON.parse(String(entry?.value ?? '{}'))
      if (!/^([a-z0-9][a-z0-9-]*):([a-z0-9][a-z0-9-]*)$/i.test(String(data.name))) continue
      return {
        name: String(data.name), source: 'iconify',
        color: typeof data.props?.color === 'string' ? String(data.props.color) : undefined,
        size: Number.isFinite(Number(data.props?.size)) ? Number(data.props.size) : undefined,
      }
    } catch { /* 坏 metadata 留在缺失台账，不能猜图标 */ }
  }
  return undefined
}

export function walkDesignNodes(root: DesignNode, visit: (node: DesignNode) => void): void {
  if (root.raw.visible === false) return
  visit(root)
  for (const child of root.children) walkDesignNodes(child, visit)
}

function iconColorOf(node: DesignNode): string | undefined {
  const overrides = node.raw.symbolData?.symbolOverrides ?? []
  const paints = overrides.filter((o: any) => o?.fillPaints).at(-1)?.fillPaints
  return paintToCss(paints) ?? paintToCss(node.raw.fillPaints)
}

/**
 * 按 Figma 的 Iconify metadata 取图标库官方 SVG 并落到 static/assets。
 * 已有文件优先（可离线复现）；失败不静默：返回每个节点的错误供工具输出与审计使用。
 * 路径只来自已校验的 icon-set/name，不读取调用方任意路径。
 */
export async function prepareIconifyAssets(model: DesignModel, outputDir: string): Promise<{ assets: Record<string, string>; failures: string[] }> {
  const refs: Array<{ node: DesignNode; ref: DesignIconRef }> = []
  walkDesignNodes(model.tree, (node) => { const ref = iconRefOf(node); if (ref) refs.push({ node, ref }) })
  const assets: Record<string, string> = {}
  const failures: string[] = []
  const dir = resolve(outputDir, 'assets')
  await mkdir(dir, { recursive: true })
  for (const { node, ref } of refs) {
    const nodeId = node.id
    const color = iconColorOf(node)
    const [set, name] = ref.name.split(':')
    const filename = `${set}--${name}${color ? `--${color.replace(/[^a-z0-9]/gi, '')}` : ''}.svg`
    const outPath = join(dir, filename)
    if (!existsSync(outPath)) {
      try {
        const query = color ? `?color=${encodeURIComponent(color)}` : ''
        const url = `https://api.iconify.design/${encodeURIComponent(set)}/${encodeURIComponent(name)}.svg${query}`
        const response = await fetch(url, { headers: { Accept: 'image/svg+xml' }, signal: AbortSignal.timeout(10_000) })
        const text = await response.text()
        // <img> 方式引用原始 SVG，不 inline 注入第三方文档；不允许 HTML/脚本/non-SVG 内容。
        if (!response.ok || !/^\s*<svg[\s>]/i.test(text) || /<script|<foreignObject|onload\s*=|javascript:/i.test(text)) {
          failures.push(`${nodeId} ${ref.name}：${response.status}，不是可用的 SVG 资源`)
          continue
        }
        await writeFile(outPath, text, 'utf8')
      } catch (error) {
        failures.push(`${nodeId} ${ref.name}：${error instanceof Error ? error.message : String(error)}`)
        continue
      }
    }
    assets[nodeId] = `assets/${filename}`
  }
  await writeFile(join(dir, '../icons.json'), JSON.stringify({
    source: 'Iconify library metadata from Figma (no hand-drawn paths)',
    icons: refs.map(({ node, ref }) => ({ nodeId: node.id, name: node.name, library: ref.name, color: iconColorOf(node) })),
    assets, failures,
  }, null, 2), 'utf8')
  return { assets, failures }
}
