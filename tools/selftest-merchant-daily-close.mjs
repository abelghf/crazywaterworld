import assert from 'node:assert/strict';
import { merchantDailyCloseWindow, merchantSettings, planMerchant } from '../src/merchant-planner.mjs';
import { planMerchantSpeed, merchantClosingRoute } from '../src/merchant-speed.mjs';
import { watchMerchant } from '../src/merchant-monitor.mjs';
import { merchantStrategyPlan } from '../src/merchant-strategy.mjs';

const close = Date.UTC(2026, 10, 26, 14) / 1000;
const pointer = '海商王加速';
function fixture() {
  const config = { tables: {
    ActivityTradeCfg: { data: [['海商王贸易时间', '10-22'], ['海商王行驶时间', '120'],
      ['海商王加速时长', '30'], ['海商王刷新时间', '10,12,14,16,18,20']].map(([key, value]) => ({ key, value })) },
    TradeShipCfg: { data: [{ lv: 1, capacity: 10, profitMargin: 0 }] },
    TradeGoodsCfg: { data: [1, 2, 3].map(goodsId => ({ goodsId, capacity: 1, unitPrice: goodsId * 100,
      maxCount: 20, itemName: '货' + goodsId })) }
  } };
  const event = { period: 1, startTime: close - 86400, endTime: close + 2 * 86400 };
  const state = { period: 1, player: { coins: 1000, profit: 1000000, goods: [1, 2].map(pid =>
    ({ pid, goodsId: 1, cityId: 10, buyPrice: 50, num: 3 })) },
    cargo: { cityId: 10, cargoLv: 1, moveToCityId: 20, moveStartTime: close - 7170, moveEndTime: close + 30 } };
  const radar = { radar: [{ cityId: 10, specGoodsId: 1 }, { cityId: 20, specGoodsId: 2 }, { cityId: 30, specGoodsId: 3 }] };
  const settings = merchantSettings({ autoSpeedUp: true, speedUpMode: 'dailyClose', dailyPointerLimit: 10,
    periodPointerLimit: 20, minPurchaseReturnPercent: 5 });
  const f = { config, event, state, radar, settings, time: close - 120, stock: new Map([[pointer, 4]]) };
  f.speed = (options = {}) => planMerchantSpeed(config, event, state, radar, f.stock, settings, f.time,
    { actionSeconds: 10, periodRemaining: 20, ...options });
  return f;
}
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('通过：' + name); };

test('所有用针策略共用收市开关，独立模式与显式防抢保留兼容', () => {
  const f = fixture(); f.time = close - 7201;
  f.state.cargo.moveStartTime = f.time - 100;
  f.state.cargo.moveEndTime = f.time + 7100;
  assert.equal(f.speed().kind, 'none');
  assert.equal(merchantDailyCloseWindow(f.config, f.event, f.settings, f.time).active, false);
  f.config.tables.ActivityTradeCfg.data.find(r => r.key === '海商王刷新时间').value = '10,18,21,23';
  f.time = close - 3601;
  assert.equal(merchantDailyCloseWindow(f.config, f.event, f.settings, f.time).active, false);
  f.time++;
  assert.equal(merchantDailyCloseWindow(f.config, f.event, f.settings, f.time).active, true);
  assert.equal(merchantDailyCloseWindow(f.config, f.event, { ...f.settings, closeBeforeRest: false }, f.time), null);
  for (const mode of ['deadline', 'refresh', 'arrival', 'race', 'full', 'goal', 'targetFirst', 'eventFree', 'dailyClose']) {
    const g = fixture(); g.settings.speedUpMode = mode;
    assert.equal(g.speed().accelerationReason, 'dailyClose', mode + ' 无同行也能保住当天成交');
    g.settings.closeBeforeRest = false;
    assert.ok(!['dailyClose', 'finalClose'].includes(g.speed().accelerationReason), mode + ' 可独立关闭收市附加规则');
  }
  const guarded = fixture(); guarded.settings.guardLastPointer = true;
  guarded.time = close - 10800; guarded.state.cargo.moveStartTime = guarded.time - 6600;
  guarded.state.cargo.moveEndTime = guarded.time + 600;
  assert.equal(guarded.speed().accelerationReason, 'guard', '另行开启的最后一根防抢仍可在日间执行');
  guarded.time = close - 600; guarded.state.cargo.moveEndTime = close - 100;
  assert.equal(guarded.speed().accelerationReason, 'guard', '自然收市流程赶得上时，保留显式防抢开关的语义');
});

test('自然到港能卖货但来不及备货出航时用最少针，逐批和加速自身都计时', () => {
  const f = fixture(); f.state.cargo.moveEndTime = close - 30;
  assert.equal(f.speed().kind, 'none', '没有可见现货依据，不为假设的隔夜货加针');
  const market = { cityId: 20, period: 1, startTime: f.event.startTime, observedAt: f.time, specGoodsId: 2, rareGoodsId: 1,
    goods: [{ goodsId: 1, price: 100, stock: 0 }, { goodsId: 2, price: 50, stock: 0 }] };
  const plan = f.speed({ targetMarket: market });
  assert.deepEqual([plan.kind, plan.useNum, plan.saleCount, plan.saleSeconds, plan.spareActions], ['speed', 1, 2, 20, 2]);
  assert.equal(plan.continuation.cost, 500);
  assert.ok(Math.max(f.time + 10, plan.expected.afterEndTime) + plan.saleSeconds + plan.spareActions * 10 < close);
  f.time = close - 600; f.state.cargo.moveEndTime = close - 100;
  assert.equal(f.speed().kind, 'none', '自然完成完整流程则省针');
  f.time = close - 45; f.state.cargo.moveEndTime = close + 1800;
  const rescue = f.speed();
  assert.deepEqual([rescue.kind, rescue.useNum, rescue.spareActions], ['speed', 2, 0], '晚到仅抢救今天卖货，不承诺隔夜备货');
  f.time = close - 30;
  assert.notEqual(f.speed().kind, 'speed', '加速一轮加两批卖货恰好到收市，不能发针');
});

test('额外隔夜用针核对现货、本金、同港竞争，不把过期基线或同样赶上开市算成多一趟', () => {
  const f = fixture(); f.state.cargo.moveEndTime = close - 30;
  const market = { cityId: 20, period: 1, startTime: f.event.startTime, observedAt: f.time, specGoodsId: 2, rareGoodsId: 1,
    goods: [{ goodsId: 1, price: 100, stock: 0 }, { goodsId: 2, price: 50, stock: 0 }] };
  const options = { targetMarket: market, actor: { playerId: '1', guildId: '1001' } };
  const before = structuredClone({ state: f.state, market });
  assert.ok(f.speed(options).continuation);
  assert.deepEqual({ state: f.state, market }, before, '试算不能修改真实货舱、资金和行情');
  market.goods[1].stock = 20; assert.equal(f.speed(options).kind, 'none', '售罄就不为隔夜货用针');
  market.goods[1].stock = 0;
  market.observedAt -= 301; assert.equal(f.speed(options).kind, 'none', '过期报价不承诺现货');
  market.observedAt = f.time;
  f.state.player.coins = 0; f.state.player.goods.forEach(g => { g.num = 1; });
  f.config.tables.TradeGoodsCfg.data[1].unitPrice = 1000; market.goods[1].price = 500;
  assert.equal(f.speed(options).kind, 'none', '旧货实际回款只有200，买不起一件500的新货');
  f.state.player.coins = 1000; assert.ok(f.speed(options).continuation);
  market.goods[1].price = 50; market.goods[1].stock = 10;
  f.state.worldCargo = [{ playerId: '2', guildIdx: 1, cargo: { cityId: 30, moveToCityId: 20,
    cargoLv: 1, moveStartTime: f.time - 100, moveEndTime: f.time + 5 } }];
  assert.equal(f.speed(options).kind, 'none', '先到同港船可能买完剩下的10格，不假设能抢到');
  f.state.worldCargo[0].cargo.moveToCityId = 30;
  assert.ok(f.speed(options).continuation, '去其他港的同行不扣本港库存');
  f.state.worldCargo = [];
  f.state.cargo.moveEndTime = close - 80;
  assert.equal(f.speed(options).kind, 'none', '自然与加速均可备货并赶上明日开市，没有额外一船');
  f.time = close - 600; market.observedAt = f.time;
  f.state.cargo.moveEndTime = close - 100;
  assert.equal(f.speed(options).kind, 'none', '自然流程来得及，未来报价过期不能被当成收益差');
});

test('每刷新一程仍限制普通航次，但共用开关允许已核实的收市加速航次', () => {
  const f = fixture(); f.settings.speedUpMode = 'arrival'; f.time = close - 5400;
  const record = { confirmed: true, details: { scope: 'merchant:' + f.event.startTime + ':1',
    expected: { request: 'TradeMoveRequest', start: f.time - 10 } } };
  const ledger = { keyRecords: () => ({ first: record }) };
  const move = { kind: 'move', city: 10, destination: 20, latestActionAt: close - 100 };
  const plan = p => merchantStrategyPlan(p, f.config, f.event, f.state, f.settings, f.time, ledger);
  assert.equal(plan(move).kind, 'wait');
  assert.equal(plan({ ...move, accelerationRequired: 2 }).kind, 'move');
  f.settings.closeBeforeRest = false;
  assert.equal(plan({ ...move, accelerationRequired: 2 }).kind, 'wait');
  f.settings.closeBeforeRest = true; f.time = close - 10800; record.details.expected.start = f.time - 10;
  assert.equal(plan({ ...move, accelerationRequired: 2 }).kind, 'wait', '日间不绕过每刷新一程');
});

test('逐批卖货、按回款买隔夜货、收市前出航，次日按新实价清舱', () => {
  const f = fixture(); f.time = close - 600;
  Object.assign(f.state.cargo, { cityId: 20, moveToCityId: 0, moveEndTime: 0 });
  const market = { cityId: 20, specGoodsId: 2, rareGoodsId: 1,
    goods: [{ goodsId: 1, price: 120, stock: 0 }, { goodsId: 2, price: 60, stock: 0 }] };
  const plan = (options = {}) => planMerchant(f.config, f.event, f.state, market, f.radar, f.time, [],
    { settings: f.settings, actionSeconds: 10, ...options });
  for (let i = 0; i < 2; i++) {
    const sell = plan(); assert.equal(sell.mode, 'DAILY_CLOSE_SALE');
    const batch = f.state.player.goods.find(b => b.pid === sell.pid);
    f.state.player.coins += batch.buyPrice * batch.num + sell.gain;
    f.state.player.goods = f.state.player.goods.filter(b => b.pid !== sell.pid);
    f.time += 10;
  }
  const buy = plan(); assert.equal(buy.mode, 'OVERNIGHT'); assert.equal(buy.kind, 'buy');
  f.state.player.coins -= buy.price * buy.count;
  f.state.player.goods.push({ pid: 3, goodsId: buy.goodsId, cityId: 20, buyPrice: buy.price, num: buy.count });
  market.goods.find(g => g.goodsId === buy.goodsId).stock += buy.count;
  f.time += 10;
  const move = plan(); assert.equal(move.kind, 'move'); assert.equal(move.mode, 'OVERNIGHT');
  assert.ok(f.time + 10 < close && move.latestActionAt <= close - 10);
  assert.ok(move.plannedOpening > close);
  Object.assign(f.state.cargo, { cityId: 20, moveToCityId: move.destination, moveStartTime: f.time, moveEndTime: f.time + 7200 });
  assert.notEqual(f.speed({ plannedOpening: move.plannedOpening }).kind, 'speed', '隔夜航次自然航行');
  Object.assign(f.state.cargo, { cityId: move.destination, moveToCityId: 0, moveEndTime: 0 });
  f.time = move.plannedOpening;
  market.cityId = move.destination; market.observedAt = f.time;
  market.goods.find(g => g.goodsId === buy.goodsId).price = 55;
  const opening = plan({ plannedOpening: move.plannedOpening, openingCargoPids: [3] });
  assert.equal(opening.mode, 'OPENING_SALE'); assert.ok(opening.gain < 0, '旧隔夜清舱仍按次日实价，不沿用昨日溢价');
});

test('末日以实际收盘截止，夜间活动结束也不备隔夜货，亏损须受原限制', () => {
  const f = fixture(); f.event.endTime = close + 2 * 3600;
  f.state.cargo.moveEndTime = close - 30;
  assert.equal(merchantDailyCloseWindow(f.config, f.event, f.settings, f.time).finalDay, true);
  assert.equal(f.speed().kind, 'none', '末日不必预留下一次备货出航');
  f.state.cargo.moveEndTime = close + 300;
  assert.equal(f.speed().accelerationReason, 'finalClose');
  Object.assign(f.state.cargo, { cityId: 20, moveToCityId: 0, moveEndTime: 0 });
  const market = { specGoodsId: 2, goods: [{ goodsId: 1, price: 45, stock: 0 }, { goodsId: 2, price: 60, stock: 0 }] };
  const plan = () => planMerchant(f.config, f.event, f.state, market, f.radar, f.time, [], { settings: f.settings, actionSeconds: 10 });
  assert.notEqual(plan().kind, 'sell', '默认仍不亏损出售');
  f.event.endTime = close; // 显式清仓亏损仍仅在原配置的活动结束前窗口内允许。
  f.settings.maxLossPercent = 10;
  assert.equal(plan().kind, 'sell'); assert.equal(plan().gain, -15);
  f.state.player.goods = [];
  assert.notEqual(plan().kind, 'buy'); assert.notEqual(plan().mode, 'OVERNIGHT');
  f.event.endTime = close - 3600; f.time = f.event.endTime - 120;
  assert.equal(merchantDailyCloseWindow(f.config, f.event, f.settings, f.time).deadline, f.event.endTime);
});

test('预算、暂停、达标、空舱和已规划隔夜航次均不因收市绕过', () => {
  for (const options of [{ dailyUsed: 10 }, { periodRemaining: 0 }, { usedPointers: 4 }, { plannedOpening: close + 43200 }])
    assert.notEqual(fixture().speed(options).kind, 'speed');
  const f = fixture();
  f.stock.set(pointer, 0); assert.notEqual(f.speed().kind, 'speed');
  f.stock.set(pointer, 4); f.settings.keepPointers = 4; assert.notEqual(f.speed().kind, 'speed');
  f.settings.keepPointers = 0; f.settings.autoSpeedUp = false; assert.notEqual(f.speed().kind, 'speed');
  f.settings.autoSpeedUp = true; f.state.player.profit = 50000000; assert.notEqual(f.speed().kind, 'speed');
  f.state.player.profit = 0; f.state.player.goods = []; assert.notEqual(f.speed().kind, 'speed');
});

test('最后刷新前唤醒在途检查，收市阶段按账号间隔优先调度', () => {
  const f = fixture(), monitor = watchMerchant({}); f.time = close - 7201;
  f.state.cargo.moveEndTime = close + 100;
  monitor.observe({ ...f, settings: { merchant: { ...f.settings, monitorSeconds: 300 } } });
  assert.equal(monitor.nextCheckAt, close - 7200); assert.equal(monitor.priorityAt, close - 7200);
  f.time = close - 7200;
  monitor.observe({ ...f, settings: { merchant: { ...f.settings, monitorSeconds: 10 } } });
  assert.equal(monitor.priorityAt, f.time + 10);
});

test('泊港时也核对最少针与备货出航时间，预算不够不能先买一船依赖加速的货', () => {
  const f = fixture(); f.time = close - 5400; f.settings.liquidationMinutes = 0;
  f.state.player.goods = [];
  Object.assign(f.state.cargo, { cityId: 10, moveToCityId: 0, moveEndTime: 0 });
  const market = { specGoodsId: 1, goods: [{ goodsId: 1, price: 50, stock: 0 }] };
  const route = pins => merchantClosingRoute(f.config, f.event, f.state, market, f.radar, f.radar, f.time, [],
    { settings: f.settings, actionSeconds: 10 }, { stock: new Map([[pointer, pins]]), dailyUsed: 0, periodRemaining: pins });
  const buy = route(4); assert.equal(buy.kind, 'buy'); assert.equal(buy.accelerationRequired, 2);
  for (const mode of ['deadline', 'refresh', 'arrival', 'race', 'full', 'goal', 'targetFirst', 'eventFree']) {
    f.settings.speedUpMode = mode;
    assert.equal(route(4)?.kind, 'buy', mode + ' 泊港配货也共用已核实的收尾针数');
  }
  assert.equal(route(1), null);
  f.time = close - 50; assert.equal(route(4), null, '即使能瞬间抵港也来不及备货出航');
});

console.log('每日收市验证：' + passed + ' 项通过');
