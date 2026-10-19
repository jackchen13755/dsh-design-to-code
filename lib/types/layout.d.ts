/**
 * auto-layout → flex 的映射与**自校验**。
 *
 * 为什么需要这一层：auto-layout 在数据里是 `stack*` 一堆字段，而"到底该谁吸收剩余空间、
 * 主轴怎么对齐、要不要换行"决定了 flex 写出来对不对。以前这些字段只被读了一半，
 * 剩下的交给会话 LLM 脑补 —— 于是每一轮评审都在修同一批位移/换行。
 *
 * 这里做两件事：
 *  1. `flexDecls()`：把 DesignLayout 翻成一组确定的 CSS 声明（渲染器共用，保证基准页与骨架同源）；
 *  2. `verifyFlexPlan()`：按同一套规则**推演一遍**每个容器的子项位置，与设计坐标比对，
 *     输出 `abs-vs-flex.json`。差异为 0 才说明"flex 计划能复现设计"，否则是计划本身错了，
 *     而不是实现写错了 —— 这条判据把"翻译阶段的损耗"变成了可断言的产物。
 */
import type { DesignBorder, DesignModel, DesignNode } from './design.js';
export interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}
export interface FlexMismatch {
    id: string;
    name: string;
    containerId: string;
    expected: Box;
    actual: Box;
    delta: [number, number, number, number];
}
export declare const isHorizontal: (mode?: string) => boolean;
/**
 * flex 流里的**渲染顺序**：按设计坐标的主轴位置排，而不是按图层数组顺序。
 * 实测有些容器（如 132:9418）子项数组顺序与 x 顺序相反（z-order 与布局顺序不一致），
 * 按数组渲染会把两个子项左右调换 —— 与设计坐标不符。
 */
export declare function orderFlow(kids: DesignNode[], parent: DesignNode): DesignNode[];
/** 子项是否在父容器的 flex 流里（绝对子项 / 父容器不是 auto-layout 时不在） */
export declare function flowsInParent(child: DesignNode, parent?: DesignNode): boolean;
/**
 * 容器四边实际从"盒边界"到"内容起点"的距离。
 *
 * Figma 的 `bordersTakeSpace=true` 表示**描边占空间**（内容整体让开 border），
 * 而我们把描边画成 inset shadow（不占布局）——所以必须把 border 宽度折算进 padding，
 * 否则子项会整体偏 border 宽度（实测 132:8223：x/y 各偏 1px、宽偏 0.67px）。
 */
export declare function contentInsets(n: DesignNode): [number, number, number, number];
/** 容器自身的 flex 声明（不含定位） */
export declare function flexDecls(n: DesignNode): string[];
/** 子项在父 flex 流里的声明（不含尺寸/背景） */
export declare function flowChildDecls(child: DesignNode, parent: DesignNode, index?: number): string[];
/**
 * 按 flex 规则推演子项位置，与设计坐标比对。
 * 只检查"在流里"的子项；绝对子项按 left/top 天然一致，不参与。
 */
export declare function verifyFlexPlan(model: DesignModel, tol?: number): {
    containers: number;
    flowChildren: number;
    mismatches: FlexMismatch[];
};
/**
 * 描边的**非布局**画法（关键修复）。
 *
 * 为什么不能用 CSS `border`：CSS 的 border 会占布局空间，流内子项从 border 之后起算；
 * 而 Figma 的子节点坐标**不含 stroke**（`stackPadding` 已含在内）。直接写 border 会让
 * 每个带边框的自动布局容器里的子项整体偏移 = borderLeft/borderTop（实测 1–2px，
 * 涉及 22 个容器 / 207 个子项），而且这种偏移"照基准页改"也修不掉。
 *
 * 画法：
 * - 实线 → 用 inset `box-shadow`（逐边等宽可合成一条），完全不参与布局；
 * - 虚线（uniform 四边等宽）→ 用 `outline` + 负 `outline-offset`（同样不参与布局）；
 * - 虚线但四边不等宽 → 退回 `border`（CSS 无法表达非均匀 outline），并从返回值里标记 fallback。
 */
export declare function borderPaint(b: DesignBorder | undefined, baseShadow?: string): {
    decls: string[];
    fallback: boolean;
};
/**
 * 圆角声明（基准页与骨架共用的唯一实现）。
 * 设计有值就用；没有才按拼接角色推：中间格方角 / 两端格只留外侧圆角 / 其余回落设计系统圆角。
 * 以前只有基准页跑这段，骨架 `if (n.radius)` → 32 个实例出现"基准 8px、骨架直角"。
 */
export declare function radiusDecl(n: DesignNode, dsRadius: number): {
    value: string;
    guessed: boolean;
};
/** 根节点（#frame / .root）的声明：根自己也可能有 auto-layout，必须有 display:flex */
export declare function rootCssDecls(model: DesignModel): string[];
