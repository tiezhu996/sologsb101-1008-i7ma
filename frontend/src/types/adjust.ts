/** 调节单：由失衡度排序生成，派单/执行分别冻结当时实测与阀门开度 */
import type { BalanceLevel } from '@/utils/balance'

export type AdjustState = '待下发' | '已调节' | '已复核' | '待复测'

export interface Adjust {
  id: string
  valveId: string
  /** 目标开度（%） */
  targetOpening: number
  /** 调节依据（派单时生成的文字结论，永不随后续实测修改而变） */
  basis: string
  executor: string
  state: AdjustState
  /** 复核意见（最近一次复核；原复核失效后内容归档到 reviewHistory） */
  reviewNote: string
  /** 派单时冻结的实测与阀门开度快照（签字依据） */
  basisSnapshot: MeasureSnapshot | null
  /** 执行调节时冻结的当时实测与阀门开度快照；复核只认此时间点之后新采集的数据 */
  executionSnapshot: MeasureSnapshot | null
  executedAt: number | null
  /** 退回待复测的原因说明（如引用实测被修改/删除） */
  invalidateReason: string
  /** 历次复核结论归档，原结论仍可查看 */
  reviewHistory: ReviewArchive[]
  createdAt: number
  updatedAt: number
}

/** 冻结快照：某个时间点的实测读数、阀门开度与据此算出的结论 */
export interface MeasureSnapshot {
  /** 快照对应实测记录 id（无实测的补录场景为 null） */
  measureId: string | null
  date: string
  /** 采集时间（实测记录的 createdAt），用于判定「执行后新采集」 */
  measuredAt: number
  flowM3h: number
  supplyTempC: number
  returnTempC: number
  roomTempC: number
  designFlowM3h: number
  /** 快照时阀门当前开度（%） */
  valveOpening: number
  flowRatio: number
  flowDeviation: number
  roomDeviation: number
  imbalanceValue: number
  level: BalanceLevel
  /** 快照生成时间 */
  frozenAt: number
}

export interface ReviewArchive {
  note: string
  reviewedAt: number
  /** 复核时引用的执行后新实测快照 */
  reviewSnapshot: MeasureSnapshot | null
}

export const ADJUST_STATES: AdjustState[] = ['待下发', '已调节', '待复测', '已复核']

/**
 * 调节单状态机：
 * 待下发 → 已调节（执行时冻结当时实测与开度，回写阀门开度）
 * 已调节 → 已复核（只认执行后新采集的实测）
 * 已复核/已调节/待复测 —引用实测被修改或删除→ 待复测（原结论归档可查看）
 * 待复测 → 已复核（补采新数据后重新复核）
 */
export const ADJUST_STATE_FLOW: Record<AdjustState, AdjustState | null> = {
  待下发: '已调节',
  已调节: '已复核',
  待复测: '已复核',
  已复核: null
}

export interface AdjustDraft {
  valveId: string
  targetOpening: number
  basis: string
  executor: string
  state: AdjustState
  reviewNote: string
}

export const EMPTY_ADJUST_DRAFT: AdjustDraft = {
  valveId: '',
  targetOpening: 50,
  basis: '',
  executor: '',
  state: '待下发',
  reviewNote: ''
}
