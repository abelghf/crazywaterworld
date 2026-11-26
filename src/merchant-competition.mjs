import { exactAutomationId } from './automation-policy.mjs';

const positive = n => Number.isSafeInteger(n) && n > 0;

// 公开航程不是货舱或采购订单。这里只保留同盟在途船，不把缺失记录当作无人竞争。
export function visibleGuildVoyages(state, actor, time) {
  const voyages = new Map();
  const self = exactAutomationId(actor?.playerId), guild = exactAutomationId(actor?.guildId);
  if (!self || !guild || !Array.isArray(state?.worldCargo)) return [];
  const guildIdx = Number(BigInt(guild) % 1000n);
  if (!guildIdx) return [];
  for (const other of state.worldCargo) {
    const id = exactAutomationId(other?.playerId), voyage = other?.cargo;
    if (!id || id === self || other.guildIdx !== guildIdx || !positive(voyage?.moveToCityId) ||
      !positive(voyage.cityId) || voyage.cityId === voyage.moveToCityId || !positive(voyage.moveStartTime) ||
      voyage.moveStartTime > time || !positive(voyage.moveEndTime) || voyage.moveEndTime <= time) continue;
    if (!voyages.has(id) || voyage.moveStartTime > voyages.get(id).moveStartTime ||
      voyage.moveStartTime === voyages.get(id).moveStartTime && voyage.moveEndTime < voyages.get(id).moveEndTime)
      voyages.set(id, { ...voyage });
  }
  return [...voyages.values()];
}

// 假设同港先到的船会买特产，按船级估计潜在占舱；未知船级取最大船容量。
// 这是可见船满额采购时的压力情景，不冒充实时库存或确定采购意图。
export function merchantStockPressure(config, voyages, city, definition, readyAt, available, observedAt = 0) {
  const ships = config?.tables?.TradeShipCfg?.data ?? [];
  const maxCapacity = Math.max(0, ...ships.map(ship => positive(ship.capacity) ? ship.capacity : 0));
  const incoming = voyages.filter(v => v.moveToCityId === city && v.moveEndTime >= observedAt && v.moveEndTime <= readyAt);
  const cells = incoming.reduce((sum, v) => sum + (ships.find(s => s.lv === v.cargoLv)?.capacity || maxCapacity), 0);
  const units = positive(definition?.capacity) ? Math.floor(cells / definition.capacity) : 0;
  return { ships: incoming.length, cells, potentialRemaining: Math.max(0, available - units),
    firstArrival: incoming.length ? Math.min(...incoming.map(v => v.moveEndTime)) : null, estimated: true };
}
