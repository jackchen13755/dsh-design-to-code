import type { CoverageReport, DesignModel, DesignNode } from './design.js';
import { type FlexMismatch } from './layout.js';
export interface StaticRenderOptions {
    outputDir: string;
    /** 组件/页面名（用于标题） */
    title?: string;
    /** 项目 token 映射（写进 SPEC.md 的对照表右列由调用方补） */
    projectName?: string;
    /** nodeId → 图标库原始 SVG 的相对路径（不自绘路径） */
    iconAssets?: Record<string, string>;
    /** 是否输出 SPEC.md（默认 true） */
    spec?: boolean;
}
export interface StaticRenderResult {
    htmlPath: string;
    /** 全绝对定位的对照页（旧行为，用于 diff 归因） */
    absHtmlPath: string;
    specPath?: string;
    specJsonPath: string;
    coveragePath: string;
    layoutReportPath: string;
    /** 几何真值清单：mismatch 节点的 flex 推断值 / 设计坐标 / 采用值（见 SPEC 0.3） */
    geometryTruthPath: string;
    /** abs.html 对应的 2x 图路径（真几何，供 UI 专家看；由工具层的导出流程落盘） */
    absPngPath: string;
    stats: {
        nodes: number;
        rules: number;
        instances: number;
        flexContainers: number;
        flexMismatches: number;
        borderFallbacks: number;
    };
}
interface Ds {
    line: string;
    lineStrong: string;
    text: string;
    placeholder: string;
    primary: string;
    accentSurface: string;
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
 */
export type JoinRole = 'mid' | 'leftEnd' | 'rightEnd';
export declare function joinRoleOf(n: DesignNode): JoinRole | undefined;
/** 从设计数据里"投票"出设计系统常量，避免把某个项目的色值写死在插件里 */
export declare function inferDesignSystem(model: DesignModel): Ds;
/** 生成 SPEC.md：设计规格 + 到项目 token 的映射表（右列由人/会话填） */
export declare function renderSpecMarkdown(model: DesignModel, ds: Ds, projectName?: string, iconAssets?: Record<string, string>, mismatches?: FlexMismatch[]): string;
export declare function renderStatic(model: DesignModel, opts: StaticRenderOptions): StaticRenderResult;
/** 供 codegen 复用的摘要行（把规格表塞进 Codegen Prompt） */
export declare function specTable(model: DesignModel, limit?: number): string;
export type { CoverageReport };
