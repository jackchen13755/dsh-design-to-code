#!/usr/bin/env node
/**
 * 设计审计 CLI：输入节点 → 输出全量视觉属性清单 + 实现前核对清单。
 *
 * 用法：
 *   node scripts/audit-node.mjs <fileKey> <nodeId> [--dir <captureDir>] [--out <outDir>]
 *   node scripts/audit-node.mjs <fileKey> <nodeId> --data <frame_0001_recv_*.bin>
 *   node scripts/audit-node.mjs <fileKey> <nodeId> --json <decoded.json>
 *
 * 数据源优先 --json（已解码节点 JSON），否则用浏览器扩展捕获帧零 REST 解码。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { auditNode, auditToMarkdown } from '../lib/audit.js'

function parseArgs(argv) {
  const args = { fileKey: argv[2], nodeId: argv[3] }
  for (let i = 4; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--dir') args.dir = argv[++i]
    else if (k === '--out') args.out = argv[++i]
    else if (k === '--data') args.data = argv[++i]
    else if (k === '--json') args.json = argv[++i]
  }
  return args
}

async function findDataFrame(dir) {
  const manifestPath = join(dir, 'last_capture.json')
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (m.dataFile && Number(m.dataSize ?? 0) >= 1024) {
        const p = join(dir, m.dataFile)
        if (existsSync(p)) return p
      }
    } catch { /* ignore */ }
  }
  const { readdir } = await import('node:fs/promises')
  const files = (await readdir(dir)).filter((f) => /^frame_0001_recv_\d+b\.bin$/.test(f))
  if (!files.length) throw new Error(`目录 ${dir} 没有数据帧（先装扩展打开 Figma，或 --json 传已解码 JSON）`)
  return join(dir, files[files.length - 1])
}

async function main() {
  const args = parseArgs(process.argv)
  if (!args.fileKey || !args.nodeId) {
    console.error('用法: node scripts/audit-node.mjs <fileKey> <nodeId> [--json path | --data path | --dir dir] [--out dir]')
    process.exit(1)
  }

  let nodeJson
  if (args.json) {
    nodeJson = JSON.parse(await readFile(resolve(args.json), 'utf8'))
  } else {
    const dir = resolve(args.dir || join(homedir(), 'Downloads', 'figma_ws'))
    const dataPath = args.data ? resolve(args.data) : await findDataFrame(dir)
    // 复用 dsh-figma-reader 的 Kiwi 解码器（零 REST）
    const { decodeFrameAndBuildReport } = await import('@deepseek-ai/dsh-tool-figma-reader/lib/kiwi.js')
    const tmp = resolve(args.out || '.') + '/.decode-audit'
    await mkdir(tmp, { recursive: true })
    const dec = decodeFrameAndBuildReport(dataPath, args.fileKey, args.nodeId, tmp)
    nodeJson = JSON.parse(await readFile(dec.jsonPath, 'utf8'))
  }

  const audit = auditNode(nodeJson)
  const outDir = resolve(args.out || `.`)
  await mkdir(outDir, { recursive: true })
  const mdPath = join(outDir, `figma_${args.fileKey}_${args.nodeId}.audit.md`)
  await writeFile(mdPath, auditToMarkdown(audit), 'utf8')
  await writeFile(join(outDir, `figma_${args.fileKey}_${args.nodeId}.audit.json`), JSON.stringify(audit, null, 2), 'utf8')

  console.log(`节点数 ${audit.entries.length} · 核对项 ${audit.checklist.length} · 待人工确认 ${audit.ambiguousCount}`)
  console.log(`清单已写入 ${mdPath}`)
  if (audit.ambiguousCount) {
    console.log(`⚠️ ${audit.ambiguousCount} 项歧义需人工确认（见 audit.md）`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
