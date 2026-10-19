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
 * ── 这一版修掉的解析缺陷（实测：三行标准专家表格全部被判成 info → verdict=pass）──
 * 旧实现把表格行拆开后**丢掉了"级别"列**（被当噪声过滤），只拿"最长的那一格"去匹配严重级关键词，
 * 于是「锚点项应为只有左边框…」这种不含关键词的描述一律变 info，含 blocker 的一轮被判定"通过"。
 * 现在：先识别表头 → 按列名定位"级别/问题/位置/期望/实际" → 级别优先取显式列，列缺失才退回正文关键词。
 *
 * ── 作用域（scope）分区 ──
 * baseline（设计基准本身）与 implementation（实现 vs 基准）的条目分开记、分开算未关闭，
 * 避免"基准页的遗留项阻塞实现收尾"或反过来。
 */
export type ReviewSeverity = 'blocker' | 'major' | 'minor' | 'info';
export interface ReviewItem {
    id: string;
    severity: ReviewSeverity;
    /** 级别来自哪里：column（显式级别列）/ text（正文关键词）/ default */
    severitySource?: 'column' | 'text' | 'default';
    text: string;
    location?: string;
    expected?: string;
    actual?: string;
    /** 设计稿节点 id（如 132:8240）——用于在基准图上钉框 */
    nodeId?: string;
    /** 设计稿内坐标 [x,y,w,h]（由 nodeId 解析或直接给） */
    box?: [number, number, number, number] | null;
}
export type ReviewStatus = 'open' | 'closed' | 'accepted';
export interface ReviewItemState extends ReviewItem {
    /** accepted = 命中 known-diffs（已确认接受的差异），不阻塞收尾、也不再重复提出 */
    status: ReviewStatus;
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
    /** 本轮没有任何问题（干净的 pass）：允许落盘，且仍然算"审计发生过" */
    emptyRound?: boolean;
}
/** 已确认接受的差异（figma_confirm_static 的 diffs 落成结构化条目） */
export interface KnownDiff {
    /** 可选：只对这一条评审条目 id 生效 */
    id?: string;
    /** 设计稿节点 id（命中即视为同一条） */
    nodeId?: string;
    /** 属性/关键词（如 "radius" / "虚线" / "字体"），出现在条目正文里即视为同一条 */
    property?: string;
    /** 自由说明 */
    note?: string;
    at?: string;
}
/**
 * 解析专家整改清单。启发式但保守：
 * - 有表头就按列取（级别列是权威）；
 * - 没表头退回"最长格 + 整行关键词"；
 * - 结果会原样回显给调用方核对。
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
/** 未关闭条目（收尾门禁用）。scope 省略 = 不过滤 */
export declare function openItems(rounds: ReviewRoundState[] | undefined, scope?: 'baseline' | 'implementation'): ReviewItemState[];
/** 已接受（命中 known-diffs）的条目 */
export declare function acceptedItems(rounds: ReviewRoundState[] | undefined, scope?: 'baseline' | 'implementation'): ReviewItemState[];
export declare function summarizeRounds(rounds: ReviewRoundState[] | undefined): string;
/**
 * 是否已经过至少一轮**有效**专家审计。
 * 旧实现只看"有记录"，导致一轮只解析出 1 条 minor（或只做了 baseline 审计）也算"实现已审计"。
 */
export declare function hasExpertReview(rounds: ReviewRoundState[] | undefined, scope?: 'baseline' | 'implementation'): boolean;
/**
 * baseline 审计的 fail-closed 级别归一：解析不出级别的条目按 major 处理。
 * 必须在"抑制 → 落盘 → 判定"**之前**调用：
 * 旧顺序是先抑制后提升，导致 ① 落盘仍是 info（基准债务门禁看不到）② 无级别条目被 known-diff 吞掉。
 * 同时：来自 default（无级别）的条目不参与 known-diffs 抑制。
 */
export declare function normalizeBaselineSeverity(items: ReviewItem[], scope: 'baseline' | 'implementation'): ReviewItem[];
/** 该条目是否允许被 known-diffs 抑制（blocker 与"无级别"条目永不抑制） */
export declare function isSuppressible(it: ReviewItem): boolean;
export declare function openBySeverity(rounds: ReviewRoundState[] | undefined, scope?: 'baseline' | 'implementation'): {
    blocker: number;
    major: number;
    minor: number;
};
/**
 * known-diffs 抑制：命中已确认接受的差异 → 该条不再算"新发现"。
 * 匹配规则（任一命中）：条目 id 相同 / nodeId 相同 / property 关键词出现在正文里。
 */
export declare function matchKnownDiff(item: ReviewItem, known: KnownDiff[] | undefined): KnownDiff | undefined;
