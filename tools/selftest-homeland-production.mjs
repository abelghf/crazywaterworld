import assert from 'node:assert/strict';
import { createHomelandHarness, createHomelandClient } from './fixtures/homeland-console.mjs';

const h = await createHomelandHarness();
const { readHomeland, executeHomeland, runHomeland } = await import('../src/homeland.mjs');
const { createActionGuard } = await import('../src/automation-policy.mjs');
const { defaultSettings, importAutomationSettings, SETTINGS_FORMAT, createUsageLedger } = await import('../src/automation-settings.mjs');
const produce = 'DualCombineProduceRequest', merge = 'DualCombineMoveRequest', submit = 'DualCombineSubmitOrderRequest';
function setup(board = ['钩1', null, null, null], goals = ['鱼3']) {
  const f = h.fixture();
  f.state.cells = board.map((pieceCfgId, cellId) => ({ cellId, state: 2,
    ...(pieceCfgId ? { piece: { uid: cellId + 100, pieceCfgId, ...(pieceCfgId === '钩2' ? { produceLeft: 2 } : {}) } } : {}) }));
  f.state.warehouse = []; f.state.stamina = 50;
  f.state.orders = [{ slot: 0, orderId: 1, reqs: goals.map(pieceCfgId => ({ pieceCfgId, count: 1 })) }];
  Object.assign(f.settings.homeland, { enabled: true, submitOrders: true, mergeOrders: true, produceOrders: true, takeWarehouse: true, warehouseBuffer: true });
  return f;
}
const read = (f, config = h.config) => readHomeland(f.client, config, f.options);
const run = (f, config = h.config) => runHomeland(f.client, config, f.options);
const nextProduction = async f => {
  const view = await read(f), action = view.actions.find(row => row.kind === 'produceOrders' && !row.reason);
  assert(action, JSON.stringify(view)); return action;
};
const send = (f, action, extra = {}) => executeHomeland(f.client, h.config, { ...f.options, ...action, ...extra,
  guard: createActionGuard(f.client, () => f.settings, f.ledger, { player: f.player, config: h.config, enabled: f.options.enabled }) });
let passed = 0;
const test = async (name, body) => { await body(); console.log('通过：' + name); passed++; };
try {
  await test('旧配置不自动启用体力消费，开启后从生产器连续生产、合成并交单', async () => {
    const old = defaultSettings(); delete old.homeland.produceOrders; delete old.homeland.keepStamina; delete old.homeland.dailyStaminaLimit;
    old.homeland.mergeOrders = true;
    const migrated = importAutomationSettings({ format: SETTINGS_FORMAT, version: 74, settings: old });
    assert.equal(migrated.homeland.produceOrders, false); assert.equal(migrated.homeland.mergeOrders, true);
    const f = setup(); f.settings.homeland.produceOrders = false;
    const preview = await read(f); assert.equal(preview.orders[0].synthesis.status, 'production');
    assert.match(preview.orders[0].synthesis.reason, /开启/); assert.equal(f.state.writes.length, 0);
    await run(f); assert.equal(f.state.writes.length, 0);
    f.settings.homeland.produceOrders = true; await run(f);
    assert.equal(f.state.orders.length, 0); assert.equal(f.state.stamina, 46);
    assert.deepEqual(f.state.writes.map(row => row.name), [produce, produce, merge, produce, produce, merge, merge, submit]);
    assert.equal(f.state.cells[0].piece.pieceCfgId, '钩1');
    assert.equal(f.ledger.snapshot().counters.homelandStamina, 4);
    assert.equal(f.ledger.confirmedCounters().homelandStamina, 4);
    assert(Object.values(f.ledger.keyRecords()).filter(row => row.details?.expected?.kind === 'produceOrders')
      .every(row => row.confirmed && !row.details.expected.boardBefore), '已确认记录无需重复保存整张棋盘');
  });
  await test('家园币与升级门槛不阻止工坊生产，现有材料足够时不额外生产', async () => {
    const f = setup(); f.state.home.level = 1; f.state.coins = 0; f.state.spent = 0;
    Object.assign(f.settings.homeland, { upgrade: true, tech: true, unlockFloors: true, clean: true });
    await run(f); assert.equal(f.state.orders.length, 0); assert(f.state.writes.some(row => row.name === produce));
    const g = setup(['钩1', '鱼2', '鱼2']); await run(g);
    assert.deepEqual(g.state.writes.map(row => row.name), [merge, submit]);
  });
  await test('两个工作格配合仓库中转持续推进深层订单，不循环搬运或损失生产器', async () => {
    const f = setup(['钩1', null, null], ['鱼4']);
    for (let round = 0; round < 4 && f.state.orders.length; round++) { await run(f); f.client.serverClockOffsetMs += 301000; }
    assert.equal(f.state.orders.length, 0, JSON.stringify(f.state.writes));
    assert.equal(f.state.writes.filter(row => row.name === produce).length, 8);
    assert(f.state.writes.some(row => row.name === 'DualCombinePutToWarehouseRequest'));
    assert(f.state.writes.some(row => row.name === 'DualCombineTakeFromWarehouseRequest'));
    assert(f.state.writes.length < 40); assert.equal(f.state.cells[0].piece.pieceCfgId, '钩1');
  });
  await test('随机副产物保留，下一件按真实棋盘重算；高收益生产器可耗尽后继续交单', async () => {
    const f = setup(['钩1', null, null, null], ['鱼2']);
    const config = { ...h.config, tables: structuredClone(h.config.tables) };
    config.tables.DualCombineProduceLibCfg.data.push({ libId: '钩1', pieceId: '鱼4', weight: 100 });
    f.state.drops = ['鱼4', '鱼1', '鱼1']; await run(f, config);
    assert.equal(f.state.orders.length, 0); assert.equal(f.state.stamina, 47);
    assert(f.state.cells.some(cell => cell.piece?.pieceCfgId === '鱼4'));
    const g = setup(['钩1', '钩2', null, null]); await run(g);
    assert.equal(g.state.orders.length, 0);
    assert.deepEqual(g.state.writes.filter(row => row.name === produce).map(row => row.body.cellId), [1, 1]);
    assert.equal(g.state.cells[1].piece, undefined, '有限次数生产器正常耗尽可被确认');
    assert.equal(g.state.cells[0].piece.pieceCfgId, '钩1');
  });
  await test('按实际 libId 计算产物，不误用展示分组或生产器编号同名掉落表', async () => {
    const f = setup(['钩1', '钩2', null, null]);
    const config = { ...h.config, tables: structuredClone(h.config.tables) };
    config.tables.DualCombineProduceCfg.data[1].libId = '钩1';
    const action = (await read(f, config)).actions.find(row => row.kind === 'produceOrders');
    assert(action); assert.equal(action.staminaCost, 1);
    // Same actual table means a stable tie chooses the first cell, rather than
    // incorrectly preferring the same-name table for 钩2 (100% level-2 drops).
    const result = await executeHomeland(f.client, config, { ...f.options, ...action,
      guard: createActionGuard(f.client, () => f.settings, f.ledger, { player: f.player, config }) });
    assert.equal(result.status, 'confirmed'); assert.equal(f.state.writes[0].body.cellId, 0);
  });
  await test('保留低级订单成品，可使用半锁定配对，绝不点击锁定生产器', async () => {
    const f = setup(['钩1', '鱼1', null, null, null], ['鱼1', '鱼3']);
    await run(f); assert.equal(f.state.orders.length, 0); assert.equal(f.state.stamina, 46);
    const g = setup(['钩1', '鱼1', null], ['鱼2']); g.state.cells[1].state = 1;
    await run(g); assert.deepEqual(g.state.writes.map(row => row.name), [produce, merge, submit]);
    for (const lock of [0, 1]) {
      const x = setup(); x.state.cells[0].state = lock; await run(x); assert.equal(x.state.writes.length, 0);
    }
  });
  await test('体力保留、每日预算、冷却与仓库容量限制均在生产前生效', async () => {
    const f = setup(); f.settings.homeland.keepStamina = 49; await run(f);
    assert.equal(f.state.writes.filter(row => row.name === produce).length, 1);
    assert.match((await read(f)).orders[0].synthesis.reason, /体力不足|保留/);
    const g = setup(); g.settings.homeland.dailyStaminaLimit = 1; await run(g);
    assert.equal(g.state.writes.filter(row => row.name === produce).length, 1);
    assert.match((await read(g)).orders[0].synthesis.reason, /预算/);
    const cd = setup(); cd.state.cells[0].piece.produceCdTs = Math.floor(Date.now() / 1000) + 600;
    await run(cd); assert.equal(cd.state.writes.length, 0); assert.match((await read(cd)).orders[0].synthesis.reason, /冷却/);
    cd.client.serverClockOffsetMs += 601000; await run(cd); assert.equal(cd.state.orders.length, 0);
    const full = setup(['钩1', '鱼4'], ['鱼2']); full.state.warehouseCapacity = 1; full.state.warehouse = [{ uid: 300, pieceCfgId: '鱼4' }];
    await run(full); assert.equal(full.state.writes.length, 0); assert.match((await read(full)).orders[0].synthesis.reason, /仓库已满/);
    const impossible = setup(['钩1', null], ['鱼1', '鱼1', '鱼1']);
    await run(impossible); assert.equal(impossible.state.writes.length, 0);
    assert.match((await read(impossible)).orders[0].synthesis.reason, /同时放下订单成品/);
  });
  await test('陈旧生产计划、发送前关闭开关、调低预算、订单到期或断线均不发送', async () => {
    const stale = setup(), old = await nextProduction(stale); stale.state.cells[0].piece.uid++;
    assert.equal((await send(stale, old)).status, 'rejected'); assert.equal(stale.state.writes.length, 0);
    for (const gate of ['produceOrders', 'mergeOrders', 'submitOrders', 'enabled', 'budget', 'reserve', 'expiry', 'connection', 'day']) {
      const f = setup(); f.state.orders[0].expireTs = Math.floor(Date.now() / 1000) + 60;
      f.state.beforeWrite = () => {
        if (gate === 'budget') f.settings.homeland.dailyStaminaLimit = 0;
        else if (gate === 'reserve') f.settings.homeland.keepStamina = 50;
        else if (gate === 'expiry') f.client.serverClockOffsetMs += 61000;
        else if (gate === 'connection') f.client.connectionEpoch++;
        else if (gate === 'day') f.client.serverClockOffsetMs += 86400000;
        else f.settings.homeland[gate] = false;
      };
      assert.equal((await send(f, await nextProduction(f), { automatic: true })).status, 'cancelled', gate);
      assert.equal(f.state.writes.length, 0, gate); assert.equal(f.ledger.snapshot().uncertain, 0, gate);
      assert.equal(f.ledger.snapshot().counters.homelandStamina ?? 0, 0, gate);
    }
  });
  await test('未知生产跨重连和跨日防重，体力减少或订单过期不能冒充生产成功', async () => {
    const f = setup(); f.state.drop = produce;
    assert.equal((await send(f, await nextProduction(f))).status, 'pending');
    const original = f.state.writes.length;
    f.client = createHomelandClient(h.protocol, f.player.playerId - 1000, f.state).client;
    f.client.serverClockOffsetMs = 86400000;
    f.options.enabled = () => f.enabled && f.client.connected;
    f.ledger = createUsageLedger(f.ledgerId, { now: () => Date.now() + 86400000 }); f.options.ledger = f.ledger;
    f.state.stamina--; f.state.orders = []; await run(f);
    assert.equal(f.state.writes.length, original); assert.equal((await read(f)).pending.length, 1);
    f.state.cells[1].piece = { uid: 777, pieceCfgId: '鱼1' };
    assert.equal((await read(f)).pending.length, 0, '仅真实新增且符合生产库的棋子可核对成功');
    const g = setup(); g.state.drop = 'after:' + produce;
    assert.equal((await send(g, await nextProduction(g))).status, 'confirmed', '回执丢失后可用完整业务状态核对');
    const reject = setup(); reject.state.reject = produce;
    assert.equal((await send(reject, await nextProduction(reject))).status, 'rejected');
    assert.equal(reject.ledger.snapshot().uncertain, 0); assert.equal(reject.ledger.snapshot().counters.homelandStamina, 0);
  });
  await test('缺少生产协议不生产或执行配套搬运，不对不能补料的生产器无效点击', async () => {
    const f = setup(); f.client.protocol = { ...h.protocol }; delete f.client.protocol[produce];
    await run(f); assert.equal(f.state.writes.length, 0);
    const g = setup(['钩2', null, null], ['鱼1']); await run(g); assert.equal(g.state.writes.length, 0);
    assert.match((await read(g)).orders[0].synthesis.reason, /没有能补齐/);
  });
  await test('生产回执持久保存，后续读取失败不撤销体力占用，错误产物不能确认', async () => {
    const f = setup();
    f.state.beforeRead = name => { if (f.state.writes.length && name === 'HomelandRequest') throw Object.assign(Error('回读尚未同步'), { notSent: true }); };
    assert.equal((await send(f, await nextProduction(f))).status, 'pending');
    const record = Object.values(f.ledger.keyRecords()).find(row => row.details?.expected?.kind === 'produceOrders');
    assert(record.details.expected.receipt.uid); assert(record.details.expected.boardBefore);
    assert.equal(f.ledger.snapshot().counters.homelandStamina, 1);
    f.state.beforeRead = null; f.state.orders = []; await run(f);
    assert.equal(f.ledger.snapshot().uncertain, 0); assert.equal(f.state.writes.length, 1);
    const wrong = setup(); wrong.state.drops = ['体力瓶1'];
    assert.equal((await send(wrong, await nextProduction(wrong))).status, 'pending');
    assert.equal((await read(wrong)).pending.length, 1);
  });
  console.log(`家园生产离线验收通过 ${passed} 项`);
} finally { await h.close(); }
