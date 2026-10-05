/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号 + upgrade 迁移
 * - 级联删除、整库导入导出、首屏幂等播种
 * - v3：调节单冻结派单/执行/复核快照；旧依据实测改动后单据退回待复测
 */
import Dexie, { type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Building } from '@/types/building'
import type { Valve } from '@/types/valve'
import type { Measure } from '@/types/measure'
import { isInvalidatableState, type Adjust, type AdjustState, type MeasureSnapshot } from '@/types/adjust'
import { buildMeasureSnapshot, findReviewMeasure } from '@/utils/balance'

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
    this.version(2)
      .stores({
        stations: 'id, name, commissionYear, updatedAt',
        buildings: 'id, stationId, name, heatMode, updatedAt',
        valves: 'id, buildingId, stationId, code, position, updatedAt',
        measures: 'id, valveId, date, operator, updatedAt',
        adjusts: 'id, valveId, state, executor, updatedAt'
      })
      .upgrade(async (tx) => {
        const buildings = (await tx.table('buildings').toArray()) as Array<{ id: string; stationId: string }>
        const stationOfBuilding = new Map(buildings.map((item) => [item.id, item.stationId]))

        await tx
          .table('valves')
          .toCollection()
          .modify((valve: Record<string, unknown>) => {
            valve.revision = ROW_REVISION
            if (typeof valve.stationId !== 'string' || valve.stationId.length === 0) {
              valve.stationId = stationOfBuilding.get(String(valve.buildingId)) ?? ''
            }
            if (typeof valve.currentOpening !== 'number' || !Number.isFinite(valve.currentOpening)) {
              valve.currentOpening = 50
            }
          })

        for (const name of ['stations', 'buildings', 'measures', 'adjusts']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
            })
        }

        await tx
          .table('adjusts')
          .toCollection()
          .modify((adjust: Record<string, unknown>) => {
            if (typeof adjust.reviewNote !== 'string') adjust.reviewNote = ''
            if (adjust.state !== '待下发' && adjust.state !== '已调节' && adjust.state !== '已复核') {
              adjust.state = '待下发'
            }
          })
      })

    // v3：调节单与实测分离——冻结派单/执行/复核快照，新增「待复测」状态
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, commissionYear, updatedAt',
        buildings: 'id, stationId, name, heatMode, updatedAt',
        valves: 'id, buildingId, stationId, code, position, updatedAt',
        measures: 'id, valveId, date, operator, updatedAt',
        adjusts: 'id, valveId, state, executor, updatedAt'
      })
      .upgrade(async (tx) => {
        const valves = (await tx.table('valves').toArray()) as ValveRow[]
        const measures = (await tx.table('measures').toArray()) as MeasureRow[]
        const valveById = new Map(valves.map((valve) => [valve.id, valve]))
        const latestByValve = new Map<string, MeasureRow>()
        ;[...measures]
          .sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt ?? 0) - (b.createdAt ?? 0))
          .forEach((measure) => latestByValve.set(measure.valveId, measure))

        await tx
          .table('adjusts')
          .toCollection()
          .modify((raw: Record<string, unknown>) => {
            const state = String(raw.state ?? '待下发') as AdjustState
            const valve = valveById.get(String(raw.valveId))
            const executed = state === '已调节' || state === '已复核'
            const executedAt =
              typeof raw.executedAt === 'number'
                ? raw.executedAt
                : executed
                  ? typeof raw.updatedAt === 'number'
                    ? raw.updatedAt
                    : Date.now()
                  : null
            const latest = valve ? latestByValve.get(valve.id) ?? null : null
            const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : Date.now()

            if (!raw.basisSnapshot && valve && latest) {
              raw.basisSnapshot = buildMeasureSnapshot({ measure: latest, valve }, createdAt)
            } else if (!raw.basisSnapshot) {
              raw.basisSnapshot = null
            }
            if (raw.beforeOpening === undefined) {
              raw.beforeOpening = executed && valve ? valve.currentOpening : null
            }
            if (raw.executedAt === undefined) raw.executedAt = executedAt
            if (!raw.reviewSnapshot && state === '已复核' && valve && latest && executedAt !== null) {
              raw.reviewSnapshot = buildMeasureSnapshot({ measure: latest, valve }, executedAt)
            } else if (!raw.reviewSnapshot) {
              raw.reviewSnapshot = null
            }
            if (raw.reviewMeasureId === undefined) {
              raw.reviewMeasureId = raw.reviewSnapshot
                ? (raw.reviewSnapshot as MeasureSnapshot).measureId
                : null
            }
            if (!Array.isArray(raw.reviewHistory)) {
              raw.reviewHistory =
                state === '已复核' && raw.reviewSnapshot
                  ? [
                      {
                        note: typeof raw.reviewNote === 'string' && raw.reviewNote ? raw.reviewNote : '复核合格',
                        at: executedAt ?? Date.now(),
                        snapshot: raw.reviewSnapshot
                      }
                    ]
                  : []
            }
            if (typeof raw.invalidReason !== 'string') raw.invalidReason = ''
            if (raw.invalidatedAt === undefined) raw.invalidatedAt = null
            if (raw.invalidFromState === undefined) raw.invalidFromState = null
          })
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

// currentOpening 已反映已执行调节单的回写结果（执行前开度冻结在调节单 beforeOpening 上）
const SEED_VALVES: ValveRow[] = [
  { id: 'vv-1', buildingId: 'bd-1', stationId: 'st-1', code: 'BL-3-01', dn: 65, currentOpening: 55, designFlowM3h: 32, position: '楼栋总阀', createdAt: stamp(-280), updatedAt: stamp(-10), revision: ROW_REVISION },
  { id: 'vv-2', buildingId: 'bd-1', stationId: 'st-1', code: 'BL-3-02', dn: 50, currentOpening: 45, designFlowM3h: 18, position: '单元立管', createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'vv-3', buildingId: 'bd-2', stationId: 'st-1', code: 'BL-5-01', dn: 65, currentOpening: 75, designFlowM3h: 35, position: '楼栋总阀', createdAt: stamp(-279), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'vv-4', buildingId: 'bd-2', stationId: 'st-1', code: 'BL-5-02', dn: 50, currentOpening: 55, designFlowM3h: 20, position: '单元立管', createdAt: stamp(-279), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'vv-5', buildingId: 'bd-3', stationId: 'st-1', code: 'BL-7-01', dn: 50, currentOpening: 60, designFlowM3h: 22, position: '楼栋总阀', createdAt: stamp(-278), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'vv-6', buildingId: 'bd-3', stationId: 'st-1', code: 'BL-7-02', dn: 40, currentOpening: 35, designFlowM3h: 14, position: '单元立管', createdAt: stamp(-278), updatedAt: stamp(-3), revision: ROW_REVISION },
  { id: 'vv-7', buildingId: 'bd-4', stationId: 'st-2', code: 'BL-A-01', dn: 80, currentOpening: 85, designFlowM3h: 48, position: '楼栋总阀', createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'vv-8', buildingId: 'bd-4', stationId: 'st-2', code: 'BL-A-02', dn: 50, currentOpening: 70, designFlowM3h: 22, position: '单元立管', createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'vv-9', buildingId: 'bd-5', stationId: 'st-2', code: 'BL-B-01', dn: 65, currentOpening: 50, designFlowM3h: 30, position: '楼栋总阀', createdAt: stamp(-259), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'vv-10', buildingId: 'bd-5', stationId: 'st-2', code: 'BL-B-02', dn: 50, currentOpening: 25, designFlowM3h: 18, position: '单元立管', createdAt: stamp(-259), updatedAt: stamp(-7), revision: ROW_REVISION }
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
  mkMeasure('ms-1-1', 'vv-1', -16, 17.8, 53, 41, 18.9, '王海'),
  // vv-1 执行后新采集：流量比回到 0.95、室温达标，作为复核依据
  mkMeasure('ms-1-2', 'vv-1', -2, 30.5, 51, 39.5, 20.4, '王海'),
  mkMeasure('ms-2-1', 'vv-2', -16, 11.9, 53, 41, 20.3, '王海'),
  mkMeasure('ms-2-2', 'vv-2', -2, 12.4, 51, 39.5, 20.6, '王海'),
  mkMeasure('ms-3-1', 'vv-3', -15, 36.2, 52, 40, 20.4, '李强'),
  mkMeasure('ms-3-2', 'vv-3', -1, 38.8, 50, 39, 21.2, '李强'),
  mkMeasure('ms-4-1', 'vv-4', -15, 23.1, 52, 40, 22.1, '李强'),
  mkMeasure('ms-4-2', 'vv-4', -1, 24.6, 50, 39, 22.6, '李强'),
  mkMeasure('ms-5-1', 'vv-5', -15, 14.4, 52, 40, 18.8, '赵明'),
  // vv-5 已调节（stamp -4），此条为执行后新采集，可用于复核
  mkMeasure('ms-5-2', 'vv-5', -1, 21.2, 50, 38.5, 20.1, '赵明'),
  mkMeasure('ms-6-1', 'vv-6', -14, 13.4, 52, 40, 19.9, '赵明'),
  mkMeasure('ms-6-2', 'vv-6', -1, 13.9, 50, 38.5, 20.1, '赵明'),
  mkMeasure('ms-7-1', 'vv-7', -13, 54.2, 51, 39, 21.1, '孙倩'),
  mkMeasure('ms-7-2', 'vv-7', -1, 56.4, 49, 38, 21.8, '孙倩'),
  mkMeasure('ms-8-1', 'vv-8', -13, 17.6, 51, 39, 19.2, '孙倩'),
  mkMeasure('ms-8-2', 'vv-8', -1, 18.2, 49, 38, 19.5, '孙倩'),
  mkMeasure('ms-9-1', 'vv-9', -12, 21.4, 50, 38, 18.6, '孙倩'),
  mkMeasure('ms-9-2', 'vv-9', -1, 22.1, 49, 37.5, 18.8, '孙倩'),
  mkMeasure('ms-10-1', 'vv-10', -12, 21.8, 50, 38, 23.0, '王海'),
  // vv-10 原复核依据，演示「旧记录改动 → 原复核失效退回待复测」
  mkMeasure('ms-10-2', 'vv-10', -1, 22.6, 49, 37.5, 23.4, '王海')
]

/** 播种调节单规格：快照由本模块按阀门/实测冻结生成，保证与单据分离保存 */
interface SeedAdjustSpec {
  id: string
  valveId: string
  targetOpening: number
  basis: string
  executor: string
  state: AdjustState
  reviewNote: string
  createdOffset: number
  updatedOffset: number
  /** 派单依据实测 id */
  basisMeasureId: string | null
  /** 执行前开度；未执行为 null */
  beforeOpening: number | null
  executedOffset: number | null
  /** 复核实测 id 与复核时间 */
  reviewMeasureId?: string | null
  reviewOffset?: number | null
  invalidReason?: string
  invalidOffset?: number | null
}

function seedAdjust(spec: SeedAdjustSpec): AdjustRow {
  const valve = SEED_VALVES.find((item) => item.id === spec.valveId)
  const basisMeasure = spec.basisMeasureId
    ? SEED_MEASURES.find((item) => item.id === spec.basisMeasureId) ?? null
    : null
  const basisValve =
    valve && spec.beforeOpening !== null ? { ...valve, currentOpening: spec.beforeOpening } : valve
  const basisSnapshot =
    basisValve && basisMeasure
      ? buildMeasureSnapshot({ measure: basisMeasure, valve: basisValve }, stamp(spec.createdOffset))
      : null
  const reviewMeasure = spec.reviewMeasureId
    ? SEED_MEASURES.find((item) => item.id === spec.reviewMeasureId) ?? null
    : null
  // 复核冻结尾核：用执行后新采集实测 + 执行后开度（目标开度）
  const reviewValve = valve && spec.executedOffset !== null ? { ...valve, currentOpening: spec.targetOpening } : valve
  const reviewSnapshot =
    reviewValve && reviewMeasure && spec.reviewOffset !== null && spec.reviewOffset !== undefined
      ? buildMeasureSnapshot({ measure: reviewMeasure, valve: reviewValve }, stamp(spec.reviewOffset))
      : null
  const reviewHistory =
    reviewSnapshot
      ? [{ note: spec.reviewNote || '复核合格', at: stamp(spec.reviewOffset ?? spec.updatedOffset), snapshot: reviewSnapshot }]
      : []

  return {
    id: spec.id,
    valveId: spec.valveId,
    targetOpening: spec.targetOpening,
    basis: spec.basis,
    executor: spec.executor,
    state: spec.state,
    reviewNote: spec.reviewNote,
    basisSnapshot,
    beforeOpening: spec.beforeOpening,
    executedAt: spec.executedOffset !== null ? stamp(spec.executedOffset) : null,
    reviewSnapshot,
    reviewMeasureId: reviewMeasure ? reviewMeasure.id : null,
    reviewHistory,
    invalidReason: spec.invalidReason ?? '',
    invalidatedAt: spec.invalidOffset !== null && spec.invalidOffset !== undefined ? stamp(spec.invalidOffset) : null,
    invalidFromState: spec.invalidReason ? '已复核' : null,
    createdAt: stamp(spec.createdOffset),
    updatedAt: stamp(spec.updatedOffset),
    revision: ROW_REVISION
  }
}

const SEED_ADJUSTS: AdjustRow[] = [
  seedAdjust({
    id: 'aj-1',
    valveId: 'vv-1',
    targetOpening: 55,
    basis: '3号楼 BL-3-01 流量比 0.56 明显偏小、室温 18.9℃，合成失衡度 32.7% 严重失衡，需增大开度补流',
    executor: '王海',
    state: '已复核',
    reviewNote: '复核后流量比回升至 0.95，室温 20.4℃，合格',
    createdOffset: -14,
    updatedOffset: -6,
    basisMeasureId: 'ms-1-1',
    beforeOpening: 60,
    executedOffset: -10,
    reviewMeasureId: 'ms-1-2',
    reviewOffset: -6
  }),
  seedAdjust({
    id: 'aj-2',
    valveId: 'vv-5',
    targetOpening: 60,
    basis: '7号楼 BL-7-01 失衡度 24.2%，楼栋整体偏小，建议开度由 40% 调至 60%',
    executor: '赵明',
    state: '已调节',
    reviewNote: '',
    createdOffset: -9,
    updatedOffset: -4,
    basisMeasureId: 'ms-5-1',
    beforeOpening: 40,
    executedOffset: -4
  }),
  seedAdjust({
    id: 'aj-3',
    valveId: 'vv-9',
    targetOpening: 62,
    basis: 'B座 BL-B-01 失衡度 20.2%，流量比 0.74 偏小',
    executor: '孙倩',
    state: '待下发',
    reviewNote: '',
    createdOffset: -3,
    updatedOffset: -3,
    basisMeasureId: 'ms-9-2',
    beforeOpening: null,
    executedOffset: null
  }),
  seedAdjust({
    id: 'aj-4',
    valveId: 'vv-4',
    targetOpening: 50,
    basis: '5号楼 BL-5-02 失衡度 20.0%，流量比 1.23 偏大，需关小阀门',
    executor: '李强',
    state: '待下发',
    reviewNote: '',
    createdOffset: -2,
    updatedOffset: -2,
    basisMeasureId: 'ms-4-2',
    beforeOpening: null,
    executedOffset: null
  }),
  seedAdjust({
    id: 'aj-5',
    valveId: 'vv-10',
    targetOpening: 25,
    basis: 'B座 BL-B-02 室温 23.0℃ 偏高，建议开度由 30% 关小至 25%',
    executor: '王海',
    state: '待复测',
    reviewNote: '原复核：室温 23.4℃ 偏高但可接受，同意闭环',
    createdOffset: -8,
    updatedOffset: -1,
    basisMeasureId: 'ms-10-1',
    beforeOpening: 30,
    executedOffset: -7,
    reviewMeasureId: 'ms-10-2',
    reviewOffset: -6,
    invalidReason: '原复核依据实测 ms-10-2（2024-11-19）被修改，数据口径已变化，原复核结论失效，请重新采集后复测',
    invalidOffset: -1
  })
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

/* ====================== 旧依据实测改动 → 复核失效联动 ====================== */

export interface MeasureChange {
  /** 被修改/删除的实测记录 id */
  measureId: string
  /** 该实测原所属阀门（删除传原 valveId） */
  valveId: string
  /** 编辑后改挂到的新阀门 id；未改阀门或删除时与 valveId 相同 */
  nextValveId?: string
  action: '修改' | '删除'
  date: string
}

/**
 * 旧记录修改/删除后原复核失效：
 * - 单据冻结快照（派单依据 / 复核实测）直接引用该记录的，一律退回待复测；
 * - 同阀门且该记录仍是执行后最新一条实测的（复核口径随之变化），也退回待复测；
 * - 原复核意见与历次结论保留在 reviewNote / reviewHistory 中，仍可查看。
 * 返回受影响的调节单数量。
 */
export async function invalidateAdjustsForMeasure(change: MeasureChange): Promise<number> {
  let affected = 0
  await db.transaction('rw', db.measures, db.adjusts, async () => {
    const adjusts = await db.adjusts.toArray()
    const measures = await db.measures.toArray()
    const now = Date.now()
    const targets = adjusts.filter((adjust) => {
      if (!isInvalidatableState(adjust.state)) return false
      const referenced =
        adjust.basisSnapshot?.measureId === change.measureId ||
        adjust.reviewMeasureId === change.measureId ||
        adjust.reviewSnapshot?.measureId === change.measureId
      if (referenced) return true
      const valveIds = new Set(
        [change.valveId, change.nextValveId].filter((id): id is string => typeof id === 'string' && id.length > 0)
      )
      if (adjust.executedAt === null || !valveIds.has(adjust.valveId)) return false
      const latestPost = findReviewMeasure(measures, adjust.valveId, adjust.executedAt)
      return latestPost?.id === change.measureId
    })
    for (const adjust of targets) {
      const stage = adjust.state === '已复核' ? '复核' : '调节'
      await db.adjusts.update(adjust.id, {
        state: '待复测',
        invalidFromState: adjust.state,
        invalidReason: `${change.action}实测 ${change.date} 后原${stage}依据失效，阀门退回待复测，请重新采集执行后数据再复核`,
        invalidatedAt: now,
        updatedAt: now
      })
      affected += 1
    }
  })
  return affected
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

/** 补齐旧版存档缺失的冻结字段 */
function normalizeAdjust(row: Partial<AdjustRow>): AdjustRow {
  return {
    id: String(row.id ?? ''),
    valveId: String(row.valveId ?? ''),
    targetOpening: typeof row.targetOpening === 'number' ? row.targetOpening : 50,
    basis: typeof row.basis === 'string' ? row.basis : '',
    executor: typeof row.executor === 'string' ? row.executor : '待指派',
    state:
      row.state === '待下发' || row.state === '已调节' || row.state === '已复核' || row.state === '待复测'
        ? row.state
        : '待下发',
    reviewNote: typeof row.reviewNote === 'string' ? row.reviewNote : '',
    basisSnapshot: row.basisSnapshot ?? null,
    beforeOpening: typeof row.beforeOpening === 'number' ? row.beforeOpening : null,
    executedAt: typeof row.executedAt === 'number' ? row.executedAt : null,
    reviewSnapshot: row.reviewSnapshot ?? null,
    reviewMeasureId: typeof row.reviewMeasureId === 'string' ? row.reviewMeasureId : null,
    reviewHistory: Array.isArray(row.reviewHistory) ? row.reviewHistory : [],
    invalidReason: typeof row.invalidReason === 'string' ? row.invalidReason : '',
    invalidatedAt: typeof row.invalidatedAt === 'number' ? row.invalidatedAt : null,
    invalidFromState:
      row.invalidFromState === '已调节' || row.invalidFromState === '已复核' ? row.invalidFromState : null,
    createdAt: typeof row.createdAt === 'number' ? row.createdAt : Date.now(),
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : Date.now(),
    revision: ROW_REVISION
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
    await db.adjusts.bulkPut((payload.adjusts ?? []).map((row) => normalizeAdjust(row as Partial<AdjustRow>)))
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
