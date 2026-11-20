export interface VisualDiffOptions {
    /** 实现页（file:// 路径或 http(s) URL；后者仅本地同源可读） */
    implPathOrUrl: string;
    /** 设计画布尺寸（用于 iframe 视口） */
    width: number;
    height: number;
    /** 可接受的偏差（px），默认 1 */
    tolerance?: number;
    /** 探针产物目录 */
    outDir: string;
    chromeBin?: string;
}
export interface SpecRowLite {
    id: string;
    name: string;
    kind: string;
    x: number;
    y: number;
    w: number;
    h: number;
    background?: string;
    borderEdges?: string;
    radius?: string;
    font?: string;
    color?: string;
    dash?: string;
}
export interface ProbeNode {
    id: string;
    left: number;
    top: number;
    width: number;
    height: number;
    color: string;
    backgroundColor: string;
    borderRadius: string;
    borderTopWidth: string;
    borderRightWidth: string;
    borderBottomWidth: string;
    borderLeftWidth: string;
    borderTopStyle: string;
    fontSize: string;
    fontWeight: string;
    lineHeight: string;
    display: string;
    backgroundImage?: string;
    boxShadow?: string;
    outlineStyle?: string;
    outlineWidth?: string;
    /** 该元素上标了哪些"推断/占位"属性（data-guessed） */
    guessed?: string;
    flexDirection: string;
    gap: string;
    opacity: string;
}
export interface VisualFinding {
    nodeId: string;
    name: string;
    property: string;
    expected: string;
    actual: string;
    delta?: number;
    severity: 'blocker' | 'major' | 'minor';
}
/** 设计树的最小形状（DesignNode 结构上满足：id + 可选 children/raw.visible） */
export interface TreeLikeNode {
    id: string;
    children?: TreeLikeNode[];
    raw?: {
        visible?: boolean;
    };
}
/**
 * 从完整设计树里取某个节点的后代 data-design-id 集合（含自身）。
 *  - 找不到节点 → 返回 null（调用方必须抛明确错误，绝不静默退化成整页对比）
 *  - 跳过 raw.visible === false 的子树，与骨架/基准页口径一致
 *  - 去重且保持树序
 */
export declare function descendantDesignIds(tree: TreeLikeNode | undefined, nodeId: string): string[] | null;
/**
 * 从 computed box-shadow 反解"描边四边"。
 * 我们（基准页/骨架）用非布局画法表达描边：
 *  - 实线：`inset 0 0 0 Npx`（等宽）或 `inset 0 ±Npx 0 0`（逐边）；只认 **blur=0** 的层，
 *    避免把设计里的 INNER_SHADOW（通常 blur>0）误判成描边；
 *  - 虚线：`outline: Npx dashed`（等宽，四边同宽）。
 */
export declare function edgesFromProbe(n: ProbeNode): [number, number, number, number];
/** 逐节点对照，产出结构化差异 */
export declare function compareProbe(rows: SpecRowLite[], nodes: ProbeNode[], tolerance?: number, root?: {
    left: number;
    top: number;
    width: number;
    height: number;
}, canvas?: {
    width: number;
    height: number;
}): {
    findings: VisualFinding[];
    checked: number;
    missing: string[];
    scale?: number;
};
export interface VisualDiffResult {
    ok: boolean;
    findings: VisualFinding[];
    checked: number;
    missing: string[];
    /** findings=0 且没有实现页缺失节点（= 没有未接受的差异）；收尾门禁据此放行 */
    clean: boolean;
    reportPath?: string;
    jsonPath?: string;
    error?: string;
}
/** 一站式：跑探针 → 对照 → 落盘报告 */
export declare function visualDiff(opts: VisualDiffOptions & {
    rows: SpecRowLite[];
}): Promise<VisualDiffResult>;
