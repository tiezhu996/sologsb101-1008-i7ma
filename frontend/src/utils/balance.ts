/**
 * 水力失衡度计算、开度调整步长建议与单位格式化
 * 失衡度 = |流量偏差率| × 0.7 + |室温偏差| × 1.5（单位：%）
 */
import type { Building } from '@/types/building'
import type { Valve } from '@/types/valve'
import type { Measure } from '@/types/measure'
import type { MeasureSnapshot } from '@/types/adjust'
import { ROOM_TARGET_C } from '@/types/measure'

/** 平衡判定阈值：失衡度 ≤ 10% 视为平衡 */
export const IMBALANCE_BALANCED = 10
/** 常规偏大/偏小上限：≤ 25%，超过即严重失衡 */
export const IMBALANCE_WARN = 25

export type BalanceLevel = '平衡' | '偏大' | '偏小' | '严重失衡'

export const BALANCE_COLOR: Record<BalanceLevel, string> = {
  平衡: '#1e8449',
  偏大: '#d68910',
  偏小: '#2b6cb0',
  严重失衡: '#c0392b'
}

export const BALANCE_BG: Record<BalanceLevel, string> = {
  平衡: '#eaf6ee',
  偏大: '#fdf3e3',
  偏小: '#e8f1fb',
  严重失衡: '#fdecea'
}

/** TDesign 标签主题色映射 */
export const BALANCE_THEME: Record<BalanceLevel, 'success' | 'warning' | 'primary' | 'danger'> = {
  平衡: 'success',
  偏大: 'warning',
  偏小: 'primary',
  严重失衡: 'danger'
}

export const BALANCE_ICON: Record<BalanceLevel, string> = {
  平衡: 'check-circle-filled',
  偏大: 'arrow-up',
  偏小: 'arrow-down',
  严重失衡: 'error-circle-filled'
}

export function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** 流量比 = 实测流量 ÷ 设计流量 */
export function flowRatio(measured: number, design: number): number {
  if (!Number.isFinite(design) || design <= 0) return 0
  return round(measured / design, 4)
}

/** 流量偏差率（%），正值为偏大 */
export function flowDeviationPct(measured: number, design: number): number {
  if (!Number.isFinite(design) || design <= 0) return 0
  return round((measured / design - 1) * 100, 2)
}

/** 室温偏差（℃） */
export function roomDeviationC(roomTempC: number): number {
  return round(roomTempC - ROOM_TARGET_C, 2)
}

/** 合成失衡度（%）：流量偏差占七成权重，室温偏差占三成权重 */
export function imbalance(measured: number, design: number, roomTempC: number): number {
  const flowPart = Math.abs(flowDeviationPct(measured, design)) * 0.7
  const roomPart = Math.abs(roomDeviationC(roomTempC)) * 1.5
  return round(flowPart + roomPart, 1)
}

/** 由失衡度与流量方向判定档位 */
export function balanceLevel(imbalanceValue: number, measured: number, design: number): BalanceLevel {
  if (imbalanceValue <= IMBALANCE_BALANCED) return '平衡'
  if (imbalanceValue > IMBALANCE_WARN) return '严重失衡'
  return flowDeviationPct(measured, design) > 0 ? '偏大' : '偏小'
}

export function balanceWeight(level: BalanceLevel): number {
  if (level === '严重失衡') return 40
  if (level === '平衡') return 0
  return 20
}

/**
 * 开度调整步长建议：目标开度 = 当前开度 ÷ 流量比，并按 5% 取整、限制在 20%~100%
 */
export function suggestOpening(currentOpening: number, ratio: number, level: BalanceLevel): number {
  if (level === '平衡') return Math.round(currentOpening)
  const safeRatio = ratio > 0.2 ? ratio : 0.2
  const raw = currentOpening / safeRatio
  const stepped = Math.round(raw / 5) * 5
  return Math.min(100, Math.max(20, stepped))
}

/** 依据文案 */
export function basisText(row: {
  valve: Valve
  building: Building | null
  ratio: number
  flowDeviation: number
  roomDeviation: number
  imbalanceValue: number
  level: BalanceLevel
}): string {
  const buildingName = row.building ? row.building.name : '未知楼栋'
  return `${buildingName} ${row.valve.code} 流量比 ${row.ratio.toFixed(2)}（偏差 ${row.flowDeviation.toFixed(1)}%）、室温偏差 ${row.roomDeviation.toFixed(1)}℃，合成失衡度 ${row.imbalanceValue.toFixed(1)}%，判定为「${row.level}」`
}

export function formatFlow(flowM3h: number): string {
  if (!Number.isFinite(flowM3h)) return '—'
  return `${flowM3h.toFixed(1)} m³/h`
}

export function formatTemp(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${value.toFixed(1)} ℃`
}

export function formatOpening(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${Math.round(value)}%`
}

export function formatImbalance(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${value.toFixed(1)}%`
}

/** 采集一组实测时的室温偏差提示 */
export function measureHint(measure: Pick<Measure, 'flowM3h' | 'roomTempC'>, designFlowM3h: number): string {
  const value = imbalance(measure.flowM3h, designFlowM3h, measure.roomTempC)
  return `失衡度约 ${value.toFixed(1)}%`
}

/* ======================= 调节单冻结快照（实测与单据分离） ======================= */

/** 构造快照所需的最小字段 */
export interface SnapshotSource {
  measure: Pick<
    Measure,
    'id' | 'date' | 'flowM3h' | 'supplyTempC' | 'returnTempC' | 'roomTempC'
  > | null
  valve: Pick<Valve, 'designFlowM3h' | 'currentOpening'>
}

/**
 * 在派单 / 执行 / 复核时点冻结当时实测与阀门开度。
 * 实测之后被补录、修改或删除，都不会改动该快照，原签字依据保持不变。
 */
export function buildMeasureSnapshot(source: SnapshotSource, frozenAt: number = Date.now()): MeasureSnapshot {
  const { measure, valve } = source
  const design = valve.designFlowM3h
  const measured = measure ? measure.flowM3h : 0
  const room = measure ? measure.roomTempC : ROOM_TARGET_C
  const value = measure ? imbalance(measured, design, room) : 0
  return {
    measureId: measure ? measure.id : null,
    measureDate: measure ? measure.date : '',
    flowM3h: measured,
    supplyTempC: measure ? measure.supplyTempC : 0,
    returnTempC: measure ? measure.returnTempC : 0,
    roomTempC: room,
    designFlowM3h: design,
    ratio: flowRatio(measured, design),
    flowDeviation: measure ? flowDeviationPct(measured, design) : 0,
    roomDeviation: measure ? roomDeviationC(room) : 0,
    imbalanceValue: value,
    level: measure ? balanceLevel(value, measured, design) : '平衡',
    opening: valve.currentOpening,
    frozenAt
  }
}

/** 仅保留日期（YYYY-MM-DD，本地时区），避免 ISO 字符串的 UTC 偏移误判 */
export function localDateOf(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 复核只认执行后新采集的数据：
 * 实测日期晚于执行日期，或同日但录入时间晚于执行时刻的记录才算数。
 */
export function isMeasureAfterExecution(
  measure: Pick<Measure, 'date' | 'createdAt'>,
  executedAt: number
): boolean {
  const execDate = localDateOf(executedAt)
  if (measure.date > execDate) return true
  if (measure.date < execDate) return false
  return (measure.createdAt ?? 0) > executedAt
}

/**
 * 取执行后新采集的最新实测（按日期、录入时间取最晚一条）。
 * 没有执行后的新数据时返回 null——此时不允许复核闭环。
 */
export function findReviewMeasure<T extends Measure>(
  measures: T[],
  valveId: string,
  executedAt: number
): T | null {
  const candidates = measures
    .filter((measure) => measure.valveId === valveId && isMeasureAfterExecution(measure, executedAt))
    .sort((a, b) => {
      const byDate = b.date.localeCompare(a.date)
      return byDate !== 0 ? byDate : (b.createdAt ?? 0) - (a.createdAt ?? 0)
    })
  return candidates[0] ?? null
}
