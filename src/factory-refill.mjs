import path from 'node:path';
import { createHash } from 'node:crypto';
import { dataDirectory } from './usage-ledger.mjs';
import { goldAccountKey } from './gold-reservations.mjs';
import { readJson, atomicJson, withFileLock } from './json-store.mjs';
import { factoryRecipeCosts, factoryRecipeAvailability } from './production-eligibility.mjs';

export const refillGoal = (rule, cap) => Math.min(rule.target ?? cap, cap);
const refillKey = rule => JSON.stringify([rule.productId, rule.trigger, rule.target]);
export const editingFactoryQueue = entry => !!(entry?.flight || entry?.remove?.length || entry?.stagedSupplies);
export const readyRefillUnits = (buildings, id) => buildings.reduce((sum, b) => sum +
  (b.factory?.finishedProducts ?? []).reduce((n, item) => n + (item.id === id ? Number(item.num) : 0), 0), 0);

// Preview and forecast use their own copy. Live checks persist only transitions,
// so a reconnect halfway through a refill does not release the factory.
export function refillHistoryFor(player) {
  if (!player?.playerId || !player.worldId) return { active:{} };
  const role = createHash('sha256').update(goldAccountKey(player)).digest('hex');
  const file = path.join(dataDirectory(), 'factory-refills', role + '.json');
  return { file, active:readJson(file, {}) };
}

export function refillFactoryType(config, building) {
  const id = building.buildingId ?? building.id;
  return building.type ?? config?.tables?.BuildingUnlockCfg?.data.find(r => r.buildingId === id)?.buildingType
    ?? config?.tables?.BuildingCfg?.data.map(r => r.buildingType).filter(t => id.endsWith(t)).sort((a,b) => b.length-a.length)[0];
}

export function refillRecipe(config, building, rule, festivals, now) {
  const type = refillFactoryType(config, building);
  const recipe = config?.tables?.BuildingProduceCfg?.data.find(row => row.itemId === rule.productId
    && row.buildType === type && row.unlockLevel <= building.level);
  return factoryRecipeAvailability(recipe, festivals, now).allowed && factoryRecipeCosts(recipe) ? recipe : null;
}

// Remember triggered items until they reach the warehouse target. The current
// rule order decides which of those items owns the factory on each check.
export function selectFactoryRefill(rules, building, { config, festivals, now, owned, cap, history, record = false }) {
  if (!(cap > 0)) return;
  const id = building.buildingId ?? building.id;
  const eligible = new Map(), triggered = new Set();
  for (const rule of rules) {
    if (rule.buildingId !== id) continue;
    const count = owned(rule.productId);
    if (count >= refillGoal(rule, cap)) continue;
    const recipe = refillRecipe(config, building, rule, festivals, now);
    if (!recipe) continue;
    const key = refillKey(rule);
    eligible.set(key, { rule, recipe });
    if (count <= rule.trigger) triggered.add(key);
  }
  function update(entries) {
    const previous = entries[id];
    // Single-item refills from older versions store their key as a string.
    const waiting = Array.isArray(previous) ? previous : typeof previous === 'string' ? [previous] : [];
    const next = [...eligible.keys()].filter(key => triggered.has(key) || waiting.includes(key));
    if (next.length) entries[id] = next.length === 1 ? next[0] : next;
    else delete entries[id];
    return eligible.get(next[0]);
  }
  const previous = history.active[id];
  let selected = update(history.active);
  if (record && history.file && JSON.stringify(previous) !== JSON.stringify(history.active[id])) {
    withFileLock(history.file, () => {
      const entries = readJson(history.file, {});
      selected = update(entries);
      history.active = entries;
      atomicJson(history.file, entries);
    });
  }
  return selected;
}

// A preview starts from the warehouse snapshot, before simulated collection
// can lift the balance above the trigger. Never persist forecast transitions.
export function snapshotRefills(snapshot, config, settings) {
  const rules = settings.factory?.refillRules;
  const history = rules?.length ? refillHistoryFor(snapshot.raw?.player ?? {playerId:snapshot.player?.id, worldId:snapshot.player?.worldId}) : {active:{}};
  const active = [];
  if (!rules?.length || !settings.factory.enabled || !settings.factory.produce || settings.loop?.world === false ||
    !(snapshot.inventoryKnown ?? snapshot.complete) || !(snapshot.stockCap > 0)) return {history, active};
  const stock = new Map(snapshot.inventory.map(row => [row.id, row.num]));
  for (const b of snapshot.factories) {
    if (!b.enabled || b.nativeAutoActive) continue;
    const selected = selectFactoryRefill(rules, b, {config, festivals:snapshot.raw?.festivals, now:snapshot.serverNow,
      owned:id => stock.get(id) ?? 0, cap:snapshot.stockCap, history});
    if (selected) active.push(selected.rule);
  }
  return {history, active};
}

export function planFactoryRefill(building, rule, recipe, { survey, owned, incoming, free, reserve, credit, useAccelerators, factoryName, productName }) {
  const { buildingId } = building, { productId } = rule;
  const queue = building.factory.factoryQ;
  const goal = refillGoal(rule, survey.stockCap);
  const missing = goal - owned(productId) - (incoming.get(productId) ?? 0);
  const steps = [];
  const step = (request, body, label, extra) => steps.push({ kind:'startProduce', request, response:null,
    body:{buildingId, ...body}, refillRule:rule, displayFactory:factoryName, label, ...extra });
  if (owned(productId) + readyRefillUnits(survey.factories, productId) >= goal ||
    !Array.isArray(queue) || editingFactoryQueue(survey.factoryInsertions?.[buildingId])) return steps;
  const others = queue.filter(job => job.productId !== productId);
  const waiting = others.filter(job => !job.finishTime);
  for (const job of waiting.toReversed()) {
    if (job === queue[0]) continue; // A missing head timer cannot prove that the slot is cancellable.
    step('CancelFactoryProduceRequest', {index:job.idx ?? 0}, factoryName + '为补' + productName + '撤下排队的' + job.productId,
      { verify:{productId:job.productId} });
  }
  const now = survey.serverNow ?? survey.now;
  if (useAccelerators) {
    for (const job of others) {
      if (!(job.finishTime > now)) continue;
      const useNum = Math.min(Math.ceil((job.finishTime - now) / 60), free('加速器'));
      if (useNum <= 0) continue;
      reserve('加速器', useNum);
      step('SpeedUpFactoryProduceRequest', {index:job.idx ?? 0, speedUp:{type:2, useNum}},
        factoryName + '使用 ' + useNum + ' 个加速器为' + productName + '腾出生产位',
        { verify:{productId:job.productId, finishTime:job.finishTime}, costs:[{id:'加速器', num:useNum}] });
    }
  }
  if (waiting.length) return steps;
  const costs = factoryRecipeCosts(recipe);
  const slots = Math.min(missing, survey.factorySlots - queue.length);
  for (let n = 0; n < slots && costs.every(({id,num}) => free(id) >= num); n++) {
    for (const {id,num} of costs) reserve(id,num);
    incoming.set(productId, (incoming.get(productId) ?? 0) + 1); credit(productId, 1);
    step('StartFactoryProduceRequest', {productId}, factoryName + '优先补' + productName + '至 ' + goal + ' 件',
      { costs, demandDriven:false, displayProduct:productName,
        eligibilityKey:factoryRecipeAvailability(recipe, survey.festivals, now).signature + ':' + building.level });
  }
  return steps;
}
