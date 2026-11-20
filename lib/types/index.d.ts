import type { Context } from '@deepseek-ai/cordis';
import z from 'schemastery';
export declare const name = "@deepseek-ai/dsh-tool-design-to-code";
export declare const inject: string[];
export interface Config {
    /** figma_ws 捕获目录（浏览器扩展静默生成），默认 ~/Downloads/figma_ws。 */
    wsCaptureDir?: string;
    /** 默认导出目录。 */
    outputDir?: string;
}
export declare const Config: z<Schemastery.ObjectS<{
    wsCaptureDir: z<string, string>;
    outputDir: z<string, string>;
}>, Schemastery.ObjectT<{
    wsCaptureDir: z<string, string>;
    outputDir: z<string, string>;
}>>;
/**
 * node-id 归一化（唯一入口，绝不猜节点）：
 *  - trim + decodeURIComponent（URL 里 node-id=110%3A854、或末尾带空格都算合法）
 *  - `^\d+-\d+$` → colon（`110-854` → `110:854`）
 *  - `^\d+:\d+$` → 原样（`110:854`）
 *  - 其它格式（空、缺段、多段、含字母、解码失败）一律抛明确错误
 */
export declare function normalizeNodeId(raw: string): string;
export declare function apply(ctx: Context, config: Config): void;
