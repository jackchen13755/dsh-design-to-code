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
/**
 * 拼接控件组里的角色（由 renderStatic 预标注）：
 * - 'mid'      中间格 → 四角全方（radius 0）
 * - 'leftEnd'  左端格 → **右侧两角方**（共用边不能有圆角）
 * - 'rightEnd' 右端格 → **左侧两角方**
 * 规则是**结构性的**：同一行内子项水平相邻且间距 ≤1px（重叠 1px 或 0 间隙）就算拼接；
 * 与设计是否显式写了 0px 无关（很多实例的 radius 字段就是空的）。
 * 上一版只处理了"中间格"且只在 3 格行生效，专家复审实测出右端格（132:9306/132:9324）仍带全圆角。
 */
export type JoinRole = 'mid' | 'leftEnd' | 'rightEnd';
export declare function joinRoleOf(n: DesignNode): JoinRole | undefined;
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
