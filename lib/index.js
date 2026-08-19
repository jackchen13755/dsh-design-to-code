import { defineTool } from '@deepseek-ai/dsh-tools';
import z from 'schemastery';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildDesignModel } from './design.js';
import { generateCode } from './codegen.js';
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
export function apply(ctx, config) {
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'figma_gen_component',
        description: '设计稿 + 需求 → React/TS/CSS Modules 代码骨架（零外部依赖）：读取 Figma（REST 缓存/WS 扩展帧），提取设计令牌与组件树，生成可运行组件 + Codegen Prompt',
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
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [textBlock(String(value))],
        },
        async execute(args) {
            const { fileKey, nodeId } = resolveTarget(args.url, args.file_key, args.node_id);
            const captureDir = resolve(args.ws_capture_dir || config.wsCaptureDir || join(homedir(), 'Downloads', 'figma_ws'));
            const outDir = resolve(args.output_dir || config.outputDir || join(homedir(), 'Desktop', 'design-to-code', nodeId.replace(':', '-')));
            // 1) 取节点 JSON
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
            // 2) 设计模型
            const model = buildDesignModel(nodeJson);
            // 3) 生成代码
            const componentName = args.component_name || model.componentName;
            const files = generateCode(model, {
                componentName,
                requirements: args.requirements || '（未提供需求，按设计稿默认交互：表单输入 + 按钮动作 + 关闭）',
                conventions: args.conventions || 'React 18 + TypeScript + CSS Modules，零运行时第三方依赖，组件/逻辑拆分，类型安全',
                outputDir: outDir,
            });
            return [
                `✅ 已生成 React 组件骨架（设计 ${fileKey} · 节点 ${nodeId}）`,
                `- 组件：${componentName}（${model.width}×${model.height}，${model.tree.children.length} 个直接子节点 / ${model.texts.length} 段文本）`,
                `- 设计令牌：${model.tokens.colors ? Object.keys(model.tokens.colors).length : 0} 色 / ${Object.keys(model.tokens.fonts).length} 字体`,
                `- 输出：${outDir}`,
                '',
                '生成文件：',
                ...files.map((f) => `  - ${f}`),
                '',
                '下一步：把 CODEGEN_PROMPT.md + 需求交给会话 LLM 补全交互与业务逻辑（保持零外部依赖与项目约定）。',
            ].join('\n');
        },
    })), '@deepseek-ai/dsh-tool-design-to-code: figma_gen_component');
}
export default apply;
//# sourceMappingURL=index.js.map