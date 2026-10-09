import type { DesignModel, DesignNode } from './design.js';
export interface StaticRenderOptions {
    outputDir: string;
    /** 组件/页面名（用于标题） */
    title?: string;
    /** 项目 token 映射（写进 SPEC.md 的对照表右列由调用方补） */
    projectName?: string;
    /** 是否输出 SPEC.md（默认 true） */
    spec?: boolean;
}
interface Ds {
    line: string;
    lineStrong: string;
    text: string;
    placeholder: string;
    primary: string;
    radius: number;
    controlH: number;
    fontFamily: string;
}
/** 是否处于"拼接控件组"的中间：同一父级下，左右都有兄弟且水平间距 ≤1px（设计用 stackSpacing=-1 表达共用一条边） */
export declare function middleOfJoinedGroup(n: DesignNode): boolean;
/** 从设计数据里"投票"出设计系统常量，避免把某个项目的色值写死在插件里 */
export declare function inferDesignSystem(model: DesignModel): Ds;
/** 生成 SPEC.md：设计规格 + 到项目 token 的映射表（右列由人/会话填） */
export declare function renderSpecMarkdown(model: DesignModel, ds: Ds, projectName?: string): string;
export declare function renderStatic(model: DesignModel, opts: StaticRenderOptions): {
    htmlPath: string;
    specPath?: string;
    specJsonPath: string;
    stats: {
        nodes: number;
        rules: number;
        instances: number;
    };
};
/** 供 codegen 复用的摘要行（把规格表塞进 Codegen Prompt） */
export declare function specTable(model: DesignModel, limit?: number): string;
export {};
