/**
 * 调节单：由失衡度排序生成。
 * 实测与调节单分开保存——调节单内冻结派单/执行/复核三个时点的快照，
 * 之后实测补录或修改都不会改变单据上的原签字依据。
 */
import type { BalanceLevel } from '@/utils/balance'

/** 调节单状态：待下发 → 已调节 → 已复核；依据被旧实测改动推翻时退回「待复测」 */
export type AdjustState = '待下发' | '已调节' | '已复核' | '待复测'

/**
 * 实测快照：调节单在派单 / 执行 / 复核时点对「实测 + 开度」的冻结副本。
 * measureId 为 null 表示派单时该阀门尚无实测（手工派单）。
 */
export interface MeasureSnapshot {
  /** 冻结时对应的实测记录 id；无实测时为 null */
  measureId: string | null
  /** 实测日期 YYYY-MM-DD */
  measureDate: string
  flowM3h: number
  supplyTempC: number
  returnTempC: number
  roomTempC: number
  /** 冻结时点的设计流量 */
  designFlowM3h: number
  ratio: number
  /** 流量偏差率（%），正值为偏大 */
  flowDeviation: number
  roomDeviation: number
  imbalanceValue: number
  level: BalanceLevel
  /** 冻结时点的阀门开度（%） */
  opening: number
  frozenAt: number
}

/** 一次复核结论留痕，原结论在复核失效后仍可查看 */
export interface ReviewHistoryEntry {
  note: string
  at: number
  /** 复核时采信的执行后新采集实测快照 */
  snapshot: MeasureSnapshot
}

export interface Adjust {
  id: string
  valveId: string
  /** 目标开度（%） */
  targetOpening: number
  /** 调节依据（文本，与 basisSnapshot 同时冻结） */
  basis: string
  executor: string
  state: AdjustState
  /** 最近一次复核意见（复核闭环后的当前结论） */
  reviewNote: string

  /** 派单时冻结的依据快照；执行时会以当时最新实测再冻一次 */
  basisSnapshot: MeasureSnapshot | null
  /** 执行前阀门开度（%），执行瞬间冻结 */
  beforeOpening: number | null
  /** 执行时间戳；复核只认该时间之后新采集的实测 */
  executedAt: number | null

  /** 复核时采信的执行后新采集实测快照 */
  reviewSnapshot: MeasureSnapshot | null
  reviewMeasureId: string | null
  /** 历次复核结论留痕（原结论在退回待复测后仍可查看） */
  reviewHistory: ReviewHistoryEntry[]

  /** 退回待复测的原因（旧实测被修改/删除等） */
  invalidReason: string
  invalidatedAt: number | null
  /** 失效前所处状态（已调节 / 已复核） */
  invalidFromState: AdjustState | null

  createdAt: number
  updatedAt: number
}

export const ADJUST_STATES: AdjustState[] = ['待下发', '已调节', '已复核', '待复测']

/**
 * 调节单状态机：
 * 待下发 → 已调节 → 已复核；待复测（原已调节/已复核被旧实测改动推翻）→ 已复核。
 */
export const ADJUST_STATE_FLOW: Record<AdjustState, AdjustState | null> = {
  待下发: '已调节',
  已调节: '已复核',
  待复测: '已复核',
  已复核: null
}

/** 已执行（开度已回写）、可以进入复核环节的状态 */
export function isExecutedState(state: AdjustState): boolean {
  return state === '已调节' || state === '已复核' || state === '待复测'
}

/** 旧依据实测被改动时需要退回待复测的状态 */
export function isInvalidatableState(state: AdjustState): boolean {
  return state === '已调节' || state === '已复核'
}

export interface AdjustDraft {
  valveId: string
  targetOpening: number
  basis: string
  executor: string
}

export const EMPTY_ADJUST_DRAFT: AdjustDraft = {
  valveId: '',
  targetOpening: 50,
  basis: '',
  executor: ''
}

/** 新建调节单行的默认字段（快照由 store 在派单/执行时点补齐） */
export function emptyAdjustRuntime(): {
  basisSnapshot: null
  beforeOpening: null
  executedAt: null
  reviewSnapshot: null
  reviewMeasureId: null
  reviewHistory: []
  invalidReason: ''
  invalidatedAt: null
  invalidFromState: null
} {
  return {
    basisSnapshot: null,
    beforeOpening: null,
    executedAt: null,
    reviewSnapshot: null,
    reviewMeasureId: null,
    reviewHistory: [],
    invalidReason: '',
    invalidatedAt: null,
    invalidFromState: null
  }
}
