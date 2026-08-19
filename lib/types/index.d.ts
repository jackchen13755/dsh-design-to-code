import type { Context } from 'cordis';
import z from 'schemastery';
export interface Config {
    /** figma_ws 捕获目录（浏览器扩展静默生成），默认 ~/Downloads/figma_ws。 */
    wsCaptureDir?: string;
    /** 默认导出目录。 */
    outputDir?: string;
}
export declare const Config: z<Schemastery.ObjectS<{
    wsCaptureDir: z<string, string>;
    outputDir: z<string, string>;
}>, Schemastery.ObjectT<{
    wsCaptureDir: z<string, string>;
    outputDir: z<string, string>;
}>>;
export declare function apply(ctx: Context, config: Config): void;
export default apply;
