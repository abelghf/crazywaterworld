// 人工行情、公开航线与虚拟库存；不登录真实账号。
import assert from 'node:assert/strict';
import { planMerchantSpeed } from '../src/merchant-speed.mjs';
import { visibleGuildVoyages, merchantStockPressure } from '../src/merchant-competition.mjs';

const now = Date.UTC(2026, 10, 26, 4, 1) / 1000;
function fixture() {
  const config = { tables: {
    ActivityTradeCfg: { data: [{ key: '海商王贸易时间', value: '10-22' }, { key: '海商王行驶时间', value: '120' },
      { key: '海商王加速时长', value: '30' }, { key: '海商王刷新时间', value: '10,12,14,16,18,20' }] },
    TradeShipCfg: { data: [{ lv: 1, capacity: 10, profitMargin: 300 }] },
    TradeGoodsCfg: { data: [1, 2].map(goodsId => ({ goodsId, capacity: 1, maxCount: 20, unitPrice: 100, itemName: '货' + goodsId })) }
  } };
  const actor = { playerId: '1', guildId: '1001' };
  const voyage = (id, dest = 20, eta = 120) => ({ playerId: id, guildIdx: 1,
    cargo: { cityId: 30, cargoLv: 1, moveToCityId: dest, moveStartTime: now - 100, moveEndTime: now + eta } });
  const state = { period: 1001, player: { coins: 1000, profit: 1000000, goods: [] },
    cargo: { cargoLv: 1, cityId: 10, moveToCityId: 20, moveStartTime: now - 6000, moveEndTime: now + 1200 },
    worldCargo: [voyage('2')] };
  const event = { period: 1001, startTime: now - 86400, endTime: now + 3 * 86400 };
  const radar = { radar: [{ cityId: 10, specGoodsId: 2 }, { cityId: 20, specGoodsId: 1, rareGoodsId: 2 },
    { cityId: 30, specGoodsId: 2, rareGoodsId: 1 }] };
  const policy = { autoSpeedUp: true, speedUpMode: 'targetFirst', knownPortChains: true, minPurchaseReturnPercent: 5,
    estimateDiscountPercent: 10, speedUpIntelPorts: 12, dailyPointerLimit: 100, periodPointerLimit: 220, keepPointers: 0 };
  const market = { cityId: 20, specGoodsId: 1, rareGoodsId: 2, period: event.period, startTime: event.startTime,
    observedAt: now, goods: [{ goodsId: 1, price: 50, stock: 10 }] };
  const options = { actor, markets: [market], periodRemaining: 220, actionSeconds: 10 };
  const stock = new Map([['海商王加速', 4]]);
  return { config, actor, state, event, radar, policy, options, market, stock, voyage,
    plan: () => planMerchantSpeed(config, event, state, radar, stock, policy, now, options) };
}
let passed = 0;
const test = (label, run) => { run(); passed++; console.log('通过：' + label); };

test('本轮报价支持抢货时，冲刺仅用一针越过情报门槛；达标及预算仍生效', () => {
  const f = fixture(), plan = f.plan();
  assert.equal(plan.kind, 'speed');
  assert.equal(plan.accelerationReason, 'stockRace');
  assert.equal(plan.useNum, 1);
  assert(plan.estimatedIncrementalProfit > 0);
  assert.equal(plan.rivalEta, now + 120);
  f.options.periodRemaining = 0;
  assert.notEqual(f.plan().kind, 'speed');
  f.options.periodRemaining = 220; f.policy.dailyPointerLimit = 0;
  assert.notEqual(f.plan().kind, 'speed');
  f.policy.dailyPointerLimit = 100; f.state.player.profit = 50000000;
  assert.equal(f.plan().kind, 'none');
});

test('同港有船但余货足够不产生抢货收益，其他港和其他联盟不触发用针', () => {
  const f = fixture();
  f.market.goods[0].stock = 0; // 20件货，对方最多10件，本船仍可买10件。
  assert.notEqual(f.plan().kind, 'speed');
  f.market.goods[0].stock = 10; f.state.worldCargo[0].cargo.moveToCityId = 10;
  assert.notEqual(f.plan().kind, 'speed');
  f.state.worldCargo[0].cargo.moveToCityId = 20; f.state.worldCargo[0].guildIdx = 2;
  assert.notEqual(f.plan().kind, 'speed');
});

test('缺少、过期、跨轮和未来报价不构造抢货利润；同行到港即可买', () => {
  for (const offset of [-360, -7200, 1]) {
    const f = fixture(); f.market.observedAt = now + offset;
    assert.notEqual(f.plan().kind, 'speed');
  }
  const f = fixture(); f.options.markets = [];
  assert.notEqual(f.plan().kind, 'speed');
  f.options.markets = [f.market]; f.state.worldCargo.push(f.voyage('3', 20, 5));
  assert.notEqual(f.plan().kind, 'speed', '不能只抢过第二艘，忽略先到且可立即购买的船');
});

test('历史同轮耗库也可支持抢货；本人采购量必须剔除，不混用不同次到访', () => {
  const f = fixture(); f.options.markets = [];
  const before = { ...structuredClone(f.market), observedAt: now - 7200, held: [], visitStart: 1 };
  const after = { ...structuredClone(before), observedAt: now - 6660, goods: [{ goodsId: 1, price: 50, stock: 20 }] };
  f.options.marketHistory = [before, after];
  assert.equal(f.plan().accelerationReason, 'stockRace');
  after.held = [{ cityId: 20, goodsId: 1, num: 10 }];
  assert.notEqual(f.plan().kind, 'speed', '自己买走10件不是同行造成的缺货');
  after.held = []; after.visitStart = 2;
  assert.notEqual(f.plan().kind, 'speed');
});

test('同行加速后的较早ETA去重，容量按船级折算；本人及非法航程剔除', () => {
  const f = fixture();
  f.state.worldCargo = [f.voyage('2', 20, 300), f.voyage('2', 20, 60), f.voyage('1'),
    { ...f.voyage('4'), guildIdx: 2 }];
  const voyages = visibleGuildVoyages(f.state, f.actor, now);
  assert.equal(voyages.length, 1);
  assert.equal(voyages[0].moveEndTime, now + 60);
  const pressure = merchantStockPressure(f.config, voyages, 20, { capacity: 2 }, now + 60, 20);
  assert.equal(pressure.potentialRemaining, 15);
  assert.equal(merchantStockPressure(f.config, voyages, 20, { capacity: 2 }, now + 59, 20).potentialRemaining, 20);
});

console.log('海商王竞争回归：' + passed + ' 项通过');
