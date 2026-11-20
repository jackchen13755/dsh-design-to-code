/**
 * Roompedia 110:854 实测回归（真实 Figma WS 解码证据）
 * 用法：node scripts/roompedia-regression.mjs /path/to/figma_..._110-854.ws.json [out_dir]
 * 测试源必须由调用者提供，避免把一份含真实业务文案的捕获当成通用测试数据。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { buildDesignModel } from '../lib/design.js'
import { flexDecls, orderFlow, verifyFlexPlan } from '../lib/layout.js'
import { renderStatic } from '../lib/render-static.js'
import { iconRefOf, prepareIconifyAssets } from '../lib/icons.js'
import { exportStaticPagePng } from '../lib/screenshot.js'
import { visualDiff } from '../lib/visual-diff.js'
import { auditModel } from '../lib/audit.js'

const source = process.argv[2]
if (!source || !existsSync(source)) throw new Error('请提供 Roompedia 110:854 的已解码 ws.json 路径')
const out = resolve(process.argv[3] ?? `${dirname(resolve(source))}/verified-final`)
const raw = JSON.parse(readFileSync(source, 'utf8'))
const model = buildDesignModel(raw)
const nodes = []
const walk = (n) => { nodes.push(n); n.children.forEach(walk) }
walk(model.tree)
const byId = (id) => nodes.find((n) => n.id === id)
assert(byId('110:854'), '必须是题设对应的 110:854 设计证据')

// 1) 5 列 Grid：旧版会误当 VERTICAL，导致四张卡片全部竖排。
const grid = byId('110:870')
assert.equal(grid.layout.mode, 'GRID')
assert.equal(grid.layout.grid.columnIds.length, 5)
assert(flexDecls(grid).includes('display: grid'))
assert(flexDecls(grid).some((x) => x.includes('grid-template-columns')))
assert(flexDecls(grid).some((x) => x.includes('minmax(0, 1fr)')))

// 2) wrap + position：第一行 7 个，第二行 5 个；不能按 x 混排、也不能丢掉行 gap。
const tabs = byId('110:887')
assert.equal(tabs.layout.counterSpacing, 8)
assert(flexDecls(tabs).includes('row-gap: 8px'))
assert(flexDecls(tabs).includes('flex-wrap: wrap'))
assert.deepEqual(orderFlow(tabs.children, tabs).map((n) => n.id), Array.from({ length: 12 }, (_, i) => `110:${888 + i}`))
const plan = verifyFlexPlan(model)
assert.equal(plan.mismatches.length, 0, JSON.stringify(plan.mismatches.slice(0, 3)))

// 3) 多段实例文字：All + 999 两段，字体/局部尺寸取 derived，不再统一 14px。
const all = byId('110:888')
assert.deepEqual(all.instanceTexts.map((p) => p.value), ['All', '999'])
assert.deepEqual(all.instanceTexts.map((p) => p.size), [13, 12])
assert.equal(all.instanceTexts[0].family, 'Nunito Sans')
assert.equal(all.instanceTexts[0].lineHeight, '20px')
assert.equal(all.value, 'All 999')
assert(!byId('110:896').instanceTexts.some((p) => p.x < 0 || p.y < 0), '实例文字不能相互叠出容器')
// 徽标在 derived 里有 strokeGeometry（描边证据）→ 渲染为描边胶囊，而不是自造浅色实底方块
const badge = all.instanceTexts.find((p) => p.value === '999')
assert.equal(badge.containerStroke, true)
assert.equal(badge.containerWidth, 30)
assert.equal(badge.containerHeight, 14)
const audit = auditModel(model)
assert(audit.missing.some((x) => x.includes('实例派生文字已恢复')))
assert(!audit.ambiguous.some((x) => x.includes('visible=false')), 'visible=false 是明确隐藏，不是设计歧义')

// 4) 图标：引用图标库原始 SVG；不从 Figma command blob 自绘。
const sound = byId('157:748')
assert.equal(iconRefOf(sound).name, 'akar-icons:sound-on')
const icons = await prepareIconifyAssets(model, out)
assert.equal(icons.failures.length, 0, JSON.stringify(icons.failures))
assert(icons.assets[sound.id]?.endsWith('.svg'))
const rendered = renderStatic(model, { outputDir: out, iconAssets: icons.assets })
const html = readFileSync(rendered.htmlPath, 'utf8')
assert(html.includes('data-icon-library="akar-icons:sound-on"'))
assert(html.includes('border-radius:999px'), '徽标应为描边胶囊（derived 有 strokeGeometry）')
assert(html.includes('data-src="icon-library"'))
assert.equal(rendered.stats.flexMismatches, 0)
assert(icons.assets && existsSync(resolve(out, icons.assets[sound.id])))

// 5) 真正的浏览器探针：设计规格坐标必须与基准页渲染后一致，而非只验证推演器自身。
const png = await exportStaticPagePng({ htmlPath: rendered.htmlPath, outPath: resolve(out, 'index@2x.png'), width: model.width, height: model.height })
assert(png.every((x) => x.ok), JSON.stringify(png))
const diff = await visualDiff({ implPathOrUrl: `file://${rendered.htmlPath}`, width: model.width, height: model.height, outDir: resolve(out, 'probe'), rows: model.spec, tolerance: 0.5 })
assert(diff.ok, diff.error)
assert.equal(diff.findings.length, 0, JSON.stringify(diff.findings.slice(0, 10)))

console.log(JSON.stringify({ ok: true, model: `${model.fileKey}/${model.nodeId}`, plan: { containers: plan.containers, flowChildren: plan.flowChildren, mismatches: 0 }, derivedTextSegments: nodes.flatMap((n) => n.instanceTexts ?? []).length, icons, output: out, png: png.map((x) => x.path), browserFindings: diff.findings.length }, null, 2))
