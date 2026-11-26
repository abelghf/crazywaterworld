import { randomUUID } from 'node:crypto';
import { exactAutomationId } from './automation-policy.mjs';
import { normalizeFormation, formationSignature, readLineupEditor, validateEditorFormation } from './saved-lineups.mjs';
import { fleetRecordReason } from './fleet-availability.mjs';
import { isFleetReserved } from './fleet-reservations.mjs';

const busy = new WeakSet();
const journalTypes = {
  worldBossLineup: { prefix: 'world-boss-lineup:', dispatch: 'worldBoss', dispatchPrefix: 'world-boss:' },
  pirateLineup: { prefix: 'pirate-lineup:', dispatch: 'pirateFirst', dispatchPrefix: 'pirate-first:' },
};
export const isFleetLineupRecord = record => Object.hasOwn(journalTypes, record?.details?.kind);
const clone = value => structuredClone(value);
const isFleetId = value => typeof value === 'string' && /^[1-9]\d*远征船$/.test(value);
const zero = value => value == null || value === 0 || value === '0' || value.low === 0 && value.high === 0;
const home = fleet => fleet?.state === 1 && fleet.curGridIdx === 0 && zero(fleet.treasureLootUid)
  && !fleet.chipWar?.rewardTs && !fleet.autoFight?.isOn;

function roleOf(player) {
  const playerId = exactAutomationId(player?.playerId ?? player?.id), worldId = exactAutomationId(player?.worldId);
  if (!playerId || !worldId) throw new Error('无法确认舰队阵容所属角色与区服');
  return { playerId, worldId };
}

// FleetFormation does not contain a pet field. Saved lineup pets belong to
// other game modes and must never be serialized into the fleet protocol.
function fleetFormation(value, allowEmpty = false) {
  const normalized = normalizeFormation({ ...value, petUid: '0' }, { allowEmpty });
  return { presetId: normalized.presetId, heroPositions: normalized.heroPositions };
}

export const fleetFormationSignature = value => formationSignature({ ...value, petUid: '0' });
const signature = fleetFormationSignature;
const journalKey = (kind, role, buildingId) => journalTypes[kind].prefix + role.worldId + ':' + role.playerId + ':' + buildingId.replace('远征船', '');
const sameRole = (left, right) => left?.playerId === right.playerId && left?.worldId === right.worldId;
const active = (client, enabled) => client.connected !== false && enabled();

function emit(report, kind, entry) {
  const owner = kind === 'pirateLineup' ? { label: '海盗挑战阵容' } : { label: '世界Boss临时阵容', taskKey: 'worldBoss' };
  try { Promise.resolve(report({ ...owner, ...entry })).catch(() => {}); }
  catch { /* A log observer cannot interrupt restoration. */ }
}

function journalEntries(ledger) {
  return Object.entries(ledger.keyRecords()).filter(([key, record]) =>
    isFleetLineupRecord(record) || Object.values(journalTypes).some(type => key.startsWith(type.prefix)));
}

function validateJournal(key, record) {
  const details = record.details;
  if (!isFleetLineupRecord(record) || !isFleetId(details.buildingId)
    || !['prepared', 'dispatched', 'settled'].includes(details.phase)) throw new Error('舰队阵容恢复记录损坏');
  const role = roleOf(details.role);
  if (key !== journalKey(details.kind, role, details.buildingId)) throw new Error('舰队阵容恢复记录身份不一致');
  if (details.transferId !== undefined && (typeof details.transferId !== 'string' || !details.transferId)
    || details.support && !details.transferId) throw new Error('舰队借用英雄恢复记录损坏');
  return { ...details, role, original: fleetFormation(details.original, true), target: fleetFormation(details.target, details.support === true),
    ...(details.released && { released: fleetFormation(details.released, true) }),
    ...(details.restoring && { restoring: fleetFormation(details.restoring, true) }) };
}

async function snapshot(client) {
  const water = await client.request('OnWaterRequest', {}, 'OnWaterResponse');
  const own = await client.request('MyFleetsRequest', {}, 'MyFleetsResponse');
  if (!Array.isArray(water?.building) || !Array.isArray(own?.fleets)) throw new Error('舰队阵容或返航状态未同步');
  const docks = water.building.filter(row => isFleetId(row.buildingId) && row.level > 0);
  if (new Set(docks.map(row => row.buildingId)).size !== docks.length
    || new Set(own.fleets.map(row => row.buildingId)).size !== own.fleets.length) throw new Error('舰队状态重复，未换阵');
  return { docks, fleets: own.fleets };
}

function dockFor(state, buildingId) {
  const dock = state.docks.find(row => row.buildingId === buildingId);
  if (!dock) throw new Error(buildingId + '尚未建成或阵容未同步');
  return dock;
}

function assertHeroesFree(formation, buildingId, docks) {
  const wanted = new Set(formation.heroPositions.map(row => row.heroId));
  for (const dock of docks) {
    if (dock.buildingId === buildingId) continue;
    const occupied = dock.fleet?.formation?.heroPositions ?? [];
    if (!Array.isArray(occupied)) throw new Error(dock.buildingId + '的英雄占用未同步');
    const conflict = occupied.find(row => wanted.has(row.heroId));
    if (conflict) throw new Error(conflict.heroId + '已编入' + dock.buildingId + '，不能同时编入' + buildingId);
  }
}

function withoutTransferredHeroes(formation, buildingId, owners) {
  return { ...formation, heroPositions: formation.heroPositions.filter(row => !owners.has(row.heroId) || owners.get(row.heroId) === buildingId) };
}

function assertKnownFormation(current, details) {
  if (![details.original, details.target, details.released, details.restoring].filter(Boolean)
    .some(formation => signature(formation) === signature(current))) {
    throw new Error('舰队阵容已被其他操作修改，未覆盖当前阵容');
  }
}

function assertDispatchFinished(details, ledger) {
  if (details.phase !== 'dispatched') return;
  const dispatch = ledger.keyRecords()[details.dispatchKey];
  const finished = dispatch?.details?.active === false || (details.kind === 'pirateLineup'
    && dispatch?.confirmed && ['won', 'lost'].includes(dispatch.details?.outcome));
  if (!finished || dispatch.details.kind !== journalTypes[details.kind].dispatch
    || dispatch.details.buildingId !== details.buildingId || (details.dispatchId && details.dispatchId !== dispatch.id)) {
    throw new Error('派遣尚未确认结束，返航后恢复阵容');
  }
}

function currentRecord(ledger, key, expected) {
  const current = ledger.keyRecords()[key];
  if (!current || current.id !== expected.id) throw new Error('舰队阵容恢复记录已变化');
  return current;
}

async function saveAndConfirm(client, buildingId, formation) {
  let error;
  try { await client.sendWatch('FleetSaveFormationRequest', { buildingId, formation: clone(formation) }); }
  catch (failure) { error = failure; }
  // A lost response can follow a successful write. Always read before deciding.
  const water = await client.request('OnWaterRequest', {}, 'OnWaterResponse');
  const matches = water?.building?.filter(row => row.buildingId === buildingId);
  if (matches?.length !== 1 || signature(fleetFormation(matches[0].fleet?.formation, true)) !== signature(formation)) {
    throw error ?? new Error('服务端尚未确认' + buildingId + '的阵容');
  }
}

async function recover(client, player, ledger, { enabled, report, onlyKeys }) {
  const all = journalEntries(ledger);
  const transfers = new Set(all.filter(([key]) => onlyKeys?.has(key)).map(([, record]) => record.details?.transferId).filter(Boolean));
  const entries = all.filter(([key, record]) => !onlyKeys || onlyKeys.has(key) || transfers.has(record.details?.transferId));
  const result = { restored: [], pending: [] };
  if (!entries.length) return result;
  const role = roleOf(player), groups = new Map();
  for (const entry of entries) {
    const id = entry[1].details?.transferId || entry[0];
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(entry);
  }
  for (const group of groups.values()) {
    try {
      const changes = group.map(([key, record]) => ({ key, record, details: validateJournal(key, record) }));
      const assertActive = () => {
        if (!active(client, enabled) || !sameRole(roleOf(player), role)) throw new Error('连接或账号状态已变化，原阵容等待下次连接恢复');
        for (const { key, record, details } of changes) {
          currentRecord(ledger, key, record);
          if (!sameRole(details.role, role)) throw new Error('待恢复舰队阵容属于其他角色或区服');
          assertDispatchFinished(details, ledger);
        }
      };
      assertActive();
      const state = await snapshot(client);
      const owners = new Map(), observed = new Map(), ids = new Set(changes.map(change => change.details.buildingId));
      for (const { key, details } of changes) {
        if (!home(state.fleets.find(row => row.buildingId === details.buildingId))) throw new Error('舰队尚未空闲返航，暂不恢复阵容');
        const current = fleetFormation(dockFor(state, details.buildingId).fleet?.formation, true);
        assertKnownFormation(current, details);
        observed.set(key, current);
        assertHeroesFree(details.original, details.buildingId, state.docks.filter(dock => !ids.has(dock.buildingId)));
        for (const { heroId } of details.original.heroPositions) {
          if (owners.has(heroId)) throw new Error('原阵容存在重复英雄，暂不恢复');
          owners.set(heroId, details.buildingId);
        }
      }
      // Return borrowed heroes before restoring any ship, including cyclic swaps.
      // Persist intermediate formations so a restart can resume either stage.
      for (const releasing of [true, false]) for (const { key, details } of changes) {
        const previous = observed.get(key);
        const planned = releasing ? withoutTransferredHeroes(previous, details.buildingId, owners) : details.original;
        if (signature(previous) === signature(planned)) continue;
        const fresh = await snapshot(client);
        for (const change of changes) {
          if (!home(fresh.fleets.find(row => row.buildingId === change.details.buildingId))) throw new Error('舰队尚未空闲返航，暂不恢复阵容');
          assertKnownFormation(fleetFormation(dockFor(fresh, change.details.buildingId).fleet?.formation, true), change.details);
        }
        const current = fleetFormation(dockFor(fresh, details.buildingId).fleet?.formation, true);
        const target = releasing ? withoutTransferredHeroes(current, details.buildingId, owners) : details.original;
        assertActive();
        observed.set(key, current);
        if (signature(current) === signature(target)) continue;
        assertHeroesFree(target, details.buildingId, fresh.docks);
        if (releasing) {
          details.restoring = target;
          ledger.updateKeyDetails(key, { ...details });
        }
        await saveAndConfirm(client, details.buildingId, target);
        observed.set(key, target);
      }
      const restored = await snapshot(client);
      for (const { details } of changes) {
        if (!home(restored.fleets.find(row => row.buildingId === details.buildingId))) throw new Error('舰队尚未空闲返航，暂不恢复阵容');
        if (signature(fleetFormation(dockFor(restored, details.buildingId).fleet?.formation, true)) !== signature(details.original)) {
          throw new Error('核对时舰队阵容已变化，原阵容恢复记录已保留');
        }
      }
      assertActive();
      // A crash between reserve() and confirm() leaves a valid no-cost snapshot.
      for (const { key, details } of changes) {
        if (!ledger.keyRecords()[key].confirmed) ledger.resolveKey(key, true);
        ledger.releaseCompletedKey(key);
        result.restored.push(key);
        emit(report, details.kind, { ok: true, buildingId: details.buildingId, reason: details.buildingId + '已恢复出战前阵容' });
      }
    } catch (error) {
      for (const [key, record] of group) {
        if (result.restored.includes(key)) continue;
        result.pending.push(key);
        const current = ledger.keyRecords()[key], unchanged = current?.details?.reason === error.message;
        if (current?.id === record.id && !unchanged) ledger.updateKeyDetails(key, { ...current.details, reason: error.message });
        if (!unchanged) emit(report, record.details?.kind, { skipped: true, status: 'pending', buildingId: record.details?.buildingId, reason: error.message });
      }
    }
  }
  return result;
}

export async function recoverFleetLineups(client, player, ledger, { enabled = () => true, report = () => {}, onlyKeys } = {}) {
  if (busy.has(client)) throw new Error('舰队阵容正在核对');
  busy.add(client);
  try { return await recover(client, player, ledger, { enabled, report, onlyKeys }); }
  finally { busy.delete(client); }
}

export async function prepareFleetLineups(client, config, player, {
  kind, selections, fleetIds = selections.map(selection => selection.buildingId), ledger, enabled = () => true, report = () => {},
}) {
  if (busy.has(client)) throw new Error('舰队阵容正在核对');
  busy.add(client);
  const keys = [];
  try {
    if (!selections.length) return keys;
    if (!Object.hasOwn(journalTypes, kind) || selections.some(row => !isFleetId(row.buildingId))
      || new Set(selections.map(row => row.buildingId)).size !== selections.length) {
      throw new Error('出战舰队选择无效');
    }
    const role = roleOf(player);
    if (!active(client, enabled)) throw new Error('账号状态已变化，未切换舰队阵容');
    for (const [, record] of journalEntries(ledger)) {
      if (fleetIds.includes(record.details?.buildingId)) throw new Error('出战舰队的上次阵容尚待恢复');
    }
    const editor = await readLineupEditor(client, config, player);
    const state = await snapshot(client), assigned = new Map(), occupiedBy = new Map();
    for (const dock of state.docks) {
      const occupied = dock.fleet?.formation?.heroPositions ?? [];
      if (!Array.isArray(occupied)) throw new Error(dock.buildingId + '的英雄占用未同步');
      for (const { heroId } of occupied) {
        if (occupiedBy.has(heroId)) throw new Error('舰队英雄占用重复，暂不切换阵容');
        occupiedBy.set(heroId, dock.buildingId);
      }
    }
    const readOriginal = buildingId => {
      const saved = dockFor(state, buildingId).fleet?.formation;
      if (!saved || !Number.isSafeInteger(saved.presetId) || saved.presetId < 1) {
        throw new Error(buildingId + '的原阵容未同步，暂不切换');
      }
      return fleetFormation(saved, true);
    };
    // Validate the entire group before persisting or writing any formation.
    const changes = selections.map(binding => {
      const preset = binding.preset;
      if (!preset) throw new Error(binding.buildingId + '选择的阵容已删除');
      const target = fleetFormation(validateEditorFormation({ ...preset.formation, petUid: '0' }, editor));
      if (!home(state.fleets.find(row => row.buildingId === binding.buildingId))) throw new Error(binding.buildingId + '不是空闲返航状态');
      for (const { heroId } of target.heroPositions) {
        if (assigned.has(heroId)) throw new Error(heroId + '不能同时编入两支出战舰队');
        assigned.set(heroId, binding.buildingId);
      }
      const original = readOriginal(binding.buildingId);
      if (binding.expectedFormation && signature(original) !== signature(binding.expectedFormation)) {
        throw new Error('所选舰队阵容已变化，请刷新后重新选择');
      }
      return { kind, role, buildingId: binding.buildingId, original, target,
        phase: 'prepared', active: true, startedAt: Date.now(), presetId: preset.id, reason: '' };
    });
    // A selected ship without an explicit preset can lend heroes too. Keep its
    // unaffected slots, use available substitutes, and never dispatch it empty.
    const unconfigured = fleetIds.filter(id => !selections.some(binding => binding.buildingId === id)).map(buildingId => {
      const original = readOriginal(buildingId);
      const target = withoutTransferredHeroes(original, buildingId, assigned);
      for (const { heroId } of target.heroPositions) assigned.set(heroId, buildingId);
      return { buildingId, original, target };
    });
    const substitutes = [...editor.heroes].sort((a, b) => b.power - a.power || a.heroId.localeCompare(b.heroId));
    const replacementChanges = [];
    for (const change of unconfigured) {
      if (signature(change.original) === signature(change.target)) continue;
      if (!home(state.fleets.find(row => row.buildingId === change.buildingId))) throw new Error(change.buildingId + '不是空闲返航状态');
      const planned = { ...change, kind, role, phase: 'prepared', active: true, startedAt: Date.now(), reason: '' };
      changes.push(planned);
      replacementChanges.push(planned);
    }
    for (const dock of state.docks) {
      const occupied = dock.fleet?.formation?.heroPositions ?? [];
      const recipients = occupied.map(row => assigned.get(row.heroId)).filter(id => id && id !== dock.buildingId);
      if (!recipients.length) continue;
      if (!changes.some(row => row.buildingId === dock.buildingId)) {
        if (!home(state.fleets.find(row => row.buildingId === dock.buildingId))) throw new Error(dock.buildingId + '不是空闲返航状态，暂不能借用英雄');
        const held = fleetRecordReason(ledger.keyRecords(), dock.buildingId, role.worldId);
        if (held || isFleetReserved(client, dock.buildingId)) throw new Error(dock.buildingId + '尚有任务占用，暂不能借用英雄' + (held ? '：' + held : ''));
        const original = fleetFormation(dock.fleet.formation, true);
        const change = { kind, role, buildingId: dock.buildingId, original, support: true,
          target: withoutTransferredHeroes(original, dock.buildingId, assigned), phase: 'prepared', active: true, startedAt: Date.now(), reason: '' };
        for (const { heroId } of change.target.heroPositions) assigned.set(heroId, dock.buildingId);
        changes.push(change);
        replacementChanges.push(change);
      }
    }
    const vacancies = replacementChanges.flatMap(change => change.original.heroPositions
      .filter(slot => !change.target.heroPositions.some(kept => kept.heroId === slot.heroId))
      .map(slot => ({ change, slot, borrower: assigned.get(slot.heroId), filled: false })));
    // Complete direct two-ship exchanges before allocating any fallback heroes.
    // Otherwise an earlier fallback could consume a later ship's swap partner.
    for (const exchanging of [true, false]) for (const vacancy of vacancies) {
      if (vacancy.filled) continue;
      const substitute = substitutes.find(hero => !assigned.has(hero.heroId) && (exchanging
        ? vacancy.borrower && occupiedBy.get(hero.heroId) === vacancy.borrower
        : !occupiedBy.has(hero.heroId) || fleetIds.includes(occupiedBy.get(hero.heroId))));
      if (!substitute) continue;
      assigned.set(substitute.heroId, vacancy.change.buildingId);
      vacancy.change.target.heroPositions.push({ ...vacancy.slot, heroId: substitute.heroId });
      vacancy.filled = true;
    }
    for (const change of replacementChanges) {
      if (!change.support && !change.target.heroPositions.length) throw new Error(change.buildingId + '没有可替换英雄，不能与所选阵容同时出战');
    }
    // Substitutes may come from a ship scanned earlier. Build the transfer
    // dependencies only after every final formation has been assigned.
    const links = new Map();
    for (const change of changes) {
      const { buildingId } = change;
      const recipients = change.original.heroPositions.map(row => assigned.get(row.heroId)).filter(id => id && id !== buildingId);
      if (!recipients.length) continue;
      change.released = withoutTransferredHeroes(change.original, buildingId, assigned);
      // Fill vacated slots immediately when the substitute is already free.
      // Cyclic swaps still use the persisted release stage before applying.
      for (const slot of change.target.heroPositions) {
        if (change.target.presetId === change.original.presetId && !occupiedBy.has(slot.heroId)
          && change.original.heroPositions.some(row => row.pos.x === slot.pos.x && row.pos.y === slot.pos.y)
          && !change.released.heroPositions.some(row => row.pos.x === slot.pos.x && row.pos.y === slot.pos.y)) {
          change.released.heroPositions.push(slot);
        }
      }
      for (const recipient of recipients) {
        for (const [from, to] of [[buildingId, recipient], [recipient, buildingId]]) {
          if (!links.has(from)) links.set(from, new Set());
          links.get(from).add(to);
        }
      }
    }
    // Only ships sharing heroes wait for one another on return. Independent
    // fleets retain their existing per-ship restoration behavior.
    const visited = new Set();
    for (const buildingId of links.keys()) {
      if (visited.has(buildingId)) continue;
      const transferId = randomUUID(), pending = [buildingId];
      while (pending.length) {
        const id = pending.pop();
        if (visited.has(id)) continue;
        visited.add(id);
        changes.find(change => change.buildingId === id).transferId = transferId;
        pending.push(...links.get(id));
      }
    }
    const planned = changes.filter(change => signature(change.original) !== signature(change.target));
    if (!active(client, enabled) || !sameRole(roleOf(player), role)) throw new Error('换阵前账号状态已变化');
    for (const details of planned) {
      const key = journalKey(kind, role, details.buildingId);
      const ticket = ledger.reserve({}, {}, {}, { uniqueKey: key, details });
      keys.push(key);
      ledger.confirm(ticket);
    }
    const records = ledger.keyRecords();
    for (const releasing of [true, false]) for (const details of planned) {
      const expected = releasing ? details.original : details.released ?? details.original;
      const target = releasing ? details.released ?? details.original : details.target;
      if (signature(expected) === signature(target)) continue;
      const fresh = await snapshot(client);
      if (!home(fresh.fleets.find(row => row.buildingId === details.buildingId))) throw new Error('换阵前舰队已离港');
      const current = fleetFormation(dockFor(fresh, details.buildingId).fleet?.formation, true);
      if (signature(current) !== signature(expected)) throw new Error('换阵前游戏阵容已变化，未覆盖');
      assertHeroesFree(target, details.buildingId, fresh.docks);
      currentRecord(ledger, journalKey(kind, role, details.buildingId), records[journalKey(kind, role, details.buildingId)]);
      if (details.support) {
        const held = fleetRecordReason(Object.fromEntries(Object.entries(ledger.keyRecords()).filter(([key]) => !keys.includes(key))), details.buildingId, role.worldId);
        if (held || isFleetReserved(client, details.buildingId, 'dispatch-ledger')) throw new Error(details.buildingId + '尚有任务占用，暂不能借用英雄');
      }
      if (!active(client, enabled) || !sameRole(roleOf(player), role)) throw new Error('换阵前账号状态已变化');
      await saveAndConfirm(client, details.buildingId, target);
    }
    return keys;
  } catch (error) {
    if (keys.length) {
      const recovery = await recover(client, player, ledger, { enabled, report, onlyKeys: new Set(keys) });
      if (recovery.pending.length) error.fleetLineupPending = recovery.pending;
    }
    throw error;
  } finally { busy.delete(client); }
}

// Call before sending the dispatch request. The journal must already describe
// an in-flight operation if the process dies after the server accepts it.
export function markFleetLineupsDispatched(ledger, keys, dispatchKeys) {
  const records = ledger.keyRecords();
  const updates = keys.map(key => {
    const record = records[key];
    if (!record) throw new Error('舰队阵容恢复记录已不存在');
    const details = validateJournal(key, record);
    // A lending ship stays at home. Its transfer group is held until all
    // borrowing ships have settled, so it has no dispatch record of its own.
    if (details.support) {
      if (!keys.some(other => records[other]?.details?.transferId === details.transferId
        && !records[other].details.support && dispatchKeys[records[other].details.buildingId])) {
        throw new Error('派遣记录与借用英雄舰队不一致');
      }
      return null;
    }
    const dispatchKey = dispatchKeys[details.buildingId];
    const dispatch = records[dispatchKey];
    const type = journalTypes[details.kind];
    if (!dispatchKey?.startsWith(type.dispatchPrefix + details.role.worldId + ':')
      || dispatch?.details?.kind !== type.dispatch || dispatch.details.buildingId !== details.buildingId) {
      throw new Error('派遣记录与待恢复舰队不一致');
    }
    return [key, { ...details, phase: 'dispatched', dispatchKey, dispatchId: dispatch.id, reason: '' }];
  }).filter(Boolean);
  for (const [key, details] of updates) ledger.updateKeyDetails(key, details);
}

// Only for a definitely unsent or explicitly rejected dispatch, never timeout.
export function markFleetLineupsCancelled(ledger, keys) {
  const records = ledger.keyRecords();
  for (const key of keys) {
    const record = records[key];
    if (!record) continue;
    const details = validateJournal(key, record);
    delete details.dispatchKey;
    delete details.dispatchId;
    ledger.updateKeyDetails(key, { ...details, phase: 'prepared', reason: '' });
  }
}

// A lost pirate target can be retried by another fleet before this one is home.
// Preserve its confirmed outcome before the dispatch key is reused.
export function releaseRetryablePirateDispatch(ledger, dispatchKey) {
  const records = ledger.keyRecords(), dispatch = records[dispatchKey];
  if (dispatch?.details?.kind !== 'pirateFirst') return;
  const lost = dispatch.confirmed && dispatch.details.outcome === 'lost';
  const timedOut = dispatch.expired && dispatch.details.outcome === 'timedOut';
  if (!lost && !timedOut) return;
  for (const [key, record] of Object.entries(records)) {
    const details = record.details;
    if (details?.kind === 'pirateLineup' && details.phase === 'dispatched'
      && details.dispatchKey === dispatchKey && details.dispatchId === dispatch.id) {
      ledger.updateKeyDetails(key, { ...validateJournal(key, record), phase: 'settled' });
    }
  }
  ledger.releaseCompletedKey(dispatchKey, dispatch);
}
