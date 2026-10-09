/**
 * 设计审计（Design Audit）：把 DesignModel 变成一份**可核对的实现清单**。
 *
 * 与上一版的区别（都是实测教训）：
 * - 不再用 `strokeWeight > 0 && strokePaints 为空` 判"隐藏边框"：Kiwi 里 strokeWeight 是
 *   带默认值的标量（实测 364 个节点 281 个 =1，真有描边的只有 22 个），该判据会对
 *   259 个"本来就没描边"的节点误报，最终把清单变成噪音、让会话 LLM 直接忽略整份清单。
 * - 描边按**逐边**读（borderStrokeWeightsIndependent + border*Weight），
 *   圆角按**逐角**读（rectangleCornerRadiiIndependent + rectangle*CornerRadius）。
 * - checklist 按类型分组并去重（同一套"背景 #fff / 描边 1px #dee0ec"只出现一次）。
 * - 把"**数据缺失**（实例内部数据 ws.json 里没有，必须用项目组件重建）"与
 *   "**真歧义**（设计本身没画清，需要问设计）"分开：前者给兜底规则，不写"不要猜"。
 */
import type { DesignModel, DesignSpecRow } from './design.js';
export interface AuditResult {
    fileKey: string;
    nodeId: string;
    componentName: string;
    width: number;
    height: number;
    nodeCount: number;
    instanceCount: number;
    checklist: string[];
    /** 真歧义：设计本身没说清，需要问设计（数量应为个位数） */
    ambiguous: string[];
    /** 数据缺失：解码数据里就没有，按兜底规则处理（不是"歧义"） */
    missing: string[];
    rows: DesignSpecRow[];
}
export declare function auditModel(model: DesignModel): AuditResult;
export declare function auditToMarkdown(a: AuditResult): string;
