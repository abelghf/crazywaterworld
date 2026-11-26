import { natural, positive, table } from './activity-actions.mjs';
import { homelandMergeModel, planHomelandMerges } from './homeland-merge.mjs';
import { planHomelandProduction } from './homeland-production.mjs';
import { planHomelandSpace } from './homeland-space.mjs';

// Only visible half-locked cells have a known recipe. Wood-covered cells are
// revealed by the server; never invent their contents or adjacency effects.
export function planHomelandBoard(config, state, mergePlans = planHomelandMerges(config, state, { takeWarehouse: true, warehouseBuffer: true })) {
  const { byId, stock } = homelandMergeModel(config, state, true, true);
  const pieces = [...byId.values()], configs = table(config, 'DualCombineProduceCfg');
  const libraries = table(config, 'DualCombineProduceLibCfg');
  const knownType = row => row && ['普通', '产品', '生产器', '可使用'].includes(row.type);
  const successor = row => {
    const next = byId.get(row?.nextId);
    return knownType(row) && knownType(next) && positive(row.level) && next.level === row.level + 1
      && row.pieceGroup && row.pieceGroup === next.pieceGroup
      && pieces.filter(item => item.nextId === next.pieceId).length === 1 ? next : null;
  };
  const keep = piece => {
    if (byId.get(piece.id)?.type !== '生产器') return false;
    const matches = configs.filter(row => row.produceid === piece.id), cfg = matches[0];
    if (matches.length !== 1 || ![cfg.count, cfg.cost, cfg.cd].every(natural)) return true;
    if (cfg.count > 0 && piece.produceLeft !== cfg.count) return true;
    if (cfg.count === 0 && !(natural(piece.produceLeft) || piece.produceLeft === -1)) return true;
    // Keep one working producer unless the upgrade preserves every output and
    // supplies it indefinitely. Protect a specific UID, not "has another": a
    // synthetic recipe could otherwise consume both supposedly spare copies.
    const next = configs.filter(row => row.produceid === byId.get(piece.id)?.nextId);
    const outputs = libraries.filter(row => row.libId === cfg.libId && positive(row.weight));
    const preservesSupply = next.length === 1 && next[0].count === 0 && outputs.length
      && outputs.every(row => libraries.some(item => item.libId === next[0].libId && item.pieceId === row.pieceId && positive(item.weight)));
    if (preservesSupply) return false;
    const working = state.cells.filter(cell => cell.state === 2 && cell.piece?.id === piece.id
      && (cfg.count > 0 ? positive(cell.piece.produceLeft) : natural(cell.piece.produceLeft) || cell.piece.produceLeft === -1))
      .map(cell => cell.piece).sort((a, b) => a.uid - b.uid);
    return !working.length || piece.uid === working[0].uid;
  };
  const targets = state.cells.filter(cell => cell.state === 1 && successor(byId.get(cell.piece?.id)))
    .sort((a, b) => byId.get(a.piece.id).level - byId.get(b.piece.id).level || a.cellId - b.cellId);
  const result = (target, next, extra = {}) => ({ next, target, forUnlock: true, ...extra });
  // Prefer an immediate unlock anywhere on the board before building partners.
  for (const target of targets) {
    const partner = stock.get(target.piece.id)?.find(piece => piece.location === 'board' && !keep(piece));
    if (partner) return result(target, { kind: 'mergeOrders', from: partner,
      to: { ...target.piece, cellId: target.cellId, state: 1, location: 'half' }, nextId: byId.get(partner.id).nextId });
  }
  const candidates = [], deferred = [], seen = new Set(), budget = { left: 24 };
  let limited = false;
  for (const target of targets) {
    if (seen.has(target.piece.id)) continue;
    seen.add(target.piece.id);
    const chain = new Set([target.piece.id]);
    let cursor = byId.get(target.piece.id);
    while (cursor) {
      const parents = pieces.filter(row => row.nextId === cursor.pieceId && successor(row));
      if (parents.length !== 1 || chain.has(parents[0].pieceId)) break;
      cursor = parents[0]; chain.add(cursor.pieceId);
    }
    const modelConfig = { ...config, tables: { ...config.tables, DualCombinePieceCfg: { data: pieces.map(row =>
      chain.has(row.pieceId) && knownType(row) ? { ...row, type: '普通' } : row) } } };
    const excluded = piece => chain.has(piece.id) && keep(piece);
    const slot = Math.max(-1, ...state.orders.map(order => order.slot)) + 1;
    const plannedState = { ...state,
      // Plan a separate unlocked partner, not a higher item that could bypass
      // this target. The final merge is selected on the next server snapshot.
      cells: state.cells.map(cell => cell.cellId === target.cellId || cell.piece && excluded(cell.piece) ? { ...cell, state: 0 } : cell),
      warehouse: state.warehouse.filter(piece => !excluded(piece)),
      orders: [...state.orders, { slot, orderId: 0, reqs: [{ pieceCfgId: target.piece.id, count: 1 }] }],
    };
    if (positive(plannedState.warehouseCapacity)) plannedState.warehouseCapacity -= state.warehouse.length - plannedState.warehouse.length;
    const plans = planHomelandMerges(modelConfig, plannedState, { takeWarehouse: true, warehouseBuffer: true, targetSlot: slot,
      searchLimits: { maxExpanded: 1000, maxStates: 3000, maxMilliseconds: 10 } });
    const plan = plans[0];
    if (plan?.next) {
      const compact = plan.next.kind === 'warehouseBuffer' ? planHomelandSpace(config, plannedState, state.emptyCells + 1) : null;
      candidates.push(result(target, compact ?? plan.next, { steps: plan.steps ?? Infinity }));
    }
    else if (plan?.status === 'unreachable') deferred.push({ target, modelConfig, plannedState, plans, slot });
    else if (plan?.status === 'limited') limited = true;
  }
  if (candidates.length) return candidates.sort((a, b) => a.steps - b.steps)[0];
  let reason = '';
  for (const item of deferred) {
    if (budget.left <= 0) break;
    const plan = planHomelandProduction(config, item.plannedState, item.plans,
      { modelConfig: item.modelConfig, slot: item.slot, budget })[0];
    if (plan?.next) return result(item.target, plan.next, { forProduction: true });
    const compact = planHomelandSpace(config, item.plannedState, item.plans[0]?.spaceNeeded ?? 0);
    if (compact) return result(item.target, compact);
    reason ||= plan?.reason ?? '';
  }
  // A deterministic order can also be blocked on a warehouse withdrawal.
  // Only compact for that concrete plan; no idle "keep two cells free" sweep.
  const compact = mergePlans.map(plan => planHomelandSpace(config, state,
    plan.next?.kind === 'warehouseBuffer' ? state.emptyCells + 1 : plan.status === 'unreachable' ? plan.spaceNeeded ?? 0 : 0)).find(Boolean) ?? null;
  return { next: compact, forSpace: !!compact,
    reason: targets.length ? `格子解锁暂缓：${reason || (limited ? '规划达到检查上限，等待下次重算' : '缺少可用配对材料')}` : '' };
}
