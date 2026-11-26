import { natural, positive, table } from './activity-actions.mjs';
import { homelandMergeModel, planHomelandMerges } from './homeland-merge.mjs';

const ordinary = row => row && ['普通', '产品'].includes(row.type);

// Production is stochastic. Keep the deterministic A* solution whenever one
// exists; otherwise take one useful step and plan again from the server reply.
// Exact products reserved for all orders remain available for delivery.
export function planHomelandProduction(config, state, mergePlans, traversal = {}) {
  const modelConfig = traversal.modelConfig ?? config;
  const { byId, previous, stock, halves, requests } = homelandMergeModel(modelConfig, state, true, true);
  const actual = new Map(table(config, 'DualCombinePieceCfg').map(row => [row.pieceId, row]));
  const producers = state.cells.filter(cell => cell.state === 2 && actual.get(cell.piece?.id)?.type === '生产器');
  const configs = table(config, 'DualCombineProduceCfg'), libraries = table(config, 'DualCombineProduceLibCfg');
  const types = [...byId.values()].filter(ordinary).sort((a, b) => b.level - a.level);
  return requests.filter(request => traversal.slot === undefined || request.order.slot === traversal.slot).flatMap(request => {
    const recipe = mergePlans.find(row => row.slot === request.order.slot);
    if (recipe?.status !== 'unreachable') return [];
    const result = { slot: request.order.slot, order: request.order, next: null, reason: '' };
    // Even with all possible unlocks, the final order must fit on the board.
    // Count producer cells optimistically because finite producers may expire.
    const maximumCells = state.cells.filter(cell => cell.state === 2 || cell.state === 1 && ordinary(byId.get(cell.piece?.id))).length;
    if ([...request.needs.values()].reduce((sum, num) => sum + num, 0) > maximumCells)
      return [{ ...result, reason: '棋盘可用格子不足以同时放下订单成品，暂不生产' }];
    const required = new Map(request.missing.map(row => [row.id, row.num])), missing = new Map(), halfUse = new Map();
    for (const row of types) {
      const need = required.get(row.pieceId) ?? 0;
      // Half-locked pieces may supply at most one operand per pair, and cannot
      // satisfy a directly deliverable product. Their unlocked partner is still required.
      const parents = missing.get(row.nextId) ?? 0;
      const usableHalf = Math.min(halves.get(row.pieceId)?.length ?? 0, parents);
      halfUse.set(row.pieceId, usableHalf);
      const deficit = Math.max(0, need - (stock.get(row.pieceId)?.length ?? 0) - usableHalf);
      missing.set(row.pieceId, deficit);
      const lower = previous.get(row.pieceId);
      if (lower && deficit) required.set(lower, (required.get(lower) ?? 0) + deficit * 2);
    }
    // Material sufficiency with a spatial dead end is not a reason to spend stamina.
    if (![...missing].some(([id, num]) => num > 0 && !previous.get(id))) return [];
    const mergeCandidates = [], transfers = [];
    for (const row of types) {
      if (!positive(missing.get(row.nextId)) || previous.get(row.nextId) !== row.pieceId) continue;
      const pieces = stock.get(row.pieceId) ?? [], board = pieces.filter(piece => piece.location === 'board');
      const bag = pieces.filter(piece => piece.location === 'warehouse');
      const half = halfUse.get(row.pieceId) ? halves.get(row.pieceId)?.[0] : null;
      if (board.length && (half || board.length >= 2))
        mergeCandidates.push({ kind: 'mergeOrders', from: board[0], to: half ?? board[1], nextId: row.nextId });
      if (bag.length && (board.length || half || bag.length >= 2))
        transfers.push({ kind: 'takeWarehouse', piece: bag[0], room: board.length || half ? 1 : 2 });
    }
    // A useful merge reduces occupancy without spending stamina. Never merge
    // beyond this order's remaining demand, or consume any reserved product.
    if (mergeCandidates.length) return [{ ...result, next: mergeCandidates[0] }];
    const transfer = transfers.find(step => state.emptyCells >= step.room);
    if (transfer) return [{ ...result, next: transfer }];

    const candidates = [], blocked = [];
    for (const cell of producers) {
      const matches = configs.filter(row => row.produceid === cell.piece.id), cfg = matches[0];
      if (matches.length !== 1 || !cfg.libId || ![cfg.cost, cfg.count, cfg.cd].every(natural)) continue;
      const outputs = libraries.filter(row => row.libId === cfg.libId && row.weight !== 0);
      if (!outputs.length || outputs.some(row => !positive(row.weight) || !byId.has(row.pieceId))) continue;
      const weight = outputs.reduce((sum, row) => sum + row.weight, 0);
      // Compare expected useful base units per stamina, using the actual libId
      // (the display group and producer level may name a different drop table).
      const gain = outputs.reduce((sum, row) => sum + (positive(missing.get(row.pieceId))
        ? row.weight * 2 ** (byId.get(row.pieceId).level - 1) : 0), 0) / weight;
      if (!(gain > 0) || !Number.isFinite(gain)) continue;
      let reason = '';
      const remainingKnown = natural(cell.piece.produceLeft) || cfg.count === 0 && cell.piece.produceLeft === -1;
      if (!natural(cell.piece.produceCdTs) || !remainingKnown) reason = '生产器次数或冷却状态未同步';
      else if (cell.piece.produceCdTs > state.now) reason = `生产器冷却中，剩余 ${Math.ceil(cell.piece.produceCdTs - state.now)} 秒`;
      else if (cfg.count > 0 && cell.piece.produceLeft === 0) reason = '生产器次数已用完，等待游戏同步';
      else if (state.stamina < cfg.cost) reason = '工坊体力不足';
      if (reason) { blocked.push(reason); continue; }
      candidates.push({ kind: 'produceOrders', producer: { ...cell.piece, cellId: cell.cellId },
        staminaCost: cfg.cost, count: cfg.count, cd: cfg.cd,
        outputs: [...new Set(outputs.map(row => row.pieceId))], score: cfg.cost ? gain / cfg.cost : Infinity, gain });
    }
    candidates.sort((a, b) => b.score - a.score || b.gain - a.gain || a.producer.cellId - b.producer.cellId);
    const producer = candidates[0];
    if (producer && state.emptyCells > 0) return [{ ...result, next: producer }];
    if (!producer && !transfers.length) {
      if (!blocked.length) {
        const built = planProducerChain(config, state, missing, traversal);
        if (built?.next) return [{ ...result, ...built, next: { ...built.next, forProducer: true } }];
        if (built?.reason) return [{ ...result, reason: built.reason }];
      }
      return [{ ...result, reason: blocked[0]
        || (producers.length ? '没有能补齐当前缺料的已解锁生产器' : '棋盘上没有已解锁的生产器') }];
    }
    // Reserve space for the next useful action only. Prefer unrelated pieces,
    // then high-level intermediates; stored products retain their UID and are
    // reconsidered by A* after every confirmed production or transfer.
    if (!positive(state.warehouseCapacity)) return [{ ...result, reason: '仓库容量未确认，等待同步后腾位' }];
    if (state.warehouse.length >= state.warehouseCapacity) return [{ ...result, reason: '仓库已满，无法为生产腾位' }];
    const incoming = transfers[0]?.piece.id;
    const parked = state.cells.filter(cell => cell.state === 2 && ordinary(byId.get(cell.piece?.id))
      && !(incoming && cell.piece.id === incoming))
      .sort((a, b) => Number(required.has(a.piece.id)) - Number(required.has(b.piece.id))
        || byId.get(b.piece.id).level - byId.get(a.piece.id).level || a.cellId - b.cellId)[0];
    if (!parked) return [{ ...result, reason: '没有可暂存的普通棋子，等待整理棋盘后生产' }];
    return [{ ...result, next: { kind: 'warehouseBuffer', piece: { ...parked.piece, cellId: parked.cellId } } }];
  });
}

function planProducerChain(config, state, missing, traversal) {
  const path = traversal.path ?? [], budget = traversal.budget ?? { left: 48 };
  if (path.length >= 8 || budget.left <= 0) return { reason: '生产器依赖规划达到搜索上限，等待下次检查' };
  const pieces = table(config, 'DualCombinePieceCfg'), byId = new Map(pieces.map(row => [row.pieceId, row]));
  const configs = table(config, 'DualCombineProduceCfg'), libraries = table(config, 'DualCombineProduceLibCfg');
  const sources = configs.filter(cfg => byId.get(cfg.produceid)?.type === '生产器' && !path.includes(cfg.produceid)
    && [cfg.cost, cfg.count, cfg.cd].every(natural)
    && libraries.some(row => row.libId === cfg.libId && positive(row.weight) && positive(missing.get(row.pieceId))))
    .sort((a, b) => byId.get(a.produceid).level - byId.get(b.produceid).level || a.cost - b.cost || a.produceid.localeCompare(b.produceid));
  const candidates = [], deferred = [];
  for (const source of sources) {
    if (--budget.left < 0) break;
    const target = byId.get(source.produceid);
    // A synthetic goal may merge only the predecessor chain of this required
    // producer. Other producers remain fixed. Part-used finite producers are
    // preserved rather than throwing away their remaining charges by upgrading.
    const chain = new Set([target.pieceId]);
    let cursor = target;
    while (cursor) {
      const parents = pieces.filter(row => row.nextId === cursor.pieceId && row.pieceGroup === cursor.pieceGroup && row.level + 1 === cursor.level);
      if (parents.length !== 1) break;
      cursor = parents[0];
      if (chain.has(cursor.pieceId)) break;
      chain.add(cursor.pieceId);
    }
    const modelConfig = { ...config, tables: { ...config.tables, DualCombinePieceCfg: { data: pieces.map(row =>
      chain.has(row.pieceId) && row.type === '生产器' ? { ...row, type: '普通' } : row) } } };
    const keep = piece => {
      const cfg = configs.find(row => row.produceid === piece.id);
      return chain.has(piece.id) && cfg?.count > 0 && piece.produceLeft !== cfg.count;
    };
    const slot = Math.max(-1, ...state.orders.map(order => order.slot)) + 1;
    const plannedState = { ...state,
      cells: state.cells.map(cell => cell.piece && keep(cell.piece) ? { ...cell, state: 0 } : cell),
      warehouse: state.warehouse.filter(piece => !keep(piece)),
      orders: [...state.orders, { slot, orderId: 0, reqs: [{ pieceCfgId: target.pieceId, count: 1 }] }],
    };
    // Retain excluded warehouse occupancy; such pieces cannot be consumed or
    // fetched as part of the synthetic goal.
    if (positive(plannedState.warehouseCapacity)) plannedState.warehouseCapacity -= state.warehouse.length - plannedState.warehouse.length;
    const plans = planHomelandMerges(modelConfig, plannedState, { takeWarehouse: true, warehouseBuffer: true, targetSlot: slot, searchLimits: { maxExpanded: 1500, maxStates: 5000, maxMilliseconds: 15 } });
    const plan = plans.find(row => row.slot === slot);
    if (plan?.next) candidates.push({ next: plan.next, steps: plan.steps ?? Infinity, reason: `先备好${target.name}，再生产订单原料` });
    else if (plan?.status === 'unreachable') deferred.push({ modelConfig, plannedState, plans, slot, target });
  }
  if (candidates.length) return candidates.sort((a, b) => a.steps - b.steps)[0];
  let blockedReason = '';
  for (const item of deferred) {
    if (budget.left <= 0) break;
    const next = planHomelandProduction(config, item.plannedState, item.plans,
      { modelConfig: item.modelConfig, slot: item.slot, path: [...path, item.target.pieceId], budget })[0];
    if (next?.next) return { next: next.next, reason: `先为${item.target.name}备料，再衔接订单生产` };
    if (/体力|冷却/.test(next?.reason)) blockedReason ||= next.reason;
  }
  return sources.length ? { reason: blockedReason || (budget.left <= 0 ? '生产器依赖规划达到搜索上限，等待下次检查' : '缺少合成所需生产器的材料或可用空间') } : null;
}
