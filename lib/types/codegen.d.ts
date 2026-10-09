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
    /** 组件化方案 markdown（由 componentize 生成，注入 Prompt 并落盘） */
    componentPlanMd?: string;
    /** 最多抽几个可复用组件（默认 3） */
    maxExtract?: number;
    /** 项目组件落点/形态（由 componentize.detectProjectConventions 探测，决定生成文件放哪、什么形态） */
    projectLayout?: {
        componentsRoot?: string;
        layout: 'dir-index' | 'flat' | 'unknown';
        styleExt?: string;
        codeDir: string;
    };
    /** 当前轮次 */
    round?: number;
    roundFeedback?: string;
}
export declare function generateCode(model: DesignModel, opts: CodegenOptions): string[];
export declare function summarizeAudit(a: AuditResult): string;
