/**
 * 收尾门禁的唯一判定实现（可单测）。
 *
 * 为什么单独抽出来：门禁以前散在 figma_codegen_round 的几个 if 里，既没法单测，
 * 也容易被"另加一个入口"绕开（历史上 `confirmed` 就曾写成恒真）。现在：
 *  - 规则集中在这里，codegen_round 只负责把文案回显给调用方；
 *  - selftest 直接对它跑用例（旧目录 / 未确认 / 打回 / 未关闭项 / 干净）——
 *    这类"证据产品"本身必须可断言，否则它会静默失效。
 */
import type { FlowState } from './flow.js';
import { GATE_VERSION } from './flow.js';
export { GATE_VERSION };
export interface GateInput {
    flow: FlowState | null;
    /** 当前门禁契约版本 */
    gateVersion?: number;
    /** 显式越过（必须给 forceReason，且**不能**越过版本戳） */
    force?: boolean;
    forceReason?: string;
    /** 基准产物是否存在（static/index.html 与 static/spec.json） */
    artifacts?: {
        staticPage: boolean;
        spec: boolean;
    };
    /**
     * 组件复用契约状态：由 figma_codegen_round 读 <outDir>/gen/component-reuse.json 得出。
     * 只有存在 confirmed 契约时才要求 flow.reuseVerification（fail-closed）；默认 false 保持向后兼容。
     */
    reuse?: {
        hasConfirmed: boolean;
    };
}
export interface GateResult {
    ok: boolean;
    /** 拒绝原因（人可读，含下一步动作） */
    reason?: string;
    /** 是否因 force 越过 */
    forced?: boolean;
    /** 供输出用的统计 */
    stats?: {
        openImpl: number;
        openBaseline: number;
        accepted: number;
    };
}
export declare function evaluateCloseGate(input: GateInput): GateResult;
