import { merchantTiming, planMerchant } from './merchant-planner.mjs';
import { visibleGuildVoyages, merchantStockPressure } from './merchant-competition.mjs';

// worldCargo 只描述航程。停港者以及对方的货舱、资金和采购意图均不可见。
export function merchantCompetitorArrivals(state, actor, time, refreshAt) {
  return visibleGuildVoyages(state, actor, time).filter(v => v.moveToCityId === state.cargo.moveToCityId && v.moveEndTime >= refreshAt)
    .map(v => v.moveEndTime).sort((a, b) => a - b);
}

export function merchantOpeningRadar(radar, state, actor, time, opening) {
  if (!Array.isArray(radar?.radar)) return radar;
  const counts = new Map();
  for (const v of visibleGuildVoyages(state, actor, time)) {
    if (v.moveEndTime <= opening) counts.set(v.moveToCityId, (counts.get(v.moveToCityId) ?? 0) + 1);
  }
  if (!counts.size) return radar;
  return { ...radar, radar: radar.radar.map(p => counts.has(p?.cityId) ? { ...p, openingShips: counts.get(p.cityId) } : p) };
}

// 在相同本人资金、批次和设置下，用以往到访的库存重算到港卖旧货、再配新货的机会。
// 只统计新采购的潜在利润，旧货本来就能卖的利润不归到抢先到港。
function modelPurchase(config, event, state, radar, sample, arrival, settings, actionSeconds) {
  const cityId = state.cargo.moveToCityId;
  const docked = { period: event.period, cargo: { ...state.cargo, cityId, moveToCityId: 0, moveEndTime: 0 },
    player: { ...state.player } };
  const epoch = merchantTiming(config, event, arrival).marketEpoch;
  let time = arrival;
  for (;;) {
    // 这是同一报价条件下的早/晚到港反事实比较，原采集时效在入口验证；不能让晚到分支
    // 仅因 observedAt 过期返回零利润，否则库存充足也会被误报为抢货增益。
    const plan = planMerchant(config, event, docked, { goods: sample.goods,
      specGoodsId: sample.specGoodsId, rareGoodsId: sample.rareGoodsId }, radar, time, [], { settings, actionSeconds });
    if (plan.kind === 'buy') {
      const readyAt = time + actionSeconds * plan.purchases.length;
      const window = merchantTiming(config, event, readyAt);
      if (window.marketEpoch !== epoch) return { profit: null, readyAt };
      if (settings.speedUpMode === 'arrival' &&
        window.marketEpoch === merchantTiming(config, event, state.cargo.moveStartTime).marketEpoch &&
        window.nextRefreshAt + window.travelSeconds + (1 + plan.purchases.length) * actionSeconds >= window.tradeEndTime)
        return { profit: 0, readyAt };
      return { profit: plan.purchases.reduce((sum, row) => sum + row.gain, 0), readyAt };
    }
    if (plan.kind !== 'sell') return { profit: plan.mode === 'WAIT_REFRESH' ? null : 0, readyAt: time };
    const batch = docked.player.goods.find(row => row.pid === plan.pid);
    docked.player.goods = docked.player.goods.filter(row => row.pid !== plan.pid);
    docked.player.coins += batch.buyPrice * batch.num + plan.gain;
    docked.player.profit += Math.max(0, plan.gain);
    time += actionSeconds;
    if (merchantTiming(config, event, time).marketEpoch !== epoch) return { profit: null, readyAt: time };
    if (settings.profitLimit > 0 && docked.player.profit >= settings.profitLimit) return { profit: 0, readyAt: time };
  }
}

export function estimateMerchantRace(config, event, state, radar, time, settings, options, rival, actionSeconds) {
  const natural = state.cargo.moveEndTime, city = state.cargo.moveToCityId;
  const epoch = merchantTiming(config, event, natural).previousRefreshAt;
  const port = radar?.radar?.find(row => row?.cityId === city);
  if (!port || !epoch || !rival || rival < epoch || rival > natural)
    return () => null;
  const definition = config.tables.TradeGoodsCfg?.data?.find(g => g.goodsId === port.specGoodsId);
  const maxAge = settings.quoteMaxAgeSeconds ?? 300;
  const sample = [...(options.markets ?? []), ...(options.marketHistory ?? [])].filter(m =>
    m?.cityId === city && m.period === event.period && m.startTime === event.startTime &&
    Number.isSafeInteger(m.observedAt) && m.observedAt >= epoch && m.observedAt <= time && time - m.observedAt <= maxAge &&
    m.specGoodsId === port.specGoodsId && (!port.rareGoodsId || m.rareGoodsId === port.rareGoodsId) && Array.isArray(m.goods) &&
    new Set(m.goods.map(g => g?.goodsId)).size === m.goods.length && m.goods.every(g =>
      Number.isSafeInteger(g?.goodsId) && Number.isSafeInteger(g.price) && g.price > 0 &&
      Number.isSafeInteger(g.stock) && g.stock >= 0))
    .sort((a, b) => b.observedAt - a.observedAt)[0];
  const voyages = visibleGuildVoyages(state, options.actor, time);
  const cycles = new Map();
  for (const market of options.marketHistory ?? []) {
    if (market?.cityId !== city || market.period !== event.period || market.startTime !== event.startTime ||
      !Number.isSafeInteger(market.observedAt) || market.observedAt < event.startTime || market.observedAt > time ||
      market.specGoodsId !== port.specGoodsId || (port.rareGoodsId && market.rareGoodsId !== port.rareGoodsId) ||
      !Array.isArray(market.goods) || market.goods.some(row => !row || !Number.isSafeInteger(row.goodsId) ||
        !Number.isSafeInteger(row.price) || row.price <= 0 || !Number.isSafeInteger(row.stock) || row.stock < 0)) continue;
    const start = merchantTiming(config, event, market.observedAt).previousRefreshAt;
    if (!start) continue;
    if (!cycles.has(start)) cycles.set(start, []);
    cycles.get(start).push({ ...market, offset: market.observedAt - start });
  }
  const histories = [...cycles].sort(([a], [b]) => b - a).map(([, rows]) => rows.sort((a, b) => a.offset - b.offset));
  return early => {
    // 提前跨到上一轮会触发实际到港交易。等刷新唤醒后重算，避免把下一轮库存计入上一轮。
    if (early < epoch || early + actionSeconds >= rival || early >= natural) return null;
    const quote = sample?.goods.find(g => g.goodsId === definition?.goodsId);
    if (quote && Number.isSafeInteger(definition.maxCount) && definition.maxCount >= quote.stock) {
      const initial = modelPurchase(config, event, state, radar, sample, early, settings, actionSeconds);
      // 同一轮有效报价，只预测特产被先到船采购的影响，不把每种货都各扣一整船。
      // 全部计划采购完成在对手到港之前才计入抢先收益；无货舱信息时按到港即可买处理。
      if (initial.profit > 0 && initial.readyAt < rival && initial.readyAt <= sample.observedAt + maxAge) {
        const pressure = merchantStockPressure(config, voyages, city, definition, natural,
          definition.maxCount - quote.stock, sample.observedAt);
        const laterSample = { ...sample, goods: sample.goods.map(g => g.goodsId === definition.goodsId
          ? { ...g, stock: definition.maxCount - pressure.potentialRemaining } : g) };
        const later = modelPurchase(config, event, state, radar, laterSample, natural, settings, actionSeconds);
        const uncontested = modelPurchase(config, event, state, radar, sample, natural, settings, actionSeconds);
        const gain = later.profit !== null && uncontested.profit !== null
          ? Math.min(initial.profit, uncontested.profit) - later.profit : 0;
        if (gain > 0) return { gain,
          baseline: later.profit, source: 'visible-capacity',
          expiresAt: Math.min(sample.observedAt + maxAge, rival - (initial.readyAt - early) - 1) };
      }
    }
    for (const rows of histories) {
      // 同一实际刷新周期内两次观测，落入抢先到港和自然到港之间的时间范围。
      const before = rows.find(row => row.offset >= early - epoch);
      const after = rows.findLast(row => row.offset <= natural - epoch);
      if (!before || !after || before.offset >= after.offset || before.visitStart !== after.visitStart) continue;
      if (before.rareGoodsId && after.rareGoodsId && before.rareGoodsId !== after.rareGoodsId) continue;
      const rareGoodsId = before.rareGoodsId || after.rareGoodsId || port.rareGoodsId;
      // 同一批挂牌货比较早晚已购量。换价、缺项或库存倒退不能作为耗库证据。
      const old = new Map(before.goods.map(row => [row.goodsId, row]));
      if (old.size !== before.goods.length || old.size !== after.goods.length || new Set(after.goods.map(row => row.goodsId)).size !== old.size ||
        after.goods.some(row => !old.has(row.goodsId) ||
        old.get(row.goodsId).price !== row.price || old.get(row.goodsId).stock > row.stock)) continue;
      // 自己在这次停港采购的数量也进入联盟已购量，不能把它算作晚到的损失。
      const held = (sample, id) => (sample.held ?? []).reduce((sum, batch) =>
        sum + (batch.cityId === city && batch.goodsId === id ? batch.num : 0), 0);
      const laterGoods = after.goods.map(row => ({ ...row, stock: Math.max(old.get(row.goodsId).stock,
        row.stock - Math.max(0, held(after, row.goodsId) - held(before, row.goodsId))) }));
      if (!laterGoods.some(row => old.get(row.goodsId).stock < row.stock)) return null;
      const initial = modelPurchase(config, event, state, radar, { goods: before.goods, rareGoodsId }, early, settings, actionSeconds);
      if (!initial.profit || initial.readyAt >= rival) return null;
      const later = modelPurchase(config, event, state, radar, { goods: laterGoods, rareGoodsId }, natural, settings, actionSeconds);
      if (later.profit === null) return null;
      const gain = initial.profit - later.profit;
      return gain > 0 ? { gain, baseline: later.profit, source: 'observed-depletion',
        expiresAt: Math.min(epoch + before.offset, rival - (initial.readyAt - early) - 1) } : null;
    }
    return null;
  };
}
