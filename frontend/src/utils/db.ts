/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号 + upgrade 迁移
 * - 级联删除、整库导入导出、首屏幂等播种
 */
import Dexie, { type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Building } from '@/types/building'
import type { Valve } from '@/types/valve'
import type { Measure } from '@/types/measure'
import type { Adjust, MeasureSnapshot, ReviewArchive } from '@/types/adjust'
import { archiveReview, buildSnapshot, invalidateReasonText } from '@/utils/freeze'

export const DB_NAME = 'gbheatgrid'
export const DB_VERSION = 3

export const LS_KEYS = {
  dbVersion: 'gbheatgrid:db-version',
  lastBackupAt: 'gbheatgrid:last-backup-at',
  uiPrefs: 'gbheatgrid:ui-prefs'
} as const

export interface UiPrefs {
  lastStationId: string | null
  onlyImbalanced: boolean
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastStationId: null, onlyImbalanced: false }

export interface BackupPayload {
  app: 'gbheatgrid'
  dbVersion: number
  exportedAt: string
  stations: Station[]
  buildings: Building[]
  valves: Valve[]
  measures: Measure[]
  adjusts: Adjust[]
}

export interface Revisioned {
  revision?: number
}

export const ROW_REVISION = 3

export type StationRow = Station & Revisioned
export type BuildingRow = Building & Revisioned
export type ValveRow = Valve & Revisioned
export type MeasureRow = Measure & Revisioned
export type AdjustRow = Adjust & Revisioned

class HeatGridDatabase extends Dexie {
  stations!: Table<StationRow, string>
  buildings!: Table<BuildingRow, string>
  valves!: Table<ValveRow, string>
  measures!: Table<MeasureRow, string>
  adjusts!: Table<AdjustRow, string>

  constructor() {
    super(DB_NAME)

    this.version(1).stores({
      stations: 'id, name, commissionYear',
      buildings: 'id, stationId, name, heatMode',
      valves: 'id, buildingId, code, position',
      measures: 'id, valveId, date',
      adjusts: 'id, valveId, state'
    })

    // v2：阀门补 stationId 冗余列并在升级时回填；实测补 revision；调节单补 reviewNote
    this.version(2).stores({
      stations: 'id, name, commissionYear, updatedAt',
      buildings: 'id, stationId, name, heatMode, updatedAt',
      valves: 'id, buildingId, stationId, code, position, updatedAt',
      measures: 'id, valveId, date, operator, updatedAt',
      adjusts: 'id, valveId, state, executor, updatedAt'
    })

    // v3：实测与调节单分离——调节单冻结派单/执行两份快照，新增待复测状态与执行时间索引
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, commissionYear, updatedAt',
        buildings: 'id, stationId, name, heatMode, updatedAt',
        valves: 'id, buildingId, stationId, code, position, updatedAt',
        measures: 'id, valveId, date, operator, updatedAt, createdAt',
        adjusts: 'id, valveId, state, executor, updatedAt, executedAt'
      })
      .upgrade(async (tx) => {
        const valveRows = (await tx.table('valves').toArray()) as unknown as ValveRow[]
        const measureRows = (await tx.table('measures').toArray()) as unknown as MeasureRow[]

        const latestByValve = new Map<string, MeasureRow>()
        measureRows.forEach((measure) => {
          const prev = latestByValve.get(measure.valveId)
          if (!prev || measure.date > prev.date || (measure.date === prev.date && measure.createdAt > prev.createdAt)) {
            latestByValve.set(measure.valveId, measure)
          }
        })
        const valveById = new Map(valveRows.map((valve) => [valve.id, valve]))

        await tx
          .table('adjusts')
          .toCollection()
          .modify((adjust: Record<string, unknown>) => {
            const valveId = String(adjust.valveId ?? '')
            const valve = valveById.get(valveId)
            const latest = latestByValve.get(valveId) ?? null
            const basisSnapshot: MeasureSnapshot | null =
              valve && latest
                ? (buildSnapshot({
                    valve,
                    measure: latest,
                    frozenAt: typeof adjust.createdAt === 'number' ? adjust.createdAt : Date.now()
                  }) as MeasureSnapshot)
                : null

            if (adjust.basisSnapshot === undefined) adjust.basisSnapshot = basisSnapshot
            if (adjust.executionSnapshot === undefined) {
              // 已调节/已复核的老单据：执行快照用当时最新实测近似回填，并以执行时刻开度留痕
              adjust.executionSnapshot =
                adjust.state === '待下发'
                  ? null
                  : basisSnapshot
                    ? { ...basisSnapshot, valveOpening: Number(adjust.targetOpening) || basisSnapshot.valveOpening }
                    : null
            }
            if (adjust.executedAt === undefined) {
              adjust.executedAt = adjust.state === '待下发' ? null : typeof adjust.updatedAt === 'number' ? adjust.updatedAt : null
            }
            if (typeof adjust.invalidateReason !== 'string') adjust.invalidateReason = ''
            if (!Array.isArray(adjust.reviewHistory)) adjust.reviewHistory = []
            if (adjust.state === '待复测') {
              // 保留迁移前已存在的待复测状态
            } else if (adjust.state !== '待下发' && adjust.state !== '已调节' && adjust.state !== '已复核') {
              adjust.state = '待下发'
            }
            adjust.revision = ROW_REVISION
          })

        for (const name of ['stations', 'buildings', 'valves', 'measures']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
            })
        }
      })
  }
}

export const db = new HeatGridDatabase()

export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/* ============================ 演示数据播种 ============================ */

const SEED_STAMP = Date.parse('2024-11-20T09:00:00+08:00')
const stamp = (offsetDays = 0): number => SEED_STAMP + offsetDays * 86400000

const SEED_STATIONS: StationRow[] = [
  { id: 'st-1', name: '阳光家园换热站', heatAreaM2: 86000, designFlowM3h: 320, supplyTempC: 55, returnTempC: 40, commissionYear: 2015, createdAt: stamp(-300), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'st-2', name: '锦绣花园换热站', heatAreaM2: 64000, designFlowM3h: 240, supplyTempC: 52, returnTempC: 38, commissionYear: 2018, createdAt: stamp(-280), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_BUILDINGS: BuildingRow[] = [
  { id: 'bd-1', stationId: 'st-1', name: '3号楼', areaM2: 4800, floors: 11, units: 2, heatMode: '地暖', createdAt: stamp(-290), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'bd-2', stationId: 'st-1', name: '5号楼', areaM2: 5200, floors: 12, units: 2, heatMode: '散热器', createdAt: stamp(-289), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'bd-3', stationId: 'st-1', name: '7号楼', areaM2: 4100, floors: 9, units: 1, heatMode: '地暖', createdAt: stamp(-288), updatedAt: stamp(-3), revision: ROW_REVISION },
  { id: 'bd-4', stationId: 'st-2', name: 'A座', areaM2: 6800, floors: 15, units: 3, heatMode: '散热器', createdAt: stamp(-270), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'bd-5', stationId: 'st-2', name: 'B座', areaM2: 5900, floors: 14, units: 2, heatMode: '地暖', createdAt: stamp(-269), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_VALVES: ValveRow[] = [
  { id: 'vv-1', buildingId: 'bd-1', stationId: 'st-1', code: 'BL-3-01', dn: 65, currentOpening: 55, designFlowM3h: 32, position: '楼栋总阀', createdAt: stamp(-280), updatedAt: stamp(-10), revision: ROW_REVISION },
  { id: 'vv-2', buildingId: 'bd-1', stationId: 'st-1', code: 'BL-3-02', dn: 50, currentOpening: 45, designFlowM3h: 18, position: '单元立管', createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'vv-3', buildingId: 'bd-2', stationId: 'st-1', code: 'BL-5-01', dn: 65, currentOpening: 75, designFlowM3h: 35, position: '楼栋总阀', createdAt: stamp(-279), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'vv-4', buildingId: 'bd-2', stationId: 'st-1', code: 'BL-5-02', dn: 50, currentOpening: 55, designFlowM3h: 20, position: '单元立管', createdAt: stamp(-279), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'vv-5', buildingId: 'bd-3', stationId: 'st-1', code: 'BL-7-01', dn: 50, currentOpening: 60, designFlowM3h: 22, position: '楼栋总阀', createdAt: stamp(-278), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'vv-6', buildingId: 'bd-3', stationId: 'st-1', code: 'BL-7-02', dn: 40, currentOpening: 35, designFlowM3h: 14, position: '单元立管', createdAt: stamp(-278), updatedAt: stamp(-3), revision: ROW_REVISION },
  { id: 'vv-7', buildingId: 'bd-4', stationId: 'st-2', code: 'BL-A-01', dn: 80, currentOpening: 70, designFlowM3h: 48, position: '楼栋总阀', createdAt: stamp(-260), updatedAt: stamp(-11), revision: ROW_REVISION },
  { id: 'vv-8', buildingId: 'bd-4', stationId: 'st-2', code: 'BL-A-02', dn: 50, currentOpening: 70, designFlowM3h: 22, position: '单元立管', createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'vv-9', buildingId: 'bd-5', stationId: 'st-2', code: 'BL-B-01', dn: 65, currentOpening: 50, designFlowM3h: 30, position: '楼栋总阀', createdAt: stamp(-259), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'vv-10', buildingId: 'bd-5', stationId: 'st-2', code: 'BL-B-02', dn: 50, currentOpening: 30, designFlowM3h: 18, position: '单元立管', createdAt: stamp(-259), updatedAt: stamp(-1), revision: ROW_REVISION }
]

function mkMeasure(
  id: string,
  valveId: string,
  dayOffset: number,
  flowM3h: number,
  supply: number,
  back: number,
  room: number,
  operator: string
): MeasureRow {
  return {
    id,
    valveId,
    date: new Date(SEED_STAMP + dayOffset * 86400000).toISOString().slice(0, 10),
    flowM3h,
    supplyTempC: supply,
    returnTempC: back,
    roomTempC: room,
    operator,
    createdAt: stamp(dayOffset),
    updatedAt: stamp(dayOffset),
    revision: ROW_REVISION
  }
}

const SEED_MEASURES: MeasureRow[] = [
  // vv-1：派单(-16) → 执行(-12) → 执行后复测(-8) → 已复核
  mkMeasure('ms-1-1', 'vv-1', -16, 17.8, 53, 41, 18.9, '王海'),
  mkMeasure('ms-1-2', 'vv-1', -12, 18.2, 52, 40, 19.2, '王海'),
  mkMeasure('ms-1-3', 'vv-1', -8, 30.7, 51, 39.5, 20.4, '王海'),
  mkMeasure('ms-2-1', 'vv-2', -16, 11.9, 53, 41, 20.3, '王海'),
  mkMeasure('ms-2-2', 'vv-2', -2, 12.4, 51, 39.5, 20.6, '王海'),
  mkMeasure('ms-3-1', 'vv-3', -15, 36.2, 52, 40, 20.4, '李强'),
  mkMeasure('ms-3-2', 'vv-3', -1, 38.8, 50, 39, 21.2, '李强'),
  mkMeasure('ms-4-1', 'vv-4', -15, 23.1, 52, 40, 22.1, '李强'),
  mkMeasure('ms-4-2', 'vv-4', -1, 24.6, 50, 39, 22.6, '李强'),
  mkMeasure('ms-5-1', 'vv-5', -15, 14.4, 52, 40, 18.8, '赵明'),
  mkMeasure('ms-5-2', 'vv-5', -9, 14.8, 51, 39, 19.0, '赵明'),
  // vv-7：派单(-13) → 执行(-12) → 已复核；之后补录的 -1 实测不改变历史结论，当前排行已平衡
  mkMeasure('ms-7-1', 'vv-7', -13, 54.2, 51, 39, 21.1, '孙倩'),
  mkMeasure('ms-7-2', 'vv-7', -12, 55.0, 50, 38.5, 21.3, '孙倩'),
  mkMeasure('ms-7-3', 'vv-7', -10, 47.5, 49, 38, 20.1, '孙倩'),
  mkMeasure('ms-7-4', 'vv-7', -1, 48.6, 49, 38, 20.0, '孙倩'),
  mkMeasure('ms-8-1', 'vv-8', -13, 17.6, 51, 39, 19.2, '孙倩'),
  mkMeasure('ms-8-2', 'vv-8', -1, 18.2, 49, 38, 19.5, '孙倩'),
  mkMeasure('ms-9-1', 'vv-9', -12, 21.4, 50, 38, 18.6, '孙倩'),
  mkMeasure('ms-9-2', 'vv-9', -1, 22.1, 49, 37.5, 18.8, '孙倩'),
  mkMeasure('ms-10-1', 'vv-10', -12, 21.8, 50, 38, 23.0, '王海'),
  mkMeasure('ms-10-2', 'vv-10', -1, 22.6, 49, 37.5, 23.4, '王海')
]

/** 播种用：按实测 id 冻结快照，可覆盖开度（执行前开度）与冻结时刻 */
function seedSnapshot(args: {
  valveId: string
  measureId: string
  valveOpening?: number
  frozenAt?: number
}): MeasureSnapshot {
  const valve = SEED_VALVES.find((item) => item.id === args.valveId)
  const measure = SEED_MEASURES.find((item) => item.id === args.measureId)
  if (!valve || !measure) throw new Error('播种快照缺少阀门或实测')
  const snapshot = buildSnapshot({
    valve: { ...valve, currentOpening: args.valveOpening ?? valve.currentOpening },
    measure,
    frozenAt: args.frozenAt
  })
  if (!snapshot) throw new Error('播种快照构造失败')
  return snapshot
}

const SEED_ADJUSTS: AdjustRow[] = [
  // vv-1：完整闭环。派单依据 -16 旧实测（60% 开度），执行时 60→55 并冻结 -12 实测，复核认 -8 新采集
  {
    id: 'aj-1',
    valveId: 'vv-1',
    targetOpening: 55,
    basis: '3号楼 BL-3-01 流量比 0.56 明显偏小，开度由 60% 调至 55% 后复测（注：依据为派单时冻结快照，不随后续修改变化）',
    executor: '王海',
    state: '已复核',
    reviewNote: '执行后新测（11-12 之后）流量比回升至 0.96，室温 20.4℃，合格',
    basisSnapshot: seedSnapshot({ valveId: 'vv-1', measureId: 'ms-1-1', valveOpening: 60, frozenAt: stamp(-14) }),
    executionSnapshot: seedSnapshot({ valveId: 'vv-1', measureId: 'ms-1-2', valveOpening: 60, frozenAt: stamp(-12) }),
    executedAt: stamp(-12),
    invalidateReason: '',
    reviewHistory: [],
    createdAt: stamp(-14),
    updatedAt: stamp(-6),
    revision: ROW_REVISION
  },
  // vv-5：已调节待复核，执行冻结 -9 实测；复核前需有执行后新采集
  {
    id: 'aj-2',
    valveId: 'vv-5',
    targetOpening: 60,
    basis: '7号楼 BL-7-01 流量比 0.65 偏小，建议开度由 40% 调至 60%',
    executor: '赵明',
    state: '已调节',
    reviewNote: '',
    basisSnapshot: seedSnapshot({ valveId: 'vv-5', measureId: 'ms-5-1', valveOpening: 40, frozenAt: stamp(-9) }),
    executionSnapshot: seedSnapshot({ valveId: 'vv-5', measureId: 'ms-5-2', valveOpening: 40, frozenAt: stamp(-4) }),
    executedAt: stamp(-4),
    invalidateReason: '',
    reviewHistory: [],
    createdAt: stamp(-9),
    updatedAt: stamp(-4),
    revision: ROW_REVISION
  },
  // vv-9：待下发，仅有派单快照，执行时会重新冻结
  {
    id: 'aj-3',
    valveId: 'vv-9',
    targetOpening: 62,
    basis: 'B座 BL-B-01 流量比 0.71 偏小，建议增大开度',
    executor: '孙倩',
    state: '待下发',
    reviewNote: '',
    basisSnapshot: seedSnapshot({ valveId: 'vv-9', measureId: 'ms-9-2', valveOpening: 50, frozenAt: stamp(-3) }),
    executionSnapshot: null,
    executedAt: null,
    invalidateReason: '',
    reviewHistory: [],
    createdAt: stamp(-3),
    updatedAt: stamp(-3),
    revision: ROW_REVISION
  },
  // vv-4：待下发
  {
    id: 'aj-4',
    valveId: 'vv-4',
    targetOpening: 50,
    basis: '5号楼 BL-5-02 流量比 1.23 偏大，需关小阀门',
    executor: '李强',
    state: '待下发',
    reviewNote: '',
    basisSnapshot: seedSnapshot({ valveId: 'vv-4', measureId: 'ms-4-2', valveOpening: 55, frozenAt: stamp(-2) }),
    executionSnapshot: null,
    executedAt: null,
    invalidateReason: '',
    reviewHistory: [],
    createdAt: stamp(-2),
    updatedAt: stamp(-2),
    revision: ROW_REVISION
  },
  // vv-7：复核后引用实测被修改 → 退回待复测，原结论归档仍可查看
  {
    id: 'aj-5',
    valveId: 'vv-7',
    targetOpening: 70,
    basis: 'A座 BL-A-01 流量比 1.13 偏大，开度由 85% 关至 70%',
    executor: '孙倩',
    state: '待复测',
    reviewNote: '',
    basisSnapshot: seedSnapshot({ valveId: 'vv-7', measureId: 'ms-7-1', valveOpening: 85, frozenAt: stamp(-13) }),
    executionSnapshot: seedSnapshot({ valveId: 'vv-7', measureId: 'ms-7-2', valveOpening: 85, frozenAt: stamp(-12) }),
    executedAt: stamp(-12),
    invalidateReason:
      '执行后复测记录（BL-A-01 2024-11-10）于 2024-11-20 08:30 被修改，原复核依据失效，阀门退回待复测，原结论已归档',
    reviewHistory: [
      {
        note: '复核时流量比 0.99、室温 20.1℃，判定合格闭环',
        reviewedAt: stamp(-9),
        reviewSnapshot: seedSnapshot({ valveId: 'vv-7', measureId: 'ms-7-3', valveOpening: 70, frozenAt: stamp(-9) })
      }
    ] as ReviewArchive[],
    createdAt: stamp(-13),
    updatedAt: stamp(0),
    revision: ROW_REVISION
  }
]

export async function seedDatabase(): Promise<void> {
  await db.transaction('rw', db.stations, db.buildings, db.valves, db.measures, db.adjusts, async () => {
    await db.stations.bulkPut(SEED_STATIONS)
    await db.buildings.bulkPut(SEED_BUILDINGS)
    await db.valves.bulkPut(SEED_VALVES)
    await db.measures.bulkPut(SEED_MEASURES)
    await db.adjusts.bulkPut(SEED_ADJUSTS)
  })
}

/** 首屏调用：打开数据库并在主表为空时播种演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.stations.count()) === 0) {
    await seedDatabase()
  }
}

/* ============================== 级联删除 ============================== */

export async function deleteStationCascade(stationId: string): Promise<void> {
  await db.transaction('rw', db.stations, db.buildings, db.valves, db.measures, db.adjusts, async () => {
    const buildings = await db.buildings.where('stationId').equals(stationId).toArray()
    await deleteValvesOfBuildings(buildings.map((item) => item.id))
    if (buildings.length > 0) await db.buildings.bulkDelete(buildings.map((item) => item.id))
    await db.stations.delete(stationId)
  })
}

export async function deleteBuildingCascade(buildingId: string): Promise<void> {
  await db.transaction('rw', db.buildings, db.valves, db.measures, db.adjusts, async () => {
    await deleteValvesOfBuildings([buildingId])
    await db.buildings.delete(buildingId)
  })
}

export async function deleteValveCascade(valveId: string): Promise<void> {
  await db.transaction('rw', db.valves, db.measures, db.adjusts, async () => {
    await db.measures.where('valveId').equals(valveId).delete()
    await db.adjusts.where('valveId').equals(valveId).delete()
    await db.valves.delete(valveId)
  })
}

async function deleteValvesOfBuildings(buildingIds: string[]): Promise<void> {
  if (buildingIds.length === 0) return
  const valves = await db.valves.where('buildingId').anyOf(buildingIds).toArray()
  const valveIds = valves.map((valve) => valve.id)
  if (valveIds.length > 0) {
    await db.measures.where('valveId').anyOf(valveIds).delete()
    await db.adjusts.where('valveId').anyOf(valveIds).delete()
    await db.valves.bulkDelete(valveIds)
  }
}

/* ====================== 调节单执行 / 复核 / 失效（事务） ====================== */

export interface AdjustExecutionResult {
  executed: number
  /** 无最新实测、无法冻结执行依据而跳过的调节单 */
  skippedNoMeasure: AdjustRow[]
}

/**
 * 整批执行：逐张冻结当时实测与阀门开度并回写目标开度。
 * 整个过程在单个读写事务内，任一步骤写入失败则全部回滚，
 * 已调整的阀门开度随事务恢复为执行前数值；未完成单据保留「待下发」可重试。
 */
export async function bulkExecuteAdjusts(adjustIds: string[]): Promise<AdjustExecutionResult> {
  const skipped: AdjustRow[] = []
  let executedCount = 0
  try {
    await db.transaction('rw', db.adjusts, db.valves, db.measures, async () => {
      const adjusts = await db.adjusts.where('id').anyOf(adjustIds).toArray()
      const pending = adjusts.filter((item) => item.state === '待下发')
      const valveIds = Array.from(new Set(pending.map((item) => item.valveId)))
      const valves = valveIds.length > 0 ? await db.valves.where('id').anyOf(valveIds).toArray() : []
      const valveById = new Map(valves.map((valve) => [valve.id, valve]))
      const measures =
        valveIds.length > 0 ? await db.measures.where('valveId').anyOf(valveIds).toArray() : []

      const now = Date.now()
      const adjustUpdates: AdjustRow[] = []
      const valveUpdates = new Map<string, ValveRow>()

      for (const adjust of pending) {
        const valve = valveById.get(adjust.valveId)
        if (!valve) {
          skipped.push(adjust)
          continue
        }
        const latest = [...measures]
          .filter((item) => item.valveId === adjust.valveId)
          .sort((a, b) =>
            a.date === b.date ? b.createdAt - a.createdAt : b.date.localeCompare(a.date)
          )[0]
        if (!latest) {
          skipped.push(adjust)
          continue
        }
        const executionSnapshot = buildSnapshot({ valve, measure: latest, frozenAt: now })
        if (!executionSnapshot) {
          skipped.push(adjust)
          continue
        }
        adjustUpdates.push({
          ...adjust,
          state: '已调节',
          executionSnapshot,
          executedAt: now,
          invalidateReason: '',
          updatedAt: now,
          revision: ROW_REVISION
        })
        valveUpdates.set(valve.id, {
          ...valve,
          currentOpening: adjust.targetOpening,
          updatedAt: now,
          revision: ROW_REVISION
        })
      }

      if (adjustUpdates.length > 0) await db.adjusts.bulkPut(adjustUpdates)
      if (valveUpdates.size > 0) await db.valves.bulkPut([...valveUpdates.values()])
      executedCount = adjustUpdates.length
    })
    return { executed: executedCount, skippedNoMeasure: skipped }
  } catch (error) {
    // 事务已整体回滚；此处显式恢复本次阀门开度作为二次保障，未完成单据维持待下发可重试
    await restoreValveOpenings(adjustIds)
    throw error
  }
}

/** 失败恢复：把本批涉及阀门的开度恢复到各调节单执行前快照（basisSnapshot.valveOpening） */
export async function restoreValveOpenings(adjustIds: string[]): Promise<void> {
  try {
    const adjusts = await db.adjusts.where('id').anyOf(adjustIds).toArray()
    const valves = await db.valves.toArray()
    const valveById = new Map(valves.map((valve) => [valve.id, valve]))
    const now = Date.now()
    const restores: ValveRow[] = []
    adjusts.forEach((adjust) => {
      const valve = valveById.get(adjust.valveId)
      const opening = adjust.basisSnapshot?.valveOpening
      if (valve && typeof opening === 'number' && valve.currentOpening !== opening) {
        restores.push({ ...valve, currentOpening: opening, updatedAt: now, revision: ROW_REVISION })
      }
    })
    if (restores.length > 0) await db.valves.bulkPut(restores)
  } catch {
    // 恢复尽力而为，事务回滚已保证一致性
  }
}

/**
 * 复核闭环：只认执行后新采集的实测。
 * 无执行后新数据时抛出错误（拒绝用旧数据复核）。
 */
export async function reviewAdjustWithNewMeasure(args: {
  adjustId: string
  note: string
  findReviewSnapshot: (valveId: string, executedAt: number) => MeasureSnapshot | null
}): Promise<void> {
  await db.transaction('rw', db.adjusts, async () => {
    const adjust = await db.adjusts.get(args.adjustId)
    if (!adjust) throw new Error('调节单不存在')
    if (adjust.state !== '已调节' && adjust.state !== '待复测') {
      throw new Error('当前状态不可复核')
    }
    if (adjust.executedAt === null) throw new Error('该调节单尚未执行，无执行时间可比对')
    const snapshot = args.findReviewSnapshot(adjust.valveId, adjust.executedAt)
    if (!snapshot) {
      throw new Error('执行后尚无新采集的实测数据，请先补测再复核（复核不认可执行前旧数据）')
    }
    const now = Date.now()
    const history =
      adjust.state === '待复测' && adjust.reviewNote
        ? archiveReview(adjust.reviewHistory, adjust.reviewNote, adjust.executionSnapshot, now)
        : adjust.reviewHistory
    await db.adjusts.put({
      ...adjust,
      state: '已复核',
      reviewNote: args.note.trim() || '复核合格',
      reviewHistory: history,
      invalidateReason: '',
      executionSnapshot: snapshot,
      executedAt: adjust.executedAt,
      updatedAt: now,
      revision: ROW_REVISION
    })
  })
}

/**
 * 实测被修改/删除后的失效联动：
 * 非「待下发」且冻结快照引用该实测的调节单一律退回「待复测」，
 * 已复核单据的原结论归档到 reviewHistory 并写明原因，原结论仍可查看。
 * 待下发单据不受影响（执行时会重新冻结）。
 */
export async function invalidateAdjustsForMeasure(args: {
  measureId: string
  valveId: string
  /** 编辑时若改了所属阀门，同时检查原阀门与新阀门的引用 */
  extraValveIds?: string[]
  kind: 'modify' | 'delete'
  snapshotDate: string
  valveCode: string
}): Promise<number> {
  return await db.transaction('rw', db.adjusts, async () => {
    const valveIds = Array.from(new Set([args.valveId, ...(args.extraValveIds ?? [])]))
    const related =
      valveIds.length > 0 ? await db.adjusts.where('valveId').anyOf(valveIds).toArray() : []
    const now = Date.now()
    const reason = invalidateReasonText(args.kind, args.snapshotDate, args.valveCode)
    const updates: AdjustRow[] = []
    related.forEach((adjust) => {
      if (adjust.state === '待下发') return
      const refs = [adjust.basisSnapshot?.measureId, adjust.executionSnapshot?.measureId]
      if (!refs.includes(args.measureId)) return
      const reviewHistory =
        adjust.state === '已复核' && adjust.reviewNote
          ? archiveReview(adjust.reviewHistory, adjust.reviewNote, adjust.executionSnapshot, now)
          : adjust.reviewHistory
      updates.push({
        ...adjust,
        state: '待复测',
        reviewNote: '',
        reviewHistory,
        invalidateReason: reason,
        updatedAt: now,
        revision: ROW_REVISION
      })
    })
    if (updates.length > 0) await db.adjusts.bulkPut(updates)
    return updates.length
  })
}

/* ============================ 整库导入导出 ============================ */

export async function countAll(): Promise<Record<string, number>> {
  const [stations, buildings, valves, measures, adjusts] = await Promise.all([
    db.stations.count(),
    db.buildings.count(),
    db.valves.count(),
    db.measures.count(),
    db.adjusts.count()
  ])
  return { stations, buildings, valves, measures, adjusts }
}

export async function exportSnapshot(): Promise<BackupPayload> {
  const [stations, buildings, valves, measures, adjusts] = await Promise.all([
    db.stations.toArray(),
    db.buildings.toArray(),
    db.valves.toArray(),
    db.measures.toArray(),
    db.adjusts.toArray()
  ])
  const strip = <T extends Revisioned>(row: T): Omit<T, 'revision'> => {
    const { revision: _revision, ...rest } = row
    return rest
  }
  return {
    app: 'gbheatgrid',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    stations: stations.map(strip),
    buildings: buildings.map(strip),
    valves: valves.map(strip),
    measures: measures.map(strip),
    adjusts: adjusts.map(strip)
  }
}

export async function importSnapshot(payload: BackupPayload): Promise<void> {
  await db.transaction('rw', db.stations, db.buildings, db.valves, db.measures, db.adjusts, async () => {
    await Promise.all([
      db.stations.clear(),
      db.buildings.clear(),
      db.valves.clear(),
      db.measures.clear(),
      db.adjusts.clear()
    ])
    const rev = <T>(row: T): T & Revisioned => ({ ...row, revision: ROW_REVISION })
    await db.stations.bulkPut((payload.stations ?? []).map(rev))
    await db.buildings.bulkPut((payload.buildings ?? []).map(rev))
    await db.valves.bulkPut((payload.valves ?? []).map(rev))
    await db.measures.bulkPut((payload.measures ?? []).map(rev))
    // 兼容旧版备份：调节单补齐冻结快照相关字段（缺失即为 null / 空）
    const adjusts = (payload.adjusts ?? []).map((row) =>
      rev({
        ...{
          basisSnapshot: null,
          executionSnapshot: null,
          executedAt: row.state === '待下发' ? null : row.updatedAt ?? null,
          invalidateReason: '',
          reviewHistory: []
        },
        ...row
      })
    )
    await db.adjusts.bulkPut(adjusts)
  })
}

export async function clearAllTables(): Promise<void> {
  await db.transaction('rw', db.stations, db.buildings, db.valves, db.measures, db.adjusts, async () => {
    await Promise.all([
      db.stations.clear(),
      db.buildings.clear(),
      db.valves.clear(),
      db.measures.clear(),
      db.adjusts.clear()
    ])
  })
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

/* ============================ 本地 UI 偏好 ============================ */

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastStationId: typeof parsed.lastStationId === 'string' ? parsed.lastStationId : null,
      onlyImbalanced: parsed.onlyImbalanced === true
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
}

export function stampDbVersion(): void {
  localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
}

export function readStampedDbVersion(): number {
  const parsed = Number(localStorage.getItem(LS_KEYS.dbVersion))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
}

export function stampBackupTime(iso: string): void {
  localStorage.setItem(LS_KEYS.lastBackupAt, iso)
}

export function readLastBackupAt(): string | null {
  return localStorage.getItem(LS_KEYS.lastBackupAt)
}
