import type { DesignModel } from './design.js';
export interface CodegenOptions {
    componentName: string;
    requirements: string;
    conventions: string;
    outputDir: string;
}
export declare function generateCode(model: DesignModel, opts: CodegenOptions): string[];
