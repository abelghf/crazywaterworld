import { natural, positive, table } from './activity-actions.mjs';
import { homelandMergeModel } from './homeland-merge.mjs';

const ordinary = row => row && ['普通', '产品'].includes(row.type);

// Production is stochastic. Keep the deterministic A* solution whenever one
// exists; otherwise take one useful step and plan again from the server reply.
// Exact products reserved for all orders remain available for delivery.
export function planHomelandProduction(config, state, pref, mergePlans, usedStamina = 0) {
  const { byId, previous, stock, halves, requests } = homelandMergeModel(config, state, pref.takeWarehouse, pref.warehouseBuffer);
  const producers = state.cells.filter(cell => cell.state === 2 && byId.get(cell.piece?.id)?.type === '生产器');
  const configs = table(config, 'DualCombineProduceCfg'), libraries = table(config, 'DualCombineProduceLibCfg');
  const types = [...byId.values()].filter(ordinary).sort((a, b) => b.level - a.level);
  return requests.flatMap(request => {
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
      if (!natural(cell.piece.produceCdTs) || !natural(cell.piece.produceLeft)) reason = '生产器次数或冷却状态未同步';
      else if (cell.piece.produceCdTs > state.now) reason = `生产器冷却中，剩余 ${Math.ceil(cell.piece.produceCdTs - state.now)} 秒`;
      else if (cfg.count > 0 && cell.piece.produceLeft === 0) reason = '生产器次数已用完，等待游戏同步';
      else if (state.stamina - cfg.cost < pref.keepStamina) reason = '工坊体力不足或低于保留量';
      else if (usedStamina + cfg.cost > pref.dailyStaminaLimit) reason = '今日工坊生产体力预算不足';
      if (reason) { blocked.push(reason); continue; }
      candidates.push({ kind: 'produceOrders', producer: { ...cell.piece, cellId: cell.cellId },
        staminaCost: cfg.cost, count: cfg.count, cd: cfg.cd,
        outputs: [...new Set(outputs.map(row => row.pieceId))], score: cfg.cost ? gain / cfg.cost : Infinity, gain });
    }
    candidates.sort((a, b) => b.score - a.score || b.gain - a.gain || a.producer.cellId - b.producer.cellId);
    const producer = candidates[0];
    if (producer && state.emptyCells > 0) return [{ ...result, next: producer }];
    if (!producer && !transfers.length) return [{ ...result, reason: blocked[0]
      || (producers.length ? '没有能补齐当前缺料的已解锁生产器' : '棋盘上没有已解锁的生产器') }];
    // Reserve space for the next useful action only. Prefer unrelated pieces,
    // then high-level intermediates; stored products retain their UID and are
    // reconsidered by A* after every confirmed production or transfer.
    if (!pref.takeWarehouse || !pref.warehouseBuffer)
      return [{ ...result, reason: '棋盘空间不足，请开启仓库取料与中转或整理棋盘' }];
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
