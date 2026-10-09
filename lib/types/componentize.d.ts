import type { DesignModel } from './design.js';
export interface RepeatGroup {
    /** 结构指纹 */
    signature: string;
    /** 设计里的图层名（如 "Form Field"） */
    name: string;
    count: number;
    /** 子树节点数 */
    nodeCount: number;
    /** 建议的组件名（PascalCase） */
    suggestedName: string;
    /** 建议的 props（由内部文案派生） */
    props: Array<{
        name: string;
        type: string;
        sample: string;
        nodeId: string;
    }>;
    /** 代表节点的 id */
    representativeId: string;
    w: number;
    h: number;
    /** 是否值得抽成组件（结构性容器/无语义图层名 → false） */
    reusable: boolean;
    /** 不抽的理由（写进方案，便于人核对） */
    skipReason?: string;
}
export interface ReuseHint {
    /** 设计里的实例名（Input/Select/Button/Radio/日期选择…） */
    designName: string;
    count: number;
    /** 建议复用的项目组件（启发式；最终由会话按项目实际确认） */
    suggestion: string;
}
export interface ProjectConventions {
    codeDir: string;
    /** 组件根目录（相对 codeDir），如 isomorph/components */
    componentsRoot?: string;
    /** 组件目录形态 */
    layout: 'dir-index' | 'flat' | 'unknown';
    /** 形态证据（真实路径，供人核对） */
    evidence: string[];
    /** 样式后缀（.less / .css / .module.css） */
    styleExt?: string;
    /** 是否有 barrel（index.ts 汇总导出） */
    barrel?: boolean;
    /** 现成组件名样例（供复用匹配） */
    sampleNames: string[];
}
/** 重复结构 → 该抽成可复用组件的候选 */
export declare function detectRepeats(model: DesignModel, opts?: {
    minCount?: number;
    minNodes?: number;
}): RepeatGroup[];
export interface DesignSection {
    id: string;
    name: string;
    w: number;
    h: number;
    /** 该节里的节点数（含自身） */
    nodeCount: number;
    suggestedName: string;
}
/**
 * 顶层分区：把画布拆成"可以各自成为一个组件/文件"的块。
 * 规则：根的直接子级里，尺寸占主导的容器（内容区/导航/吸底）各自成块；
 * 内容区里再按它的直接子级容器（各业务节）细分。
 */
export declare function detectSections(model: DesignModel): DesignSection[];
/** 设计侧实例名 → 建议复用的项目组件（启发式；最终以项目实际为准） */
export declare function reuseHints(model: DesignModel): ReuseHint[];
/** 探测目标仓库的组件约定（组件根目录 / 目录形态 / 样式后缀 / barrel / 现成组件名） */
export declare function detectProjectConventions(codeDir: string, opts?: {
    maxFiles?: number;
}): ProjectConventions;
/** 生成组件化方案（人看 + 注入 Prompt） */
export declare function renderComponentPlan(opts: {
    model: DesignModel;
    repeats: RepeatGroup[];
    sections: DesignSection[];
    reuse: ReuseHint[];
    conventions?: ProjectConventions;
    componentName: string;
}): string;
