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
type ReusePolicy = 'off' | 'auto' | 'explicit';
interface ReuseContractLite {
    id?: string;
    designNodeId?: string;
    designName?: string;
    level?: string;
    role?: string;
    projectComponent?: string;
    importPath?: string;
    match?: {
        source?: string;
        confidence?: number;
        status?: string;
        evidence?: string;
    };
    status?: string;
    verify?: {
        nodeId?: string;
        note?: string;
    };
    [k: string]: unknown;
}
export declare function normalizeReusePolicy(raw?: string): ReusePolicy;
/** confirmed 判定：席位A 的 status 在 match.status；兼容顶层 status（防御式） */
export declare function isConfirmedReuseContract(c: ReuseContractLite): boolean;
/** 把 component-reuse.json 的各种包裹形状归一成契约数组 */
export declare function normalizeReuseContracts(raw: unknown): ReuseContractLite[];
/**
 * 解析 reuse_contract：JSON 串或文件路径；解析失败抛明确错误（仿 normalizeNodeId 的 fail-closed）。
 * 返回契约数组（空串/undefined → undefined，表示未提供）。
 */
export declare function parseReuseContractInput(raw?: string): ReuseContractLite[] | undefined;
/**
 * 纯函数：静态核对 confirmed 契约的 projectComponent 是否真的在实现源码出现。
 * 不写 flow.json（写回由 figma_verify_reuse 工具层做）。
 */
export declare function verifyReuseImports(contracts: ReuseContractLite[], implSrcDir: string): {
    clean: boolean;
    missingImports: string[];
    hits: string[];
};
export declare function apply(ctx: Context, config: Config): void;
export {};
