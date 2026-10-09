/**
 * 审计标注与打回判定。
 *
 * 用户要求：① 审计要**标出有问题的地方**；② 结果是**打回给开发修复**。
 * 所以一轮 UI 审计的产物不能只是文字清单，必须有：
 *   - **标注图**：把每条问题按 id 编号钉在设计基准图上（有坐标的钉框、没坐标的进图例），
 *     开发一眼能看到"哪儿不对"；代码侧位置则交给主 agent 用行内标注（diff_approval_annotate）钉到行上；
 *   - **判定（verdict）**：有 blocker/major 就是 **打回(reject)**，全清或只剩 minor 才算通过(pass)；
 *   - **收尾门禁**：最后一轮必须是 pass，且没有未关闭项 —— blocker/major 关闭后必须**再提审一次**，
 *     由审计方判定通过，而不是开发自己说改完了就算。
 */
export type Verdict = 'pass' | 'reject';
export interface AnnotationInput {
    id: string;
    severity: string;
    text: string;
    /** 设计稿内坐标 [x, y, w, h]（由 node_id 解析或直接给） */
    box?: [number, number, number, number] | null;
    /** 代码位置（文件:行）——不进图，进"打回清单"的改法列 */
    location?: string;
}
/** blocker/major 任一存在 → 打回 */
export declare function legendHeightFor(count: number): number;
export declare function verdictOf(items: Array<{
    severity: string;
}>): Verdict;
/**
 * 生成标注页：基准图铺底，按 id 编号钉出问题框；没有坐标的问题在右侧图例里列出。
 * 页面尺寸 = 设计稿尺寸，方便直接用无头 Chrome 截成同尺寸的标注图。
 */
export declare function buildAnnotatedHtml(opts: {
    /** 基准图文件名（与标注页同目录，用相对路径） */
    imageFile: string;
    width: number;
    height: number;
    annotations: AnnotationInput[];
    title?: string;
    /** 图例区高度（放在设计图下方，避免遮挡设计内容，也能被一起截进图） */
    legendHeight: number;
}): string;
/** 打回清单（给人/给开发/给下一轮用），与 CODEGEN_PROMPT 里的表互补 */
export declare function renderRejectionMarkdown(opts: {
    round: number;
    reviewer: string;
    at: string;
    verdict: Verdict;
    items: AnnotationInput[];
    annotatedImage?: string;
    staticPng?: string;
    rejected: boolean;
}): string;
