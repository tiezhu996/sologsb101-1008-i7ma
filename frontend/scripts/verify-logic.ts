/**
 * 逻辑校验（node + tsx + fake-indexeddb），不进入 npm 脚本：
 * 1. v3 播种数据结构正确（冻结快照、状态）
 * 2. 执行冻结当时实测与执行前开度
 * 3. 复核只认执行后新采集数据
 * 4. 修改旧依据实测 → 已复核单据退回待复测，原结论保留
 * 5. 整批执行失败 → 开度恢复、单据留在待下发
 * 6. 冻结依据不随后续实测补录而改变
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert'
import { db, invalidateAdjustsForMeasure, resetDatabase } from '../src/utils/db.ts'
import { findReviewMeasure, isMeasureAfterExecution, localDateOf } from '../src/utils/balance.ts'

let passed = 0
function ok(name: string): void {
  passed += 1
  console.log(`  ✓ ${name}`)
}

async function main(): Promise<void> {
  await resetDatabase()

  /* 1. 播种结构 */
  const adjusts = await db.adjusts.toArray()
  const valves = await db.valves.toArray()
  const measures = await db.measures.toArray()
  assert.strictEqual(adjusts.length, 5, '应有 5 张播种调节单')
  const aj1 = adjusts.find((a) => a.id === 'aj-1')!
  const aj5 = adjusts.find((a) => a.id === 'aj-5')!
  assert.ok(aj1.basisSnapshot, 'aj-1 派单依据已冻结')
  assert.ok(aj1.basisSnapshot.measureId === 'ms-1-1', 'aj-1 依据指向执行前实测 ms-1-1')
  assert.strictEqual(aj1.basisSnapshot.opening, 60, 'aj-1 依据快照开度为执行前 60%')
  assert.strictEqual(aj1.beforeOpening, 60, 'aj-1 执行前开度冻结 60%')
  assert.ok(aj1.executedAt, 'aj-1 有执行时间')
  assert.ok(aj1.reviewSnapshot && aj1.reviewSnapshot.measureId === 'ms-1-2', 'aj-1 复核快照指向执行后新实测')
  assert.strictEqual(aj1.reviewHistory.length, 1, 'aj-1 有 1 条复核留痕')
  assert.strictEqual(aj5.state, '待复测', 'aj-5 处于待复测')
  assert.ok(aj5.invalidReason.length > 0, 'aj-5 有失效原因')
  assert.strictEqual(aj5.invalidFromState, '已复核', 'aj-5 由已复核退回')
  assert.ok(aj5.reviewHistory.length >= 1, 'aj-5 原复核结论仍保留')
  const vv1 = valves.find((v) => v.id === 'vv-1')!
  assert.strictEqual(vv1.currentOpening, 55, 'vv-1 当前开度已回写为 55%')
  ok('播种：派单/执行/复核快照与待复测数据齐全')

  /* 2/3. 执行与复核门控：aj-2（已调节，vv-5，有执行后实测 ms-5-2） */
  const aj2 = adjusts.find((a) => a.id === 'aj-2')!
  const reviewMeasure = findReviewMeasure(measures, 'vv-5', aj2.executedAt!)
  assert.ok(reviewMeasure, 'vv-5 存在执行后新采集实测')
  assert.strictEqual(reviewMeasure!.id, 'ms-5-2')

  // 执行时间之前的实测不算数
  const old = measures.find((m) => m.id === 'ms-5-1')!
  assert.strictEqual(isMeasureAfterExecution(old, aj2.executedAt!), false, '执行前实测不可用于复核')
  const fresh = measures.find((m) => m.id === 'ms-5-2')!
  assert.strictEqual(isMeasureAfterExecution(fresh, aj2.executedAt!), true, '执行后新实测可用于复核')
  ok('复核门控：只认执行后新采集数据')

  /* 4. 修改旧依据实测 → 已复核退回待复测，原结论保留 */
  const originalHistory = aj1.reviewHistory.length
  const ms12 = measures.find((m) => m.id === 'ms-1-2')!
  await db.measures.update('ms-1-2', { flowM3h: 999, roomTempC: 30, updatedAt: Date.now() })
  const affected = await invalidateAdjustsForMeasure({
    measureId: 'ms-1-2',
    valveId: ms12.valveId,
    action: '修改',
    date: ms12.date
  })
  assert.ok(affected >= 1, '修改复核实测至少使 1 张单据失效')
  const aj1After = await db.adjusts.get('aj-1')
  assert.strictEqual(aj1After!.state, '待复测', 'aj-1 退回待复测')
  assert.strictEqual(aj1After!.invalidFromState, '已复核')
  assert.ok(aj1After!.reviewHistory.length === originalHistory, '原复核结论仍可查看')
  assert.ok(aj1After!.reviewSnapshot, '原复核快照保留')
  assert.ok(aj1After!.invalidReason.includes('修改'))
  // 阀门开度不回退，保持执行结果
  const vv1After = await db.valves.get('vv-1')
  assert.strictEqual(vv1After!.currentOpening, 55, '退回待复测不回退阀门开度')
  ok('旧依据修改：已复核 → 待复测，原结论保留，开度保持')

  /* 5. 整批执行失败 → 开度恢复、单据留在待下发 */
  // 取两张待下发：aj-3(vv-9)、aj-4(vv-4)，记录执行前开度
  const pendingBefore = (await db.adjusts.toArray()).filter((a) => a.state === '待下发')
  assert.ok(pendingBefore.length >= 2, '至少有 2 张待下发可用于整批执行')
  const open9Before = (await db.valves.get('vv-9'))!.currentOpening
  const open4Before = (await db.valves.get('vv-4'))!.currentOpening
  const now = Date.now()

  // 模拟整批执行中途写入失败：先回写 vv-9，再在写第二张前抛错
  let threw = false
  try {
    await db.transaction('rw', db.valves, db.adjusts, async () => {
      await db.valves.update('vv-9', { currentOpening: 99, updatedAt: now })
      await db.adjusts.update(pendingBefore[0].id, { state: '已调节' })
      throw new Error('模拟中途写入失败')
    })
  } catch (err) {
    threw = true
    assert.ok((err as Error).message.includes('模拟中途写入失败'))
  }
  assert.ok(threw, '事务按预期抛错')
  // 事务原子回滚后开度恢复、单据仍待下发
  assert.strictEqual((await db.valves.get('vv-9'))!.currentOpening, open9Before, '事务回滚恢复 vv-9 开度')
  assert.strictEqual((await db.valves.get('vv-4'))!.currentOpening, open4Before, 'vv-4 开度从未被改')
  const stillPending = (await db.adjusts.toArray()).filter((a) => a.state === '待下发')
  assert.ok(stillPending.some((a) => a.id === pendingBefore[0].id), '失败单据留在待下发，可重试')
  ok('整批执行失败：事务回滚恢复开度，未完成单据留在待下发')

  // 成功路径：两张都执行
  const pendingIds = (await db.adjusts.toArray()).filter((a) => a.state === '待下发').map((a) => a.id)
  await db.transaction('rw', db.valves, db.adjusts, db.measures, async () => {
    const allMeasures = await db.measures.toArray()
    for (const id of pendingIds) {
      const adj = (await db.adjusts.get(id))!
      const valve = (await db.valves.get(adj.valveId))!
      const latest = [...allMeasures]
        .filter((m) => m.valveId === valve.id)
        .sort((a, b) => b.date.localeCompare(a.date))[0]
      await db.valves.update(valve.id, { currentOpening: adj.targetOpening })
      await db.adjusts.update(id, {
        state: '已调节',
        beforeOpening: valve.currentOpening,
        executedAt: now
      })
      void latest
    }
  })
  const afterExec = await db.adjusts.toArray()
  for (const id of pendingIds) {
    const adj = afterExec.find((a) => a.id === id)!
    const valve = await db.valves.get(adj.valveId)
    assert.strictEqual(adj.state, '已调节')
    assert.strictEqual(valve!.currentOpening, adj.targetOpening, `${id} 开度已回写为目标开度`)
  }
  ok('整批执行成功：开度全部回写、单据推进为已调节')

  /* 6. 补录新实测不改变冻结依据 */
  const aj3 = afterExec.find((a) => a.id === 'aj-3')!
  const frozenImbalance = aj3.basisSnapshot!.imbalanceValue
  await db.measures.put({
    id: 'ms-9-3',
    valveId: 'vv-9',
    date: localDateOf(Date.now()),
    flowM3h: 5,
    supplyTempC: 50,
    returnTempC: 38,
    roomTempC: 18,
    operator: '测试',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 3
  })
  const aj3Later = await db.adjusts.get('aj-3')
  assert.strictEqual(aj3Later!.basisSnapshot!.imbalanceValue, frozenImbalance, '补录实测后原签字依据失衡度不变')
  ok('补录实测：冻结依据保持不变（实测与调节单分离）')

  /* 同日但录入更晚的实测也算执行后新数据 */
  const execDate = localDateOf(aj3Later!.executedAt!)
  const sameDayLater = {
    id: 'ms-same-day',
    valveId: 'vv-9',
    date: execDate,
    createdAt: aj3Later!.executedAt! + 60000
  } as never
  assert.strictEqual(isMeasureAfterExecution(sameDayLater, aj3Later!.executedAt!), true, '同日录入更晚算执行后数据')

  console.log(`\n全部 ${passed} 项逻辑校验通过`)
  await db.close()
  await db.delete()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
