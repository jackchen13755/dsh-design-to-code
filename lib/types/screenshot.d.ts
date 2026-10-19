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
export interface DumpDomOptions {
    htmlPath: string;
    width: number;
    height: number;
    chromeBin?: string;
    /** 等待脚本跑完的虚拟时间（毫秒） */
    settleMs?: number;
    /** 允许 file:// 页面互访（探针 iframe 读实现页的 computed style 必需） */
    allowFileAccess?: boolean;
}
export interface DumpDomResult {
    ok: boolean;
    html?: string;
    bin?: string;
    error?: string;
}
/**
 * HTML → 序列化后的 DOM（`--dump-dom`）。
 * 用途：在页面里跑一段脚本、把结果写进 `<pre>`，再把 DOM 取回来 ——
 * 这是零依赖拿到 "实现页的真实 computed style" 的办法。
 */
export declare function dumpDom(opts: DumpDomOptions): Promise<DumpDomResult>;
