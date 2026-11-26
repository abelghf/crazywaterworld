import { natural, positive, table } from './activity-actions.mjs';
import { homelandMergeModel } from './homeland-merge.mjs';

// v77 has no separate usable-reward table. Accept only the two configured
// resource families and their explicit collection amount; the response and
// complete inventory still have to confirm that amount after use.
export function homelandSupplyReward(row) {
  if (row?.type !== '可使用') return null;
  const stamina = /^体力瓶[1-5]$/.test(row.pieceId) && row.pieceGroup === '体力';
  const coins = /^金币[1-5]$/.test(row.pieceId) && row.pieceGroup === '金币';
  const match = (stamina || coins) && row.desc?.match(stamina ? /点击收集([1-9]\d*)点体力[。．]/ : /点击收集([1-9]\d*)个家园币[。．]/);
  const amount = match ? Number(match[1]) : 0;
  return positive(amount) ? { resource: stamina ? 'stamina' : 'coins', amount } : null;
}

export function homelandSupplyBox(config, id) {
  const byId = new Map(table(config, 'DualCombinePieceCfg').map(row => [row.pieceId, row]));
  const matches = table(config, 'DualCombineProduceCfg').filter(row => row.produceid === id);
  const cfg = matches[0];
  if (byId.get(id)?.type !== '生产器' || matches.length !== 1 || cfg.cost !== 0 || !positive(cfg.count) || !natural(cfg.cd)) return null;
  const outputs = table(config, 'DualCombineProduceLibCfg').filter(row => row.libId === cfg.libId && row.weight !== 0);
  return outputs.length && outputs.every(row => positive(row.weight) && homelandSupplyReward(byId.get(row.pieceId)))
    ? { ...cfg, outputs: outputs.map(row => row.pieceId) } : null;
}

export function planHomelandSupplies(config, state, { stamina = 0, coins = 0 } = {}) {
  const { byId, stock } = homelandMergeModel(config, state, true, true);
  const items = [...stock.values()].flat().filter(piece => homelandSupplyReward(byId.get(piece.id)))
    .map(piece => ({ piece, row: byId.get(piece.id), reward: homelandSupplyReward(byId.get(piece.id)) }));
  const board = items.filter(item => item.piece.location === 'board');
  const use = item => ({ kind: 'useSupplies', piece: item.piece, reward: item.reward });
  const terminal = board.find(item => !item.row.nextId);
  if (terminal) return { next: use(terminal) };
  // A profitable pair always precedes collecting a lower level, even when
  // stamina is empty. It also frees one cell without losing resource value.
  for (const item of [...items].sort((a, b) => b.row.level - a.row.level)) {
    const next = byId.get(item.row.nextId), reward = homelandSupplyReward(next);
    if (!next || next.pieceGroup !== item.row.pieceGroup || next.level !== item.row.level + 1
      || reward?.resource !== item.reward.resource || reward.amount < item.reward.amount * 2) continue;
    const pair = items.filter(other => other.piece.id === item.piece.id);
    const ready = pair.filter(other => other.piece.location === 'board');
    if (ready.length >= 2) return { next: { kind: 'mergeSupplies', from: ready[0].piece, to: ready[1].piece, nextId: next.pieceId } };
    const stored = pair.filter(other => other.piece.location === 'warehouse');
    if (ready.length + stored.length >= 2 && state.emptyCells >= (ready.length ? 1 : 2))
      return { next: { kind: 'takeWarehouse', piece: stored[0].piece } };
  }
  const needs = { stamina, coins };
  const needed = board.filter(item => needs[item.reward.resource] > 0).sort((a, b) => {
    const enoughA = a.reward.amount >= needs[a.reward.resource], enoughB = b.reward.amount >= needs[b.reward.resource];
    return Number(enoughB) - Number(enoughA) || (enoughA ? a.reward.amount - b.reward.amount : b.reward.amount - a.reward.amount);
  });
  if (needed.length) return { next: use(needed[0]) };
  if (!state.emptyCells && board.length) return { next: use([...board].sort((a, b) => b.reward.amount - a.reward.amount)[0]) };
  if (state.emptyCells) {
    const stored = items.find(item => item.piece.location === 'warehouse' && (!item.row.nextId || needs[item.reward.resource] > 0));
    if (stored) return { next: { kind: 'takeWarehouse', piece: stored.piece } };
    const boxes = state.cells.filter(cell => cell.state === 2 && cell.piece).map(cell => ({ cell, cfg: homelandSupplyBox(config, cell.piece.id) }))
      .filter(({ cell, cfg }) => cfg && positive(cell.piece.produceLeft) && natural(cell.piece.produceCdTs) && cell.piece.produceCdTs <= state.now)
      .sort((a, b) => Number(b.cfg.outputs.some(id => needs[homelandSupplyReward(byId.get(id)).resource] > 0))
        - Number(a.cfg.outputs.some(id => needs[homelandSupplyReward(byId.get(id)).resource] > 0)) || a.cell.cellId - b.cell.cellId);
    if (boxes.length) {
      const { cell, cfg } = boxes[0];
      return { next: { kind: 'openSupplies', producer: { ...cell.piece, cellId: cell.cellId },
        staminaCost: 0, outputs: cfg.outputs, count: cfg.count, cd: cfg.cd } };
    }
    // Leave a working cell when taking an unknown sequence of rewards. The
    // advertised next piece is authoritative; never assume every reward is a box.
    if (state.emptyCells >= 2 && positive(state.chestCount) && byId.has(state.newestPieceCfgId))
      return { next: { kind: 'takeRewards', pieceId: state.newestPieceCfgId } };
  }
  return { next: null, reason: state.chestCount > 0 && state.emptyCells < 2 ? '奖励区有物品，等待至少两个空格后逐件取出' : '' };
}
