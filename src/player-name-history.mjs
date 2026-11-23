import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { atomicJson, readJson, withFileLock } from './json-store.mjs';
import { accountKey, dataDirectory } from './usage-ledger.mjs';
import { validPlayerIdText } from './extended-settings.mjs';

const historyFile = account => path.join(dataDirectory(), 'player-names', createHash('sha256').update(accountKey(account)).digest('hex') + '.json');

function listRules(settings) {
  const treasure = settings?.treasure ?? {}, alliance = settings?.alliance ?? {}, fleets = settings?.silicon?.fleets ?? [];
  const ids = new Set([...(treasure.followPlayerIds ?? []), ...(treasure.avoidPlayerIds ?? []), ...(treasure.chasePlayerIds ?? []),
    ...(alliance.memberIds ?? []), ...fleets.flatMap(f => [...(f.safePlayerIds ?? []), ...(f.huntPlayerIds ?? [])])]);
  const names = new Set([...(treasure.followNames ?? []), ...(treasure.avoidNames ?? []), ...(treasure.chaseNames ?? [])]);
  const folded = new Set([...(alliance.memberKeywords ?? []), ...fleets.flatMap(f => [...(f.huntPlayers ?? []), ...(f.safePlayers ?? [])])].map(name => name.toLocaleLowerCase()));
  return { ids, hasNames: names.size > 0 || folded.size > 0, matches: name => names.has(name) || folded.has(name.toLocaleLowerCase()) };
}

function listed(rules, id, record) {
  return rules.ids.has(id) || record && (rules.matches(record.name) || record.previous.some(rules.matches));
}

export function listedPlayerNames(account, settings) {
  const rules = listRules(settings);
  if (!rules.ids.size && !rules.hasNames) return {};
  const history = readJson(historyFile(account), {});
  return Object.fromEntries(Object.entries(history).filter(([id, record]) => listed(rules, id, record)));
}

// 仅同一个精确 ID 的新资料可以更新昵称。行军等快照只用于建立首次对应关系。
export function rememberPlayerNames(account, settings, observations, { initialOnly = false } = {}) {
  const rules = listRules(settings);
  if (!rules.ids.size && !rules.hasNames) return;
  const names = new Map();
  for (const { id, name } of observations) {
    if (!validPlayerIdText(id) || typeof name !== 'string' || !name.trim() || name.length > 120) continue;
    if (initialOnly && !rules.ids.has(id) && !rules.matches(name)) continue;
    names.set(id, !names.has(id) || names.get(id) === name ? name : null);
  }
  if (!names.size) return;
  const file = historyFile(account);
  const changes = history => [...names].filter(([id, name]) => name && history[id]?.name !== name && !(initialOnly && history[id])
    && (rules.matches(name) || listed(rules, id, history[id])));
  if (!changes(readJson(file, {})).length) return;
  return withFileLock(file, () => {
    const history = readJson(file, {}), updates = changes(history);
    for (const [id, name] of updates) {
      const old = history[id];
      history[id] = { name, previous: old ? [...new Set([old.name, ...old.previous])].filter(alias => alias !== name) : [] };
    }
    if (!updates.length) return;
    atomicJson(file, history);
    return Object.fromEntries(updates.map(([id]) => [id, history[id]]));
  });
}

export function knownListPlayerIds(settings, history) {
  return new Set([...listRules(settings).ids, ...Object.keys(history)]);
}

export function prunePlayerNames(account, settings) {
  const file = historyFile(account), rules = listRules(settings);
  if (!fs.existsSync(file)) return;
  withFileLock(file, () => {
    if (!settings) { fs.rmSync(file, { force: true }); return; }
    const history = readJson(file, {});
    const keep = Object.entries(history).filter(([id, record]) => listed(rules, id, record));
    if (!keep.length) fs.rmSync(file, { force: true });
    else if (keep.length !== Object.keys(history).length) atomicJson(file, Object.fromEntries(keep));
  });
}
