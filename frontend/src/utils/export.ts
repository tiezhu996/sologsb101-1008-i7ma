/**
 * 导出工具：整库 JSON 存档、调节单 CSV、失衡度排行 CSV、剪贴板复制
 */
import type { Station } from '@/types/station'
import type { Building } from '@/types/building'
import type { Valve } from '@/types/valve'
import type { Adjust } from '@/types/adjust'

export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function stampSuffix(): string {
  const date = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

export function exportBackupJson(payload: unknown): string {
  const filename = `gbheatgrid-backup-${stampSuffix()}.json`
  download(filename, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8')
  return filename
}

export function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function formatCsvTime(at: number | null | undefined): string {
  if (!at) return '—'
  return new Date(at).toLocaleString('zh-CN', { hour12: false })
}

/**
 * 导出调节单 CSV。
 * 依据列取派单/执行时冻结的 basisSnapshot（不随后续实测改动而变），
 * 复核列取执行后新采集冻结的 reviewSnapshot，与调节单页、失衡排行同一口径。
 */
export function exportAdjustCsv(
  stations: Station[],
  buildings: Building[],
  valves: Valve[],
  adjusts: Adjust[]
): string {
  const header = [
    '换热站',
    '楼栋',
    '供热方式',
    '阀门编号',
    '口径DN',
    '位置',
    '设计流量(m³/h)',
    '依据实测日期',
    '依据实测流量(m³/h)',
    '依据流量比',
    '依据室温(℃)',
    '依据开度(%)',
    '依据失衡度(%)',
    '判级',
    '执行前开度(%)',
    '目标开度(%)',
    '当前开度(%)',
    '执行时间',
    '执行后新采集日期',
    '新实测流量(m³/h)',
    '新流量比',
    '新室温(℃)',
    '新失衡度(%)',
    '执行人',
    '状态',
    '退回待复测原因',
    '复核意见'
  ]
  const lines: string[] = [header.map(csvCell).join(',')]
  adjusts.forEach((adjust) => {
    const valve = valves.find((item) => item.id === adjust.valveId)
    const building = valve ? buildings.find((item) => item.id === valve.buildingId) ?? null : null
    const station = building ? stations.find((item) => item.id === building.stationId) ?? null : null
    const basis = adjust.basisSnapshot
    const review = adjust.reviewSnapshot
    lines.push(
      [
        station ? station.name : '—',
        building ? building.name : '—',
        building ? building.heatMode : '—',
        valve ? valve.code : '—',
        valve ? valve.dn : '—',
        valve ? valve.position : '—',
        basis ? basis.designFlowM3h : valve ? valve.designFlowM3h : '—',
        basis && basis.measureDate ? basis.measureDate : '—',
        basis ? basis.flowM3h : '—',
        basis ? basis.ratio.toFixed(2) : '—',
        basis ? basis.roomTempC : '—',
        basis ? basis.opening : '—',
        basis ? basis.imbalanceValue : '—',
        basis ? basis.level : '—',
        adjust.beforeOpening ?? '—',
        adjust.targetOpening,
        valve ? valve.currentOpening : '—',
        formatCsvTime(adjust.executedAt),
        review && review.measureDate ? review.measureDate : '—',
        review ? review.flowM3h : '—',
        review ? review.ratio.toFixed(2) : '—',
        review ? review.roomTempC : '—',
        review ? review.imbalanceValue : '—',
        adjust.executor,
        adjust.state,
        adjust.invalidReason || '—',
        adjust.reviewNote || '—'
      ]
        .map(csvCell)
        .join(',')
    )
  })
  const filename = `调节单-${stampSuffix()}.csv`
  download(filename, `﻿${lines.join('\n')}`, 'text/csv;charset=utf-8')
  return filename
}

/** 导出失衡度排行 CSV（取全站统一的失衡排行结果） */
export function exportBalanceCsv(
  rows: Array<{
    station: Station | null
    building: Building | null
    valve: Valve
    measured: number
    ratio: number
    flowDeviation: number
    roomDeviation: number
    imbalanceValue: number
    level: string
  }>
): string {
  const header = ['换热站', '楼栋', '阀门编号', '设计流量', '实测流量', '流量比', '流量偏差(%)', '室温偏差(℃)', '失衡度(%)', '判级']
  const lines: string[] = [header.map(csvCell).join(',')]
  rows.forEach((row) => {
    lines.push(
      [
        row.station ? row.station.name : '—',
        row.building ? row.building.name : '—',
        row.valve.code,
        row.valve.designFlowM3h,
        row.measured,
        row.ratio.toFixed(2),
        row.flowDeviation.toFixed(1),
        row.roomDeviation.toFixed(1),
        row.imbalanceValue.toFixed(1),
        row.level
      ]
        .map(csvCell)
        .join(',')
    )
  })
  const filename = `失衡度排行-${stampSuffix()}.csv`
  download(filename, `﻿${lines.join('\n')}`, 'text/csv;charset=utf-8')
  return filename
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    return false
  }
  return false
}

/** 解析批量粘贴的实测数据：每行 阀门编号,日期,流量,供温,回温,室温[,操作人] */
export function parseMeasureBatch(text: string): Array<{
  code: string
  date: string
  flowM3h: number
  supplyTempC: number
  returnTempC: number
  roomTempC: number
  operator: string
}> {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const parts = line.split(/[,\t;]/).map((item) => item.trim())
      return {
        code: parts[0] ?? '',
        date: parts[1] ?? '',
        flowM3h: Number(parts[2] ?? 0),
        supplyTempC: Number(parts[3] ?? 0),
        returnTempC: Number(parts[4] ?? 0),
        roomTempC: Number(parts[5] ?? 0),
        operator: parts[6] ?? ''
      }
    })
    .filter((item) => item.code.length > 0)
}
