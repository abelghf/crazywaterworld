import assert from 'node:assert/strict';
import { createHomelandHarness, homelandTables } from './fixtures/homeland-console.mjs';

const h = await createHomelandHarness();
const { readHomeland, runHomeland, executeHomeland } = await import('../src/homeland.mjs');
const { createActionGuard } = await import('../src/automation-policy.mjs');
const tables = structuredClone(homelandTables);
tables.DualCombinePieceCfg.push(...[1, 2].map(level => ({ pieceId: `鱼皮${level}`, pieceGroup: '鱼皮', type: '普通',
  level, nextId: level === 1 ? '鱼皮2' : '', name: `鱼皮${level}` })));
tables.DualCombineProduceLibCfg.push({ libId: '钩1', pieceId: '鱼皮1', weight: 10 });
tables.DualCombinePieceCfg.push(...[1, 2].map(level => ({ pieceId: `过滤器${level}`, pieceGroup: '过滤器', type: '生产器',
  level, nextId: level === 1 ? '过滤器2' : '', name: `过滤器${level}` })));
tables.DualCombineProduceCfg.push(...[1, 2].map(level => ({ produceid: `过滤器${level}`, libId: '钩1', count: 3, cost: 1, cd: 0 })));
tables.DualCombinePieceCfg.find(row => row.pieceId === '钩2').nextId = '钩3';
tables.DualCombinePieceCfg.push({ pieceId: '钩3', pieceGroup: '钩', type: '生产器', level: 3, nextId: '', name: '钩3' });
tables.DualCombineProduceCfg.push({ produceid: '钩3', libId: '钩2', count: 3, cost: 1, cd: 0 });
const config = { ...h.config, tables: Object.fromEntries(Object.entries(tables).map(([key, data]) => [key, { data }])) };
function setup(ids, goals = ['鱼皮1']) {
  const f = h.fixture();
  f.state.tables = tables;
  f.state.cells = ids.map((id, cellId) => ({ cellId, state: 2, ...(id ? { piece: { uid: cellId + 100, pieceCfgId: id,
    ...(id === '钩1' ? { produceLeft: -1 } : id === '钩2' ? { produceLeft: 2 } : {}) } } : {}) }));
  f.state.warehouse = []; f.state.stamina = 50;
  f.state.orders = goals.length ? [{ slot: 0, orderId: 1, reqs: goals.map(pieceCfgId => ({ pieceCfgId, count: 1 })) }] : [];
  Object.assign(f.settings.homeland, { enabled: true, submitOrders: true });
  return f;
}
function half(f, id) {
  const cellId = f.state.cells.length;
  f.state.cells.push({ cellId, state: 1, piece: { uid: cellId + 100, pieceCfgId: id } });
  return cellId;
}
const read = f => readHomeland(f.client, config, f.options);
const run = (f, options = {}) => runHomeland(f.client, config, { ...f.options, ...options });
const send = (f, action) => executeHomeland(f.client, config, { ...f.options, ...action, automatic: true,
  guard: createActionGuard(f.client, () => f.settings, f.ledger, { player: f.player, config, enabled: f.options.enabled }) });
const names = f => f.state.writes.map(row => row.name);
let passed = 0;
const test = async (name, body) => { await body(); passed++; console.log('通过：' + name); };
try {
  await test('仓库满且鱼占满棋盘：先备料解锁带网格，再继续生产鱼皮订单', async () => {
    const f = setup(['钩1', ...Array(14).fill('鱼1')]);
    const target = half(f, '鱼2');
    f.state.warehouse = Array.from({ length: 5 }, (_, i) => ({ uid: 500 + i, pieceCfgId: '鱼4' }));
    f.state.drops = ['鱼皮1'];
    const view = await read(f);
    assert(view.actions.some(row => row.forUnlock && row.kind === 'mergeOrders'));
    await run(f);
    assert.equal(f.state.cells[target].state, 2);
    assert.equal(f.state.cells[target].piece.pieceCfgId, '鱼3');
    assert.equal(f.state.orders.length, 0);
    assert.deepEqual(names(f).slice(0, 2), ['DualCombineMoveRequest', 'DualCombineMoveRequest']);
    assert.equal(f.state.writes[1].body.toCellId, target);
    assert.equal(f.state.stamina, 49);
    assert.equal(f.state.warehouse.length, 5);
    assert(!names(f).includes('DualCombinePutToWarehouseRequest'));
  });
  await test('解锁优先于已经齐备的订单，订单成品不被消耗', async () => {
    const f = setup(['鱼皮1', '鱼1', '鱼1']);
    const target = half(f, '鱼2');
    await run(f, { maxActions: 1 });
    assert.equal(names(f)[0], 'DualCombineMoveRequest');
    assert.equal(f.state.cells[0].piece.pieceCfgId, '鱼皮1');
    f.client.serverClockOffsetMs += 2000;
    await run(f);
    assert.equal(f.state.cells[target].state, 2);
    assert.equal(f.state.orders.length, 0);
  });
  await test('缺少解锁配对时主动生产，逐次回读后完成解锁', async () => {
    const f = setup(['钩1', null, null], []), target = half(f, '鱼2');
    f.state.drops = ['鱼1', '鱼1'];
    const view = await read(f);
    assert(view.actions.some(row => row.forUnlock && row.kind === 'produceOrders' && row.orderSlot === null));
    await run(f);
    assert.equal(f.state.cells[target].state, 2);
    assert.equal(f.state.stamina, 48);
    assert.deepEqual(names(f), ['DualCombineProduceRequest', 'DualCombineProduceRequest', 'DualCombineMoveRequest', 'DualCombineMoveRequest']);
  });
  await test('从仓库取配对解锁；已有高阶成品不能冒充目标格子的解锁', async () => {
    const f = setup(['鱼3', null], []), target = half(f, '鱼2');
    f.state.warehouse = [{ uid: 800, pieceCfgId: '鱼2' }];
    await run(f);
    assert.deepEqual(names(f), ['DualCombineTakeFromWarehouseRequest', 'DualCombineMoveRequest']);
    assert.equal(f.state.cells[target].state, 2);
    assert.equal(f.state.cells[0].piece.pieceCfgId, '鱼3');
  });
  await test('没有可解锁格时合并副产物腾位，保持生产器并恢复订单生产', async () => {
    const f = setup(['钩1', '鱼1', '鱼1', '鱼1', '鱼1']);
    f.state.warehouse = Array.from({ length: 5 }, (_, i) => ({ uid: 500 + i, pieceCfgId: '鱼4' }));
    f.state.drops = ['鱼皮1'];
    assert((await read(f)).actions.some(row => row.forSpace && row.kind === 'mergeOrders'));
    await run(f);
    assert.equal(names(f)[0], 'DualCombineMoveRequest');
    assert(names(f).includes('DualCombineProduceRequest'));
    assert.equal(f.state.orders.length, 0);
    assert.equal(f.state.cells[0].piece.pieceCfgId, '钩1');
  });
  await test('不把其他订单的低阶材料过度合并，不动半锁成品、生产器和资源瓶腾位', async () => {
    const f = setup(['鱼1', '鱼1', '钩1', '钩1', '体力瓶1', '体力瓶1'], ['鱼2', '鱼皮1']);
    half(f, '鱼4');
    const view = await read(f);
    assert.equal(view.actions.some(row => row.forSpace), false);
    const g = setup(['鱼1'], ['鱼1']); half(g, '鱼1');
    assert.equal((await read(g)).actions.some(row => row.forUnlock), false);
  });
  await test('解锁受订单开关控制，发送前关闭取消且旧棋子预览失效', async () => {
    const f = setup(['鱼1'], []); half(f, '鱼1');
    const action = (await read(f)).actions.find(row => row.forUnlock);
    assert(action);
    f.settings.homeland.submitOrders = false;
    await run(f); assert.equal(f.state.writes.length, 0);
    assert.equal((await send(f, action)).status, 'cancelled');
    f.settings.homeland.submitOrders = true;
    f.state.cells[0].piece.uid = 900;
    assert.equal((await send(f, action)).status, 'rejected');
    assert.equal(f.state.writes.length, 0);
  });
  await test('不消耗部分使用的有限生产器，也不把唯一无限生产器换成有限生产器', async () => {
    const partial = setup(['过滤器1'], []); half(partial, '过滤器1');
    partial.state.cells[0].piece.produceLeft = 1;
    await run(partial); assert.equal(partial.state.writes.length, 0);
    const f = setup(['钩1'], []); half(f, '钩1');
    assert.equal((await read(f)).actions.some(row => row.forUnlock), false);
    await run(f); assert.equal(f.state.writes.length, 0);
    const g = setup(['钩1', '钩1'], []); const target = half(g, '钩1');
    await run(g);
    assert.equal(g.state.cells[target].state, 2);
    assert.equal(g.state.cells.filter(cell => cell.piece?.pieceCfgId === '钩1').length, 1);
    const prefix = setup(['钩1', '钩1'], []); half(prefix, '钩2');
    await run(prefix); assert.equal(prefix.state.writes.length, 0, '不能在配对材料合成中把两台无限生产器一起消耗');
    const exhausted = setup(['过滤器1', '过滤器1'], []); half(exhausted, '过滤器1');
    exhausted.state.cells[0].piece.produceLeft = 0;
    exhausted.state.cells[1].piece.produceLeft = 3;
    await run(exhausted); assert.equal(exhausted.state.writes.length, 0, '耗尽的生产器不能充当留下的可用生产器');
  });
  await test('缺少合成协议时不提前取料或为解锁消耗体力', async () => {
    const f = setup(['钩1', null, null], []); half(f, '鱼2');
    const protocol = { ...f.client.protocol }; delete protocol.DualCombineMoveRequest;
    f.client.protocol = protocol;
    const view = await read(f);
    assert.match(view.actions.find(row => row.forUnlock).reason, /缺少格子解锁/);
    await run(f); assert.equal(f.state.writes.length, 0);
  });
  await test('未知结果保持待确认，不重复解锁；木板格不作为拖动目标', async () => {
    const f = setup(['鱼1'], []); half(f, '鱼1');
    f.state.drop = 'DualCombineMoveRequest';
    f.state.beforeRead = name => { if (f.state.writes.length && name === 'DualCombineInfoRequest') throw Error('断开'); };
    assert.equal((await send(f, (await read(f)).actions.find(row => row.forUnlock))).status, 'pending');
    f.state.beforeRead = null;
    await run(f); assert.equal(f.state.writes.length, 1);
    const g = setup(['鱼1'], []); half(g, '鱼1'); g.state.cells[1].state = 0;
    await run(g); assert.equal(g.state.writes.length, 0);
  });
  await test('服务端额外揭开木板格后，回读新格状态并继续解锁', async () => {
    const f = setup(['鱼1'], []); half(f, '鱼1');
    f.state.cells.push({ cellId: 2, state: 0 });
    f.state.beforeRead = name => {
      if (name === 'DualCombineInfoRequest' && f.state.writes.length === 1) {
        f.state.cells[2] = { cellId: 2, state: 1, piece: { uid: 999, pieceCfgId: '鱼2' } };
        f.state.beforeRead = null;
      }
    };
    await run(f);
    assert.deepEqual(names(f), ['DualCombineMoveRequest', 'DualCombineMoveRequest']);
    assert.equal(f.state.cells[2].state, 2);
    assert.equal(f.state.cells[2].piece.pieceCfgId, '鱼3');
  });
  await test('订单需要两份二级物品，只合成两份交单，不把余料升到三级', async () => {
    const f = setup(['钩1', ...Array(6).fill('鱼1')], ['鱼2', '鱼2']);
    assert.equal((await read(f)).actions.some(row => row.forSpace), false);
    await run(f);
    assert.equal(f.state.orders.length, 0);
    assert.equal(names(f).filter(name => name === 'DualCombineMoveRequest').length, 2);
    assert.equal(f.state.cells.filter(cell => cell.piece?.pieceCfgId === '鱼1').length, 2);
    assert.equal(names(f).includes('DualCombineProduceRequest'), false);
  });
  await test('一个空位够生产就不整理，有同级高阶副产物也保持原样', async () => {
    const f = setup(['钩1', '鱼3', '鱼3', null]); f.state.drops = ['鱼皮1'];
    assert.equal((await read(f)).actions.some(row => row.forSpace), false);
    await run(f);
    assert.deepEqual(names(f), ['DualCombineProduceRequest', 'DualCombineSubmitOrderRequest']);
    assert.equal(f.state.cells.filter(cell => cell.piece?.pieceCfgId === '鱼3').length, 2);
  });
  await test('腾出生产所需的一格就停止压缩，不为凑两格继续升级高阶副产物', async () => {
    const f = setup(['钩1', '鱼1', '鱼1', '鱼3', '鱼3']); f.state.drops = ['鱼皮1'];
    await run(f);
    assert.deepEqual(names(f), ['DualCombineMoveRequest', 'DualCombineProduceRequest', 'DualCombineSubmitOrderRequest']);
    assert.equal(f.state.cells.filter(cell => cell.piece?.pieceCfgId === '鱼3').length, 2);
    assert.equal(f.state.cells.some(cell => cell.piece?.pieceCfgId === '鱼4'), false);
  });
  await test('体力不足、冷却、缺少生产器或没有目标时，不为了备用空位合成副产物', async () => {
    for (const condition of ['stamina', 'cooldown', 'producer', 'orders', 'unlock']) {
      const f = setup(['钩1', '鱼3', '鱼3']);
      if (condition === 'stamina' || condition === 'unlock') f.state.stamina = 0;
      if (condition === 'cooldown') f.state.cells[0].piece.produceCdTs = Math.floor(Date.now() / 1000) + 1000;
      if (condition === 'producer') f.state.cells[0].piece.pieceCfgId = '鱼4';
      if (condition === 'orders') f.state.orders = [];
      if (condition === 'unlock') half(f, '鱼2');
      assert.equal((await read(f)).actions.some(row => row.forSpace), false, condition);
      await run(f); assert.equal(f.state.writes.length, 0, condition);
    }
  });
  await test('订单原料全在满仓库时，仍能按实际取料需求腾位并交单', async () => {
    const f = setup(Array(4).fill('鱼1'), ['鱼皮2']);
    f.state.warehouse = ['鱼皮1', '鱼皮1', '鱼4', '鱼4', '鱼4'].map((pieceCfgId, i) => ({ uid: 700 + i, pieceCfgId }));
    assert((await read(f)).actions.some(row => row.forSpace));
    await run(f);
    assert.equal(names(f)[0], 'DualCombineMoveRequest');
    assert(names(f).includes('DualCombineTakeFromWarehouseRequest'));
    assert.equal(names(f).includes('DualCombineProduceRequest'), false);
    assert.equal(f.state.orders.length, 0);
    assert.equal(f.state.cells.some(cell => cell.piece?.pieceCfgId === '鱼3'), false);
  });
  console.log(`家园棋盘规划离线验收通过 ${passed} 项`);
} finally { await h.close(); }
