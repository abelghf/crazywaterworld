// 装备与徽章的本机状态：首次读到的时间（当作「入库时间」）和已读标记。
// 协议里没有获得时间字段，只有 uid，所以只能记录第一次读到它的时刻。
import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from './json-store.mjs';
import { dataDirectory } from './usage-ledger.mjs';

export function itemsStatePath(accountId) {
  return path.join(dataDirectory(), 'items', encodeURIComponent(String(accountId)) + '.json');
}

function readState(accountId) {
  try {
    const raw = JSON.parse(fs.readFileSync(itemsStatePath(accountId), 'utf8'));
    if (raw && typeof raw === 'object' && raw.items && typeof raw.items === 'object') {
      return { version: 1, baselineAt: Number(raw.baselineAt ?? 0), updatedAt: Number(raw.updatedAt ?? 0), items: raw.items };
    }
  } catch { /* 首次运行或文件损坏都按空状态处理 */ }
  return { version: 1, baselineAt: 0, updatedAt: 0, items: {} };
}

const unreadOf = state => Object.values(state.items).filter(entry => entry && entry.read !== true).length;

/**
 * 把这次读到的物品合并进状态：
 * 第一次运行只建立基线并全部标为已读，避免一上线几百个红点；之后新出现的才算未读。
 */
export function syncItems(accountId, rows, now = Date.now()) {
  const state = readState(accountId);
  const baseline = !state.baselineAt;
  let added = 0;
  const alive = new Set();
  for (const row of rows) {
    const key = row.kind + ':' + row.uid;
    alive.add(key);
    const known = state.items[key];
    if (known) {
      row.firstSeen = Number(known.firstSeen ?? now);
      row.read = known.read === true;
      row.isNew = !row.read;
      continue;
    }
    state.items[key] = { firstSeen: now, read: baseline };
    row.firstSeen = now;
    row.read = baseline;
    row.isNew = !baseline;
    if (!baseline) added += 1;
  }
  // 分解/消耗掉的物品要清掉，状态文件不能只涨不落
  for (const key of Object.keys(state.items)) if (!alive.has(key)) delete state.items[key];
  if (baseline) state.baselineAt = now;
  state.updatedAt = now;
  atomicJson(itemsStatePath(accountId), state);
  return { added, baseline, unread: unreadOf(state) };
}

/** 看过某一件就把它标为已读，不必等「一键已读」。 */
export function markItemRead(accountId, key) {
  const state = readState(accountId);
  const entry = state.items[key];
  if (!entry || entry.read === true) return { changed: 0, unread: unreadOf(state) };
  entry.read = true;
  state.updatedAt = Date.now();
  atomicJson(itemsStatePath(accountId), state);
  return { changed: 1, unread: unreadOf(state) };
}

export function markAllItemsRead(accountId) {
  const state = readState(accountId);
  let changed = 0;
  for (const entry of Object.values(state.items)) {
    if (entry && entry.read !== true) { entry.read = true; changed += 1; }
  }
  state.updatedAt = Date.now();
  atomicJson(itemsStatePath(accountId), state);
  return changed;
}

export function unreadItems(accountId) {
  return unreadOf(readState(accountId));
}
