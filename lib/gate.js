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