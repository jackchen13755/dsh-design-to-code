/**
 * 评审闭环：把「UI 专家 / 验收专家」的整改清单变成**可追踪的轮次任务**。
 *
 * 为什么需要它：probe 能测出"逐边描边/逐角圆角/高度/字号"这类**可量化**差异，
 * 但测不出"视觉层级、信息密度、文案、一致性"这类**需要人味判断**的问题。
 * 这类问题由专家子 agent 出整改清单，然后必须能：
 *   ① 结构化进 CODEGEN_PROMPT.md（下一轮按条目改，而不是"看着办"）；
 *   ② 逐条记状态（open / closed），**未关闭的项不允许收尾**；
 *   ③ 留下"谁在什么时候提的、什么时候关的"，可审计。
 *
 * 解析是启发式的（专家输出是自然语言 markdown），所以：
 * - 支持列表项、表格行、编号项；
 * - 支持显式结构化输入（items JSON）以绕过解析；
 * - 解析结果会原样回显给人核对，避免"解析错了没人发现"。
 */
export type ReviewSeverity = 'blocker' | 'major' | 'minor' | 'info';
export interface ReviewItem {
    id: string;
    severity: ReviewSeverity;
    text: string;
    location?: string;
    expected?: string;
    actual?: string;
    /** 设计稿节点 id（如 132:8240）——用于在基准图上钉框 */
    nodeId?: string;
    /** 设计稿内坐标 [x,y,w,h]（由 nodeId 解析或直接给） */
    box?: [number, number, number, number] | null;
}
export interface ReviewItemState extends ReviewItem {
    status: 'open' | 'closed';
    closedBy?: string;
    closedAt?: string;
    closedNote?: string;
}
export interface ReviewRoundState {
    round: number;
    reviewer: string;
    at: string;
    source?: string;
    /** 审计对象：baseline（设计基准本身）| implementation（组件实现 vs 基准） */
    scope?: 'baseline' | 'implementation';
    /** 判定：有 blocker/major → reject（打回）；否则 pass */
    verdict?: 'pass' | 'reject';
    annotatedImage?: string;
    items: ReviewItemState[];
}
/**
 * 解析专家整改清单。启发式但保守：只收"看起来是一条整改项"的行，
 * 且返回结果会原样回显给调用方核对。
 */
export declare function parseReview(text: string, opts?: {
    maxItems?: number;
    resolveBox?: (nodeId: string) => [number, number, number, number] | null;
}): ReviewItem[];
/** 专家整改清单 → 追加进 CODEGEN_PROMPT.md 的轮次内容 */
export declare function renderReviewRound(items: ReviewItem[], meta: {
    round: number;
    reviewer: string;
    at: string;
    source?: string;
    extra?: string;
}): string;
/** 未关闭条目（收尾门禁用） */
export declare function openItems(rounds: ReviewRoundState[] | undefined): ReviewItemState[];
export declare function summarizeRounds(rounds: ReviewRoundState[] | undefined): string;
/** 是否已经过至少一轮 UI 专家审计（主流程要求项） */
export declare function hasExpertReview(rounds: ReviewRoundState[] | undefined): boolean;
export declare function openByeSeverity(rounds: ReviewRoundState[] | undefined): {
    blocker: number;
    major: number;
    minor: number;
};
