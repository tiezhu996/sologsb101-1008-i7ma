/**
 * 调节单状态（Pinia）
 *
 * 实测与调节单分开保存：派单时冻结依据快照，执行时再冻结当时最新实测与
 * 阀门开度；复核只认执行后新采集的实测。旧依据实测被修改/删除后，已调节/
 * 已复核的单据退回「待复测」，原结论留痕仍可查看。
 *
 * 整批执行在单个 Dexie 事务内回写阀门开度与单据状态，任一条失败整体回滚
 * （本批阀门开度恢复为执行前），未完成单据留在「待下发」可重试；事务外再
 * 追加一层开度补偿恢复，双保险。
 *
 * 排行、调节单、站内汇总统一消费 useImbalanceRank 单例的同一套结果。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, type AdjustRow, type ValveRow } from '@/utils/db'
import {
  emptyAdjustRuntime,
  isExecutedState,
  type AdjustDraft,
  type MeasureSnapshot,
  type ReviewHistoryEntry
} from '@/types/adjust'
import { useValveStore } from '@/stores/valveStore'
import { useImbalanceRank } from '@/hooks/useImbalanceRank'
import { buildMeasureSnapshot, findReviewMeasure, type BalanceLevel } from '@/utils/balance'
import type { Measure } from '@/types/measure'
import type { Valve } from '@/types/valve'

export interface AdjustEnriched {
  adjust: AdjustRow
  valve: ValveRow | null
  /** 派单/执行冻结的依据判级（原签字依据，不随后续实测改动而变） */
  basisLevel: BalanceLevel
  /** 执行后新采集的最新实测（复核只认它）；执行前或无新数据时为 null */
  reviewMeasure: Measure | null
  /** 按执行后新实测 + 当前开度计算的快照；无新数据时为 null */
  currentSnapshot: MeasureSnapshot | null
  currentLevel: BalanceLevel
}

export interface BatchExecuteResult {
  /** 本批成功执行的调节单 id */
  succeeded: string[]
  /** 未能执行的调节单 id（留在待下发，可重试） */
  failed: string[]
  /** 失败原因（首条），用于提示 */
  reason: string
}

function clampOpening(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

export const useAdjustStore = defineStore('adjust', () => {
  const adjustTable = useIdbTable<AdjustRow>((database) => database.adjusts, { sortByUpdatedAt: false })
  const valveStore = useValveStore()
  const rank = useImbalanceRank()

  const stateFilter = ref<string[]>([])
  const keyword = ref('')
  /** 整批执行勾选的待下发单据 */
  const selectedIds = ref<string[]>([])

  const adjusts = computed<AdjustRow[]>(() =>
    [...adjustTable.rows.value].sort((a, b) => b.updatedAt - a.updatedAt)
  )

  /** 冻结某阀门当前最新实测 + 当前开度，作为派单依据快照 */
  function freezeBasis(valve: Valve): MeasureSnapshot | null {
    const row = rank.rowOf(valve.id)
    if (!row || !row.latest) return null
    return buildMeasureSnapshot({ measure: row.latest, valve }, Date.now())
  }

  const enriched = computed<AdjustEnriched[]>(() =>
    adjusts.value.map((adjust) => {
      const valve = valveStore.valves.find((item) => item.id === adjust.valveId) ?? null
      const basis = adjust.basisSnapshot
      const basisLevel: BalanceLevel = basis ? basis.level : '平衡'

      let reviewMeasure: Measure | null = null
      if (valve && adjust.executedAt !== null) {
        reviewMeasure = findReviewMeasure(rank.measureTable.rows.value, valve.id, adjust.executedAt)
      }

      // 执行后当前失衡度：用执行后新实测 + 当前（执行后）开度，与排行同一口径
      const currentSnapshot: MeasureSnapshot | null =
        reviewMeasure && valve
          ? buildMeasureSnapshot({ measure: reviewMeasure, valve }, adjust.executedAt ?? Date.now())
          : null
      const currentLevel: BalanceLevel = currentSnapshot ? currentSnapshot.level : basisLevel

      return { adjust, valve, basisLevel, reviewMeasure, currentSnapshot, currentLevel }
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

  const stateCounts = computed<Record<string, number>>(() => {
    const counts: Record<string, number> = { 待下发: 0, 已调节: 0, 已复核: 0, 待复测: 0 }
    adjusts.value.forEach((adjust) => {
      counts[adjust.state] = (counts[adjust.state] ?? 0) + 1
    })
    return counts
  })

  /** 待处理：待下发 + 待复测（需要班组跟进的单据） */
  const pendingCount = computed(() => stateCounts.value['待下发'] + stateCounts.value['待复测'])

  const reviewedPercent = computed(() =>
    adjusts.value.length === 0 ? 0 : Math.round((stateCounts.value['已复核'] / adjusts.value.length) * 100)
  )

  function patchFilter(patch: { stateFilter?: string[]; keyword?: string }): void {
    if (patch.stateFilter) stateFilter.value = patch.stateFilter
    if (patch.keyword !== undefined) keyword.value = patch.keyword
  }

  function resetFilter(): void {
    stateFilter.value = []
    keyword.value = ''
  }

  /** 该阀门是否已有任意状态的调节单（含待复测），避免重复派单 */
  const hasAdjust = (valveId: string): boolean => adjusts.value.some((adjust) => adjust.valveId === valveId)

  /* ------------------------------ 新建 / 编辑 ------------------------------ */

  async function createAdjust(draft: AdjustDraft): Promise<AdjustRow> {
    const valve = valveStore.valves.find((item) => item.id === draft.valveId)
    const now = Date.now()
    const row: AdjustRow = {
      id: `aj_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      valveId: draft.valveId,
      targetOpening: clampOpening(draft.targetOpening),
      basis: draft.basis.trim(),
      executor: draft.executor.trim() || '待指派',
      state: '待下发',
      reviewNote: '',
      ...emptyAdjustRuntime(),
      basisSnapshot: valve ? freezeBasis(valve) : null,
      createdAt: now,
      updatedAt: now
    }
    await db.adjusts.put(row)
    return row
  }

  /** 仅「待下发」单据可编辑；已执行单据的依据/开度已冻结，只能撤销后重新派单 */
  async function updateAdjust(id: string, patch: Partial<AdjustDraft>): Promise<void> {
    const existing = adjusts.value.find((item) => item.id === id)
    if (!existing || existing.state !== '待下发') return
    const next: Partial<AdjustRow> = {}
    if (patch.targetOpening !== undefined) next.targetOpening = clampOpening(patch.targetOpening)
    if (patch.basis !== undefined) next.basis = patch.basis.trim()
    if (patch.executor !== undefined) next.executor = patch.executor.trim() || '待指派'
    if (patch.valveId !== undefined) {
      next.valveId = patch.valveId
      const valve = valveStore.valves.find((item) => item.id === patch.valveId)
      next.basisSnapshot = valve ? freezeBasis(valve) : null
    }
    await adjustTable.update(id, next)
  }

  async function removeAdjust(id: string): Promise<void> {
    await adjustTable.remove(id)
    selectedIds.value = selectedIds.value.filter((item) => item !== id)
  }

  /* ------------------------------ 执行（冻结） ------------------------------ */

  /**
   * 整批执行：在单个事务内把每张单据的目标开度回写到阀门，并把单据推进为
   * 「已调节」，同时冻结执行前开度与当时最新实测。任一写入失败事务整体回滚
   * （阀门开度恢复执行前）；事务抛出后再做一次开度补偿恢复作为双保险，
   * 未完成单据保留在「待下发」，可对失败集合重试。
   */
  async function executeBatch(ids: string[]): Promise<BatchExecuteResult> {
    const targets = Array.from(new Set(ids))
      .map((id) => adjusts.value.find((item) => item.id === id))
      .filter((item): item is AdjustRow => Boolean(item))
      .filter((item) => item.state === '待下发')

    if (targets.length === 0) {
      return { succeeded: [], failed: Array.from(new Set(ids)), reason: '没有可执行的待下发调节单' }
    }

    // 执行前开度备份（key: 阀门 id），用于事务外补偿恢复
    const beforeByValve = new Map<string, number>()
    targets.forEach((adjust) => {
      const valve = valveStore.valves.find((item) => item.id === adjust.valveId)
      if (valve && !beforeByValve.has(valve.id)) beforeByValve.set(valve.id, valve.currentOpening)
    })

    let failedReason = ''
    try {
      await db.transaction('rw', db.valves, db.adjusts, db.measures, async () => {
        const now = Date.now()
        const measures = await db.measures.toArray()

        for (const adjust of targets) {
          const valve = await db.valves.get(adjust.valveId)
          if (!valve) throw new Error(`调节单 ${adjust.id} 的阀门已不存在`)

          const beforeOpening = valve.currentOpening
          const latest = findReviewMeasure(measures, valve.id, 0)
          // 执行瞬间冻结：当时最新实测 + 执行前开度
          const basisSnapshot = latest
            ? buildMeasureSnapshot({ measure: latest, valve: { ...valve, currentOpening: beforeOpening } }, now)
            : (() => {
                // 无新实测时也要把依据快照的开度冻结为执行前开度
                const previous = adjust.basisSnapshot
                return previous ? { ...previous, opening: beforeOpening, frozenAt: now } : null
              })()

          await db.valves.update(valve.id, {
            currentOpening: clampOpening(adjust.targetOpening),
            updatedAt: now
          })
          await db.adjusts.update(adjust.id, {
            state: '已调节',
            beforeOpening,
            executedAt: now,
            basisSnapshot,
            invalidReason: '',
            invalidatedAt: null,
            invalidFromState: null,
            updatedAt: now
          })
        }
      })
    } catch (error) {
      failedReason = error instanceof Error ? error.message : '整批执行写入失败'
      // 双保险：若事务回滚后开度仍与执行前不一致，逐阀补偿恢复本次开度
      try {
        await db.transaction('rw', db.valves, async () => {
          for (const [valveId, opening] of beforeByValve) {
            const current = await db.valves.get(valveId)
            if (current && current.currentOpening !== opening) {
              await db.valves.update(valveId, { currentOpening: opening })
            }
          }
        })
      } catch {
        // 补偿恢复仍失败时交由调用方提示重试，不吞掉原始错误
      }
      return { succeeded: [], failed: targets.map((item) => item.id), reason: failedReason }
    }

    const succeededIds = targets.map((item) => item.id)
    selectedIds.value = selectedIds.value.filter((id) => !succeededIds.includes(id))
    return { succeeded: succeededIds, failed: [], reason: '' }
  }

  /** 单张执行（复用整批事务路径） */
  async function executeOne(id: string): Promise<BatchExecuteResult> {
    return executeBatch([id])
  }

  /* -------------------------------- 复核 -------------------------------- */

  /** 复核前置：只认执行后新采集的数据，返回缺失原因（null 表示可复核） */
  function reviewBlockReason(item: AdjustEnriched): string | null {
    if (!isExecutedState(item.adjust.state)) return '该调节单尚未执行'
    if (item.adjust.executedAt === null) return '缺少执行时间，无法确认执行后新采集数据'
    if (!item.reviewMeasure) return '执行后尚无新采集的实测数据，请先补录执行后实测再复核'
    return null
  }

  /**
   * 复核闭环：只采信执行后新采集的最新实测并冻结为复核快照；
   * 待复测单据用新数据复核后重新闭环，原结论保留在 reviewHistory。
   */
  async function review(id: string, note: string): Promise<{ ok: boolean; reason: string }> {
    const item = enriched.value.find((entry) => entry.adjust.id === id)
    if (!item) return { ok: false, reason: '调节单不存在' }
    const block = reviewBlockReason(item)
    if (block) return { ok: false, reason: block }

    const snapshot = item.currentSnapshot
    if (!snapshot || !item.reviewMeasure) return { ok: false, reason: '缺少执行后复核实测' }

    const now = Date.now()
    const historyEntry: ReviewHistoryEntry = { note: note.trim() || '复核合格', at: now, snapshot }
    const existingHistory = Array.isArray(item.adjust.reviewHistory) ? item.adjust.reviewHistory : []
    await adjustTable.update(id, {
      state: '已复核',
      reviewNote: historyEntry.note,
      reviewSnapshot: snapshot,
      reviewMeasureId: item.reviewMeasure.id,
      reviewHistory: [...existingHistory, historyEntry],
      invalidReason: '',
      invalidatedAt: null,
      invalidFromState: null
    })
    return { ok: true, reason: '' }
  }

  /* ---------------------------- 批量生成（派单冻结） ---------------------------- */

  async function generateFromRank(
    rows: Array<{ valve: Valve; basisText: string; suggestOpening: number }>
  ): Promise<number> {
    const now = Date.now()
    const payload: AdjustRow[] = rows
      .filter((row) => !hasAdjust(row.valve.id))
      .map((row, index) => ({
        id: `aj_${now.toString(36)}${index}${Math.random().toString(36).slice(2, 5)}`,
        valveId: row.valve.id,
        targetOpening: row.suggestOpening,
        basis: row.basisText,
        executor: '待指派',
        state: '待下发' as const,
        reviewNote: '',
        ...emptyAdjustRuntime(),
        basisSnapshot: freezeBasis(row.valve),
        createdAt: now,
        updatedAt: now
      }))
    if (payload.length > 0) await db.adjusts.bulkPut(payload)
    return payload.length
  }

  /* ------------------------------- 勾选状态 ------------------------------- */

  function toggleSelect(id: string, checked: boolean): void {
    selectedIds.value = checked
      ? Array.from(new Set([...selectedIds.value, id]))
      : selectedIds.value.filter((item) => item !== id)
  }

  function clearSelection(): void {
    selectedIds.value = []
  }

  return {
    adjustTable,
    adjusts,
    enriched,
    filtered,
    stateFilter,
    keyword,
    selectedIds,
    stateCounts,
    pendingCount,
    reviewedPercent,
    patchFilter,
    resetFilter,
    hasAdjust,
    createAdjust,
    updateAdjust,
    removeAdjust,
    executeBatch,
    executeOne,
    reviewBlockReason,
    review,
    generateFromRank,
    toggleSelect,
    clearSelection
  }
})
