// 离线共享库存竞争模拟。复用生产交易规划，实验策略仅作用于本脚本。
// 运行说明与情景假设见 output/merchant-competition-20261126/。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { experimentalClearance } from './merchant-clearance-policy.mjs';
const engineRoot = process.env.MC_ENGINE_ROOT ?? path.resolve(import.meta.dirname, '..');
const engine = name => import(pathToFileURL(path.join(engineRoot, 'src', name + '.mjs')).href);
const { merchantPresets } = await engine('merchant-presets');
const { planMerchant, merchantTiming } = await engine('merchant-planner');
const { merchantStrategyPlan } = await engine('merchant-strategy');
const { planMerchantSpeed, merchantClosingRoute } = await engine('merchant-speed');

const [file, seedsArg = '8', grantSource = 'rewards', firstSeedArg = '1', selected, stockArg = '139', baseline = 'legacy'] = process.argv.slice(2);
const seeds = Number(seedsArg), firstSeed = Number(firstSeedArg);
const dailyGrant = /^\d+$/.test(grantSource) ? Number(grantSource) : null;
const sprintStock = Number(stockArg);
if (!file || !Number.isSafeInteger(seeds) || seeds < 1 || !Number.isSafeInteger(firstSeed) || firstSeed < 1 ||
  (dailyGrant !== null && !Number.isSafeInteger(dailyGrant)) || !Number.isSafeInteger(sprintStock) || sprintStock < 0 ||
  !['legacy', 'v70'].includes(baseline) || (selected && selected !== 'sprint'))
  throw Error('用法：node tools/merchant-competition-sim.mjs <四天观察文件> [行情组数] [rewards|到账记录.json|固定每日针数] [起始种子] [sprint] [开局针数] [v70]；旧决策层通过 MC_ENGINE_ROOT 选择');
const config = loadConfig(), defs = new Map(config.tables.TradeGoodsCfg.data.map(g => [g.goodsId, g]));
const snapshots = JSON.parse(fs.readFileSync(file, 'utf8')).entries.filter(e => e.type === 'snapshot');
const event = snapshots[0]?.event, day = 86400, pointer = '海商王加速';
if (!event || event.endTime - event.startTime !== 4 * day || snapshots.some(s =>
  s.event.period !== event.period || s.event.startTime !== event.startTime)) throw Error('需要同一完整四天期次的行情样本');
const ports = snapshots.at(-1).radar.radar.filter(p => defs.has(p.specGoodsId));
const goods = [...new Set(ports.map(p => p.specGoodsId))];
// 固定每日针数保留旧模拟口径。其余场景也把开局以后到账的免费奖励计入冲刺库存。
function forecastFunding(source) {
  if (dailyGrant !== null) return (time, profit, d, rounds) => d * dailyGrant + Math.floor(rounds * dailyGrant / 6);
  if (source !== 'rewards') {
    const ledger = JSON.parse(fs.readFileSync(source, 'utf8'));
    if (ledger?.period !== event.period || ledger.startTime !== event.startTime || !Array.isArray(ledger.grants) || ledger.grants.some(g =>
      !g || !Number.isSafeInteger(g.time) || g.time < event.startTime || g.time >= event.endTime || !Number.isSafeInteger(g.amount) || g.amount <= 0))
      throw Error('到账记录需要同一期次及有效的到账时间和数量');
    return time => ledger.grants.reduce((sum, g) => sum + (g.time <= time ? g.amount : 0), 0);
  }
  const quantity = rewards => rewards.reduce((n, [item, count]) => n + (item === pointer ? count : 0), 0);
  const tasks = config.tables.TradeGuildTaskCfg.data;
  const reports = config.tables.TradeDayRewardCfg.data;
  const pass = config.tables.TradePassCfg.data.filter(row => row.period === event.period && quantity(row.freeReward));
  // 联盟满参与情景：把当天任务和三档商情奖励分配到六轮刷新；战令按模拟累计利润解锁。
  const byDay = [];
  let prior = 0;
  for (let d = 0; d < 4; d++) {
    const unlocked = tasks.filter(row => row.day === d + 1);
    const grants = Array.from({length: 7}, (_, rounds) => prior + [unlocked, reports].reduce((sum, rows) =>
      sum + rows.slice(0, Math.floor(rounds * rows.length / 6)).reduce((n, r) => n + quantity(r.rewards), 0), 0));
    byDay.push(grants);
    prior = grants[6];
  }
  return (time, profit, d, rounds) => byDay[d][rounds] + pass.reduce((sum, tier) => sum + (profit >= tier.reqScore ? quantity(tier.freeReward) : 0), 0);
}
const earnedAt = forecastFunding(grantSource);
const roles = new Map(), seen = new Set();
const timings = new Map();
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}
function addSample(key, value) {
  if (!roles.has(key)) roles.set(key, []);
  roles.get(key).push(value);
}
for (const s of snapshots) {
  const m = s.market, key = m.cityId + ':' + s.marketEpoch;
  if (!m.rareGoodsId || !merchantTiming(config, event, m.observedAt).tradingOpen) continue;
  if (Number.isFinite(s.actionSeconds) && s.actionSeconds > 0) {
    if (!timings.has(key)) timings.set(key, []);
    timings.get(key).push(s.actionSeconds);
  }
  if (seen.has(key)) continue;
  seen.add(key);
  for (const row of m.goods) {
    const def = defs.get(row.goodsId);
    const role = row.goodsId === m.specGoodsId ? 'special' : row.goodsId === m.rareGoodsId ? 'rare' : 'ordinary';
    const observed = { priceRatio: row.price / def.unitPrice, usedFraction: row.stock / def.maxCount };
    addSample(role, observed);
    addSample(role + def.qualityIndex, observed);
  }
}
if (!roles.has('special') || !roles.has('rare') || !roles.has('ordinary') || !timings.size) throw Error('快照缺少可用的行情或操作间隔');
const step = Math.max(60, Math.ceil(median(Array.from(timings.values(), median))));
function makeWorld(seed) {
  let randomState = seed;
  const random = () => ((randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0) / 4294967296);
  const world = [];
  for (let d = 0; d < 4; d++) {
    const order = ports.map(p => ({ ...p, roll: random() })).sort((a,b) => a.roll-b.roll);
    const offset = 1 + Math.floor(random() * (order.length - 1));
    const cities = order.map((p,i) => ({ cityId: p.cityId, specGoodsId: p.specGoodsId,
      rareGoodsId: order[(i + offset) % order.length].specGoodsId, reveal: process.env.MC_INTEL === 'full' ? 0 : Math.floor(i * (process.env.MC_INTEL === 'slow' ? 12 : 6) / order.length) }));
    for (let round = 0; round < 6; round++) {
      const markets = new Map(cities.map(port => [port.cityId, { ...port, goods: goods.map(goodsId => {
        const def = defs.get(goodsId), role = goodsId === port.specGoodsId ? 'special' : goodsId === port.rareGoodsId ? 'rare' : 'ordinary';
        const pool = roles.get(role + def.qualityIndex) ?? roles.get(role);
        const observed = pool[Math.floor(random() * pool.length)];
        return { goodsId, price: Math.round(def.unitPrice * observed.priceRatio), stock: Math.round(def.maxCount * observed.usedFraction) };
      }) }]));
      world.push({ cities, markets });
    }
  }
  return world;
}

const goal = 50_000_000;
const rivalCount = Number(process.env.MC_RIVALS ?? 0);
const variants = (process.env.MC_VARIANTS ?? 'baseline,noGate,refresh8,refresh20,window20,sync20').split(',');
const cap = Number(process.env.MC_CAP ?? 220);
const rivalStep = Number(process.env.MC_RIVAL_STEP ?? 30);
const rivalWindow = Number(process.env.MC_RIVAL_WINDOW ?? 30) * 60;
const rivalDailyLimit = Number(process.env.MC_RIVAL_DAILY ?? 100);
const rivalDistribution = process.env.MC_DISTRIBUTION ?? 'greedy';
if (!['greedy', 'diverse', 'staggered', 'mixed'].includes(rivalDistribution)) throw Error('未知同行分布情景');
// 执行耗时与无动作时的检查周期分别建模，历史 actionSeconds 只是旧规划估计。
const selfStep = Number(process.env.MC_SELF_STEP ?? step);
const pollSeconds = Number(process.env.MC_POLL_SECONDS ?? selfStep);
if (![selfStep, pollSeconds, rivalStep].every(n => Number.isSafeInteger(n) && n >= 1)) throw Error('操作/检查耗时必须为正整数秒');
const trace = process.env.MC_TRACE === '1';
function rng(seed) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
}
function bookAt(world, time) {
  const d = Math.floor((time - event.startTime) / day);
  const timing = merchantTiming(config, event, time);
  const round = Math.max(0, Math.min(5, Math.floor((time - timing.tradeStartTime) / 7200)));
  return { book: world[d * 6 + round], d, round, timing };
}
function sharedQuote(world, time, cityId) {
  return bookAt(world, time).book.markets.get(cityId);
}
function gainFor(batch, price, lv) {
  const difference = (price - batch.buyPrice) * batch.num;
  const ship = config.tables.TradeShipCfg.data.find(s => s.lv === lv);
  return difference > 0 ? Math.ceil(difference * (10000 + ship.profitMargin) / 10000) : difference;
}
function takeStock(row, count, buyer = 'self') {
  if (!Number.isSafeInteger(count) || count <= 0 || row.stock + count > defs.get(row.goodsId).maxCount)
    throw Error('共享库存越界');
  row.initialStock ??= row.stock;
  row.selfBought ??= 0; row.rivalBought ??= 0;
  row[buyer === 'self' ? 'selfBought' : 'rivalBought'] += count;
  row.stock += count;
}

// 对手逐笔操作，拥有自己的现金、货物、船级、航程和用针账本。
// 只查看所在港的实价/库存及当时已公开的紧缺；不读取未来报价或他人现金。
function createRivals(world, seed, n) {
  const random = rng(seed ^ 0x71c3a95b);
  const bots = Array.from({ length: n }, (_, index) => ({
    id: index + 2, cityId: ports[Math.floor(random() * ports.length)].cityId,
    lv: 1, coins: 10000, profit: 0, goods: [], pins: 0, daily: [0, 0, 0, 0],
    next: event.startTime + 10 * 3600 + Math.floor(random() * 180),
    action: Math.max(5, Math.round(rivalStep * (0.8 + random() * 0.4))),
    reaction: 15 + Math.floor(random() * 75), voyage: null, seen: new Set(), seenDay: -1,
    destination: null, purchases: 0, moves: 0, buyCells: [0, 0, 0, 0], netGain: 0,
  }));
  // 使用独立随机流，保持旧情景的起点、反应和行情完全不变。
  for (const bot of bots) {
    const profile = rng(seed ^ Math.imul(bot.id, 0x5bd1e995));
    bot.choose = profile;
    bot.windowOffset = ['staggered', 'mixed'].includes(rivalDistribution) ? Math.floor(profile() * 4) * 1800 : 0;
  }
  const purchasesByPortRound = new Map(), census = { samples: 0, maxAtPortHistogram: {}, occupiedPortsSum: 0, dockedShipsSum: 0 };
  let nextCensus = event.startTime + 10 * 3600;
  function recordCensus(time) {
    const timing = merchantTiming(config, event, time);
    if (!timing.tradingOpen) { nextCensus = time < timing.tradeStartTime ? timing.tradeStartTime : timing.tradeStartTime + day; return; }
    const counts = new Map();
    for (const bot of bots) {
      if (bot.voyage?.end > time) continue;
      const city = bot.voyage ? bot.voyage.target : bot.cityId;
      counts.set(city, (counts.get(city) ?? 0) + 1);
    }
    const peak = Math.max(0, ...counts.values());
    census.samples++; census.maxAtPortHistogram[peak] = (census.maxAtPortHistogram[peak] ?? 0) + 1;
    census.occupiedPortsSum += counts.size; census.dockedShipsSum += [...counts.values()].reduce((a, b) => a + b, 0);
    nextCensus = time + 60;
  }
  const botPrice = (def, port) => Math.floor(def.unitPrice *
    (port.specGoodsId === def.goodsId ? 0.85 : port.rareGoodsId === def.goodsId ? 1.12 : 0.98));
  function act(bot) {
    const time = bot.next;
    if (time >= event.endTime) { bot.next = Infinity; return; }
    const { book, d, round, timing } = bookAt(world, time);
    const inRivalWindow = timing.tradingOpen && time - timing.previousRefreshAt >= bot.windowOffset &&
      time - timing.previousRefreshAt < bot.windowOffset + rivalWindow;
    if (bot.voyage) {
      if (bot.voyage.end > time) {
        // 每个对手整期220、每天100；只在刷新后的抢货窗口加速。
        const earned = earnedAt(time, bot.profit, d, time < timing.tradeStartTime ? 0 : round + 1);
        const count = Math.min(4 - bot.voyage.pins, Math.ceil((bot.voyage.end - time) / 1800),
          220 - bot.pins, 169 + earned - bot.pins, rivalDailyLimit - bot.daily[d]);
        if (inRivalWindow &&
            bot.goods.length && bot.profit < goal && count > 0) {
          bot.pins += count; bot.daily[d] += count; bot.voyage.pins += count;
          bot.voyage.end = Math.max(time, bot.voyage.end - count * 1800);
          bot.next = Math.max(time + bot.action, bot.voyage.end);
        } else {
          const nextWindow = timing.tradingOpen
            ? (time < timing.previousRefreshAt + bot.windowOffset ? timing.previousRefreshAt : timing.nextRefreshAt) + bot.windowOffset
            : (timing.tradeStartTime > time ? timing.tradeStartTime : timing.tradeStartTime + day) + bot.windowOffset;
          bot.next = Math.min(bot.voyage.end, nextWindow + bot.reaction);
        }
        return;
      }
      bot.cityId = bot.voyage.target; bot.voyage = null; bot.destination = null;
    }
    if (!timing.tradingOpen) {
      bot.next = (time < timing.tradeStartTime ? timing.tradeStartTime : timing.tradeStartTime + day) + bot.reaction;
      return;
    }
    if (bot.seenDay !== d) { bot.seenDay = d; bot.seen.clear(); }
    bot.seen.add(bot.cityId);
    const market = book.markets.get(bot.cityId);
    const held = bot.goods.find(g => g.cityId !== bot.cityId);
    if (held) {
      const gain = gainFor(held, market.goods.find(g => g.goodsId === held.goodsId).price, bot.lv);
      bot.coins += held.buyPrice * held.num + gain; bot.profit += Math.max(0, gain); bot.netGain += gain;
      bot.goods.splice(bot.goods.indexOf(held), 1); bot.next += bot.action; return;
    }
    const upgrade = config.tables.TradeShipCfg.data.find(s => s.lv === bot.lv + 1);
    if (upgrade && bot.profit >= upgrade.upMoney) { bot.lv++; bot.next += bot.action; return; }
    const ship = config.tables.TradeShipCfg.data.find(s => s.lv === bot.lv);
    const remaining = ship.capacity - bot.goods.reduce((sum, g) => sum + g.num * defs.get(g.goodsId).capacity, 0);
    const radar = book.cities.map(p => ({ ...p, rareGoodsId: p.reveal <= round || bot.seen.has(p.cityId) ? p.rareGoodsId : 0 }));
    let best = null;
    const candidates = [];
    for (const port of radar) {
      if (port.cityId === bot.cityId || bot.destination && port.cityId !== bot.destination) continue;
      const offers = market.goods.flatMap(row => {
        const def = defs.get(row.goodsId), sell = botPrice(def, port);
        if (row.goodsId === market.rareGoodsId || sell < row.price * 1.05) return [];
        return [{ row, def, unitGain: sell - row.price }];
      });
      const cashBound = bot.coins < remaining * 60;
      offers.sort((a, b) => b.unitGain / (cashBound ? b.row.price : b.def.capacity) - a.unitGain / (cashBound ? a.row.price : a.def.capacity));
      let coins = bot.coins, space = remaining, profit = 0;
      const buys = [];
      for (const offer of offers) {
        const count = Math.min(offer.def.maxCount - offer.row.stock, Math.floor(coins / offer.row.price), Math.floor(space / offer.def.capacity));
        if (count <= 0) continue;
        buys.push({ ...offer, count }); profit += count * offer.unitGain;
        coins -= count * offer.row.price; space -= count * offer.def.capacity;
        if (buys.length + bot.goods.length >= 3) break;
      }
      if (buys.length) {
        const candidate = { port, buys, profit }; candidates.push(candidate);
        if (!best || profit > best.profit) best = candidate;
      }
    }
    if (best && !bot.destination && ['diverse', 'mixed'].includes(rivalDistribution)) {
      const close = candidates.filter(c => c.profit >= best.profit * .9);
      best = close[Math.floor(bot.choose() * close.length)];
    }
    const late = time + 7200 + 4 * bot.action >= timing.tradeEndTime;
    if (best && bot.goods.length < 3 && (!late || d < 3 || inRivalWindow)) {
      const buy = best.buys[0]; takeStock(buy.row, buy.count, 'rival');
      const key = d + ':' + round + ':' + bot.cityId;
      if (!purchasesByPortRound.has(key)) purchasesByPortRound.set(key, { d, round, cityId: bot.cityId, buyers: new Set(), cells: 0 });
      const activity = purchasesByPortRound.get(key); activity.buyers.add(bot.id); activity.cells += buy.count * buy.def.capacity;
      bot.coins -= buy.count * buy.row.price;
      bot.goods.push({ goodsId: buy.row.goodsId, num: buy.count, buyPrice: buy.row.price, cityId: bot.cityId });
      bot.destination = best.port.cityId; bot.buyCells[d] += buy.count * buy.def.capacity;
      bot.purchases++; bot.next += bot.action; return;
    }
    if (bot.goods.length && bot.destination) {
      bot.voyage = { origin: bot.cityId, target: bot.destination, start: time, end: time + 7200, pins: 0 };
      bot.moves++; bot.next += bot.action; return;
    }
    // 缺货时留港等刷新；不会凭空获得货物或购买预算。
    bot.next = Math.min(timing.nextRefreshAt, timing.tradeStartTime + day) + bot.reaction;
  }
  return {
    bots,
    advance(time) {
      let iterations = 0;
      for (;;) {
        let next = null;
        for (const bot of bots) if (bot.next <= time && (!next || bot.next < next.next)) next = bot;
        if (nextCensus <= time && (!next || nextCensus < next.next)) { recordCensus(nextCensus); continue; }
        if (!next) return;
        if (++iterations > 500_000) throw Error('对手事件循环未前进');
        const before = next.next; act(next);
        if (!(next.next > before)) throw Error('对手时钟未前进');
        if (next.coins < 0 || next.pins > 220 || next.daily.some(p => p > rivalDailyLimit)) throw Error('对手预算越界');
      }
    },
    distribution() {
      const byRound = Array.from({ length: 24 }, (_, i) => {
        const markets = [...purchasesByPortRound.values()].filter(p => p.d === Math.floor(i / 6) && p.round === i % 6);
        const total = markets.reduce((sum, p) => sum + p.cells, 0);
        return { day: Math.floor(i / 6) + 1, round: i % 6 + 1, portsWithPurchases: markets.length,
          maxUniqueBuyersAtPort: Math.max(0, ...markets.map(p => p.buyers.size)),
          largestPortVolumeShare: total ? Math.max(...markets.map(p => p.cells)) / total : 0,
          cellsBought: total };
      });
      return { ...census, byRound };
    },
    visible(time) {
      return bots.filter(b => b.voyage?.end > time).map(b => ({ playerId: String(b.id), guildIdx: 1,
        cargo: { cityId: b.voyage.origin, cargoLv: b.lv, moveToCityId: b.voyage.target, moveStartTime: b.voyage.start, moveEndTime: b.voyage.end } }));
    },
  };
}

function simulate(world, settings, variant, seed) {
  const rivals = createRivals(world, seed, rivalCount);
  const cargo = { cityId: ports[0].cityId, cargoLv: 1, moveStartTime: 0, moveEndTime: 0, moveToCityId: 0 };
  const player = { coins: 10000, profit: 0, goods: [] }, state = { period: event.period, player, cargo };
  const markets = new Map(), seenToday = new Set(), departures = {}, itinerary = new Set();
  const marketHistory = [];
  const daily = [0, 0, 0, 0], dayProfit = [0, 0, 0, 0], milestones = {}, levels = {}, logs = [];
  let time = event.startTime + 8 * 3600, priorDay = -1, pid = 0, pins = 0, moves = 0, voyage = {}, openingCargo = [];
  let decisions = 0, refreshPins = 0, prepPins = 0, boughtCells = 0, emptyDepartures = 0, shortageVisits = 0, visits = 0;
  let visitKey = '', waitSeconds = 0, netGain = 0, optimisticWaitSeconds = 0, refreshBoughtCells = 0;
  let grossLoss = 0, lossSales = 0, experimentSales = 0, experimentLoss = 0, experimentLossSales = 0;
  let minCapital = 10000, peakCapital = 10000, maxDrawdown = 0, maxDrawdownPercent = 0, goalAt = null;
  const speedReasons = {};
  while (time < event.endTime) {
    if (++decisions > 100_000) throw Error('本人事件循环未前进');
    rivals.advance(time);
    const { book, d, round, timing } = bookAt(world, time);
    if (priorDay !== d) { priorDay = d; seenToday.clear(); }
    const radar = { radar: book.cities.map(p => ({ cityId: p.cityId, specGoodsId: p.specGoodsId,
      rareGoodsId: timing.tradingOpen && (p.reveal <= round || seenToday.has(p.cityId)) ? p.rareGoodsId : 0 })) };
    state.worldCargo = rivals.visible(time);
    const earned = earnedAt(time, player.profit, d, time < timing.tradeStartTime ? 0 : round + 1);
    const balance = sprintStock + earned - pins;
    if (balance < 0) throw Error('已用针超过到账数量');
    const budget = { stock: new Map([[pointer, balance]]), dailyUsed: daily[d], periodRemaining: Math.min(balance, cap - pins) };
    const history = [...markets.values()];
    const sinceRefresh = time - timing.previousRefreshAt;
    const windowMinutes = variant === 'refresh8' ? 8 : 20;
    const inWindow = timing.tradingOpen && sinceRefresh < windowMinutes * 60;
    const prep = (player.goods.length + 1) * selfStep;
    const beforeWindow = timing.tradingOpen && timing.nextRefreshAt < timing.tradeEndTime &&
      timing.nextRefreshAt - time <= prep && cargo.moveEndTime >= timing.nextRefreshAt - prep;
    const emergency = !!voyage.closing || d === 3 && time >= timing.tradeEndTime - 7200;
    if (cargo.moveToCityId && time < cargo.moveEndTime) {
      let speedSettings = settings;
      if (variant === 'noGate' || variant.startsWith('refresh') && inWindow || ['window20', 'sync20', 'preclear20'].includes(variant) && (inWindow || beforeWindow))
        speedSettings = { ...settings, speedUpIntelPorts: 0 };
      if ((['window20', 'sync20', 'preclear20'].includes(variant) && inWindow || variant === 'preclear20' && beforeWindow) && player.goods.length)
        speedSettings = { ...speedSettings, speedUpMode: 'full' };
      let speed = planMerchantSpeed(config, event, state, radar, budget.stock, speedSettings, time, { ...budget,
        markets: history, marketHistory, actor: { playerId: '1', guildId: '1001' }, usedPointers: voyage.pins,
        closingPointers: voyage.closing, plannedOpening: voyage.opening, exploration: voyage.exploration, actionSeconds: selfStep });
      if (['window20', 'sync20', 'preclear20'].includes(variant) && !inWindow && !(['sync20', 'preclear20'].includes(variant) && beforeWindow) && !emergency)
        speed = { kind: 'wait' };
      if (speed.kind === 'speed') {
        if (!player.goods.length && !voyage.exploration && speed.accelerationReason !== 'stockRace') throw Error('异常空船加速');
        pins += speed.useNum; daily[d] += speed.useNum; voyage.pins += speed.useNum;
        if (sinceRefresh < 1200) refreshPins += speed.useNum;
        if (beforeWindow) prepPins += speed.useNum;
        cargo.moveEndTime = speed.expected.afterEndTime;
        if (trace) logs.push({ type: 'speed', t: time - event.startTime, pins: speed.useNum, total: pins, lv: cargo.cargoLv, reason: speed.accelerationReason });
        time += selfStep;
      } else {
        const next = Math.min(cargo.moveEndTime, time + pollSeconds);
        const reason = speed.reason ?? '实验策略等刷新';
        speedReasons[reason] = (speedReasons[reason] ?? 0) + next - time;
        if (reason.includes('剩余自然航次预计可达目标')) optimisticWaitSeconds += next - time;
        time = next;
      }
      continue;
    }
    if (cargo.moveToCityId) { cargo.cityId = cargo.moveToCityId; cargo.moveStartTime = cargo.moveToCityId = cargo.moveEndTime = 0; }
    if (!timing.tradingOpen && (moves || d > 0)) {
      time = time < timing.tradeStartTime ? timing.tradeStartTime : timing.tradeStartTime + day; continue;
    }
    const upgrade = config.tables.TradeShipCfg.data.find(s => s.lv === cargo.cargoLv + 1);
    if (settings.autoUpgrade && upgrade && player.profit >= upgrade.upMoney) {
      cargo.cargoLv++; levels[cargo.cargoLv] = { hour: (time - event.startTime) / 3600, pins }; time += selfStep; continue;
    }
    const market = { ...book.markets.get(cargo.cityId), period: event.period, startTime: event.startTime, observedAt: time };
    if (timing.tradingOpen) {
      seenToday.add(cargo.cityId); radar.radar.find(p => p.cityId === cargo.cityId).rareGoodsId = market.rareGoodsId;
      markets.set(timing.marketEpoch + ':' + cargo.cityId, structuredClone(market));
      marketHistory.push({ ...structuredClone(market), held: structuredClone(player.goods), visitStart: moves });
      if (marketHistory.length > 512) marketHistory.shift();
      const key = moves + ':' + timing.marketEpoch;
      if (key !== visitKey) {
        visitKey = key; visits++;
        const special = market.goods.find(g => g.goodsId === market.specGoodsId);
        if (special.stock >= defs.get(special.goodsId).maxCount * .75) shortageVisits++;
      }
    }
    const options = { markets: history, settings, actionSeconds: selfStep, preferredPort: voyage.origin,
      actor: { playerId: '1', guildId: '1001' },
      plannedOpening: voyage.opening, openingCargoPids: openingCargo };
    let plan = planMerchant(config, event, state, market, radar, time, [...itinerary], options);
    if (!openingCargo.length && timing.tradingOpen && (plan.kind === 'wait' || plan.exploration || plan.mode === 'OVERNIGHT') &&
      time + timing.travelSeconds + (1 + 2 * market.goods.length + player.goods.length) * selfStep >= timing.tradeEndTime)
      plan = merchantClosingRoute(config, event, state, market, radar, radar, time, [...itinerary], options, budget) ?? plan;
    plan = experimentalClearance(config, event, state, market, radar, time, [...itinerary], options, plan, variant, planMerchant);
    plan = merchantStrategyPlan(plan, config, event, state, settings, time, { keyRecords: () => departures });
    if (['sync20', 'preclear20'].includes(variant) && timing.tradingOpen && !player.goods.length &&
      ['move', 'wait'].includes(plan.kind) && timing.nextRefreshAt < timing.tradeEndTime && timing.nextRefreshAt - time <= 1200) {
      waitSeconds += timing.nextRefreshAt - time; time = timing.nextRefreshAt; continue;
    }
    if (plan.kind === 'buy') {
      const quote = market.goods.find(g => g.goodsId === plan.goodsId);
      if (plan.count * quote.price > player.coins) throw Error('本人采购资金越界');
      takeStock(quote, plan.count); player.coins -= quote.price * plan.count;
      boughtCells += plan.count * defs.get(quote.goodsId).capacity;
      if (sinceRefresh < 1200) refreshBoughtCells += plan.count * defs.get(quote.goodsId).capacity;
      // 每笔采购保留独立批次，不能合并后少算清仓操作时间。
      player.goods.push({ pid: ++pid, goodsId: quote.goodsId, num: plan.count, cityId: cargo.cityId, buyPrice: quote.price });
      itinerary.clear();
    } else if (plan.kind === 'sell') {
      const batch = player.goods.find(g => g.pid === plan.pid);
      if (batch.cityId === cargo.cityId) throw Error('原港出售');
      const expected = gainFor(batch, market.goods.find(g => g.goodsId === batch.goodsId).price, cargo.cargoLv);
      if (plan.gain !== expected) throw Error('成交记账公式不一致');
      player.coins += batch.buyPrice * batch.num + plan.gain; player.profit += Math.max(0, plan.gain); dayProfit[d] += Math.max(0, plan.gain); netGain += plan.gain;
      if (plan.gain < 0) { grossLoss -= plan.gain; lossSales++; }
      if (plan.experiment) {
        experimentSales++;
        if (plan.gain < 0) { experimentLoss -= plan.gain; experimentLossSales++; }
      }
      if (player.profit >= goal && goalAt === null) goalAt = time - event.startTime;
      for (const target of [1_000_000, 5_000_000, goal]) if (player.profit >= target && milestones[target] === undefined) milestones[target] = pins;
      player.goods = player.goods.filter(g => g.pid !== batch.pid); openingCargo = openingCargo.filter(p => p !== batch.pid); itinerary.clear();
    } else if (plan.kind === 'move') {
      voyage = { origin: cargo.cityId, opening: plan.plannedOpening, exploration: plan.exploration, pins: 0, closing: plan.accelerationRequired };
      openingCargo = plan.plannedOpening ? player.goods.map(g => g.pid) : [];
      if (!player.goods.length) emptyDepartures++;
      itinerary.add(cargo.cityId); cargo.moveStartTime = time; cargo.moveEndTime = time + timing.travelSeconds; cargo.moveToCityId = plan.destination;
      departures[++moves] = { confirmed: true, details: { scope: 'merchant:' + event.startTime + ':' + event.period, expected: { request: 'TradeMoveRequest', start: time } } };
    } else {
      const next = Math.min(plan.nextCheckAt || Infinity, timing.nextRefreshAt || Infinity, timing.tradeEndTime > time ? timing.tradeEndTime : Infinity);
      const nextTime = Math.max(time + 1, Math.min(next,
        time + (timing.tradingOpen ? pollSeconds : Math.max(pollSeconds, timing.tradeStartTime - time))));
      if (timing.tradingOpen) waitSeconds += nextTime - time;
      time = nextTime; continue;
    }
    if (trace) logs.push({ type: plan.kind, t: time - event.startTime, city: cargo.cityId, profit: player.profit, coins: player.coins,
      count: plan.count, goodsId: plan.goodsId, destination: plan.destination, gain: plan.gain,
      experiment: plan.experiment, clearance: plan.clearance });
    const used = player.goods.reduce((sum, g) => sum + g.num * defs.get(g.goodsId).capacity, 0);
    if (used > config.tables.TradeShipCfg.data.find(s => s.lv === cargo.cargoLv).capacity || player.coins < 0) throw Error('本人资金或舱位越界');
    const capital = 10000 + netGain;
    minCapital = Math.min(minCapital, capital); peakCapital = Math.max(peakCapital, capital);
    maxDrawdown = Math.max(maxDrawdown, peakCapital - capital);
    maxDrawdownPercent = Math.max(maxDrawdownPercent, (peakCapital - capital) / peakCapital * 100);
    time += selfStep;
  }
  rivals.advance(event.endTime - 1);
  if (pins > cap || daily.some(n => n > settings.dailyPointerLimit)) throw Error('针数预算越界');
  for (const book of world) for (const market of book.markets.values()) for (const row of market.goods) {
    if (row.stock < 0 || row.stock > defs.get(row.goodsId).maxCount) throw Error('最终库存越界');
    if (row.initialStock !== undefined && row.stock !== row.initialStock + row.selfBought + row.rivalBought) throw Error('共享库存不守恒');
  }
  const cost = rows => rows.reduce((sum, g) => sum + g.buyPrice * g.num, 0);
  if (player.coins + cost(player.goods) !== 10000 + netGain) throw Error('本人资金不守恒');
  for (const b of rivals.bots) if (b.coins + cost(b.goods) !== 10000 + b.netGain) throw Error('对手资金不守恒');
  return { profit: player.profit, pins, moves, milestones, dailyPins: daily, dayProfit, levels,
    cash: player.coins, heldCost: cost(player.goods), netGain, grossLoss, lossSales, experimentSales, experimentLoss, experimentLossSales,
    minCapital, maxDrawdown, maxDrawdownPercent, goalAt,
    refreshPins, prepPins, boughtCells, refreshBoughtCells, emptyDepartures, shortageVisits, visits, waitHours: waitSeconds / 3600,
    optimisticWaitHours: optimisticWaitSeconds / 3600, speedReasons,
    distribution: rivals.distribution(),
    rivals: rivals.bots.map(b => ({ profit: b.profit, pins: b.pins, lv: b.lv, moves: b.moves, buyCells: b.buyCells })), ...(trace ? { logs } : {}) };
}

const settings = { ...merchantPresets.find(p => p.id === 'sprint').settings.merchant, periodPointerLimit: cap };
for (let seed = firstSeed; seed < firstSeed + seeds; seed++) for (const variant of variants) {
  const started = performance.now();
  const result = simulate(makeWorld(seed), settings, variant, seed);
  console.log(JSON.stringify({ seed, variant, modelRevision: 'clearance-v1-separated-batches', engine: process.env.MC_ENGINE_LABEL ?? 'current', rivalCount, rivalStep, rivalWindow, rivalDailyLimit, rivalDistribution, actionSeconds: selfStep, pollSeconds,
    cap, sprintStock, intel: process.env.MC_INTEL ?? 'normal', elapsedMs: Math.round(performance.now() - started), ...result }));
}
