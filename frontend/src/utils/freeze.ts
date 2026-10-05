/**
 * 冻结快照与复核口径工具（单一事实来源）
 * - 派单时冻结当时实测与阀门开度（basisSnapshot）
 * - 执行时再次冻结当时实测与阀门开度（executionSnapshot）
 * - 复核只认执行时间之后「新采集」的实测
 * - 旧实测被修改/删除后，依据快照失效，相关调节单退回待复测
 * 失衡排行、调节单、站内汇总均通过本模块得到同一结果。
 */
import type { Measure } from '@/types/measure'
import type { Valve } from '@/types/valve'
import type { MeasureSnapshot, ReviewArchive } from '@/types/adjust'
import {
  balanceLevel,
  flowDeviationPct,
  flowRatio,
  imbalance,
  roomDeviationC
} from '@/utils/balance'

export interface SnapshotInput {
  valve: Valve
  /** 作为冻结依据的实测；执行前允许为 null（无最新实测时不允许执行） */
  measure: Measure | null
  frozenAt?: number
}

/** 由阀门 + 一条实测构造不可变快照 */
export function buildSnapshot(input: SnapshotInput): MeasureSnapshot | null {
  const { valve, measure } = input
  if (!measure) return null
  const measuredAt = measure.createdAt
  const frozenAt = input.frozenAt ?? Date.now()
  const ratio = flowRatio(measure.flowM3h, valve.designFlowM3h)
  const deviation = flowDeviationPct(measure.flowM3h, valve.designFlowM3h)
  const roomDev = roomDeviationC(measure.roomTempC)
  const value = imbalance(measure.flowM3h, valve.designFlowM3h, measure.roomTempC)
  return {
    measureId: measure.id,
    date: measure.date,
    measuredAt,
    flowM3h: measure.flowM3h,
    supplyTempC: measure.supplyTempC,
    returnTempC: measure.returnTempC,
    roomTempC: measure.roomTempC,
    designFlowM3h: valve.designFlowM3h,
    valveOpening: valve.currentOpening,
    flowRatio: ratio,
    flowDeviation: deviation,
    roomDeviation: roomDev,
    imbalanceValue: value,
    level: balanceLevel(value, measure.flowM3h, valve.designFlowM3h),
    frozenAt
  }
}

/** 取某阀门截至给定时间（不含）最新采集的实测 */
export function latestMeasureBefore(valveId: string, measures: Measure[], before: number): Measure | null {
  const own = measures
    .filter((item) => item.valveId === valveId && item.createdAt < before)
    .sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : b.date.localeCompare(a.date)))
  return own[0] ?? null
}

/** 取某阀门当前最新采集的实测（失衡排行 / 站内汇总同一口径） */
export function latestMeasure(valveId: string, measures: Measure[]): Measure | null {
  const own = measures
    .filter((item) => item.valveId === valveId)
    .sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : b.date.localeCompare(a.date)))
  return own[0] ?? null
}

/**
 * 复核候选实测：执行（或上次失效）之后新采集的实测中最新的一条。
 * 复核只认执行后新采集的数据，旧数据一律不作为复核依据。
 */
export function reviewCandidateMeasure(
  valveId: string,
  measures: Measure[],
  executedAt: number | null
): Measure | null {
  if (executedAt === null) return null
  const own = measures
    .filter((item) => item.valveId === valveId && item.createdAt > executedAt)
    .sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : b.date.localeCompare(a.date)))
  return own[0] ?? null
}

export interface ReviewBasis {
  measure: Measure
  snapshot: MeasureSnapshot
}

/** 解析复核依据：执行后存在新采集实测时返回阀门最新开度下的复核快照 */
export function resolveReviewBasis(
  valve: Valve,
  measures: Measure[],
  executedAt: number | null
): ReviewBasis | null {
  const measure = reviewCandidateMeasure(valve.id, measures, executedAt)
  if (!measure) return null
  return { measure, snapshot: buildSnapshot({ valve, measure }) as MeasureSnapshot }
}

/** 依据快照对应的结论文案（派单依据 / 快照展示通用） */
export function snapshotBasisText(args: {
  valveCode: string
  buildingName: string
  snapshot: MeasureSnapshot
}): string {
  const { valveCode, buildingName, snapshot } = args
  return `${buildingName} ${valveCode} 流量比 ${snapshot.flowRatio.toFixed(2)}（偏差 ${snapshot.flowDeviation.toFixed(
    1
  )}%）、室温偏差 ${snapshot.roomDeviation.toFixed(1)}℃，合成失衡度 ${snapshot.imbalanceValue.toFixed(
    1
  )}%，判定为「${snapshot.level}」（快照日期 ${snapshot.date}，当时开度 ${snapshot.valveOpening}%）`
}

/** 失效原因文案 */
export function invalidateReasonText(kind: 'modify' | 'delete', snapshotDate: string, valveCode: string): string {
  const action = kind === 'delete' ? '删除' : '修改'
  return `依据实测（${valveCode} ${snapshotDate}）于 ${formatDateTime(
    Date.now()
  )} 被${action}，原签字依据失效，阀门退回待复测，原结论已归档`
}

/** 归档当前复核结论 */
export function archiveReview(
  history: ReviewArchive[],
  note: string,
  reviewSnapshot: MeasureSnapshot | null,
  reviewedAt = Date.now()
): ReviewArchive[] {
  return [...history, { note, reviewedAt, reviewSnapshot }]
}

export function formatDateTime(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
