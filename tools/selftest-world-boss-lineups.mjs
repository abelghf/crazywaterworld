// Real durable ledger, synthetic game replies: no account or game connection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageLedger } from '../src/usage-ledger.mjs';
import { runWorldBoss } from '../src/world-boss.mjs';
import { checkFleetSettlement } from '../src/fleet-settlement.mjs';
import { bridgeFleetReservations, fleetRecordReason } from '../src/fleet-availability.mjs';
import { registerFleetReservations } from '../src/fleet-reservations.mjs';
import { prepareFleetLineups, markFleetLineupsDispatched, releaseRetryablePirateDispatch } from '../src/fleet-lineups.mjs';
import { prepareWorldBossLineups, recoverWorldBossLineups, markWorldBossLineupsDispatched,
  markWorldBossLineupsCancelled } from '../src/world-boss-lineups.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-world-boss-lineups-'));
const player = { playerId: '9007199254740993', worldId: '1001001', level: 50, mainlineStage: 100 };
const form = heroId => ({ presetId: 1, heroPositions: [{ heroId, pos: { x: 1, y: 1 } }] });
const empty = () => ({ presetId: 1, heroPositions: [] });
const config = { tables: {
  HeroCfg: { data: ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, name: id })) },
  FormationHeroNumCfg: { data: [{ mainlineStage: 0, heroNum: 2 }] },
  FormationTypePositionCfg: { data: [{ id: 1, position: [1, 1] }, { id: 1, position: [2, 1] }, { id: 7, position: [1, 1] }] },
  FormationTypeUnlockCfg: { data: [{ id: 7, name: '阵型7' }] },
} };
let sequence = 0, passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };

function fixture() {
  const file = path.join(directory, ++sequence + '.json');
  const ledger = createUsageLedger('fixture', { file });
  const docks = [1, 2].map((id, index) => ({ buildingId: id + '远征船', level: 1, fleet: { formation: form(['a', 'b'][index]) } }));
  const fleets = docks.map(dock => ({ buildingId: dock.buildingId, state: 1, curGridIdx: 0 }));
  const settings = { worldBoss: { fleetPresets: [1, 2].map(id => ({ buildingId: id + '远征船', presetId: 'preset-' + id })) },
    lineups: { presets: [1, 2].map((id, index) => ({ id: 'preset-' + id, name: '阵容' + id, formation: {
      ...form(['c', 'd'][index]), petUid: '9007199254740994',
    } })) } };
  const writes = [], reads = [], reports = [];
  let enabled = true;
  const client = {
    connected: true, onWrite: null, onRead: null,
    async request(name) {
      reads.push(name);
      if (this.onRead) await this.onRead(name);
      if (!this.connected) throw new Error('连接中断');
      const replies = {
        GetFormationRequest: { formation: form('a') },
        AllHeroRequest: { heroes: ['a', 'b', 'c', 'd', 'e'].map(heroId => ({ heroId })) },
        MyFormationPresetRequest: { ids: [] }, AllPetRequest: { pets: [] },
        OnWaterRequest: { building: docks }, MyFleetsRequest: { fleets },
      };
      assert(Object.hasOwn(replies, name), name);
      return structuredClone(replies[name]);
    },
    async sendWatch(name, body) {
      assert.equal(name, 'FleetSaveFormationRequest');
      assert.deepEqual(Object.keys(body.formation).sort(), ['heroPositions', 'presetId']);
      assert(Object.values(ledger.keyRecords()).some(record => ['worldBossLineup', 'pirateLineup'].includes(record.details?.kind)
        && record.details.buildingId === body.buildingId), '写协议前必须有持久恢复快照');
      writes.push(structuredClone(body));
      if (this.onWrite) await this.onWrite(body, writes.length);
      if (!this.connected) throw new Error('连接中断');
      for (const dock of docks.filter(row => row.buildingId !== body.buildingId)) {
        assert(!body.formation.heroPositions.some(slot => dock.fleet?.formation?.heroPositions?.some(other => other.heroId === slot.heroId)),
          '模拟服务器拒绝同时在两支舰队编入同一英雄');
      }
      docks.find(dock => dock.buildingId === body.buildingId).fleet.formation = structuredClone(body.formation);
    },
  };
  const options = { settings, ledger, fleetIds: fleets.map(fleet => fleet.buildingId), enabled: () => enabled, report: row => reports.push(row) };
  return { client, ledger, file, settings, docks, fleets, writes, reads, reports, options,
    setEnabled: value => { enabled = value; },
    prepare: () => prepareWorldBossLineups(client, config, player, options),
    recover: (replacementLedger = ledger, role = player) => recoverWorldBossLineups(client, role, replacementLedger, { enabled: options.enabled, report: options.report }),
    dispatch(keys) {
      const mapping = {};
      for (const fleet of fleets) {
        const key = 'world-boss:' + player.worldId + ':20000:' + fleet.buildingId.replace('远征船', '');
        const ticket = ledger.reserve({ worldBossPetrol: 300 }, {}, {}, { uniqueKey: key,
          details: { kind: 'worldBoss', buildingId: fleet.buildingId, active: true } });
        ledger.confirm(ticket); mapping[fleet.buildingId] = key;
      }
      markWorldBossLineupsDispatched(ledger, keys, mapping);
      return mapping;
    },
  };
}

try {
  await test('两支舰队先保存全部快照再换阵，不把预设海兽写入舰队', async () => {
    const f = fixture();
    f.client.onWrite = () => assert.equal(Object.values(f.ledger.keyRecords()).filter(record => record.details?.kind === 'worldBossLineup').length, 2);
    const keys = await f.prepare();
    assert.equal(keys.length, 2);
    assert(keys.every(key => /^[A-Za-z0-9:_-]+$/.test(key)));
    assert.equal(f.writes.length, 2);
    assert.deepEqual(f.docks.map(dock => dock.fleet.formation), [form('c'), form('d')]);
    assert.equal(Object.keys(f.ledger.pendingCounters()).length, 0);
    f.client.onWrite = null;
    const result = await f.recover();
    assert.deepEqual(result.pending, []); assert.equal(result.restored.length, 2);
    assert.deepEqual(f.docks.map(dock => dock.fleet.formation), [form('a'), form('b')]);
    assert.deepEqual(f.ledger.keyRecords(), {});
  });

  await test('任何目标缺失、阵型未解锁、英雄不存在或重复占用均在写入前拒绝', async () => {
    for (const mode of ['missing', 'locked', 'hero', 'duplicate', 'busy', 'autoFight']) {
      const f = fixture(), preset = f.settings.lineups.presets[1];
      if (mode === 'missing') f.settings.lineups.presets.pop();
      if (mode === 'locked') preset.formation.presetId = 7;
      if (mode === 'hero') preset.formation.heroPositions[0].heroId = 'unknown';
      if (mode === 'duplicate') preset.formation.heroPositions[0].heroId = 'c';
      if (mode === 'busy') f.fleets[1].state = 2;
      if (mode === 'autoFight') f.fleets[1].autoFight = { isOn: true };
      await assert.rejects(f.prepare());
      assert.deepEqual(f.writes, [], mode); assert.deepEqual(f.ledger.keyRecords(), {}, mode);
    }
  });

  await test('借用未出战舰队英雄时优先两队交换，保留人数和其他英雄站位，任务结束后恢复两队', async () => {
    const f = fixture(); f.options.fleetIds = ['1远征船'];
    f.settings.lineups.presets[0].formation = form('b');
    const donor = { ...form('b'), heroPositions: [...form('b').heroPositions, { heroId: 'e', pos: { x: 2, y: 1 } }] };
    f.docks[1].fleet.formation = structuredClone(donor);
    f.client.onWrite = () => assert.equal(Object.values(f.ledger.keyRecords()).length, 2, '借出方也必须先保存恢复快照');
    const keys = await f.prepare();
    assert.deepEqual(f.writes.map(row => row.buildingId), ['1远征船', '2远征船', '1远征船', '2远征船']);
    assert.deepEqual(f.docks[1].fleet.formation.heroPositions, [donor.heroPositions[1], form('a').heroPositions[0]]);
    assert.deepEqual(f.docks[0].fleet.formation, form('b'));
    f.client.onWrite = null;
    const dispatches = f.dispatch(keys), firstKey = dispatches['1远征船'];
    assert.equal((await f.recover()).pending.length, 2, '借出方留在港口也要等借用方结束');
    assert(fleetRecordReason(f.ledger.keyRecords(), '2远征船', player.worldId));
    f.ledger.updateKeyDetails(firstKey, { ...f.ledger.keyRecords()[firstKey].details, active: false });
    f.fleets[0].state = 2;
    assert.equal((await f.recover()).pending.length, 2);
    f.fleets[0].state = 1;
    assert.equal((await f.recover()).restored.length, 2);
    assert.deepEqual(f.docks.map(row => row.fleet.formation), [form('a'), donor]);
  });

  await test('两支出战舰队互换英雄，全部先释放再上阵，双方返航后一起恢复', async () => {
    const f = fixture();
    f.settings.lineups.presets.forEach((preset, index) => { preset.formation = form(['b', 'a'][index]); });
    const keys = await f.prepare();
    assert.deepEqual(f.writes.map(row => row.formation), [empty(), empty(), form('b'), form('a')]);
    const dispatches = f.dispatch(keys);
    const firstKey = dispatches['1远征船'];
    f.ledger.updateKeyDetails(firstKey, { ...f.ledger.keyRecords()[firstKey].details, active: false });
    assert.equal((await f.recover()).pending.length, 2);
    assert.equal(f.writes.length, 4);
    const secondKey = dispatches['2远征船'];
    f.ledger.updateKeyDetails(secondKey, { ...f.ledger.keyRecords()[secondKey].details, active: false });
    assert.equal((await f.recover()).restored.length, 2);
    assert.deepEqual(f.docks.map(row => row.fleet.formation), [form('a'), form('b')]);
  });

  await test('无法直接交换时选战力最高的可用替补，不挪用其他舰队成员', async () => {
    const f = fixture(); f.options.fleetIds = ['1远征船'];
    f.settings.lineups.presets[0].formation = { ...form('a'), heroPositions: [...form('a').heroPositions, { heroId: 'b', pos: { x: 2, y: 1 } }] };
    f.docks.push({ buildingId: '3远征船', level: 1, fleet: { formation: form('e') } });
    const request = f.client.request.bind(f.client);
    f.client.request = async name => name === 'AllHeroRequest'
      ? { heroes: ['a', 'b', 'c', 'd', 'e'].map((heroId, index) => ({ heroId, power: [1000, 50, 10, 100, 2000][index] })) }
      : request(name);
    await f.prepare();
    assert.deepEqual(f.docks.map(row => row.fleet.formation), [f.settings.lineups.presets[0].formation, form('d'), form('e')]);
    assert.deepEqual(f.writes.map(row => row.buildingId), ['2远征船', '1远征船']);
    assert(f.writes.every(row => row.formation.heroPositions.length > 0), '可直接换人时不先清空舰队');
    assert.equal((await f.recover()).restored.length, 2);
    assert.deepEqual(f.docks.map(row => row.fleet.formation), [form('a'), form('b'), form('e')]);
  });

  await test('优先从借入舰队换回战力最高的可交换英雄，即使闲置替补更强', async () => {
    const f = fixture(); f.options.fleetIds = ['1远征船'];
    const original = { ...form('a'), heroPositions: [...form('a').heroPositions, { heroId: 'e', pos: { x: 2, y: 1 } }] };
    f.docks[0].fleet.formation = structuredClone(original);
    f.settings.lineups.presets[0].formation = form('b');
    const request = f.client.request.bind(f.client);
    f.client.request = async name => name === 'AllHeroRequest'
      ? { heroes: ['a', 'b', 'c', 'd', 'e'].map((heroId, index) => ({ heroId, power: [10, 50, 100, 1000, 90][index] })) }
      : request(name);
    await f.prepare();
    assert.deepEqual(f.docks.map(row => row.fleet.formation), [form('b'), form('e')]);
    assert.equal((await f.recover()).restored.length, 2);
    assert.deepEqual(f.docks.map(row => row.fleet.formation), [original, form('b')]);
  });

  await test('先完成所有两队交换，再补其他舰队，避免提前分走可交换英雄', async () => {
    const f = fixture();
    f.docks[1].fleet.formation = empty();
    f.docks.push({ buildingId: '4远征船', level: 1, fleet: { formation: form('d') } },
      { buildingId: '3远征船', level: 1, fleet: { formation: form('c') } });
    f.fleets.push({ buildingId: '4远征船', state: 1, curGridIdx: 0 }, { buildingId: '3远征船', state: 1, curGridIdx: 0 });
    const request = f.client.request.bind(f.client);
    f.client.request = async name => name === 'AllHeroRequest'
      ? { heroes: ['a', 'c', 'd', 'e'].map((heroId, index) => ({ heroId, power: [1000, 10, 20, 30][index] })) }
      : request(name);
    await f.prepare();
    assert.deepEqual(f.docks.map(row => row.fleet.formation), [form('c'), form('d'), form('e'), form('a')]);
    assert.equal((await f.recover()).restored.length, 4);
    assert.deepEqual(f.docks.map(row => row.fleet.formation), [form('a'), empty(), form('d'), form('c')]);
  });

  await test('无法两队交换时，替补按全部可用英雄战力选择，包含其他换阵腾出的英雄', async () => {
    const f = fixture();
    f.docks[1].fleet.formation = empty();
    f.settings.lineups.presets[1].formation = form('b');
    f.docks.push({ buildingId: '3远征船', level: 1, fleet: { formation: form('b') } });
    f.fleets.push({ buildingId: '3远征船', state: 1, curGridIdx: 0 });
    const request = f.client.request.bind(f.client);
    f.client.request = async name => name === 'AllHeroRequest'
      ? { heroes: ['a', 'b', 'c', 'd', 'e'].map((heroId, index) => ({ heroId, power: [1000, 50, 10, 100, 30][index] })) }
      : request(name);
    await f.prepare();
    assert.deepEqual(f.docks.map(row => row.fleet.formation), [form('c'), form('b'), form('a')]);
    assert.equal((await f.recover()).restored.length, 3);
    assert.deepEqual(f.docks.map(row => row.fleet.formation), [form('a'), empty(), form('b')]);
  });

  await test('没有闲置英雄时借出方用本次换阵腾出的英雄补齐，不重复分配替补', async () => {
    const f = fixture();
    const donor = { ...form('c'), heroPositions: [...form('c').heroPositions, { heroId: 'd', pos: { x: 2, y: 1 } }] };
    f.docks.push({ buildingId: '3远征船', level: 1, fleet: { formation: structuredClone(donor) } },
      { buildingId: '4远征船', level: 1, fleet: { formation: form('e') } });
    f.fleets.push({ buildingId: '3远征船', state: 1, curGridIdx: 0 });
    await f.prepare();
    assert.deepEqual(f.docks[2].fleet.formation.heroPositions, [form('a').heroPositions[0], { heroId: 'b', pos: { x: 2, y: 1 } }]);
    assert.deepEqual(f.docks.slice(0, 2).map(row => row.fleet.formation), [form('c'), form('d')]);
    assert.equal(f.writes.filter(row => row.buildingId === '4远征船').length, 0);
    assert.equal((await f.recover()).restored.length, 3);
    assert.deepEqual(f.docks.map(row => row.fleet.formation), [form('a'), form('b'), donor, form('e')]);
  });

  await test('多个借出方分配不同替补，只有确实无替补的空位才下阵', async () => {
    for (const spare of [true, false]) {
      const f = fixture(); f.options.fleetIds = ['1远征船'];
      f.settings.lineups.presets[0].formation = { ...form('b'), heroPositions: [...form('b').heroPositions, { heroId: 'c', pos: { x: 2, y: 1 } }] };
      f.docks[0].fleet.formation = empty();
      f.docks.push({ buildingId: '3远征船', level: 1, fleet: { formation: form('c') } });
      f.fleets.push({ buildingId: '3远征船', state: 1, curGridIdx: 0 });
      const request = f.client.request.bind(f.client);
      f.client.request = async name => name === 'AllHeroRequest'
        ? { heroes: (spare ? ['b', 'c', 'd', 'e'] : ['b', 'c', 'd']).map(heroId => ({ heroId })) }
        : request(name);
      await f.prepare();
      assert.deepEqual(f.docks.slice(1).map(row => row.fleet.formation), [form('d'), spare ? form('e') : empty()]);
      assert.equal((await f.recover()).restored.length, 3);
      assert.deepEqual(f.docks.map(row => row.fleet.formation), [empty(), form('b'), form('c')]);
    }
  });

  await test('三队循环调动英雄可换阵并恢复，不受预设顺序影响', async () => {
    const f = fixture();
    f.docks.push({ buildingId: '3远征船', level: 1, fleet: { formation: form('c') } });
    f.fleets.push({ buildingId: '3远征船', state: 1, curGridIdx: 0 });
    f.options.fleetIds.push('3远征船');
    f.settings.worldBoss.fleetPresets = [3, 1, 2].map(id => ({ buildingId: id + '远征船', presetId: 'preset-' + id }));
    f.settings.lineups.presets = ['b', 'c', 'a'].map((hero, index) => ({ id: 'preset-' + (index + 1), formation: form(hero) }));
    await f.prepare();
    assert.deepEqual(f.docks.map(row => row.fleet.formation), ['b', 'c', 'a'].map(form));
    assert.equal((await f.recover()).restored.length, 3);
    assert.deepEqual(f.docks.map(row => row.fleet.formation), ['a', 'b', 'c'].map(form));
  });

  await test('借用方换阵被拒绝时自动归还英雄，重连后可从交换中间状态恢复', async () => {
    for (const disconnect of [false, true]) {
      const f = fixture(); f.options.fleetIds = ['1远征船'];
      f.settings.lineups.presets[0].formation = form('b');
      f.client.onWrite = (_body, count) => {
        if (count === 2) {
          if (disconnect) f.client.connected = false;
          throw new Error(disconnect ? '连接中断' : '服务端拒绝换阵');
        }
      };
      await assert.rejects(f.prepare(), disconnect ? /连接中断/ : /拒绝换阵/);
      if (disconnect) {
        assert.deepEqual(f.docks.map(row => row.fleet.formation), [empty(), form('b')]);
        f.client.connected = true; f.client.onWrite = null;
        const restarted = createUsageLedger('fixture', { file: f.file });
        assert.equal((await f.recover(restarted)).restored.length, 2);
        assert.deepEqual(restarted.keyRecords(), {});
      } else assert.deepEqual(f.ledger.keyRecords(), {});
      assert.deepEqual(f.docks.map(row => row.fleet.formation), [form('a'), form('b')]);
    }
  });

  await test('互换后的归还写入中断可继续恢复，回包丢失也以回读为准', async () => {
    const f = fixture();
    f.settings.lineups.presets.forEach((preset, index) => { preset.formation = form(['b', 'a'][index]); });
    await f.prepare();
    f.client.onWrite = (body, count) => {
      if (count === 5) {
        f.docks.find(row => row.buildingId === body.buildingId).fleet.formation = structuredClone(body.formation);
        f.client.connected = false;
        throw new Error('归还时连接中断');
      }
    };
    assert.equal((await f.recover()).pending.length, 2);
    assert.deepEqual(f.docks.map(row => row.fleet.formation), [empty(), form('a')]);
    f.client.connected = true;
    f.client.onWrite = body => {
      f.docks.find(row => row.buildingId === body.buildingId).fleet.formation = structuredClone(body.formation);
      throw new Error('写入成功但响应丢失');
    };
    const restarted = createUsageLedger('fixture', { file: f.file });
    assert.equal((await f.recover(restarted)).restored.length, 2);
    assert.deepEqual(f.docks.map(row => row.fleet.formation), [form('a'), form('b')]);
    assert.deepEqual(restarted.keyRecords(), {});
  });

  await test('借出舰队忙碌、占用、未同步或人工修改时保留保护', async () => {
    for (const mode of ['away', 'autoFight', 'ledger', 'reservation', 'missing', 'pending']) {
      const f = fixture(); f.options.fleetIds = ['1远征船'];
      f.settings.lineups.presets[0].formation = form('b');
      if (mode === 'away') f.fleets[1].state = 2;
      if (mode === 'autoFight') f.fleets[1].autoFight = { isOn: true };
      if (mode === 'ledger') f.ledger.reserve({}, {}, {}, { uniqueKey: 'radar-send:' + player.worldId + ':1', details: { kind: 'radarSend', buildingId: '2远征船', active: true } });
      if (mode === 'reservation') registerFleetReservations(f.client, 'fixture', id => id === '2远征船');
      if (mode === 'missing') f.fleets.pop();
      if (mode === 'pending') {
        await f.prepare();
        f.docks[0].fleet.formation = form('a');
        f.docks[1].fleet.formation = form('b');
        f.writes.length = 0;
      }
      const before = f.ledger.keyRecords();
      await assert.rejects(f.prepare());
      assert.deepEqual(f.writes, [], mode); assert.deepEqual(f.ledger.keyRecords(), before, mode);
    }
    const changed = fixture(); changed.options.fleetIds = ['1远征船'];
    changed.settings.lineups.presets[0].formation = form('b');
    await changed.prepare(); changed.docks[1].fleet.formation = form('e');
    assert.equal((await changed.recover()).pending.length, 2);
    assert.deepEqual(changed.docks.map(row => row.fleet.formation), [form('b'), form('e')]);
    assert.equal(changed.writes.length, 4);
  });

  await test('同时出战的未配置预设舰队临时换人，释放目标英雄后仍可派遣', async () => {
    const f = fixture(); f.settings.worldBoss.fleetPresets.pop();
    f.settings.lineups.presets[0].formation = form('b');
    const keys = await f.prepare();
    assert.deepEqual(f.docks.map(row => row.fleet.formation), [form('b'), form('a')]);
    f.dispatch(keys); markWorldBossLineupsCancelled(f.ledger, keys);
    assert.equal((await f.recover()).restored.length, 2);
    assert.deepEqual(f.docks.map(row => row.fleet.formation), [form('a'), form('b')]);
  });

  await test('无替补时可以部分下阵，但不允许把同时出战舰队清空', async () => {
    const f = fixture(); f.settings.worldBoss.fleetPresets.pop();
    f.settings.lineups.presets[0].formation = form('b');
    f.docks[0].fleet.formation = empty();
    const request = f.client.request.bind(f.client);
    f.client.request = async name => name === 'AllHeroRequest' ? { heroes: [{ heroId: 'b' }, { heroId: 'e' }] } : request(name);
    f.docks[1].fleet.formation.heroPositions.push({ heroId: 'e', pos: { x: 2, y: 1 } });
    await f.prepare();
    assert.deepEqual(f.docks[1].fleet.formation.heroPositions, [{ heroId: 'e', pos: { x: 2, y: 1 } }]);
    await f.recover(); f.writes.length = 0;
    f.docks[1].fleet.formation = form('b');
    f.client.request = async name => name === 'AllHeroRequest' ? { heroes: [{ heroId: 'b' }] } : request(name);
    await assert.rejects(f.prepare(), /没有可替换英雄/);
    assert.deepEqual(f.writes, []); assert.deepEqual(f.ledger.keyRecords(), {});
  });

  await test('海盗共用借用与恢复流程，失败重试释放派遣记录后仍能归还英雄', async () => {
    const f = fixture();
    const keys = await prepareFleetLineups(f.client, config, player, { kind: 'pirateLineup', ledger: f.ledger,
      selections: [{ buildingId: '1远征船', preset: { id: 'pirate', formation: form('b') } }] });
    const key = 'pirate-first:' + player.worldId + ':1:1:1';
    const ticket = f.ledger.reserve({}, {}, {}, { uniqueKey: key, details: { kind: 'pirateFirst', buildingId: '1远征船', active: true } });
    markFleetLineupsDispatched(f.ledger, keys, { '1远征船': key });
    assert.equal((await f.recover()).pending.length, 2);
    f.ledger.confirm(ticket);
    f.ledger.updateKeyDetails(key, { ...f.ledger.keyRecords()[key].details, outcome: 'lost' });
    releaseRetryablePirateDispatch(f.ledger, key);
    assert.equal((await f.recover()).restored.length, 2);
    assert.deepEqual(f.docks.map(row => row.fleet.formation), [form('a'), form('b')]);
  });

  await test('无预设不读取或换阵；阵容相同不创建恢复记录', async () => {
    const f = fixture(); f.settings.worldBoss.fleetPresets = [];
    assert.deepEqual(await f.prepare(), []); assert.deepEqual(f.reads, []);
    const equal = fixture();
    equal.settings.lineups.presets.forEach((preset, index) => { preset.formation = form(['a', 'b'][index]); });
    assert.deepEqual(await equal.prepare(), []); assert.deepEqual(equal.writes, []);
  });

  await test('未选中的新建空舰队不阻止换阵，格式损坏与所选原阵容未知仍停止', async () => {
    for (const dock of [{ buildingId: '3远征船', level: 1 },
      { buildingId: '3远征船', level: 1, fleet: { formation: { presetId: 1 } } }]) {
      const f = fixture(); f.docks.push(dock);
      assert.equal((await f.prepare()).length, 2);
      assert.equal((await f.recover()).restored.length, 2);
    }
    const malformed = fixture();
    malformed.docks.push({ buildingId: '3远征船', level: 1, fleet: { formation: { heroPositions: {} } } });
    await assert.rejects(malformed.prepare(), /英雄占用未同步/);
    assert.deepEqual(malformed.writes, []); assert.deepEqual(malformed.ledger.keyRecords(), {});
    const missing = fixture(); delete missing.docks[1].fleet;
    await assert.rejects(missing.prepare(), /原阵容未同步/);
    assert.deepEqual(missing.writes, []); assert.deepEqual(missing.ledger.keyRecords(), {});
  });

  await test('第二支舰队换阵被拒绝时恢复第一支，尚未修改的快照直接清理', async () => {
    const f = fixture();
    f.client.onWrite = (_body, count) => { if (count === 2) throw Object.assign(new Error('服务端拒绝换阵'), { prompt: true }); };
    await assert.rejects(f.prepare(), /拒绝换阵/);
    assert.deepEqual(f.docks.map(dock => dock.fleet.formation), [form('a'), form('b')]);
    assert.deepEqual(f.ledger.keyRecords(), {});
    assert.equal(f.writes.length, 3);
  });

  await test('写入成功但响应丢失时以回读确认，断线时保留原阵容供重连恢复', async () => {
    const f = fixture();
    f.client.onWrite = body => {
      f.docks.find(dock => dock.buildingId === body.buildingId).fleet.formation = structuredClone(body.formation);
      throw new Error('响应丢失');
    };
    const keys = await f.prepare(); assert.equal(keys.length, 2);
    f.client.onWrite = null;
    f.client.connected = false;
    assert.equal((await f.recover()).pending.length, 2);
    assert.equal(f.writes.length, 2);
    f.client.connected = true;
    const recreated = createUsageLedger('fixture', { file: f.file });
    assert.equal((await f.recover(recreated)).restored.length, 2);
    assert.deepEqual(f.docks.map(dock => dock.fleet.formation), [form('a'), form('b')]);
  });

  await test('派遣记录未结束及舰队未返航时不恢复，结束返航后逐队恢复', async () => {
    const f = fixture(), keys = await f.prepare(), dispatches = f.dispatch(keys);
    assert.equal((await f.recover()).pending.length, 2, '派遣结果刚确认仍不能恢复');
    assert.equal(f.writes.length, 2);
    const firstKey = dispatches['1远征船'];
    f.ledger.updateKeyDetails(firstKey, { ...f.ledger.keyRecords()[firstKey].details, active: false });
    f.fleets[0].state = 4;
    assert.equal((await f.recover()).pending.length, 2);
    f.fleets[0].state = 1;
    const first = await f.recover(); assert.equal(first.restored.length, 1); assert.equal(first.pending.length, 1);
    assert.deepEqual(f.docks.map(dock => dock.fleet.formation), [form('a'), form('d')]);
    const secondKey = dispatches['2远征船'];
    f.ledger.updateKeyDetails(secondKey, { ...f.ledger.keyRecords()[secondKey].details, active: false });
    assert.equal((await f.recover()).restored.length, 1);
  });

  await test('未发送或明确拒绝可取消派遣标记，未知或丢失的派遣记录继续等待', async () => {
    const f = fixture(), keys = await f.prepare(); f.dispatch(keys);
    markWorldBossLineupsCancelled(f.ledger, keys);
    assert.equal((await f.recover()).restored.length, 2);
    const unknown = fixture(), unknownKeys = await unknown.prepare(), dispatches = unknown.dispatch(unknownKeys);
    unknown.ledger.releaseCompletedKey(dispatches['1远征船']);
    assert.equal((await unknown.recover()).pending.length, 2);
    assert.equal(unknown.writes.length, 2);
  });

  await test('其他角色、人工改阵和原英雄转入别队时不覆盖，人工恢复后可清理', async () => {
    const f = fixture(); await f.prepare();
    assert.equal((await f.recover(f.ledger, { ...player, playerId: '123' })).pending.length, 2);
    assert.equal(f.writes.length, 2);
    f.docks[0].fleet.formation = form('e');
    const result = await f.recover(); assert.equal(result.pending.length, 1); assert.equal(result.restored.length, 1);
    assert.deepEqual(f.docks[0].fleet.formation, form('e'));
    f.docks[0].fleet.formation = form('a');
    assert.equal((await f.recover()).restored.length, 1);
    const occupied = fixture(); await occupied.prepare();
    occupied.docks.push({ buildingId: '3远征船', level: 1, fleet: { formation: form('a') } });
    assert.equal((await occupied.recover()).pending.length, 1);
    assert.deepEqual(occupied.docks[0].fleet.formation, form('c'));
  });

  await test('准备过程中停用不继续写入，恢复独立于新的出战设置', async () => {
    const f = fixture();
    f.client.onWrite = (_body, count) => { if (count === 1) f.setEnabled(false); };
    await assert.rejects(f.prepare(), /状态已变化/);
    assert.equal(f.writes.length, 1);
    assert.equal(Object.keys(f.ledger.keyRecords()).length, 2);
    f.client.onWrite = null; f.setEnabled(true); f.settings.worldBoss.fleetPresets = [];
    assert.equal((await f.recover()).restored.length, 2);
    assert.deepEqual(f.docks.map(dock => dock.fleet.formation), [form('a'), form('b')]);
  });

  await test('原阵容已经恢复时，回读期间停用或切换角色仍保留恢复记录', async () => {
    for (const mode of ['disabled', 'role']) {
      const f = fixture(), role = { ...player }; await f.prepare();
      f.docks.forEach((dock, index) => { dock.fleet.formation = form(['a', 'b'][index]); });
      f.client.onRead = name => {
        if (name !== 'MyFleetsRequest') return;
        if (mode === 'disabled') f.setEnabled(false);
        else role.playerId = '123';
      };
      const result = await f.recover(f.ledger, role);
      assert.equal(result.restored.length, 0); assert.equal(result.pending.length, 2);
      assert.equal(Object.keys(f.ledger.keyRecords()).length, 2, mode);
      assert.equal(f.writes.length, 2, '已有原阵容不重复写入');
      f.client.onRead = null; f.setEnabled(true); role.playerId = player.playerId;
      assert.equal((await f.recover(f.ledger, role)).restored.length, 2);
      assert.deepEqual(f.ledger.keyRecords(), {});
    }
  });

  await test('恢复写入成功但回读期间停用时保留记录，下次确认后才释放', async () => {
    const f = fixture(); await f.prepare();
    let restoreWritten = false;
    f.client.onWrite = (_body, count) => { if (count === 3) restoreWritten = true; };
    f.client.onRead = name => { if (name === 'OnWaterRequest' && restoreWritten) f.setEnabled(false); };
    const result = await f.recover();
    assert.equal(result.restored.length, 0); assert.equal(result.pending.length, 2);
    assert.equal(f.writes.length, 3);
    assert.deepEqual(f.docks.map(dock => dock.fleet.formation), [form('a'), form('d')]);
    assert.equal(Object.keys(f.ledger.keyRecords()).length, 2);
    f.client.onRead = null; f.client.onWrite = null; f.setEnabled(true);
    assert.equal((await f.recover()).restored.length, 2);
    assert.equal(f.writes.length, 4, '已经恢复的第一舰只核对，不再次写入');
    assert.deepEqual(f.ledger.keyRecords(), {});
  });

  await test('恢复记录和派遣记录归属必须匹配，重复准备不覆盖原始快照', async () => {
    const f = fixture(), keys = await f.prepare();
    const before = f.ledger.keyRecords();
    await assert.rejects(f.prepare(), /尚待恢复/);
    assert.deepEqual(f.ledger.keyRecords(), before);
    assert.throws(() => markWorldBossLineupsDispatched(f.ledger, keys, {}), /不一致/);
    assert.deepEqual(f.ledger.keyRecords(), before);
  });

  await test('完整Boss派遣借人或临时换人后正常出发，重建账本后恢复全部相关舰队', async () => {
    for (const both of [false, true]) {
      const f = fixture(), request = f.client.request.bind(f.client);
      const ids = both ? ['1远征船', '2远征船'] : ['1远征船'];
      Object.assign(f.settings.worldBoss, { enabled: true, fleetIds: ids, minDurabilityPercent: 80 });
      f.settings.worldBoss.fleetPresets.pop();
      f.settings.lineups.presets[0].formation = form('b');
      for (const fleet of f.fleets) Object.assign(fleet, { durability: 100, maxDura: 100 });
      const battleConfig = structuredClone(config);
      battleConfig.tables.ModuleOpenCfg = { data: [{ moduleId: '世界', playerLevel: 16 }] };
      battleConfig.tables.WorldParamCfg = { data: [{ paramName: '进攻首领消耗汽油', paramValue: 300 }] };
      let count = 0, dispatches = 0;
      f.client.request = async (name, body) => {
        if (name === 'WorldBossInfoRequest') return { info: { bossId: 2, gridIdx: 100 } };
        if (name === 'CounterInfoRequest') return { counters: [{ type: 'DAILY_WORLD_BOSS_TIMES', num: count, updateTime: Math.floor(Date.now() / 1000) }] };
        if (name === 'AllItemRequest') return { items: [{ itemId: '汽油', num: 1000 }] };
        if (name === 'ChallengeWorldBossRequest') {
          assert.deepEqual(body.fleetBuildingIds, ids);
          assert.deepEqual(f.docks.map(row => row.fleet.formation), [form('b'), form('a')]);
          count = 1; dispatches++;
          for (const fleet of f.fleets.filter(row => ids.includes(row.buildingId))) Object.assign(fleet, { state: 2, targetGridIdx: 100 });
          return {};
        }
        return request(name, body);
      };
      bridgeFleetReservations(f.client, () => f.settings, f.ledger, player.worldId);
      await runWorldBoss(f.client, battleConfig, player, { getSettings: () => f.settings, ledger: f.ledger, enabled: () => true, report: f.options.report });
      assert.equal(dispatches, 1);
      assert.equal(f.ledger.confirmedCounters().worldBossPetrol, 300 * ids.length);
      assert.equal((await f.recover()).pending.length, 2);
      for (const fleet of f.fleets) Object.assign(fleet, { state: 1, targetGridIdx: 0 });
      const restarted = createUsageLedger('fixture', { file: f.file });
      await checkFleetSettlement(f.client, player, restarted);
      const oneKey = Object.keys(restarted.keyRecords()).find(key => key.startsWith('world-boss-lineup:'));
      const result = await recoverWorldBossLineups(f.client, player, restarted, { onlyKeys: new Set([oneKey]) });
      assert.equal(result.restored.length, 2, '只请求恢复其中一队时也必须归还整个借用组');
      assert.deepEqual(f.docks.map(row => row.fleet.formation), [form('a'), form('b')]);
      assert.equal(fleetRecordReason(restarted.keyRecords(), '2远征船', player.worldId), '');
    }
  });

  await test('真实首战流程先换两队阵容再共同派遣，停用后各队返航仍恢复原阵容', async () => {
    const f = fixture(), request = f.client.request.bind(f.client), dispatches = [];
    Object.assign(f.settings.worldBoss, { enabled: true, fleetIds: ['1远征船', '2远征船'], minDurabilityPercent: 80 });
    for (const fleet of f.fleets) Object.assign(fleet, { durability: 100, maxDura: 100 });
    const battleConfig = structuredClone(config);
    battleConfig.tables.ModuleOpenCfg = { data: [{ moduleId: '世界', playerLevel: 16 }] };
    battleConfig.tables.WorldParamCfg = { data: [{ paramName: '进攻首领消耗汽油', paramValue: 300 }] };
    let count = 0;
    f.client.request = async (name, body) => {
      if (name === 'WorldBossInfoRequest') return { info: { bossId: 2, gridIdx: 100, bestDamage: 0, gotRewardLevel: 0 } };
      if (name === 'CounterInfoRequest') return { counters: [{ type: 'DAILY_WORLD_BOSS_TIMES', num: count, updateTime: Math.floor(Date.now() / 1000) }] };
      if (name === 'AllItemRequest') return { items: [{ itemId: '汽油', num: 1000 }] };
      if (name === 'ChallengeWorldBossRequest') {
        assert.deepEqual(body, { bossId: 2, fleetBuildingIds: ['1远征船', '2远征船'] });
        assert.deepEqual(f.docks.map(dock => dock.fleet.formation), [form('c'), form('d')]);
        const records = f.ledger.keyRecords();
        const lineups = Object.values(records).filter(record => record.details?.kind === 'worldBossLineup');
        assert.equal(lineups.length, 2);
        assert(lineups.every(record => record.details.phase === 'dispatched'
          && records[record.details.dispatchKey]?.details.active === true), '请求发出前必须已落盘派遣关联');
        dispatches.push(body); count = 1;
        for (const fleet of f.fleets) Object.assign(fleet, { state: 2, targetGridIdx: 100 });
        return {};
      }
      return request(name, body);
    };
    bridgeFleetReservations(f.client, () => f.settings, f.ledger, player.worldId);
    await runWorldBoss(f.client, battleConfig, player, { getSettings: () => f.settings, ledger: f.ledger,
      enabled: () => true, report: f.options.report });
    assert.equal(dispatches.length, 1); assert.equal(f.writes.length, 2, 'OkResponse 不是战斗结束，不立即恢复');
    assert.equal(f.ledger.confirmedCounters().worldBossPetrol, 600);
    assert(fleetRecordReason(f.ledger.keyRecords(), '1远征船', player.worldId));
    assert(fleetRecordReason(f.ledger.keyRecords(), '2远征船', player.worldId));
    f.settings.worldBoss.enabled = false; f.settings.worldBoss.fleetPresets = []; f.settings.lineups.presets = [];
    await checkFleetSettlement(f.client, player, f.ledger); await f.recover();
    assert.equal(f.writes.length, 2, '未返航时不能因配置删除而恢复');
    Object.assign(f.fleets[0], { state: 1, targetGridIdx: 0 });
    await checkFleetSettlement(f.client, player, f.ledger);
    const first = await f.recover(); assert.equal(first.restored.length, 1); assert.equal(first.pending.length, 1);
    assert.deepEqual(f.docks.map(dock => dock.fleet.formation), [form('a'), form('d')]);
    assert.equal(fleetRecordReason(f.ledger.keyRecords(), '1远征船', player.worldId), '');
    assert(fleetRecordReason(f.ledger.keyRecords(), '2远征船', player.worldId));
    Object.assign(f.fleets[1], { state: 1, targetGridIdx: 0 });
    await checkFleetSettlement(f.client, player, f.ledger);
    assert.equal((await f.recover()).restored.length, 1);
    assert.deepEqual(f.docks.map(dock => dock.fleet.formation), [form('a'), form('b')]);
    assert(!Object.values(f.ledger.keyRecords()).some(record => record.details?.kind === 'worldBossLineup'));
    assert.equal(fleetRecordReason(f.ledger.keyRecords(), '2远征船', player.worldId), '');
  });

  await test('派遣回包丢失且快战已返航，以本人匹配战报确认后恢复各队阵容', async () => {
    const f = fixture(), request = f.client.request.bind(f.client);
    Object.assign(f.settings.worldBoss, { enabled: true, fleetIds: ['1远征船', '2远征船'], minDurabilityPercent: 80 });
    for (const fleet of f.fleets) Object.assign(fleet, { durability: 100, maxDura: 100 });
    const battleConfig = structuredClone(config);
    battleConfig.tables.ModuleOpenCfg = { data: [{ moduleId: '世界', playerLevel: 16 }] };
    battleConfig.tables.WorldParamCfg = { data: [{ paramName: '进攻首领消耗汽油', paramValue: 300 }] };
    let count = 0, sentAt = 0, reportsAvailable = false, dispatches = 0;
    f.client.request = async (name, body) => {
      if (name === 'WorldBossInfoRequest') return { info: { bossId: 2, gridIdx: 100 } };
      if (name === 'CounterInfoRequest') return { counters: [{ type: 'DAILY_WORLD_BOSS_TIMES', num: count, updateTime: Math.floor(Date.now() / 1000) }] };
      if (name === 'AllItemRequest') return { items: [{ itemId: '汽油', num: 1000 }] };
      if (name === 'ChallengeWorldBossRequest') {
        count = 1; dispatches++; sentAt = Math.floor(Date.now() / 1000);
        throw new Error('派遣回包丢失');
      }
      if (name === 'CampaignReportsRequest') return reportsAvailable ? { total: 1, reports: [
        { uid: '9007199254740995', type: 5, createTime: sentAt, worldBoss: { bossId: 2 }, win: true },
      ] } : { total: 0, reports: [] };
      return request(name, body);
    };
    await runWorldBoss(f.client, battleConfig, player, { getSettings: () => f.settings, ledger: f.ledger,
      enabled: () => true, report: f.options.report });
    assert.equal(dispatches, 1); assert.equal(f.writes.length, 2);
    assert(f.reports.some(report => report.status === 'unknown'));
    assert.equal((await f.recover()).pending.length, 2, '仅看到回港不足以断言未知派遣已结束');
    // Recreate the persisted ledger before the first authoritative report read.
    reportsAvailable = true;
    const restarted = createUsageLedger('fixture', { file: f.file });
    await checkFleetSettlement(f.client, player, restarted);
    f.settings.worldBoss.enabled = false; f.settings.worldBoss.fleetPresets = [];
    assert.equal((await f.recover(restarted)).restored.length, 2);
    assert.deepEqual(f.docks.map(dock => dock.fleet.formation), [form('a'), form('b')]);
    assert.equal(restarted.confirmedCounters().worldBossPetrol, 600);
    assert(!Object.values(restarted.keyRecords()).some(record => record.details?.kind === 'worldBossLineup'));
  });
  console.log('世界Boss临时舰队阵容专项 ' + passed + '/' + passed + ' 通过');
} finally {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert(path.basename(resolved).startsWith('cw-world-boss-lineups-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
