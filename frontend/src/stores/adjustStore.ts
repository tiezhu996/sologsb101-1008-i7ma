/**
 * 调节单状态（Pinia）
 * 维护调节单状态机、复核统计与筛选。
 * 关键口径：
 * - 调节单与实测分开保存，派单/执行时各自冻结当时实测与阀门开度快照
 * - 复核只认执行后新采集的实测（见 utils/freeze）
 * - 引用实测被修改/删除 → 退回待复测，原结论归档仍可查看
 * - 整批执行在事务内完成，失败回滚并恢复本次阀门开度
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  bulkExecuteAdjusts,
  invalidateAdjustsForMeasure,
  reviewAdjustWithNewMeasure,
  type AdjustRow
} from '@/utils/db'
import { db } from '@/utils/db'
import {
  ADJUST_STATE_FLOW,
  type Adjust,
  type AdjustDraft,
  type AdjustState,
  type MeasureSnapshot
} from '@/types/adjust'
import { useValveStore } from '@/stores/valveStore'
import { buildSnapshot, latestMeasure, resolveReviewBasis, snapshotBasisText } from '@/utils/freeze'
import type { BalanceLevel } from '@/utils/balance'
import type { Valve } from '@/types/valve'
import type { Measure } from '@/types/measure'

export interface AdjustEnriched {
  adjust: Adjust
  valve: Valve | null
  /** 当前最新失衡（与失衡排行、站内汇总同一口径：取最新实测重算） */
  currentImbalance: number
  currentLevel: BalanceLevel
  hasCurrentMeasure: boolean
  /** 生效签字依据快照：已执行取执行快照，否则取派单快照 */
  signedSnapshot: MeasureSnapshot | null
  /** 派单快照，始终保留 */
  basisSnapshot: MeasureSnapshot | null
  /** 是否存在执行后新采集、可用于复核的实测 */
  canReviewWithNewMeasure: boolean
}

export interface BatchExecuteOutcome {
  executed: number
  skippedCodes: string[]
}

export const useAdjustStore = defineStore('adjust', () => {
  const adjustTable = useIdbTable<AdjustRow>((database) => database.adjusts, { sortByUpdatedAt: false })
  const valveStore = useValveStore()

  const stateFilter = ref<AdjustState[]>([])
  const keyword = ref('')

  const adjusts = computed<AdjustRow[]>(() =>
    [...adjustTable.rows.value].sort((a, b) => b.updatedAt - a.updatedAt)
  )

  /** 由页面灌入全量实测，供快照展示与复核候选判定（与失衡排行同源） */
  const measures = ref<Measure[]>([])

  function syncMeasures(rows: Measure[]): void {
    measures.value = rows
  }

  const enriched = computed<AdjustEnriched[]>(() =>
    adjusts.value.map((adjust) => {
      const valve = valveStore.valves.find((item) => item.id === adjust.valveId) ?? null
      const currentMeasure = valve ? latestMeasure(valve.id, measures.value) : null
      const currentSnapshot = valve && currentMeasure ? buildSnapshot({ valve, measure: currentMeasure }) : null
      const signedSnapshot = adjust.executionSnapshot ?? adjust.basisSnapshot
      const canReview =
        valve !== null &&
        adjust.executedAt !== null &&
        resolveReviewBasis(valve, measures.value, adjust.executedAt) !== null
      return {
        adjust,
        valve,
        currentImbalance: currentSnapshot ? currentSnapshot.imbalanceValue : 0,
        currentLevel: currentSnapshot ? currentSnapshot.level : '平衡',
        hasCurrentMeasure: currentSnapshot !== null,
        signedSnapshot,
        basisSnapshot: adjust.basisSnapshot,
        canReviewWithNewMeasure: canReview
      }
    })
  )

  const filtered = computed<AdjustEnriched[]>(() =>
    enriched.value.filter((item) => {
      if (stateFilter.value.length > 0 && !stateFilter.value.includes(item.adjust.state)) return false
      const text = keyword.value.trim().toLowerCase()
      if (text.length === 0) return true
      return (
        (item.valve ? item.valve.code.toLowerCase().includes(text) : false) ||
        item.adjust.executor.toLowerCase().includes(text) ||
        item.adjust.basis.toLowerCase().includes(text)
      )
    })
  )

  const stateCounts = computed<Record<AdjustState, number>>(() => {
    const counts: Record<AdjustState, number> = { 待下发: 0, 已调节: 0, 待复测: 0, 已复核: 0 }
    adjusts.value.forEach((adjust) => {
      counts[adjust.state] += 1
    })
    return counts
  })

  const reviewedPercent = computed(() =>
    adjusts.value.length === 0 ? 0 : Math.round((stateCounts.value['已复核'] / adjusts.value.length) * 100)
  )

  /** 待复核：已调节待复核 + 待复测 */
  const pendingReviewCount = computed(
    () => stateCounts.value['已调节'] + stateCounts.value['待复测']
  )

  function patchFilter(patch: { stateFilter?: AdjustState[]; keyword?: string }): void {
    if (patch.stateFilter) stateFilter.value = patch.stateFilter
    if (patch.keyword !== undefined) keyword.value = patch.keyword
  }

  function resetFilter(): void {
    stateFilter.value = []
    keyword.value = ''
  }

  const hasAdjust = (valveId: string): boolean => adjusts.value.some((adjust) => adjust.valveId === valveId)

  const pendingRetestValveIds = computed(
    () => new Set(adjusts.value.filter((item) => item.state === '待复测').map((item) => item.valveId))
  )

  const isPendingRetest = (valveId: string): boolean => pendingRetestValveIds.value.has(valveId)

  /** 按站统计待复测阀门数（站内汇总与调节单页同一口径） */
  function pendingRetestCountOfStation(stationId: string): number {
    return adjusts.value.filter((adjust) => {
      if (adjust.state !== '待复测') return false
      const valve = valveStore.valves.find((item) => item.id === adjust.valveId)
      return valve ? valve.stationId === stationId : false
    }).length
  }

  /** 由阀门 + 实测生成派单依据快照（派单即冻结） */
  function buildBasisSnapshot(valve: Valve, measure: Measure | null): MeasureSnapshot | null {
    return buildSnapshot({ valve, measure })
  }

  function basisTextFromSnapshot(valve: Valve, buildingName: string, snapshot: MeasureSnapshot): string {
    return snapshotBasisText({ valveCode: valve.code, buildingName, snapshot })
  }

  async function createAdjust(
    draft: AdjustDraft & { basisSnapshot?: MeasureSnapshot | null }
  ): Promise<AdjustRow> {
    return await adjustTable.create(
      {
        valveId: draft.valveId,
        targetOpening: Math.min(100, Math.max(0, Math.round(draft.targetOpening))),
        basis: draft.basis.trim(),
        executor: draft.executor.trim() || '待指派',
        state: draft.state,
        reviewNote: draft.reviewNote.trim(),
        basisSnapshot: draft.basisSnapshot ?? null,
        executionSnapshot: null,
        executedAt: null,
        invalidateReason: '',
        reviewHistory: []
      },
      'aj'
    )
  }

  async function updateAdjust(id: string, patch: Partial<AdjustDraft>): Promise<void> {
    const next: Partial<AdjustRow> = { ...patch }
    if (patch.targetOpening !== undefined) next.targetOpening = Math.min(100, Math.max(0, Math.round(patch.targetOpening)))
    if (patch.basis !== undefined) next.basis = patch.basis.trim()
    if (patch.executor !== undefined) next.executor = patch.executor.trim()
    if (patch.reviewNote !== undefined) next.reviewNote = patch.reviewNote.trim()
    await adjustTable.update(id, next)
  }

  async function removeAdjust(id: string): Promise<void> {
    await adjustTable.remove(id)
  }

  /** 单张执行：复用整批事务 */
  async function execute(id: string): Promise<void> {
    const result = await bulkExecuteAdjusts([id])
    if (result.executed === 0) {
      throw new Error('该阀门暂无最新实测，无法冻结执行依据，请先补录实测后再执行')
    }
  }

  /**
   * 整批执行待下发单据：事务内逐张冻结并回写开度。
   * 失败时事务回滚 + 恢复本次阀门开度，未完成单据保留待下发可重试。
   */
  async function batchExecute(ids?: string[]): Promise<BatchExecuteOutcome> {
    const targets = ids ?? adjusts.value.filter((item) => item.state === '待下发').map((item) => item.id)
    if (targets.length === 0) return { executed: 0, skippedCodes: [] }
    const result = await bulkExecuteAdjusts(targets)
    const skippedCodes = result.skippedNoMeasure
      .map((item) => valveStore.valves.find((valve) => valve.id === item.valveId)?.code ?? item.id)
    return { executed: result.executed, skippedCodes }
  }

  /** 复核：只认执行后新采集的数据，旧数据拒绝复核 */
  async function review(id: string, note: string): Promise<void> {
    await reviewAdjustWithNewMeasure({
      adjustId: id,
      note,
      findReviewSnapshot: (valveId, executedAt) => {
        const valve = valveStore.valves.find((item) => item.id === valveId)
        if (!valve) return null
        return resolveReviewBasis(valve, measures.value, executedAt)?.snapshot ?? null
      }
    })
  }

  /** 实测修改/删除后的失效联动 */
  async function handleMeasureChanged(args: {
    measureId: string
    valveId: string
    extraValveIds?: string[]
    kind: 'modify' | 'delete'
    snapshotDate: string
    valveCode: string
  }): Promise<number> {
    return await invalidateAdjustsForMeasure(args)
  }

  /** 由失衡度排行批量生成调节单（携带派单冻结快照） */
  async function generateFromRank(
    rows: Array<{
      valve: Valve
      measure: Measure | null
      targetOpening: number
      basis: string
    }>
  ): Promise<number> {
    const now = Date.now()
    const existing = new Set(adjusts.value.map((item) => item.valveId))
    const payload: AdjustRow[] = rows
      .filter((row) => !existing.has(row.valve.id))
      .map((row, index) => ({
        id: `aj_${now.toString(36)}${index}${Math.random().toString(36).slice(2, 5)}`,
        valveId: row.valve.id,
        targetOpening: row.targetOpening,
        basis: row.basis,
        executor: '待指派',
        state: '待下发',
        reviewNote: '',
        basisSnapshot: buildSnapshot({ valve: row.valve, measure: row.measure, frozenAt: now }),
        executionSnapshot: null,
        executedAt: null,
        invalidateReason: '',
        reviewHistory: [],
        createdAt: now,
        updatedAt: now
      }))
    if (payload.length > 0) await db.adjusts.bulkPut(payload)
    return payload.length
  }

  return {
    adjustTable,
    adjusts,
    measures,
    enriched,
    filtered,
    stateFilter,
    keyword,
    stateCounts,
    reviewedPercent,
    pendingReviewCount,
    pendingRetestValveIds,
    syncMeasures,
    patchFilter,
    resetFilter,
    hasAdjust,
    isPendingRetest,
    pendingRetestCountOfStation,
    buildBasisSnapshot,
    basisTextFromSnapshot,
    createAdjust,
    updateAdjust,
    removeAdjust,
    execute,
    batchExecute,
    review,
    handleMeasureChanged,
    generateFromRank,
    ADJUST_STATE_FLOW
  }
})
