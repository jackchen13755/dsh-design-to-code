import { acceptedItems, hasExpertReview, openBySeverity, openItems } from './review.js';
import { GATE_VERSION } from './flow.js';
export { GATE_VERSION };
export function evaluateCloseGate(input) {
    const version = input.gateVersion ?? GATE_VERSION;
    const flow = input.flow;
    // ① 没有 flow.json：只有"显式 force + 理由"才放行（否则旧目录会被当"无约束"）
    if (!flow) {
        if (input.force && String(input.forceReason ?? '').trim())
            return { ok: true, forced: true };
        return { ok: false, reason: '找不到 flow.json（旧产物）：请重新跑 figma_render_static 并重新确认基准，再收尾。' };
    }
    // ② 版本戳不可 force 越过：旧门禁写出来的 confirmed 不可信，必须重新渲染 + 重新确认
    if (flow.gateVersion !== version) {
        return {
            ok: false,
            reason: `flow.json 是本插件旧版本写的（gateVersion=${flow.gateVersion ?? '缺失'}，需要 ${version}）：旧版的 confirmed 可能是任何一次评审写进去的，不能当权威。请重新 figma_render_static → 用户确认 → figma_confirm_static。`,
        };
    }
    // ③ force：必须有理由（留痕），且仍然要求基准产物在
    if (input.force) {
        const reason = String(input.forceReason ?? '').trim();
        if (!reason)
            return { ok: false, reason: 'force=true 必须同时传 force_reason（会写进 flow.json，交付时须说明为何越过）。' };
        if (input.artifacts && (!input.artifacts.staticPage || !input.artifacts.spec)) {
            return { ok: false, reason: '基准产物缺失（static/index.html 或 static/spec.json 不在）：force 也要先把基准重新渲染出来。' };
        }
        return { ok: true, forced: true };
    }
    // ④ 基准产物存在性：产物被删/被挪时不能"凭 flow.json 收尾"
    if (input.artifacts && (!input.artifacts.staticPage || !input.artifacts.spec)) {
        return { ok: false, reason: '基准产物缺失（static/index.html 或 static/spec.json 不在）：重新跑 figma_render_static。' };
    }
    if (!flow.confirmed) {
        return { ok: false, reason: `基准页还没有确认（confirmed=false）：先让用户确认 ${flow.staticPage ?? 'static/index.html'}，再 figma_confirm_static。` };
    }
    // ⑤ 视觉回归门禁（fail-closed）：没有 visualDiff 记录，或 clean=false 且没有任何 knownDiffs 被显式接受，
    //    都不许收尾。knownDiffs 非空 = 调用方已在 figma_confirm_static 里显式登记"这部分差异接受"，
    //    是唯一能越过 clean 的凭据；没登记就一律拒绝，绝不把"没跑机器回归"当成"没问题"。
    //    注意：这里只读 knownDiffs / confirmedVia，不写回 flow，confirmedVia=expert_review 的确认来源原样保留。
    const vd = flow.visualDiff;
    const hasAcceptedDiffs = (flow.knownDiffs ?? []).length > 0;
    if ((!vd || !vd.clean) && !hasAcceptedDiffs) {
        return {
            ok: false,
            reason: vd
                ? `自动视觉回归未通过（visualDiff.clean=false，findings=${vd.findings}，报告 ${vd.reportPath}）：差异必须清零，或由 figma_confirm_static 登记为 knownDiffs 显式接受后再收尾。`
                : '缺少自动视觉回归记录（flow.json 无 visualDiff）：先跑 figma_visual_diff(output_dir=…, impl=<实现页>)，或由 figma_confirm_static 登记 knownDiffs 显式接受后再收尾。',
        };
    }
    // ⑥ 组件复用机器门禁（fail-closed，与 ⑤ 视觉回归判定并列）：
    //    有 confirmed 复用契约时，必须先跑 figma_verify_reuse 写下 reuseVerification，
    //    且 clean=true（或 knownDiffs 已显式接受）才许收尾。
    //    hasConfirmed 由 codegen_round 读 component-reuse.json 得出；没有契约时默认 false → 完全向后兼容。
    //    这里只读 knownDiffs / reuseVerification，不写 flow。
    if (input.reuse?.hasConfirmed) {
        const rv = flow.reuseVerification;
        if ((!rv || !rv.clean) && !hasAcceptedDiffs) {
            return {
                ok: false,
                reason: rv
                    ? `组件复用静态核对未通过（reuseVerification.clean=false，缺失 import：${rv.missingImports.slice(0, 5).join(', ') || '（无明细）'}）：confirmed 契约的 projectComponent 必须在实现源码真实出现；补齐后重跑 figma_verify_reuse，或由 figma_confirm_static 登记 knownDiffs 显式接受后再收尾。`
                    : '缺少组件复用静态核对记录（flow.json 无 reuseVerification）：先跑 figma_verify_reuse(output_dir=…, impl_src=<实现源码目录>)，或由 figma_confirm_static 登记 knownDiffs 显式接受后再收尾。',
            };
        }
    }
    const reviews = flow.reviews ?? [];
    const implItems = reviews
        .filter((r) => (r.scope ?? 'implementation') === 'implementation')
        .flatMap((r) => r.items)
        .filter((i) => i.status !== 'accepted');
    const implRoundsAll = reviews.filter((r) => (r.scope ?? 'implementation') === 'implementation');
    // "干净的 pass"（0 条问题）也算有效审计：否则专家认为没问题时反而无法收尾
    const cleanPass = implRoundsAll.some((r) => r.emptyRound === true && r.verdict === 'pass');
    if (flow.expertReviewRequired !== false && !cleanPass && (implItems.length === 0 || !hasExpertReview(reviews, 'implementation'))) {
        return { ok: false, reason: '还没有可用的实现审计（scope=implementation 且不是全被 known-diffs 接受的那一轮）：先叫 UI 专家审一轮实现。' };
    }
    const implRounds = reviews.filter((r) => (r.scope ?? 'implementation') === 'implementation');
    const last = implRounds[implRounds.length - 1];
    if (last?.verdict === 'reject') {
        return { ok: false, reason: `第 ${last.round} 轮实现审计判定为 reject：blocker/major 修完并关闭后必须再提审一轮拿 pass。` };
    }
    const openImpl = openItems(reviews, 'implementation');
    if (openImpl.length) {
        const sev = openBySeverity(reviews, 'implementation');
        return {
            ok: false,
            reason: `还有 ${openImpl.length} 条实现侧整改项未关闭（阻断 ${sev.blocker} / 主要 ${sev.major} / 次要 ${sev.minor}）：${openImpl.slice(0, 3).map((i) => i.id).join(', ')}。`,
            stats: { openImpl: openImpl.length, openBaseline: openItems(reviews, 'baseline').length, accepted: acceptedItems(reviews).length },
        };
    }
    const openBaseline = openItems(reviews, 'baseline').length;
    return { ok: true, stats: { openImpl: 0, openBaseline, accepted: acceptedItems(reviews).length } };
}
//# sourceMappingURL=gate.js.map