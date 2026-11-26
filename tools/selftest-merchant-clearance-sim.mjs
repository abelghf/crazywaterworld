import assert from 'node:assert/strict';
import { planMerchant, merchantTiming } from '../src/merchant-planner.mjs';
import { experimentalClearance } from './merchant-clearance-policy.mjs';

function fixture() {
  const time = Date.UTC(2026, 10, 26, 4, 10) / 1000;
  const config = { tables: {
    ActivityTradeCfg: { data: [['海商王贸易时间', '10-22'], ['海商王行驶时间', '120'],
      ['海商王刷新时间', '10,12,14,16,18,20']].map(([key, value]) => ({ key, value })) },
    TradeShipCfg: { data: [{ lv: 1, capacity: 10, profitMargin: 0 }] },
    TradeGoodsCfg: { data: [{ goodsId: 1, capacity: 1, unitPrice: 100, maxCount: 10, itemName: '旧货' },
      { goodsId: 2, capacity: 1, unitPrice: 30, maxCount: 10, itemName: '新货' },
      { goodsId: 3, capacity: 1, unitPrice: 100, maxCount: 10, itemName: '其他' }] }
  } };
  const event = { period: 1, startTime: time - 86400, endTime: time + 172800 };
  const state = { period: 1, cargo: { cityId: 10, cargoLv: 1, moveEndTime: 0, moveToCityId: 0 },
    player: { coins: 0, profit: 1000000, goods: [{ pid: 1, goodsId: 1, cityId: 90, buyPrice: 100, num: 10 }] } };
  const market = { cityId: 10, specGoodsId: 2, rareGoodsId: 3, observedAt: time,
    goods: [{ goodsId: 1, price: 90, stock: 10 }, { goodsId: 2, price: 10, stock: 0 }] };
  const radar = { radar: [{ cityId: 10, specGoodsId: 2, rareGoodsId: 3 }, { cityId: 20, specGoodsId: 3, rareGoodsId: 2 }] };
  const options = { settings: { knownPortChains: false, minPurchaseReturnPercent: 5 }, actionSeconds: 10,
    actor: { playerId: '1', guildId: '1001' }, markets: [] };
  const f = { config, event, state, market, radar, options, time };
  f.plan = variant => experimentalClearance(config, event, state, market, radar, f.time, [], options,
    planMerchant(config, event, state, market, radar, f.time, [], options), variant, planMerchant);
  return f;
}
let tests = 0;
const test = (name, fn) => { fn(); tests++; console.log('通过：' + name); };
test('亏损不扣目标进度，但先扣实际本金再计算可采购组合，预测不改变真实状态', () => {
  const f = fixture(), before = structuredClone(f.state), plan = f.plan('opportunity');
  assert.equal(plan.kind, 'sell');
  assert.equal(plan.gain, -100);
  assert.equal(plan.clearance.cashAfterClear, 900);
  assert.equal(plan.clearance.purchaseCost, 100);
  assert.equal(plan.clearance.clearScore, 200);
  assert.deepEqual(f.state, before);
  assert.notEqual(f.plan('sellFirst').gain, -100);
  assert.equal(f.plan('clearAll').gain, -100);
});
test('现货耗尽或公开同行会先买完时，不能凭后续虚构收益清仓', () => {
  const f = fixture(); f.market.goods[1].stock = 10;
  assert.equal(f.plan('opportunity').experiment, undefined);
  f.market.goods[1].stock = 0;
  f.state.worldCargo = [{ playerId: '2', guildIdx: 1, cargo: { cityId: 20, moveToCityId: 10,
    cargoLv: 1, moveStartTime: f.time - 100, moveEndTime: f.time + 5 } }];
  assert.equal(f.plan('opportunity').experiment, undefined);
});
test('清仓吃掉本金后买不起替代商品，不能按清仓前成本承诺后续收益', () => {
  const f = fixture();
  f.market.goods[0].price = 1; // 整船成本1000，但只能回款10。
  f.market.goods[1].price = 20;
  assert.equal(f.plan('opportunity').experiment, undefined);
  assert.equal(f.plan('clearAll').gain, -990, '无条件清仓对照仍会执行这笔损失');
});
test('继续持货收益更高或换货会跨刷新时保留原计划，达标后不继续实验清仓', () => {
  const f = fixture();
  f.state.player.goods[0].buyPrice = 95;
  f.radar.radar[1].rareGoodsId = 1;
  f.options.markets = [ { ...f.market, cityId: 20, specGoodsId: 3, rareGoodsId: 1,
    period: f.event.period, startTime: f.event.startTime, goods: [{ goodsId: 1, price: 200, stock: 0 }] },
    { ...f.market, cityId: 20, specGoodsId: 3, rareGoodsId: 1, observedAt: f.time - 7200,
      period: f.event.period, startTime: f.event.startTime, goods: [{ goodsId: 1, price: 200, stock: 0 }] } ];
  assert.equal(f.plan('opportunity').experiment, undefined);
  const g = fixture();
  g.time = merchantTiming(g.config, g.event, g.time).nextRefreshAt - 5;
  g.market.observedAt = g.time;
  assert.equal(g.plan('opportunity').experiment, undefined);
  g.state.player.profit = 50000000;
  assert.equal(g.plan('clearAll').experiment, undefined);
});
test('来源港货物不可出售，不能按整船成本虚构回款', () => {
  const f = fixture(); f.state.player.goods[0].cityId = 10;
  for (const variant of ['sellFirst', 'clearAll', 'opportunity']) assert.equal(f.plan(variant).experiment, undefined);
});
console.log('清仓实验核验：' + tests + ' 项通过');
