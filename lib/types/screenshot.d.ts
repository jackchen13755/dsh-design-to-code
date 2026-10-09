export interface PngExportOptions {
    htmlPath: string;
    outPath: string;
    width: number;
    height: number;
    /** 设备像素比（2 = 2x 图，1px 描边也能看清） */
    scale?: number;
    /** 显式指定浏览器可执行文件；缺省自动探测 */
    chromeBin?: string;
    /** 等待渲染的毫秒数（字体/布局） */
    settleMs?: number;
}
export interface PngExportResult {
    ok: boolean;
    path?: string;
    width?: number;
    height?: number;
    bytes?: number;
    bin?: string;
    error?: string;
}
/** 找一个能跑无头截图的浏览器（Chrome/Chromium/Edge/Brave 都行） */
export declare function findChromeBin(explicit?: string): string | null;
/**
 * HTML → PNG。用无头 Chrome 的 `--screenshot`：
 * `--window-size` 就是页面视口，静态还原页的 #frame 正好铺满并贴左上角，
 * 所以截出来就是**精确裁剪**的设计图，不需要任何图像处理库。
 */
export declare function renderHtmlToPng(opts: PngExportOptions): Promise<PngExportResult>;
/** 约定：基准页旁边的 index.png（1x）与 index@2x.png */
export declare function pngPathsFor(htmlPath: string): {
    oneX: string;
    twoX: string;
};
export declare function exportStaticPagePng(opts: PngExportOptions, alsoOneX?: boolean): Promise<PngExportResult[]>;
export declare function pngSummary(results: PngExportResult[]): string;
/** 供 UI 专家子 agent 用的读图清单（主 agent 转交时必须抄） */
export declare function expertImageBrief(paths: string[], staticPath: string, specPath?: string): string;
export declare function defaultPngDir(htmlPath: string): string;
