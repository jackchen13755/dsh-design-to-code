import type { DesignModel } from './design.js';
export interface CodegenOptions {
    componentName: string;
    requirements: string;
    conventions: string;
    outputDir: string;
    /** figma_audit_node 生成的核对清单 markdown（内联进 Codegen Prompt） */
    auditMd?: string;
    /** 当前轮次（多轮生成） */
    round?: number;
    /** 上一轮反馈（round>1 时） */
    roundFeedback?: string;
}
export declare function generateCode(model: DesignModel, opts: CodegenOptions): string[];
