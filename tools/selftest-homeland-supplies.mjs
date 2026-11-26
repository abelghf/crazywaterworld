import assert from 'node:assert/strict';
import { createHomelandHarness, createHomelandClient, homelandTables } from './fixtures/homeland-console.mjs';

const h = await createHomelandHarness();
const { readHomeland, executeHomeland, runHomeland } = await import('../src/homeland.mjs');
const { createActionGuard } = await import('../src/automation-policy.mjs');
const { automationControlView } = await import('../src/automation-controls.mjs');
const { defaultSettings, importAutomationSettings, SETTINGS_FORMAT, createUsageLedger } = await import('../src/automation-settings.mjs');
const tables = structuredClone(homelandTables);
tables.DualCombinePieceCfg = tables.DualCombinePieceCfg.filter(row => !['体力', '金币', '体力箱'].includes(row.pieceGroup));
tables.DualCombineProduceCfg = tables.DualCombineProduceCfg.filter(row => row.produceid !== '体力箱1');
tables.DualCombineProduceLibCfg = tables.DualCombineProduceLibCfg.filter(row => row.libId !== '体力箱1');
const rewards = {};
for (const [group, prefix, amounts, resource, suffix] of [
  ['体力', '体力瓶', [2, 6, 15, 40, 100], 'stamina', '点体力'],
  ['金币', '金币', [2, 6, 14, 30, 62], 'coins', '个家园币'],
]) for (const [index, amount] of amounts.entries()) {
  const pieceId = prefix + (index + 1);
  tables.DualCombinePieceCfg.push({ pieceId, pieceGroup: group, level: index + 1, type: '可使用', name: pieceId,
    nextId: index < 4 ? prefix + (index + 2) : '', desc: `点击收集${amount}${suffix}。` });
  rewards[pieceId] = { resource, amount };
}
for (const [id, output] of [['体力箱1', '体力瓶1'], ['存钱罐1', '金币1']]) {
  tables.DualCombinePieceCfg.push({ pieceId: id, pieceGroup: id, level: 1, type: '生产器', name: id, nextId: '' });
  tables.DualCombineProduceCfg.push({ produceid: id, libId: id, cost: 0, count: 5, cd: 0 });
  tables.DualCombineProduceLibCfg.push({ libId: id, pieceId: output, weight: 100 });
}
tables.DualCombinePieceCfg.push(
  { pieceId: '打捞1', pieceGroup: '打捞', level: 1, type: '生产器', name: '打捞网', nextId: '' },
  { pieceId: '滤材1', pieceGroup: '滤材', level: 1, type: '普通', name: '滤材', nextId: '滤材2' },
  { pieceId: '滤材2', pieceGroup: '滤材', level: 2, type: '生产器', name: '过滤器', nextId: '滤材3' },
  { pieceId: '滤材3', pieceGroup: '滤材', level: 3, type: '生产器', name: '高级过滤器', nextId: '' },
  ...[1, 2, 3].map(level => ({ pieceId: '水' + level, pieceGroup: '水', level, type: '普通', name: '水' + level, nextId: level < 3 ? '水' + (level + 1) : '' })),
);
tables.DualCombineProduceCfg.push(
  { produceid: '打捞1', libId: '打捞', cost: 1, count: 0, cd: 0 },
  { produceid: '滤材2', libId: '滤水', cost: 1, count: 2, cd: 0 },
  { produceid: '滤材3', libId: '滤水', cost: 1, count: 0, cd: 0 },
);
tables.DualCombineProduceLibCfg.push({ libId: '打捞', pieceId: '滤材1', weight: 100 }, { libId: '滤水', pieceId: '水1', weight: 100 });
const config = { ...h.config, tables: Object.fromEntries(Object.entries(tables).map(([name, data]) => [name, { data }])) };
const setup = (ids, goals = []) => {
  const f = h.fixture(); f.state.tables = tables; f.state.rewards = rewards;
  f.state.cells = ids.map((id, cellId) => ({ cellId, state: 2, ...(id ? { piece: { uid: cellId + 100, pieceCfgId: id,
    produceLeft: tables.DualCombineProduceCfg.find(row => row.produceid === id)?.count || -1, produceCdTs: 0 } } : {}) }));
  f.state.warehouse = []; f.state.chest = []; f.state.stamina = 50;
  f.state.orders = goals.length ? [{ slot: 0, orderId: 1, reqs: goals.map(pieceCfgId => ({ pieceCfgId, count: 1 })) }] : [];
  Object.assign(f.settings.homeland, { enabled: true, submitOrders: true, useSupplies: true });
  return f;
};
const read = f => readHomeland(f.client, config, f.options);
const send = (f, action, extra = {}) => executeHomeland(f.client, config, { ...f.options, ...action, ...extra,
  guard: createActionGuard(f.client, () => f.settings, f.ledger, { player: f.player, config, enabled: f.options.enabled }) });
const action = async (f, kind) => {
  const view = await read(f), result = view.actions.find(row => row.kind === kind && !row.reason);
  assert(result, JSON.stringify(view)); return result;
};
const run = f => runHomeland(f.client, config, f.options);
const drain = async f => {
  for (let i = 0; i < 12; i++) {
    const result = await run(f);
    assert(!result.some(row => row.status === 'pending' || row.status === 'rejected'), JSON.stringify(result));
    if (!result.some(row => row.status === 'confirmed')) return;
    f.client.serverClockOffsetMs += 301000;
  }
  assert.fail('补给与备料不能循环');
};
let passed = 0;
async function test(name, work) { await work(); console.log('通过：' + name); passed++; }
try {
  await test('旧配置保留订单与补给选择，清理废弃子开关和体力限制', async () => {
    for (const version of [72, 74, 75, 76, 77, 78]) {
      const old = defaultSettings(); Object.assign(old.homeland, { submitOrders: true, produceOrders: false, buildProducers: false, keepStamina: 9999, dailyStaminaLimit: 0 });
      const before = structuredClone(old);
      const migrated = importAutomationSettings({ format: SETTINGS_FORMAT, version, settings: old });
      assert.equal(migrated.homeland.submitOrders, true); assert.equal(migrated.homeland.useSupplies, false);
      for (const key of ['mergeOrders','produceOrders','buildProducers','takeWarehouse','warehouseBuffer','keepStamina','dailyStaminaLimit']) assert(!Object.hasOwn(migrated.homeland, key));
      assert.deepEqual(old, before);
    }
  });
  await test('先合成生产器，再产料合成交单，订单关闭时不擅自制造', async () => {
    const f = setup(['滤材1', '滤材1', null, null], ['水2']); f.settings.homeland.submitOrders = false;
    await run(f); assert.equal(f.state.writes.length, 0);
    f.settings.homeland.submitOrders = true; await drain(f);
    assert.equal(f.state.orders.length, 0);
    assert.deepEqual(f.state.writes.map(row => row.name), ['DualCombineMoveRequest', 'DualCombineProduceRequest', 'DualCombineProduceRequest', 'DualCombineMoveRequest', 'DualCombineSubmitOrderRequest']);
    assert.equal(f.state.stamina, 48); assert.equal(f.ledger.snapshot().uncertain, 0);
  });
  await test('跨生产器链路补料，有限生产器耗尽后重建并继续订单', async () => {
    const f = setup(['打捞1', null, null, null, null, null], ['水3']); await drain(f);
    assert.equal(f.state.orders.length, 0); assert.equal(f.state.stamina, 42);
    assert.equal(f.state.writes.filter(row => row.name === 'DualCombineProduceRequest').length, 8);
    assert.equal(f.state.cells[0].piece.pieceCfgId, '打捞1');
    assert(!f.state.cells.some(cell => cell.piece?.pieceCfgId === '滤材2'));
  });
  await test('循环依赖不能凭空制造材料，制造步骤发送前仍受所有父开关控制', async () => {
    const c = { ...config, tables: structuredClone(config.tables) };
    c.tables.DualCombinePieceCfg.data.push(
      { pieceId: '网料1', pieceGroup: '网料', level: 1, type: '普通', name: '网料', nextId: '打捞1' });
    const net = c.tables.DualCombinePieceCfg.data.find(row => row.pieceId === '打捞1');
    net.level = 2; net.pieceGroup = '网料';
    c.tables.DualCombineProduceLibCfg.data.find(row => row.libId === '滤水').pieceId = '网料1';
    const f = setup([null, null, null], ['滤材1']);
    const view = await readHomeland(f.client, c, f.options);
    assert(!view.actions.some(row => row.forProduction && !row.reason)); assert.equal(f.state.writes.length, 0);
    for (const gate of ['submitOrders', 'enabled']) {
      const g = setup(['滤材1', '滤材1', null], ['水1']);
      const next = await action(g, 'mergeOrders'); assert(next.forProducer);
      g.state.beforeWrite = () => { g.settings.homeland[gate] = false; };
      assert.equal((await send(g, next, { automatic: true })).status, 'cancelled', gate);
      assert.equal(g.state.writes.length, 0, gate); assert.equal(g.ledger.snapshot().uncertain, 0);
    }
  });
  await test('制造生产器保留其他订单现货，不合并已消耗次数的有限生产器', async () => {
    const f = setup(['打捞1', '滤材1', null, null, null, null], ['水2']);
    f.state.orders.push({ slot: 1, orderId: 2, reqs: [{ pieceCfgId: '滤材1', count: 1 }] });
    const preview = await read(f); const build = preview.actions.find(row => row.forProducer && !row.reason);
    assert(build); assert.equal(build.kind, 'produceOrders');
    assert.equal(f.state.cells[1].piece.uid, 101);
    const producer = tables.DualCombineProduceCfg.find(row => row.produceid === '滤材3');
    producer.libId = '升级'; tables.DualCombineProduceLibCfg.push({ libId: '升级', pieceId: '鱼1', weight: 100 });
    try {
      const g = setup(['滤材2', '滤材2', null, null], ['鱼1']); g.state.cells[0].piece.produceLeft = 1;
      await run(g); assert.equal(g.state.writes.length, 0);
      const full = setup(['滤材2', '滤材2', null, null], ['鱼1']);
      await drain(full); assert.equal(full.state.orders.length, 0);
      assert.equal(full.state.writes[0].name, 'DualCombineMoveRequest');
      const stored = setup(['滤材2', '鱼3', '鱼4'], ['鱼2']);
      stored.state.warehouse = [{ uid: 990, pieceCfgId: '滤材2', produceLeft: 2, produceCdTs: 0 }];
      const park = await action(stored, 'warehouseBuffer'); assert(park.forProducer);
      assert.equal((await send(stored, park)).status, 'confirmed');
      const fetch = await action(stored, 'takeWarehouse'); assert(fetch.forProducer);
      assert.equal((await send(stored, fetch)).status, 'confirmed');
      assert.equal((await send(stored, await action(stored, 'mergeOrders'))).status, 'confirmed');
      await drain(stored); assert.equal(stored.state.orders.length, 0);
      assert(stored.state.cells.some(cell => cell.piece?.pieceCfgId === '滤材3'));
    } finally { producer.libId = '滤水'; tables.DualCombineProduceLibCfg.pop(); }
  });
  await test('零体力时先合并瓶子再领取，并继续生产；最高级资源自动领取', async () => {
    const f = setup(['钩1', '体力瓶1', '体力瓶1', null, null], ['鱼2']); f.state.stamina = 0;
    await drain(f); assert.equal(f.state.orders.length, 0); assert.equal(f.state.stamina, 4);
    assert.deepEqual(f.state.writes.slice(0, 2).map(row => row.name), ['DualCombineMoveRequest', 'DualCombineUsePieceRequest']);
    assert.equal(f.ledger.snapshot().counters.homelandStamina, 2);
    const g = setup(['体力瓶5', '金币5', null]); await drain(g);
    assert.equal(g.state.stamina, 150); assert.equal(g.state.coins, 262);
    const chain = setup(['打捞1', '体力瓶3', null, null, null], ['水2']); chain.state.stamina = 0;
    await drain(chain); assert.equal(chain.state.orders.length, 0); assert.equal(chain.state.stamina, 11);
    const capped = setup(['钩1', '体力瓶1', null, null], ['鱼2']); capped.state.stamina = 0;
    capped.settings.homeland.submitOrders = false; await run(capped);
    assert.equal(capped.state.writes.length, 0, '订单关闭时不提前领取低级体力瓶');
  });
  await test('领取奖励区资源箱，免费产出五次并合并，空间不足不盲目取物', async () => {
    const f = setup([null, null, null, null, null, null]); f.state.chest = ['体力箱1'];
    await drain(f);
    assert.equal(f.state.chest.length, 0); assert.equal(f.state.stamina, 50);
    assert.equal(f.state.writes.filter(row => row.name === 'DualCombineProduceRequest').length, 5);
    assert(!f.state.cells.some(row => row.piece?.pieceCfgId === '体力箱1'));
    assert.deepEqual(f.state.cells.filter(row => row.piece).map(row => row.piece.pieceCfgId).sort(), ['体力瓶1', '体力瓶3']);
    const g = setup(['钩1', null]); g.state.chest = ['体力箱1']; await run(g);
    assert.equal(g.state.writes.length, 0); assert.match((await read(g)).supplyReason, /两个空格/);
  });
  await test('补给独立于交单开关；可取仓库配对，家园币不足时领取后升级科技', async () => {
    const f = setup(['体力瓶1', null, null]); f.state.warehouse = [{ uid: 990, pieceCfgId: '体力瓶1' }];
    f.settings.homeland.submitOrders = false; await drain(f);
    assert.deepEqual(automationControlView(f.settings).find(row => row.key === 'homeland.useSupplies').blockedBy, []);
    assert.deepEqual(f.state.writes.map(row => row.name), ['DualCombineTakeFromWarehouseRequest', 'DualCombineMoveRequest']);
    const g = setup(['金币5', null, null]); g.state.coins = 0; g.settings.homeland.tech = true; g.settings.homeland.targetTech = 1;
    await drain(g); assert.equal(g.state.home.techLevel, 1); assert.equal(g.state.coins, 12);
    assert.equal(g.ledger.snapshot().counters.homelandCoins, 50);
  });
  await test('补给发送前关闭、暂停及陈旧棋子均不消耗，仓库取用跟随补给开关', async () => {
    for (const gate of ['useSupplies', 'enabled', 'pause']) {
      const f = setup(['体力瓶5', null]); const next = await action(f, 'useSupplies');
      f.state.beforeWrite = () => { if (gate === 'pause') f.enabled = false; else f.settings.homeland[gate] = false; };
      assert.equal((await send(f, next, { automatic: true })).status, 'cancelled'); assert.equal(f.state.writes.length, 0);
    }
    const f = setup(['体力瓶5', null]); const next = await action(f, 'useSupplies'); f.state.cells[0].piece.uid++;
    assert.equal((await send(f, next)).status, 'rejected'); assert.equal(f.state.writes.length, 0);
    const g = setup([null, null]); g.state.warehouse = [{ uid: 99, pieceCfgId: '体力瓶5' }]; g.settings.homeland.useSupplies = false;
    await run(g); assert.equal(g.state.writes.length, 0);
  });
  await test('领取响应丢失可用棋子消耗与库存共同确认，只有余额变化不能确认', async () => {
    const f = setup(['体力瓶5', null]); f.state.drop = 'after:DualCombineUsePieceRequest';
    assert.equal((await send(f, await action(f, 'useSupplies'))).status, 'confirmed');
    const g = setup(['金币5', null]); g.state.drop = 'DualCombineUsePieceRequest';
    assert.equal((await send(g, await action(g, 'useSupplies'))).status, 'pending');
    g.state.coins += 62; assert.equal((await read(g)).pending.length, 1);
    g.client = createHomelandClient(h.protocol, g.player.playerId - 1000, g.state).client;
    g.client.serverClockOffsetMs = 86400000;
    g.options.enabled = () => g.enabled && g.client.connected;
    g.ledger = createUsageLedger(g.ledgerId, { now: () => Date.now() + 86400000 }); g.options.ledger = g.ledger;
    await run(g); assert.equal(g.state.writes.length, 1);
    delete g.state.cells[0].piece; g.state.drop = null; g.client.serverClockOffsetMs += 301000; await run(g);
    assert.equal(g.ledger.snapshot().uncertain, 0);
  });
  await test('奖励区数量变化和错误产物不能冒充取物成功，开箱未知不能重复点击', async () => {
    const f = setup([null, null, null]); f.state.chest = ['体力箱1']; f.state.drop = 'DualCombineTakeFromChestRequest';
    assert.equal((await send(f, await action(f, 'takeRewards'))).status, 'pending');
    f.state.chest = []; assert.equal((await read(f)).pending.length, 1);
    f.state.cells[0].piece = { uid: 900, pieceCfgId: '金币1' }; assert.equal((await read(f)).pending.length, 1);
    const g = setup(['体力箱1', null, null]); g.state.drop = 'DualCombineProduceRequest';
    assert.equal((await send(g, await action(g, 'openSupplies'))).status, 'pending');
    g.state.drop = null; await run(g); assert.equal(g.state.writes.length, 1);
  });
  await test('锁定补给、付费资源箱及未识别奖励不使用，错误回执持续保留未知状态', async () => {
    const f = setup(['体力箱1', '体力瓶5', null, null]); f.state.cells[0].state = 1; f.state.cells[1].state = 0;
    await run(f); assert.equal(f.state.writes.length, 0);
    const c = { ...config, tables: structuredClone(config.tables) };
    c.tables.DualCombineProduceCfg.data.find(row => row.produceid === '体力箱1').cost = 1;
    const g = setup(['体力箱1', null, null]);
    assert(!(await readHomeland(g.client, c, g.options)).actions.some(row => row.kind === 'openSupplies'));
    c.tables.DualCombinePieceCfg.data.find(row => row.pieceId === '体力瓶5').desc = '奖励待同步';
    const unknown = setup(['体力瓶5', null]);
    assert(!(await readHomeland(unknown.client, c, unknown.options)).actions.some(row => row.kind === 'useSupplies'));
    const bad = setup(['体力瓶5', null]), original = bad.client.request;
    bad.client.request = async (...args) => {
      const reply = await original(...args);
      if (args[0] === 'DualCombineUsePieceRequest') reply.reward.asset[0].num = 1;
      return reply;
    };
    assert.equal((await send(bad, await action(bad, 'useSupplies'))).status, 'pending');
    assert.equal((await read(bad)).pending.length, 1); assert.equal(bad.state.stamina, 150);
  });
  console.log(`家园生产器与补给验收通过 ${passed} 项`);
} finally { await h.close(); }
