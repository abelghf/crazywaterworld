import { normalize } from './worlds.mjs';
import { displayMaterial } from './config.mjs';
import { confirmFactoryProductionBeforeHarvest, factoryStockCapacity } from './factory-production.mjs';
import { resourceReserve } from './automation-policy.mjs';
import { readOrderReservedStock } from './order-reservations.mjs';
import { factoryProductionSnapshot } from './spend-evidence.mjs';
import { factoryInsertions, saveFactoryInsertion } from './factory-insert-store.mjs';
import { factoryProductionKey, factoryRecipeAvailability, factoryRecipeCosts, startManualFactoryProduction } from './world.mjs';

const rows = (config, table) => config?.tables?.[table]?.data ?? [];
const clock = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const stamp = queue => JSON.stringify(queue.map(j => [j.idx ?? 0, j.productId, j.finishTime ?? 0]));
const add = (map, id, num) => map.set(id, (map.get(id) ?? 0) + num);
const nativeOn = (water, building, now) => building.factory.autoProductId && (water.autoProduceForever || water.autoProduceEndTime > now);
const stale = () => new Error('工厂队列或所选任务已变化，请重新生成排产计划');

// Resolve the displayed batch to individual game indices or original dispatch order.
// Two lanes can share a start time and their finish order need not match dispatch order.
export function locateFactoryInsertion(trace, forecast, target, previous) {
  const { from, id, lane, status, offset = 0 } = target;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(from)) throw stale();
  let targetUnit, count = 1;
  const units = trace.units;
  if (status === 'gap') {
    if (from < forecast.startAt || from >= forecast.endAt || (from !== forecast.startAt && !units.some(u => u.to === from))
      || units.some(u => u.from <= from && from < u.to)) throw stale();
    targetUnit = units.filter(u => u.from > from).sort((a,b) => a.from - b.from)[0];
  } else {
    const run = forecast.runs.find(r => r.from === from && r.id === id && r.lane === lane && r.status === status);
    if (!run) throw stale();
    const matches = units.filter(u => u.from >= run.from && u.from < run.to && u.lane === lane && u.id === id && u.status === status);
    count = status === 'running' ? 1 : matches.length;
    targetUnit = matches[offset];
    if (!targetUnit) throw stale();
  }
  if (offset >= count) throw stale();
  const queue = trace.queue;
  let cut = queue.length;
  if (status === 'running') cut = 1;
  else if (targetUnit?.status === 'queued') {
    cut = queue.findIndex(q => (q.idx ?? 0) === targetUnit.idx);
    if (cut <= 0 || queue[cut].finishTime) throw stale();
  }
  const remove = queue.slice(cut).filter(q => !q.finishTime).map(q => ({ idx:q.idx ?? 0, id:q.productId })).reverse();
  const planned = units.filter(u => u.status === 'planned');
  const prefix = targetUnit?.status === 'planned' ? planned.slice(0, planned.indexOf(targetUnit))
    : status === 'gap' && !targetUnit ? planned : [];
  let consumed = 0;
  const before = prefix.map(u => {
    if (!u.manual) return { id:u.id, at:u.at };
    const job = previous?.jobs[consumed++];
    if (job?.id !== u.id) throw stale();
    return job;
  });
  const after = previous?.jobs.slice(consumed) ?? [];
  if (targetUnit?.status === 'planned' && !targetUnit.manual) after.push({ id:targetUnit.id, at:targetUnit.at });
  return { before, remove, after, count };
}

export async function prepareFactoryInsertion(client, protocol, ctx, quote, target, submit) {
  const { config, player, settings, enabled } = ctx;
  const buildingId = target.buildingId, trace = quote.anchors.get(buildingId);
  const forecast = quote.forecast.factories.find(f => f.id === buildingId);
  if (!trace || !forecast || forecast.unknown || !enabled()) throw stale();
  if (!protocol.StartFactoryProduceRequest) throw new Error('当前游戏协议无法向工厂派单');
  const entries = factoryInsertions(player), previous = entries[buildingId];
  if (previous?.flight || previous?.remove?.length || previous?.revision !== trace.revision) throw stale();
  const position = locateFactoryInsertion(trace, { ...forecast, startAt:quote.forecast.startAt, endAt:quote.forecast.endAt }, target, previous);
  if (position.remove.length && !protocol.CancelFactoryProduceRequest) throw new Error('当前游戏协议无法调整已排队的任务');
  if (submit && position.remove.length) await confirmFactoryProductionBeforeHarvest(client, protocol, buildingId, { player, enabled });
  const { stock, available, water:raw } = await readOrderReservedStock(client, protocol, config, { player, settings, enabled });
  const water = normalize(raw), live = factoryProductionSnapshot(water, buildingId), now = clock(client);
  if (!live || stamp(live.queue) !== stamp(trace.queue) || nativeOn(water, live.building, now) || !enabled()) throw stale();
  const recipes = rows(config, 'BuildingProduceCfg');
  const committed = new Map(), held = new Map();
  for (const b of water.building) {
    if (!b.factory || !b.level) continue;
    const snap = factoryProductionSnapshot(water, b.buildingId);
    if (!snap) throw new Error('无法确认在产和待收库存，请刷新后重试');
    for (const [id,n] of snap.totals) add(committed,id,n);
  }
  for (const e of Object.values(entries)) {
    for (const job of e.jobs.filter(j => j.pinned)) {
      add(committed, job.id, 1);
      for (const [id,n] of recipes.find(r => r.itemId === job.id)?.costItem ?? []) add(held,id,n);
    }
  }
  const cap = factoryStockCapacity(config, player);
  const products = [];
  for (const r of recipes) {
    if (r.buildType !== trace.type || !Number.isSafeInteger(r.unlockLevel) || r.unlockLevel > live.building.level
      || !factoryRecipeAvailability(r,client.festivals,now).allowed) continue;
    const costs = factoryRecipeCosts(r);
    if (!costs) continue;
    let max = cap - (stock.get(r.itemId) ?? 0) - (committed.get(r.itemId) ?? 0);
    for (const { id,num } of costs) {
      const free = (available.get(id) ?? 0) - (resourceReserve(settings,id) || 0) - (held.get(id) ?? 0);
      max = Math.min(max, Math.floor(free / num));
    }
    products.push({ id:r.itemId, name:displayMaterial(config,r.itemId), max:Math.max(0,max) });
  }
  if (!submit) return { products, count:position.count, reordersQueue:position.remove.length > 0 };
  const product = products.find(p => p.id === target.productId), n = target.quantity;
  if (!product || !Number.isSafeInteger(n) || n < 1 || n > product.max) {
    throw new Error('当前库存和剩余仓容最多可插入 ' + (product?.max ?? 0) + ' 件');
  }
  const inserted = Array.from({ length:n }, () => ({ id:product.id, pinned:true, ...(target.status === 'gap' ? { at:target.from } : {}) }));
  const restored = position.remove.toReversed().map(q => ({ id:q.id, pinned:true }));
  const jobs = [...position.before, ...inserted, ...restored, ...position.after];
  const rewrite = position.remove.length ? { remove:position.remove, expected:trace.queue, restored:[], rollback:previous?.jobs ?? [] } : {};
  saveFactoryInsertion(player, buildingId, previous, { jobs, ...rewrite }, entries);
  return { label:'已插入' + product.name + ' ×' + n };
}

// Journal each packet at the actual send boundary. A lost acknowledgement may
// only advance the journal after a fresh queue + uncollected-output observation.
export async function advanceFactoryInsertion(client, protocol, ctx, buildingId) {
  const { player, config, enabled } = ctx;
  let e = factoryInsertions(player)[buildingId];
  const save = next => { e = saveFactoryInsertion(player, buildingId, e, next); };
  const note = message => { if (e && e.note !== message) save({ ...e, note:message }); };
  const abortRewrite = () => {
    const jobs = [...e.restored, ...e.rollback];
    save(jobs.length ? { jobs } : null);
    return '工厂队列已变化，插单已撤回，已移出的任务将按原顺序补回';
  };
  for (let i = 0; e && i < 16 && enabled(); i++) {
    if (!e.remove?.length && !e.flight && e.jobs[0]?.at > clock(client)) return;
    const water = normalize(await client.request('OnWaterRequest', {}, 'OnWaterResponse'));
    if (!enabled()) return;
    const live = factoryProductionSnapshot(water, buildingId);
    if (!live || nativeOn(water,live.building,clock(client))) { note('等待游戏原生自动生产关闭或工厂同步'); return; }
    const sum = id => live.totals.get(id) ?? 0;
    if (e.flight) {
      const { kind, id, idx, baseline } = e.flight;
      if (kind === 'cancel') {
        const original = live.queue.find(q => (q.idx ?? 0) === idx && q.productId === id);
        if (original?.finishTime) return abortRewrite();
        if (original || sum(id) >= baseline) {
          note('游戏撤单结果待确认'); return;
        }
        const remove = e.remove.slice(1);
        save(remove.length ? { ...e, remove, flight:null, note:null,
          expected:e.expected.filter(q => (q.idx ?? 0) !== idx), restored:[{ id, pinned:true }, ...e.restored] } : { jobs:e.jobs });
      } else {
        if (sum(id) <= baseline) { note('游戏入队结果待确认'); return; }
        save(e.jobs.length > 1 ? { jobs:e.jobs.slice(1) } : null);
      }
      continue;
    }
    if (e.remove?.length) {
      const { idx,id } = e.remove[0], index = live.queue.findIndex(q => (q.idx ?? 0) === idx && q.productId === id);
      if (stamp(live.queue) !== stamp(e.expected) || index < 1 || live.queue[index].finishTime) return abortRewrite();
      try {
        await client.sendWatch('CancelFactoryProduceRequest', { buildingId,index:idx }, { beforeSend() {
          if (!enabled()) throw stale();
          if (live.queue.some(job => job.finishTime && job.finishTime <= clock(client))) throw stale();
          save({ ...e, flight:{ kind:'cancel',idx,id,baseline:sum(id) } });
        } });
      } catch (error) {
        if (error.prompt && error.request === 'CancelFactoryProduceRequest') return abortRewrite();
        throw error;
      }
      continue;
    }
    const slots = Number(rows(config,'BuildingProduceParamCfg').find(r => r.paramName === '制造位上限')?.paramValue);
    if (live.queue.length >= slots) return;
    const id = e.jobs[0].id, recipe = rows(config,'BuildingProduceCfg').find(r => r.itemId === id);
    if (!recipe) { note('插单配方已变化'); return; }
    let result;
    try {
      result = await startManualFactoryProduction(client, protocol, { buildingId, productId:id,
        productionKey:factoryProductionKey(player,live.building,recipe) }, { ...ctx, beforeInsertSend() {
        save({ ...e, flight:{ kind:'start', id, baseline:sum(id) } });
      } });
    } catch (error) {
      if (e?.flight && error.notSent) save({ ...e, flight:null, note:error.message });
      else note(error.message);
      return;
    }
    if (!result.confirmed) { note('游戏入队结果待确认'); return; }
    save(e.jobs.length > 1 ? { jobs:e.jobs.slice(1) } : null);
  }
}
