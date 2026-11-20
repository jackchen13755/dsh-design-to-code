/**
 * 流程状态（flow.json）：把"基准页是否已生成 / 是否已被确认 / 评审到第几轮"
 * 变成**可审计的状态**，而不是靠提示词自觉。
 */
import type { KnownDiff, ReviewRoundState } from './review.js'

/** 门禁契约版本：旧 flow.json 没有这个字段 = 用旧门禁写的状态（confirmed 可能是错的），一律要求重新确认 */
export const GATE_VERSION = 3

export interface FlowState {
  stage: 'static_rendered' | 'skeleton_generated' | 'change_brief_ready'
  nodeId: string
  fileKey: string
  staticPage?: string
  specPath?: string
  confirmed: boolean
  /** 谁确认的基准页：human（人看基准页）| expert_review（UI 专家审计通过） */
  confirmedVia?: 'human' | 'expert_review'
  confirmedBy?: string
  confirmedAt?: string
  confirmNote?: string
  /** 涉及 UI 的交付必须走一轮 UI 专家审计（默认 true；figma_codegen_round 会据此卡收尾） */
  expertReviewRequired?: boolean
  /** 专家整改清单的轮次记录（figma_review_to_round 维护） */
  reviews?: ReviewRoundState[]
  /** 基准版本：每次重新渲染基准页 +1 */
  baselineVersion?: number
  /** 门禁契约版本（缺失 = 旧目录） */
  gateVersion?: number
  /** 渲染器版本：确认时要求与当前一致（旧渲染器产的页面不能被一次确认解封） */
  baselineRenderer?: number
  /** force 越过门禁的留痕 */
  forcedAt?: string
  forcedBy?: string
  forceReason?: string
  /** 已确认接受的差异（known-diffs）：命中即标 accepted，不再重复提出、不阻塞收尾 */
  knownDiffs?: KnownDiff[]
  /**
   * 自动视觉回归（figma_visual_diff）的最近一次结果。
   * 缺字段 / clean=false 且没有被 knownDiffs 接受时，收尾门禁拒绝（fail-closed）。
   * checked=本次是否真的取到了可对照节点；findings=差异条数；clean=findings=0 且无未接受差异。
   */
  visualDiff?: { at: string; checked: boolean; findings: number; clean: boolean; reportPath: string }
  /** 属性来源台账摘要（placeholder 占比），门禁与交付说明引用 */
  coverage?: { nodes: number; placeholderRatio: number; counts: { design: number; inferred: number; placeholder: number }; summary: string }
  updatedAt: string
}
