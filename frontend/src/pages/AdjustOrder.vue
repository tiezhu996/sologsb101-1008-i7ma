<script setup lang="ts">
/**
 * /adjusts 调节单下发与复核
 *
 * 实测与调节单分开保存：
 * - 派单即冻结依据快照（当时最新实测 + 阀门开度），补录/修改实测不改变原依据；
 * - 执行时再冻结当时实测与执行前开度，回写目标开度，支持整批执行（失败回滚、
 *   恢复本批阀门开度，未完成单据留在待下发可重试）；
 * - 复核只认执行后新采集的实测；旧依据实测被改/删后单据退回待复测，原结论可查看。
 */
import { computed, reactive, ref } from 'vue'
import { MessagePlugin, DialogPlugin } from 'tdesign-vue-next'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import BalanceTag from '@/components/common/BalanceTag.vue'
import { useAdjustStore, type AdjustEnriched, type BatchExecuteResult } from '@/stores/adjustStore'
import { useValveStore } from '@/stores/valveStore'
import { useStationStore } from '@/stores/stationStore'
import { useImbalanceRank } from '@/hooks/useImbalanceRank'
import { ADJUST_STATES, EMPTY_ADJUST_DRAFT, type Adjust, type AdjustDraft } from '@/types/adjust'
import { basisText, formatFlow, formatImbalance, formatOpening, formatTemp } from '@/utils/balance'
import { exportAdjustCsv } from '@/utils/export'
import {
  DB_VERSION,
  clearAllTables,
  countAll,
  exportSnapshot,
  importSnapshot,
  readLastBackupAt,
  readStampedDbVersion,
  resetDatabase,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'

type FilterModel = { keyword: string; [key: string]: string | string[] | boolean }

const adjustStore = useAdjustStore()
const valveStore = useValveStore()
const stationStore = useStationStore()
const rank = useImbalanceRank()

const counts = ref<Record<string, number>>({})
const lastBackupAt = ref<string | null>(readLastBackupAt())
const stampedVersion = ref<number>(readStampedDbVersion())
const fileInput = ref<HTMLInputElement | null>(null)
const executing = ref(false)

void refreshCounts()

async function refreshCounts(): Promise<void> {
  counts.value = await countAll()
}

/* ------------------------------ 筛选 ------------------------------ */

const filterModel = computed<FilterModel>(() => ({
  keyword: adjustStore.keyword,
  state: adjustStore.stateFilter
}))

const filterSelects = computed(() => [
  { key: 'state', label: '调节单状态', options: ADJUST_STATES.map((item) => ({ label: item, value: item })) }
])

function onFilterChange(model: FilterModel): void {
  adjustStore.patchFilter({
    keyword: String(model.keyword ?? ''),
    stateFilter: (Array.isArray(model.state) ? model.state : []) as string[]
  })
}

const rows = computed(() => adjustStore.filtered)

/** 当前筛选结果中的待下发单据（整批执行对象） */
const pendingRows = computed(() => rows.value.filter((item) => item.adjust.state === '待下发'))
const allPendingSelected = computed(
  () => pendingRows.value.length > 0 && pendingRows.value.every((item) => adjustStore.selectedIds.includes(item.adjust.id))
)

function toggleAllPending(checked: boolean): void {
  pendingRows.value.forEach((item) => adjustStore.toggleSelect(item.adjust.id, checked))
}

function isSelected(id: string): boolean {
  return adjustStore.selectedIds.includes(id)
}

const columns = [
  { colKey: 'pick', title: '执行', width: 60, cell: 'pickCell' },
  { colKey: 'valve', title: '阀门 / 楼栋', width: 190, cell: 'valveCell' },
  { colKey: 'basis', title: '原签字依据（已冻结）', width: 230, cell: 'basisCell' },
  { colKey: 'review', title: '执行后新采集（复核口径）', width: 230, cell: 'reviewCell' },
  { colKey: 'opening', title: '开度 执行前→目标→当前', width: 190, cell: 'openingCell' },
  { colKey: 'state', title: '状态', width: 100, cell: 'stateCell' },
  { colKey: 'op', title: '操作', width: 240, cell: 'opCell' }
]

function rowKey(row: AdjustEnriched): string {
  return row.adjust.id
}

const stateTheme: Record<string, 'success' | 'warning' | 'primary' | 'danger'> = {
  待下发: 'warning',
  已调节: 'primary',
  已复核: 'success',
  待复测: 'danger'
}

/* ------------------------------ 新建/编辑 ------------------------------ */

const dialogVisible = ref(false)
const dialogTitle = ref('调节单')
const form = reactive<AdjustDraft>({ ...EMPTY_ADJUST_DRAFT })
const formRef = ref()
let editingId: string | null = null

const rules = {
  valveId: [{ required: true, message: '请选择阀门', type: 'error' as const }],
  basis: [{ required: true, message: '请填写调节依据', type: 'error' as const }]
}

const valveOptions = computed(() =>
  valveStore.enriched.map((item) => ({
    label: `${item.valve.code} · ${item.building ? item.building.name : '未知楼栋'}（现 ${item.valve.currentOpening}%）`,
    value: item.valve.id
  }))
)

function openCreate(): void {
  editingId = null
  dialogTitle.value = '新建调节单'
  const first = rank.rows.value.find((row) => row.level !== '平衡' && !adjustStore.hasAdjust(row.valve.id))
  Object.assign(form, {
    ...EMPTY_ADJUST_DRAFT,
    valveId: first ? first.valve.id : valveOptions.value[0]?.value ?? '',
    targetOpening: first ? first.suggestOpening : 50,
    basis: first ? describeRow(first.valve.id) : ''
  })
  dialogVisible.value = true
}

function openEdit(row: AdjustEnriched): void {
  if (row.adjust.state !== '待下发') {
    MessagePlugin.info('该单据已执行，依据与开度已冻结，不能编辑；如需调整请撤销后重新派单')
    return
  }
  editingId = row.adjust.id
  dialogTitle.value = `编辑调节单 · ${row.valve ? row.valve.code : ''}`
  Object.assign(form, {
    valveId: row.adjust.valveId,
    targetOpening: row.adjust.targetOpening,
    basis: row.adjust.basis,
    executor: row.adjust.executor
  })
  dialogVisible.value = true
}

function describeRow(valveId: string): string {
  const row = rank.rowOf(valveId)
  if (!row) return ''
  return basisText({
    valve: row.valve,
    building: row.building,
    ratio: row.ratio,
    flowDeviation: row.flowDeviation,
    roomDeviation: row.roomDeviation,
    imbalanceValue: row.imbalanceValue,
    level: row.level
  })
}

async function submit(): Promise<void> {
  try {
    const result = await formRef.value?.validate()
    if (result !== true) return
  } catch {
    return
  }
  if (editingId) {
    await adjustStore.updateAdjust(editingId, { ...form })
    MessagePlugin.success('调节单已更新')
  } else {
    await adjustStore.createAdjust({ ...form })
    MessagePlugin.success('调节单已创建，派单依据已冻结')
  }
  dialogVisible.value = false
  await refreshCounts()
}

function remove(adjust: Adjust): void {
  const dialog = DialogPlugin.confirm({
    header: '删除确认',
    body: '确认删除该调节单？删除后不可恢复（阀门开度不会自动回退）。',
    confirmBtn: '确认删除',
    cancelBtn: '取消',
    onConfirm: async () => {
      await adjustStore.removeAdjust(adjust.id)
      MessagePlugin.success('调节单已删除')
      dialog.destroy()
      await refreshCounts()
    }
  })
}

/* ------------------------------ 执行 ------------------------------ */

function reportBatchResult(result: BatchExecuteResult, scope: string): void {
  if (result.succeeded.length > 0) {
    MessagePlugin.success(`${scope}完成：已执行 ${result.succeeded.length} 张，执行时实测与阀门开度已冻结`)
  }
  if (result.failed.length > 0) {
    MessagePlugin.error(
      `${scope}写入失败：${result.reason}。本批阀门开度已恢复，${result.failed.length} 张单据留在待下发，可重试`
    )
  }
}

async function executeRow(row: AdjustEnriched): Promise<void> {
  if (row.adjust.state !== '待下发') return
  executing.value = true
  try {
    reportBatchResult(await adjustStore.executeOne(row.adjust.id), '执行')
  } finally {
    executing.value = false
  }
  await refreshCounts()
}

async function executeBatch(): Promise<void> {
  const ids = adjustStore.selectedIds.length > 0
    ? adjustStore.selectedIds
    : pendingRows.value.map((item) => item.adjust.id)
  if (ids.length === 0) {
    MessagePlugin.info('没有待下发的调节单')
    return
  }
  executing.value = true
  try {
    const result = await adjustStore.executeBatch(ids)
    reportBatchResult(result, '整批执行')
  } finally {
    executing.value = false
  }
  await refreshCounts()
}

/* ------------------------------ 复核 ------------------------------ */

const reviewVisible = ref(false)
const reviewNote = ref('')
const reviewTarget = ref<AdjustEnriched | null>(null)

const reviewBlockText = computed(() => (reviewTarget.value ? adjustStore.reviewBlockReason(reviewTarget.value) : null))

function openReview(row: AdjustEnriched): void {
  const block = adjustStore.reviewBlockReason(row)
  if (block) {
    MessagePlugin.warning(block)
    return
  }
  reviewTarget.value = row
  reviewNote.value = row.adjust.reviewNote || '执行后新采集数据显示流量比恢复至 0.95 以上，室温达标，同意闭环'
  reviewVisible.value = true
}

async function submitReview(): Promise<void> {
  if (!reviewTarget.value) return
  const result = await adjustStore.review(reviewTarget.value.adjust.id, reviewNote.value)
  if (!result.ok) {
    MessagePlugin.error(result.reason)
    return
  }
  MessagePlugin.success('复核完成，已按执行后新采集数据闭环')
  reviewVisible.value = false
  reviewTarget.value = null
  await refreshCounts()
}

/* --------------------------- 原结论 / 快照查看 --------------------------- */

const detailVisible = ref(false)
const detailTarget = ref<AdjustEnriched | null>(null)

function openDetail(row: AdjustEnriched): void {
  detailTarget.value = row
  detailVisible.value = true
}

function formatTime(at: number | null | undefined): string {
  if (!at) return '—'
  return new Date(at).toLocaleString('zh-CN', { hour12: false })
}

/* ---------------------------- 备份导出 ---------------------------- */

function exportCsv(): void {
  const filename = exportAdjustCsv(
    stationStore.stations,
    stationStore.buildings,
    valveStore.valves,
    adjustStore.adjusts
  )
  MessagePlugin.success(`已导出 ${filename}`)
}

function exportJson(): void {
  void (async () => {
    const payload = await exportSnapshot()
    const filename = `gbheatgrid-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
    const iso = new Date().toISOString()
    stampBackupTime(iso)
    lastBackupAt.value = iso
    MessagePlugin.success(`已导出全量结构版本 ${filename}`)
  })()
}

function triggerImport(): void {
  fileInput.value?.click()
}

async function onFileChange(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  try {
    const payload = JSON.parse(await file.text()) as BackupPayload
    if (payload.app !== 'gbheatgrid') {
      MessagePlugin.error('存档文件格式不匹配（缺少 app: gbheatgrid 标识）')
      return
    }
    await importSnapshot(payload)
    MessagePlugin.success('存档已导入')
    await refreshCounts()
  } catch (error) {
    MessagePlugin.error(`导入失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    target.value = ''
  }
}

function reseed(): void {
  const dialog = DialogPlugin.confirm({
    header: '重置确认',
    body: '重置将清空现有数据并重新写入演示数据，确认继续？',
    confirmBtn: '重置并播种',
    cancelBtn: '取消',
    onConfirm: async () => {
      await resetDatabase()
      MessagePlugin.success('已重置为演示数据')
      dialog.destroy()
      await refreshCounts()
    }
  })
}

function clearData(): void {
  const dialog = DialogPlugin.confirm({
    header: '清空确认',
    body: '清空后所有本地数据将被删除且不可恢复，确认清空？',
    confirmBtn: '确认清空',
    cancelBtn: '取消',
    onConfirm: async () => {
      await clearAllTables()
      MessagePlugin.success('本地数据已清空')
      dialog.destroy()
      await refreshCounts()
    }
  })
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">调节单下发与复核</h2>
        <p class="page-head__desc">
          派单即冻结依据；执行冻结当时实测与阀门开度；复核只认执行后新采集数据，旧记录改动则退回待复测。
        </p>
      </div>
      <div class="page-head__actions">
        <t-button variant="outline" @click="exportCsv">导出调节单 CSV</t-button>
        <t-button variant="outline" @click="exportJson">导出全量 JSON</t-button>
        <t-button variant="outline" @click="triggerImport">导入 JSON</t-button>
        <t-button theme="primary" @click="openCreate">新建调节单</t-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="待下发" :value="adjustStore.stateCounts['待下发']" suffix="张" tone="warning" />
      <StatBadge label="已调节" :value="adjustStore.stateCounts['已调节']" suffix="张" tone="info" />
      <StatBadge label="待复测" :value="adjustStore.stateCounts['待复测']" suffix="张" tone="danger" />
      <StatBadge label="已复核" :value="adjustStore.stateCounts['已复核']" suffix="张" tone="success" />
      <StatBadge label="复核率" :value="adjustStore.reviewedPercent" :percent="adjustStore.reviewedPercent" suffix="%" tone="primary" />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索阀门编号 / 执行人 / 依据"
      @change="onFilterChange"
    />

    <div class="panel" style="margin-top: 16px">
      <div class="panel-head">
        <h3 class="panel-title" style="margin: 0">调节单（{{ rows.length }} / {{ adjustStore.adjusts.length }}）</h3>
        <div class="toolbar">
          <t-checkbox
            :checked="allPendingSelected"
            :disabled="pendingRows.length === 0"
            @change="toggleAllPending"
          >
            全选待下发（{{ pendingRows.length }}）
          </t-checkbox>
          <t-button theme="primary" :loading="executing" :disabled="pendingRows.length === 0" @click="executeBatch">
            整批执行{{ adjustStore.selectedIds.length > 0 ? `（${adjustStore.selectedIds.length}）` : '' }}
          </t-button>
        </div>
      </div>

      <EmptyPanel
        v-if="rows.length === 0"
        title="还没有调节单"
        description="可到失衡度计算页一键生成，或在此手工新建。"
        action-text="新建调节单"
        secondary-text="重置为演示数据"
        compact
        :show-seed="adjustStore.adjusts.length === 0"
        @action="openCreate"
        @secondary="reseed"
        @seed="reseed"
      />

      <t-table v-else :data="rows" :columns="columns" :row-key="rowKey" bordered stripe size="small">
        <template #pickCell="{ row }">
          <t-checkbox
            v-if="row.adjust.state === '待下发'"
            :checked="isSelected(row.adjust.id)"
            @change="(checked: boolean) => adjustStore.toggleSelect(row.adjust.id, checked)"
          />
          <span v-else class="muted">—</span>
        </template>
        <template #valveCell="{ row }">
          <div>
            <strong>{{ row.valve ? row.valve.code : '阀门已删除' }}</strong>
            <div class="muted">
              {{ row.valve ? stationStore.stationById.get(row.valve.stationId)?.name ?? '' : '' }}
            </div>
            <div class="muted">{{ row.adjust.executor }}</div>
          </div>
        </template>
        <template #basisCell="{ row }">
          <div v-if="row.adjust.basisSnapshot">
            <BalanceTag :level="row.basisLevel" :imbalance="row.adjust.basisSnapshot.imbalanceValue" size="small" />
            <div class="snapshot-line">
              {{ row.adjust.basisSnapshot.measureDate }} · 流量比 {{ row.adjust.basisSnapshot.ratio.toFixed(2) }}
              · {{ formatFlow(row.adjust.basisSnapshot.flowM3h) }}
            </div>
            <div class="snapshot-line muted">
              室温 {{ formatTemp(row.adjust.basisSnapshot.roomTempC) }} · 依据开度 {{ formatOpening(row.adjust.basisSnapshot.opening) }}
            </div>
          </div>
          <span v-else class="muted">手工派单，无实测依据</span>
        </template>
        <template #reviewCell="{ row }">
          <template v-if="row.adjust.executedAt === null">
            <span class="muted">执行后才采集</span>
          </template>
          <template v-else-if="row.reviewMeasure && row.currentSnapshot">
            <BalanceTag :level="row.currentLevel" :imbalance="row.currentSnapshot.imbalanceValue" size="small" />
            <div class="snapshot-line">
              {{ row.reviewMeasure.date }} · 流量比 {{ row.currentSnapshot.ratio.toFixed(2) }}
              · {{ formatFlow(row.reviewMeasure.flowM3h) }}
            </div>
            <div class="snapshot-line muted">室温 {{ formatTemp(row.reviewMeasure.roomTempC) }}</div>
          </template>
          <t-tag v-else size="small" theme="warning" variant="light">待复测：尚无执行后新采集</t-tag>
        </template>
        <template #openingCell="{ row }">
          <template v-if="row.valve">
            <span v-if="row.adjust.beforeOpening !== null">{{ formatOpening(row.adjust.beforeOpening) }} → </span>
            <strong>{{ formatOpening(row.adjust.targetOpening) }}</strong>
            <span class="muted"> → 现 {{ formatOpening(row.valve.currentOpening) }}</span>
          </template>
          <span v-else class="muted">—</span>
        </template>
        <template #stateCell="{ row }">
          <t-tag size="small" variant="light" :theme="stateTheme[row.adjust.state] ?? 'default'">
            {{ row.adjust.state }}
          </t-tag>
          <div v-if="row.adjust.state === '待复测'" class="invalid-reason" :title="row.adjust.invalidReason">
            原{{ row.adjust.invalidFromState === '已复核' ? '复核' : '调节' }}已失效
          </div>
        </template>
        <template #opCell="{ row }">
          <div class="toolbar toolbar--wrap">
            <t-button
              v-if="row.adjust.state === '待下发'"
              size="small"
              variant="text"
              theme="primary"
              :loading="executing"
              @click="executeRow(row)"
            >
              执行
            </t-button>
            <t-button
              v-if="row.adjust.state === '已调节' || row.adjust.state === '待复测'"
              size="small"
              variant="text"
              theme="primary"
              @click="openReview(row)"
            >
              {{ row.adjust.state === '待复测' ? '复测复核' : '复核闭环' }}
            </t-button>
            <t-button size="small" variant="text" theme="primary" @click="openDetail(row)">依据/结论</t-button>
            <t-button
              size="small"
              variant="text"
              theme="primary"
              :disabled="row.adjust.state !== '待下发'"
              @click="openEdit(row)"
            >
              编辑
            </t-button>
            <t-button size="small" variant="text" theme="danger" @click="remove(row.adjust)">删除</t-button>
          </div>
        </template>
      </t-table>
    </div>

    <div class="panel">
      <h3 class="panel-title">结构版本与本地数据</h3>
      <t-descriptions :column="3" bordered size="small">
        <t-descriptions-item label="IndexedDB 库名">gbheatgrid</t-descriptions-item>
        <t-descriptions-item label="数据结构版本">v{{ DB_VERSION }}（记录 v{{ stampedVersion }}）</t-descriptions-item>
        <t-descriptions-item label="最近备份">{{ lastBackupAt ?? '尚未备份' }}</t-descriptions-item>
        <t-descriptions-item label="换热站 / 楼栋">
          {{ counts.stations ?? 0 }} / {{ counts.buildings ?? 0 }}
        </t-descriptions-item>
        <t-descriptions-item label="阀门 / 实测">
          {{ counts.valves ?? 0 }} / {{ counts.measures ?? 0 }}
        </t-descriptions-item>
        <t-descriptions-item label="调节单">{{ counts.adjusts ?? 0 }}</t-descriptions-item>
      </t-descriptions>
      <div class="toolbar" style="margin-top: 14px">
        <t-button theme="primary" variant="outline" @click="exportJson">导出全量 JSON</t-button>
        <t-button variant="outline" @click="reseed">重置为演示数据</t-button>
        <t-button theme="danger" variant="outline" @click="clearData">清空本地数据</t-button>
        <t-button variant="text" theme="primary" @click="refreshCounts">刷新统计</t-button>
      </div>
      <input ref="fileInput" type="file" accept="application/json,.json" style="display: none" @change="onFileChange" />
    </div>

    <!-- 新建 / 编辑（仅待下发） -->
    <t-dialog
      v-model:visible="dialogVisible"
      :header="dialogTitle"
      width="620px"
      :confirm-btn="'保存'"
      :cancel-btn="'取消'"
      @confirm="submit"
    >
      <t-form ref="formRef" :data="form" :rules="rules" label-width="128px">
        <t-form-item label="阀门" name="valveId">
          <t-select v-model="form.valveId" :options="valveOptions" filterable placeholder="选择阀门" />
        </t-form-item>
        <t-form-item label="目标开度(%)" name="targetOpening">
          <t-input-number v-model="form.targetOpening" :min="0" :max="100" :step="5" style="width: 100%" />
        </t-form-item>
        <t-form-item label="调节依据" name="basis">
          <t-textarea v-model="form.basis" :autosize="{ minRows: 3, maxRows: 5 }" placeholder="如：流量比 0.74 偏小，需增大开度" />
        </t-form-item>
        <t-form-item label="执行人" name="executor">
          <t-input v-model="form.executor" placeholder="如 王海" />
        </t-form-item>
      </t-form>
      <p class="muted">保存即按当前最新实测冻结派单依据；执行时还会再冻结当时实测与执行前开度。</p>
    </t-dialog>

    <!-- 复核：只认执行后新采集 -->
    <t-dialog
      v-model:visible="reviewVisible"
      :header="`复核闭环 · ${reviewTarget?.valve?.code ?? ''}`"
      width="560px"
      :confirm-btn="'确认闭环'"
      :cancel-btn="'取消'"
      @confirm="submitReview"
    >
      <template v-if="reviewTarget">
        <t-descriptions v-if="reviewTarget.reviewMeasure && reviewTarget.currentSnapshot" :column="2" bordered size="small">
          <t-descriptions-item label="执行时间">{{ formatTime(reviewTarget.adjust.executedAt) }}</t-descriptions-item>
          <t-descriptions-item label="新采集日期">{{ reviewTarget.reviewMeasure.date }}</t-descriptions-item>
          <t-descriptions-item label="新实测流量">{{ formatFlow(reviewTarget.reviewMeasure.flowM3h) }}</t-descriptions-item>
          <t-descriptions-item label="流量比">
            {{ reviewTarget.currentSnapshot.ratio.toFixed(2) }}
          </t-descriptions-item>
          <t-descriptions-item label="室温">{{ formatTemp(reviewTarget.reviewMeasure.roomTempC) }}</t-descriptions-item>
          <t-descriptions-item label="复核失衡度">
            <BalanceTag :level="reviewTarget.currentLevel" :imbalance="reviewTarget.currentSnapshot.imbalanceValue" size="small" />
          </t-descriptions-item>
        </t-descriptions>
        <t-alert v-if="reviewBlockText" theme="warning" :message="reviewBlockText" style="margin: 10px 0" />
        <t-textarea
          v-model="reviewNote"
          :autosize="{ minRows: 3, maxRows: 6 }"
          placeholder="填写复核结论"
          style="margin-top: 12px"
        />
        <p class="muted">复核只采信执行后新采集的实测；原依据保留在单据快照中，不会被覆盖。</p>
      </template>
    </t-dialog>

    <!-- 依据 / 原结论查看 -->
    <t-dialog v-model:visible="detailVisible" :header="`依据与复核留痕 · ${detailTarget?.valve?.code ?? ''}`" width="640px" :footer="false">
      <template v-if="detailTarget">
        <h4 class="detail-h">调节依据（文本）</h4>
        <p class="detail-text muted">{{ detailTarget.adjust.basis || '—' }}</p>

        <h4 class="detail-h">派单/执行冻结快照</h4>
        <t-descriptions v-if="detailTarget.adjust.basisSnapshot" :column="2" bordered size="small">
          <t-descriptions-item label="依据实测日期">{{ detailTarget.adjust.basisSnapshot.measureDate || '—' }}</t-descriptions-item>
          <t-descriptions-item label="冻结开度">{{ formatOpening(detailTarget.adjust.basisSnapshot.opening) }}</t-descriptions-item>
          <t-descriptions-item label="实测流量">{{ formatFlow(detailTarget.adjust.basisSnapshot.flowM3h) }}</t-descriptions-item>
          <t-descriptions-item label="流量比">{{ detailTarget.adjust.basisSnapshot.ratio.toFixed(2) }}</t-descriptions-item>
          <t-descriptions-item label="室温">{{ formatTemp(detailTarget.adjust.basisSnapshot.roomTempC) }}</t-descriptions-item>
          <t-descriptions-item label="失衡度">
            {{ formatImbalance(detailTarget.adjust.basisSnapshot.imbalanceValue) }}
          </t-descriptions-item>
          <t-descriptions-item label="执行前开度">
            {{ detailTarget.adjust.beforeOpening !== null ? formatOpening(detailTarget.adjust.beforeOpening) : '—' }}
          </t-descriptions-item>
          <t-descriptions-item label="执行时间">{{ formatTime(detailTarget.adjust.executedAt) }}</t-descriptions-item>
        </t-descriptions>
        <p v-else class="muted">无冻结实测（手工派单）。</p>

        <template v-if="detailTarget.adjust.state === '待复测'">
          <h4 class="detail-h">退回待复测原因</h4>
          <t-alert theme="error" :message="detailTarget.adjust.invalidReason || '原依据数据发生变化'" />
          <p class="muted">失效时间：{{ formatTime(detailTarget.adjust.invalidatedAt) }}（阀门开度保持执行结果，待新数据复测）</p>
        </template>

        <h4 class="detail-h">复核结论留痕（{{ detailTarget.adjust.reviewHistory.length }} 条，原结论可查）</h4>
        <EmptyPanel
          v-if="detailTarget.adjust.reviewHistory.length === 0"
          title="暂无复核结论"
          description="执行并采集新数据后可复核闭环。"
          compact
        />
        <div
          v-for="(entry, index) in [...detailTarget.adjust.reviewHistory].reverse()"
          :key="`${entry.at}-${index}`"
          class="history-item"
        >
          <div class="history-item__head">
            <strong>{{ formatTime(entry.at) }}</strong>
            <BalanceTag :level="entry.snapshot.level" :imbalance="entry.snapshot.imbalanceValue" size="small" />
          </div>
          <div class="muted">
            {{ entry.snapshot.measureDate }} · 流量比 {{ entry.snapshot.ratio.toFixed(2) }}
            · {{ formatFlow(entry.snapshot.flowM3h) }} · 室温 {{ formatTemp(entry.snapshot.roomTempC) }}
          </div>
          <div>{{ entry.note }}</div>
        </div>
      </template>
    </t-dialog>
  </div>
</template>

<style scoped>
.snapshot-line {
  margin-top: 2px;
  font-size: 12px;
  line-height: 18px;
}

.invalid-reason {
  margin-top: 2px;
  font-size: 12px;
  color: #c0392b;
}

.toolbar--wrap {
  flex-wrap: wrap;
  row-gap: 2px;
}

.detail-h {
  margin: 16px 0 8px;
  font-size: 14px;
  font-weight: 600;
}

.detail-h:first-child {
  margin-top: 0;
}

.detail-text {
  margin: 0;
  white-space: pre-wrap;
}

.history-item {
  padding: 10px 12px;
  margin-bottom: 8px;
  border: 1px solid var(--hg-line);
  border-radius: 8px;
  background: #faf8f4;
}

.history-item__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}
</style>
