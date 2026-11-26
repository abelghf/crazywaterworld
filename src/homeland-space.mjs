import { homelandMergeModel } from './homeland-merge.mjs';

// Compact only surplus ordinary pieces. Reserve not just finished orders but
// their lower-tier materials, so making room cannot over-merge a needed item.
export function planHomelandSpace(config, state, requiredEmpty = 0) {
  // A concrete production/withdrawal must need this room now. Spare pairs or
  // fewer than two free cells alone never authorize upgrading unrelated goods.
  if (!Number.isSafeInteger(requiredEmpty) || requiredEmpty <= state.emptyCells) return null;
  const { byId, previous, stock, requests } = homelandMergeModel(config, state, true, true);
  const required = new Map();
  for (const request of requests) for (const { id, num } of request.missing)
    required.set(id, (required.get(id) ?? 0) + num);
  const surplus = new Map();
  for (const row of [...byId.values()].sort((a, b) => b.level - a.level)) {
    const pieces = stock.get(row.pieceId) ?? [], need = required.get(row.pieceId) ?? 0;
    // Use the same UID order across board/warehouse as product reservations.
    const ordered = [...pieces].sort((a, b) => a.uid - b.uid);
    surplus.set(row.pieceId, ordered.slice(Math.min(need, ordered.length)));
    const lower = previous.get(row.pieceId), deficit = Math.max(0, need - pieces.length);
    if (lower && deficit) required.set(lower, (required.get(lower) ?? 0) + deficit * 2);
  }
  const pairs = [];
  for (const [id, pieces] of surplus) {
    const row = byId.get(id);
    if (!row?.nextId || previous.get(row.nextId) !== id) continue;
    const board = pieces.filter(piece => piece.location === 'board');
    if (board.length >= 2) pairs.push({ kind: 'mergeOrders', from: board[0], to: board[1], nextId: row.nextId, forSpace: true });
  }
  return pairs.sort((a, b) => byId.get(a.from.id).level - byId.get(b.from.id).level || a.from.cellId - b.from.cellId)[0] ?? null;
}
