import type { DesignModel } from './design.js';
import type { AuditResult } from './audit.js';
export interface CodegenOptions {
    componentName: string;
    requirements: string;
    conventions: string;
    outputDir: string;
    /** 审计清单 markdown（内联进 Codegen Prompt） */
    auditMd?: string;
    /** 静态还原页路径（视觉基准，写进 Prompt 让人/LLM 去对照） */
    staticPagePath?: string;
    /** 当前轮次 */
    round?: number;
    roundFeedback?: string;
}
export declare function generateCode(model: DesignModel, opts: CodegenOptions): string[];
export declare function summarizeAudit(a: AuditResult): string;
