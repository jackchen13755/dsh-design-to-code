/**
 * 设计审计（Design Audit）：全量遍历目标节点，逐节点输出完整视觉属性，
 * 并自动生成「实现前核对清单」（checklist）。
 *
 * 记忆 mem_88d6b6f0（ARS 教训）：
 * - 不要只读“看着像容器”的节点，要全量遍历（背景/边框常藏在子容器）；
 * - Kiwi 用 guid(sessionID:localID)，fills 字段是 fillPaints；
 * - 虚线边框在 dashPattern（如 [4]），不是 strokeDashes；
 * - fill visible=false 或 strokeWeight>0 但 strokePaints 为空 → 标记“待人工确认”，不要猜。
 */
type Any = Record<string, any>;
export interface AuditEntry {
    guid: string;
    name: string;
    type: string;
    x: number;
    y: number;
    w: number;
    h: number;
    fillPaints: Array<{
        visible: boolean;
        rgba: string;
        type: string;
    }>;
    strokePaints: Array<{
        visible: boolean;
        rgba: string;
        type: string;
    }>;
    strokeWeight: number | null;
    strokeAlign: string | null;
    dashPattern: number[];
    padding: {
        top: number | null;
        right: number | null;
        bottom: number | null;
        left: number | null;
    };
    text: {
        characters: string;
        fontSize: number | null;
        fontWeight: string | null;
        lineHeight: number | null;
        letterSpacing: number | null;
        color: string | null;
        alignHorizontal: string | null;
    } | null;
    effects: Array<{
        type: string;
        visible: boolean;
        css: string;
    }>;
    ambiguous: string[];
}
export interface AuditResult {
    fileKey: string;
    nodeId: string;
    componentName: string;
    width: number;
    height: number;
    entries: AuditEntry[];
    checklist: string[];
    ambiguousCount: number;
}
export declare function auditNode(nodeJson: Any): AuditResult;
/** 生成「实现前核对清单」markdown。 */
export declare function auditToMarkdown(a: AuditResult): string;
export {};
