/**
 * 设计基准图导出：把静态还原页渲染成 PNG，供**人**和 **UI 专家子 agent** 直接看图审计。
 *
 * 为什么自己做而不依赖 Figma 出图：
 * - 设计文件常设成 "Export disabled"（本机实测就遇到过），官方出图/REST images 会直接失败；
 * - 从 Figma 画布截图拿到的是"编辑器视口"（含左侧图层树、右侧属性面板、工具条，
 *   且缩放随用户操作变化，节点可能只有 4% 大小），根本没法用于审计；
 * - 而静态还原页是**从解码数据逐节点渲染**的，与 SPEC.md 规格表同源，
 *   导出的 PNG 尺寸精确、无 chrome、可复现，最适合审计"结构/尺寸/逐边描边/逐角圆角/字体"。
 *
 * 代价要说清楚：实例内部结构（图标形状、控件内部细节）在解码数据里没有，
 * 图上那部分是**按设计系统重建的占位** —— 需要"真实观感"时仍应另配 Figma 画布截图。
 */
import { execFile } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const MAC_BINS = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];
const LINUX_BINS = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
/** 找一个能跑无头截图的浏览器（Chrome/Chromium/Edge/Brave 都行） */
export function findChromeBin(explicit) {
    const envBin = process.env.DSH_CHROME_BIN || process.env.CHROME_BIN;
    const cands = [explicit, envBin, ...MAC_BINS, ...LINUX_BINS].filter(Boolean);
    for (const c of cands) {
        try {
            if (existsSync(c) && statSync(c).isFile())
                return c;
        }
        catch {
            /* ignore */
        }
    }
    return null;
}
/**
 * HTML → PNG。用无头 Chrome 的 `--screenshot`：
 * `--window-size` 就是页面视口，静态还原页的 #frame 正好铺满并贴左上角，
 * 所以截出来就是**精确裁剪**的设计图，不需要任何图像处理库。
 */
export function renderHtmlToPng(opts) {
    const scale = opts.scale ?? 2;
    const bin = findChromeBin(opts.chromeBin);
    if (!bin) {
        return Promise.resolve({
            ok: false,
            error: '找不到可用的无头浏览器（Chrome/Chromium/Edge/Brave）。可用 DSH_CHROME_BIN 指定路径；或让会话用浏览器工具对基准页截图。',
        });
    }
    const settle = opts.settleMs ?? 3000;
    // png=1：让页面进入"出图模式"（隐藏 HUD/探针、白底），避免把调试浮层拍进图里
    const url = `file://${opts.htmlPath}?png=1`;
    const args = [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--force-device-scale-factor=' + scale,
        `--window-size=${opts.width},${opts.height}`,
        `--virtual-time-budget=${settle}`,
        '--default-background-color=FFFFFFFF',
        `--screenshot=${opts.outPath}`,
        url,
    ];
    return new Promise((resolve) => {
        execFile(bin, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
            if (!existsSync(opts.outPath)) {
                resolve({ ok: false, bin, error: `截图未生成：${err?.message ?? 'unknown'}\n${String(stderr).slice(0, 400)}` });
                return;
            }
            const size = statSync(opts.outPath).size;
            resolve({
                ok: size > 0,
                path: opts.outPath,
                // 出图像素 = 页面尺寸 × scale
                width: opts.width * scale,
                height: opts.height * scale,
                bytes: size,
                bin,
                error: size > 0 ? undefined : '输出文件为空',
            });
        });
    });
}
/** 约定：基准页旁边的 index.png（1x）与 index@2x.png */
export function pngPathsFor(htmlPath) {
    const base = htmlPath.replace(/\.html?$/i, '');
    return { oneX: `${base}.png`, twoX: `${base}@2x.png` };
}
export async function exportStaticPagePng(opts, alsoOneX = true) {
    const out = [];
    out.push(await renderHtmlToPng({ ...opts, scale: opts.scale ?? 2 }));
    if (alsoOneX)
        out.push(await renderHtmlToPng({ ...opts, outPath: pngPathsFor(opts.htmlPath).oneX, scale: 1 }));
    return out;
}
export function pngSummary(results) {
    const ok = results.filter((r) => r.ok);
    if (!ok.length) {
        const err = results[0]?.error ?? '未知错误';
        return `⚠️ 设计图导出失败：${err}\n   （不影响基准页本身；可让会话用浏览器工具截 static/index.html）`;
    }
    return '🖼️ 设计基准图：\n' + ok
        .map((r) => `- ${r.path}（${r.width}×${r.height}，${Math.round((r.bytes ?? 0) / 1024)}KB）`)
        .join('\n');
}
/** 供 UI 专家子 agent 用的读图清单（主 agent 转交时必须抄） */
export function expertImageBrief(paths, staticPath, specPath) {
    return [
        '【交给 UI 专家的读图材料】',
        ...paths.map((p) => `- 设计基准图（从设计数据渲染，无 chrome、精确尺寸）：${p}`),
        `- 设计基准页（可交互查看，悬停看节点 ID）：${staticPath}`,
        specPath ? `- 规格/映射表：${specPath}` : '',
        '- 组件实现截图：（由执行方提供，需与上面同一尺寸/缩放）',
        '',
        '审计要求：逐条给出「问题 / 位置 / 期望 / 实际 / 级别(blocker|major|minor)」；',
        '可量化的（描边、圆角、高度、字号）以基准图/规格表数值为准；',
        '注意基准图上的实例（Input/Select/按钮）是按设计系统重建的占位，其内部细节不作为审计依据。',
    ].filter(Boolean).join('\n');
}
export function defaultPngDir(htmlPath) {
    return join(htmlPath, '..');
}
/**
 * HTML → 序列化后的 DOM（`--dump-dom`）。
 * 用途：在页面里跑一段脚本、把结果写进 `<pre>`，再把 DOM 取回来 ——
 * 这是零依赖拿到 "实现页的真实 computed style" 的办法。
 */
export function dumpDom(opts) {
    const bin = findChromeBin(opts.chromeBin);
    if (!bin) {
        return Promise.resolve({ ok: false, error: '找不到可用的无头浏览器（Chrome/Chromium/Edge/Brave）。可用 DSH_CHROME_BIN 指定路径。' });
    }
    // 显式 user-data-dir：并发的 headless 实例抢默认 profile 时会直接失败
    //（"Failed to create a unique user data directory for headless"）
    const profileDir = join(tmpdir(), `dsh-design-to-code-${process.pid}-${Date.now()}`);
    const args = [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        // 同上：headless 在受限环境下必须先关掉自己的 sandbox
        '--no-sandbox',
        `--user-data-dir=${profileDir}`,
        `--window-size=${opts.width},${opts.height}`,
        `--virtual-time-budget=${opts.settleMs ?? 4000}`,
        '--dump-dom',
    ];
    if (opts.allowFileAccess !== false)
        args.push('--allow-file-access-from-files');
    args.push(`file://${opts.htmlPath}`);
    return new Promise((resolve) => {
        execFile(bin, args, { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
            // 临时 profile 用完即删（否则反复跑会攒一堆目录）
            try {
                rmSync(profileDir, { recursive: true, force: true });
            }
            catch { /* ignore */ }
            const html = String(stdout ?? '');
            if (!html) {
                resolve({ ok: false, bin, error: `没拿到 DOM：${err?.message ?? 'unknown'}\n${String(stderr).slice(0, 400)}` });
                return;
            }
            resolve({ ok: true, html, bin });
        });
    });
}
//# sourceMappingURL=screenshot.js.map