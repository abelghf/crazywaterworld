// 仅供离线实验。生产走商不导入此模块，也不修改用户亏损上限。
import { merchantTiming } from '../src/merchant-planner.mjs';
import { visibleGuildVoyages, merchantStockPressure } from '../src/merchant-competition.mjs';

const target = 50_000_000;
const gainFor = (config, state, batch, price) => {
  const delta = (price - batch.buyPrice) * batch.num;
  const ship = config.tables.TradeShipCfg.data.find(s => s.lv === state.cargo.cargoLv);
  return delta > 0 ? Math.ceil(delta * (10000 + ship.profitMargin) / 10000) : delta;
};
const sale = (config, state, market, batch) => {
  const price = market.goods.find(g => g.goodsId === batch.goodsId)?.price;
  if (batch.cityId === state.cargo.cityId || !(price > 0)) return null;
  return { kind: 'sell', mode: 'EXPERIMENT_CLEAR', pid: batch.pid, goodsId: batch.goodsId,
    city: state.cargo.cityId, count: batch.num, price, gain: gainFor(config, state, batch, price) };
};
const applySale = (state, plan) => {
  const batch = state.player.goods.find(g => g.pid === plan.pid);
  state.player.coins += batch.buyPrice * batch.num + plan.gain;
  state.player.profit += Math.max(0, plan.gain);
  state.player.goods = state.player.goods.filter(g => g.pid !== plan.pid);
};

export function experimentalClearance(config, event, state, market, radar, time, visited, options, base, variant, planner) {
  if (!['sellFirst', 'clearAll', 'opportunity'].includes(variant) || state.player.profit >= target ||
    base.mode === 'OPENING_SALE' || options.openingCargoPids?.length || !merchantTiming(config, event, time).tradingOpen)
    return base;
  const available = state.player.goods.map(b => sale(config, state, market, b)).filter(Boolean)
    .sort((a, b) => b.gain - a.gain || a.pid - b.pid);
  if (!available.length) return base;
  if (variant !== 'opportunity') {
    if (base.kind === 'sell' && base.gain >= 0) return base; // 保留先卖小单解锁船级的顺序。
    const chosen = available.find(p => variant === 'clearAll' || p.gain >= 0);
    return chosen ? { ...chosen, experiment: variant } : base;
  }
  if (base.kind === 'sell') return base; // 原策略已经选择出售时先正常执行，再按新本金复算。
  const step = options.actionSeconds, timing = merchantTiming(config, event, time);
  const expires = Math.min(timing.nextRefreshAt, timing.tradeEndTime,
    market.observedAt + (options.settings.quoteMaxAgeSeconds ?? 300));
  const voyages = visibleGuildVoyages(state, options.actor, time);
  const definition = config.tables.TradeGoodsCfg.data.find(g => g.goodsId === market.specGoodsId);
  // 只用当前港实价、自己的仓位与公开航程。不能查看世界模拟器中的后续库存或对手钱包。
  const projectedMarket = ready => {
    const copy = structuredClone(market), quote = copy.goods.find(g => g.goodsId === definition?.goodsId);
    if (quote) {
      const pressure = merchantStockPressure(config, voyages, state.cargo.cityId, definition, ready,
        definition.maxCount - quote.stock, time);
      quote.stock = definition.maxCount - pressure.potentialRemaining;
    }
    return copy;
  };
  const preview = () => {
    const copy = structuredClone(state), originalProfit = copy.player.profit;
    let at = time, loss = 0, first = null;
    const remaining = available.map(p => p.pid);
    for (let i = 0; i < state.player.goods.length * 2 + 12; i++) {
      if (at >= expires) return null;
      const upgrade = options.settings.autoUpgrade && config.tables.TradeShipCfg.data.find(s =>
        s.lv === copy.cargo.cargoLv + 1 && copy.player.profit >= s.upMoney);
      if (upgrade) { copy.cargo.cargoLv++; at += step; continue; }
      let plan;
      if (remaining.length) {
        const batch = copy.player.goods.find(g => g.pid === remaining.shift());
        plan = sale(config, copy, market, batch);
      } else {
        plan = planner(config, event, copy, projectedMarket(at), radar, at, visited, options);
      }
      if (plan.kind === 'sell') {
        first ??= plan;
        applySale(copy, plan);
        loss += Math.max(0, -plan.gain);
        if (copy.player.coins < 0) return null;
        at += step;
        continue;
      }
      if (plan.kind === 'buy') {
        const ready = at + plan.purchases.length * step;
        if (ready >= expires) return null;
        // 清舱及所有采购期间先到的同行都算进去，再重配一次。
        plan = planner(config, event, copy, projectedMarket(ready), radar, at, visited, options);
        if (plan.kind !== 'buy' || at + plan.purchases.length * step >= expires) return null;
      }
      const forecast = ['buy', 'move'].includes(plan.kind) && !plan.exploration && !plan.plannedOpening
        ? Math.max(0, plan.expectedScore ?? plan.expectedProfit ?? 0) : 0;
      return { first, loss, plan, coins: copy.player.coins, ready: at,
        score: Math.max(0, copy.player.profit - originalProfit) + forecast };
    }
    return null;
  };
  // 直接采用已通过正常/收尾规划的原方案，不能重算时漏掉其已核实的加速收益。
  const keep = { score: ['buy', 'move'].includes(base.kind) && !base.exploration && !base.plannedOpening
    ? Math.max(0, base.expectedScore ?? base.expectedProfit ?? 0) : 0 };
  const clear = preview();
  if (!clear?.first || clear.plan.kind !== 'buy' || clear.plan.plannedOpening ||
    !clear.plan.purchases?.length || clear.plan.expectedProfit <= 0) return base;
  const remaining = target - state.player.profit;
  const normalProgress = Math.min(remaining, keep.score), clearProgress = Math.min(remaining, clear.score);
  // 预先固定10%的增益门槛，不从目标进度中扣亏损；亏损已从配货本金扣除。
  const required = Math.max(options.settings.minExpectedProfit ?? 1, normalProgress * 0.1);
  if (clearProgress - normalProgress < required) return base;
  return { ...clear.first, experiment: variant, clearance: { keepScore: keep.score, clearScore: clear.score,
    cashAfterClear: clear.coins, liquidationLoss: clear.loss, nextPort: clear.plan.destination,
    purchaseCost: clear.plan.purchases.reduce((n, p) => n + p.count * p.price, 0) } };
}
