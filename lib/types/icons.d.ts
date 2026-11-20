import type { DesignModel, DesignNode } from './design.js';
export interface DesignIconRef {
    /** 如 akar-icons:sound-on */
    name: string;
    source: 'iconify';
    color?: string;
    size?: number;
}
export declare function iconRefOf(node: DesignNode): DesignIconRef | undefined;
export declare function walkDesignNodes(root: DesignNode, visit: (node: DesignNode) => void): void;
/**
 * 按 Figma 的 Iconify metadata 取图标库官方 SVG 并落到 static/assets。
 * 已有文件优先（可离线复现）；失败不静默：返回每个节点的错误供工具输出与审计使用。
 * 路径只来自已校验的 icon-set/name，不读取调用方任意路径。
 */
export declare function prepareIconifyAssets(model: DesignModel, outputDir: string): Promise<{
    assets: Record<string, string>;
    failures: string[];
}>;
