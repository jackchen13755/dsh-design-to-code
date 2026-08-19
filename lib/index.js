import { defineTool } from '@deepseek-ai/dsh-tools';
import z from 'schemastery';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildDesignModel } from './design.js';
import { generateCode } from './codegen.js';
import { auditNode, auditToMarkdown } from './audit.js';
export const name = '@deepseek-ai/dsh-tool-design-to-code';
export const inject = ['tools'];
export const Config = z.object({
    wsCaptureDir: z.string().default(''),
    outputDir: z.string().default(''),
});
function textBlock(text) {
    return { type: 'text', text };
}
function parseNodeUrl(url) {
    const m = url.match(/figma\.com\/(?:design|file|proto)\/([^/?]+)/);
    const n = url.match(/node-id=([^&]+)/);
    if (!m)
        throw new Error(`无法从 URL 解析 file key：${url}`);
    const fileKey = m[1];
    const nodeId = n ? decodeURIComponent(n[1]).replace('-', ':') : '';
    return { fileKey, nodeId };
}
function resolveTarget(url, fileKey, nodeId) {
    if (url)
        return parseNodeUrl(url);
    if (fileKey && nodeId)
        return { fileKey, nodeId };
    throw new Error('需要 url，或 file_key + node_id');
}
/** 从捕获目录找最新数据帧（manifest 优先，<1KB 时回退到最大帧）。 */
async function findDataFrame(dir) {
    const manifestPath = join(dir, 'last_capture.json');
    if (existsSync(manifestPath)) {
        try {
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
            if (manifest.dataFile && Number(manifest.dataSize ?? 0) >= 1024) {
                const p = join(dir, manifest.dataFile);
                if (existsSync(p))
                    return { dataPath: p, schemaPath: manifest.schemaFile ? join(dir, manifest.schemaFile) : null, manifest };
            }
        }
        catch {
            // ignore
        }
    }
    const files = (await readdir(dir)).filter((f) => /^frame_0001_recv_\d+b\.bin$/.test(f));
    if (!files.length)
        throw new Error(`目录 ${dir} 没有数据帧（先装扩展并打开 Figma 页面，或传 design_json）`);
    const stats = await Promise.all(files.map(async (f) => ({ f, m: (await stat(join(dir, f))).mtimeMs })));
    stats.sort((a, b) => b.m - a.m);
    return { dataPath: join(dir, stats[0].f), schemaPath: null, manifest: null };
}
/** 统一取节点 JSON（design_json 优先，否则 WS 扩展帧自动解码，零 REST）。 */
async function loadNodeJson(args, config) {
    const { fileKey, nodeId } = resolveTarget(args.url, args.file_key, args.node_id);
    const captureDir = resolve(args.ws_capture_dir || config.wsCaptureDir || join(homedir(), 'Downloads', 'figma_ws'));
    const outDir = resolve(args.output_dir || config.outputDir || join(homedir(), 'Desktop', 'design-to-code', nodeId.replace(':', '-')));
    let nodeJson;
    if (args.design_json) {
        nodeJson = JSON.parse(await readFile(resolve(args.design_json), 'utf8'));
    }
    else {
        const tmp = join(outDir, '.decode');
        await mkdir(tmp, { recursive: true });
        const { dataPath } = await findDataFrame(captureDir);
        // 复用 dsh-figma-reader 的解码器（vendored Kiwi decoder，零 REST）
        const { decodeFrameAndBuildReport } = await import('@deepseek-ai/dsh-tool-figma-reader/lib/kiwi.js');
        const dec = decodeFrameAndBuildReport(dataPath, fileKey, nodeId, tmp);
        nodeJson = JSON.parse(await readFile(dec.jsonPath, 'utf8'));
    }
    return { nodeJson, fileKey, nodeId, outDir, captureDir };
}
export function apply(ctx, config) {
    ctx.effect(() => {
        const disposers = [];
        // ── 工具 1：设计审计（多轮生成第 0/1 轮） ──
        disposers.push(ctx.tools.register(defineTool({
            name: 'figma_audit_node',
            description: '设计审计（多轮生成前置步骤）：全量遍历目标节点输出完整视觉属性（fill/stroke/dashPattern/padding/effects/文本），自动生成「实现前核对清单」markdown，歧义节点标记“待人工确认”。输入与 figma_gen_component 相同',
            parameters: {
                url: { type: 'string', description: 'Figma 设计稿 URL（含 node-id）' },
                file_key: { type: 'string', description: 'Figma file key（传 url 时可不填）' },
                node_id: { type: 'string', description: '节点 ID，如 8049:4704（传 url 时可不填）' },
                design_json: { type: 'string', description: '已解码节点 JSON 路径（dsh-figma-reader 产物）；缺省读 ~/Downloads/figma_ws 帧自动解码' },
                output_dir: { type: 'string', description: '输出目录，默认 ~/Desktop/design-to-code/<nodeId>' },
                ws_capture_dir: { type: 'string', description: '捕获目录，默认 ~/Downloads/figma_ws' },
            },
            output: {
                schema: { type: 'string' },
                render: (_args, value) => [textBlock(String(value))],
            },
            async execute(args) {
                const { nodeJson, fileKey, nodeId, outDir } = await loadNodeJson(args, config);
                const audit = auditNode(nodeJson);
                await mkdir(outDir, { recursive: true });
                await import('node:fs/promises').then((fs) => fs.writeFile(join(outDir, `figma_${fileKey}_${nodeId}.audit.json`), JSON.stringify(audit, null, 2), 'utf8'));
                const md = auditToMarkdown(audit);
                const mdPath = join(outDir, `figma_${fileKey}_${nodeId}.audit.md`);
                await import('node:fs/promises').then((fs) => fs.writeFile(mdPath, md, 'utf8'));
                return [
                    `🔍 设计审计完成（${fileKey} · ${nodeId}）`,
                    `- 节点总数：${audit.entries.length} · 核对项：${audit.checklist.length} · 待人工确认：${audit.ambiguousCount}`,
                    `- 清单：${mdPath}`,
                    '',
                    '实现前请逐项勾选 checklist；歧义项不要猜，先人工确认或截图对照。',
                    '',
                    '多轮流程建议：',
                    '1. 本步（审计）→ 2. figma_gen_component（骨架，audit_path 传入本清单）→ 3. 会话 LLM 补全 → 4. figma_codegen_round（按反馈迭代）',
                ].join('\n');
            },
        })));
        // ── 工具 2：代码骨架生成（多轮生成第 1 轮） ──
        disposers.push(ctx.tools.register(defineTool({
            name: 'figma_gen_component',
            description: '设计稿 + 需求 → React/TS/CSS Modules 代码骨架（零外部依赖）：读取 Figma（REST 缓存/WS 扩展帧），提取设计令牌与组件树，生成可运行组件 + Codegen Prompt；支持多轮（round/round_feedback/audit_path）',
            parameters: {
                url: { type: 'string', description: 'Figma 设计稿 URL（含 node-id）' },
                file_key: { type: 'string', description: 'Figma file key（传 url 时可不填）' },
                node_id: { type: 'string', description: '节点 ID，如 8049:4704（传 url 时可不填）' },
                design_json: { type: 'string', description: '已解码节点 JSON 路径（dsh-figma-reader 产物）；缺省读 ~/Downloads/figma_ws 帧自动解码' },
                requirements: { type: 'string', description: '需求描述（交互/业务/校验/接口），供 Codegen Prompt 使用' },
                conventions: { type: 'string', description: '项目约定（技术栈/目录/命名/测试），JSON 或自然语言，缺省 React+TS+CSS Modules+零外部依赖' },
                component_name: { type: 'string', description: '生成组件名（英文，如 ReplaceRoomDialog）；缺省从设计稿节点名推导' },
                output_dir: { type: 'string', description: '输出目录，默认 ~/Desktop/design-to-code/<nodeId>' },
                ws_capture_dir: { type: 'string', description: '捕获目录，默认 ~/Downloads/figma_ws' },
                audit_path: { type: 'string', description: 'figma_audit_node 生成的 audit.md 路径；存在则把核对清单并入 Codegen Prompt' },
                round: { type: 'number', description: '生成轮次（默认 1；>1 时把 round_feedback 并入 Prompt 继续迭代）' },
                round_feedback: { type: 'string', description: '上一轮反馈/差异/评审意见（round>1 时必填）' },
            },
            output: {
                schema: { type: 'string' },
                render: (_args, value) => [textBlock(String(value))],
            },
            async execute(args) {
                const { nodeJson, fileKey, nodeId, outDir } = await loadNodeJson(args, config);
                // 设计模型 + 可选审计清单
                const model = buildDesignModel(nodeJson);
                let auditMd = '';
                if (args.audit_path) {
                    auditMd = await readFile(resolve(args.audit_path), 'utf8');
                }
                else {
                    // 自动生成一份审计（不落盘，仅内联进 Prompt）
                    auditMd = auditToMarkdown(auditNode(nodeJson));
                }
                const componentName = args.component_name || model.componentName;
                const round = Math.max(1, Number(args.round ?? 1));
                const files = generateCode(model, {
                    componentName,
                    requirements: args.requirements || '（未提供需求，按设计稿默认交互：表单输入 + 按钮动作 + 关闭）',
                    conventions: args.conventions || 'React 18 + TypeScript + CSS Modules，零运行时第三方依赖，组件/逻辑拆分，类型安全',
                    outputDir: outDir,
                    auditMd,
                    round,
                    roundFeedback: args.round_feedback || '',
                });
                return [
                    `✅ 已生成 React 组件骨架 第 ${round} 轮（设计 ${fileKey} · 节点 ${nodeId}）`,
                    `- 组件：${componentName}（${model.width}×${model.height}，${model.texts.length} 段文本）`,
                    `- 设计令牌：${Object.keys(model.tokens.colors).length} 色 / ${Object.keys(model.tokens.fonts).length} 字体`,
                    `- 审计：${auditMd.split('\n').filter((l) => l.startsWith('- [ ]')).length} 项核对清单已并入 CODEGEN_PROMPT.md`,
                    `- 输出：${outDir}`,
                    '',
                    '生成文件：',
                    ...files.map((f) => `  - ${f}`),
                    '',
                    `下一步（第 ${round + 1} 轮）：会话 LLM 按 CODEGEN_PROMPT.md 补全后，运行 figma_codegen_round 传入 review/差异继续迭代，直到 checklist 全勾选。`,
                ].join('\n');
            },
        })));
        // ── 工具 3：多轮迭代（第 2+ 轮） ──
        disposers.push(ctx.tools.register(defineTool({
            name: 'figma_codegen_round',
            description: '多轮代码生成迭代：在已有输出目录上追加下一轮 Codegen 指令（基于上一轮 review/差异），更新 CODEGEN_PROMPT.md 与 round 记录；不重复生成骨架',
            parameters: {
                output_dir: { type: 'string', description: '已有输出目录（figma_gen_component 的 output_dir）' },
                round_feedback: { type: 'string', description: '本轮 review/差异/截图对照结论（必填）' },
                requirements: { type: 'string', description: '需求（可省略，保留首轮即可）' },
                conventions: { type: 'string', description: '项目约定（可省略）' },
            },
            output: {
                schema: { type: 'string' },
                render: (_args, value) => [textBlock(String(value))],
            },
            async execute(args) {
                const dir = resolve(args.output_dir);
                const promptPath = join(dir, 'CODEGEN_PROMPT.md');
                if (!existsSync(promptPath))
                    throw new Error(`找不到 ${promptPath}，先运行 figma_gen_component`);
                const roundPath = join(dir, '.codegen-round');
                let round = 1;
                try {
                    round = Number(await readFile(roundPath, 'utf8')) || 1;
                }
                catch { /* ignore */ }
                round += 1;
                const prompt = await readFile(promptPath, 'utf8');
                const append = [
                    '',
                    `## 第 ${round} 轮迭代（由 figma_codegen_round 生成）`,
                    '',
                    `### 本轮反馈 / 差异 / 截图对照`,
                    args.round_feedback,
                    '',
                    '### 本轮必做',
                    '1. 先按反馈核对 design-spec.json 与审计清单，确认差异根因（是设计数据漏读还是实现偏差）；',
                    '2. 只改差异点，不重构无关代码；',
                    '3. 若涉及项目既有模式（footer/侧边栏/弹窗等），先 grep 现有实现再动手；',
                    '4. 完成后更新 audit.md 对应 checkbox（勾选/标注）；',
                    '5. 把可复用事实（如“本应用底部栏统一用 profile-footer-wrap：fixed + width:100% + left:0”）记入 Noema，便于后续复用。',
                ].join('\n');
                await import('node:fs/promises').then((fs) => fs.writeFile(promptPath, `${prompt}\n${append}`, 'utf8'));
                await import('node:fs/promises').then((fs) => fs.writeFile(roundPath, String(round), 'utf8'));
                return [
                    `🔄 已追加第 ${round} 轮迭代指令（${dir}）`,
                    '',
                    '接下来：会话 LLM 按更新后的 CODEGEN_PROMPT.md 继续实现，本轮反馈集中在差异点；',
                    '验证闭环：本地 WS 解码 JSON → audit 清单勾选 → figma_read_node/figma_read_node_ws 截图对照；',
                    '全部 checklist 勾选 + 截图对照无差异后，多轮生成结束。',
                ].join('\n');
            },
        })));
        return disposers;
    }, '@deepseek-ai/dsh-tool-design-to-code');
}
//# sourceMappingURL=index.js.map