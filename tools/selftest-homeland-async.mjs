import assert from 'node:assert/strict';
import { createHomelandHarness } from './fixtures/homeland-console.mjs';

const h = await createHomelandHarness();
const { readHomeland, runHomeland, homelandNextCheck } = await import('../src/homeland.mjs');
const { runLoop } = await import('../src/loop.mjs');
const { clock } = await import('../src/activity-actions.mjs');
const tick = () => new Promise(setImmediate);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const setup = () => {
  const f = h.fixture();
  f.client.setMaxListeners(100);
  f.state.cells = [0, 1, 2, 3].map(cellId => ({ cellId, state: 2,
    ...(cellId === 0 ? { piece: { uid: 100, pieceCfgId: '钩1', produceLeft: -1 } } : {}) }));
  f.state.warehouse = [];
  f.state.stamina = 50;
  f.state.orders = [{ slot: 0, orderId: 1, reqs: [{ pieceCfgId: '鱼3', count: 1 }] }];
  Object.assign(f.settings.homeland, { enabled: true, submitOrders: true });
  return f;
};
let passed = 0;
async function test(name, body) {
  const originalNow = Date.now, now = originalNow();
  Date.now = () => now;
  try { await body(); passed++; console.log('通过：' + name); }
  finally { Date.now = originalNow; }
}
try {
  await test('不同业务响应可乱序并发，全部到达后才并发读取库存', async () => {
    const f = h.fixture(), gates = new Map();
    const config = { ...h.config, tables: structuredClone(h.config.tables) };
    config.tables.HomelandLevelCfg.data.find(row => row.level === 3).heroStar = [1, 5];
    f.state.beforeRead = name => {
      if (name === 'HomelandRequest') return;
      const gate = deferred(); gates.set(name, gate); return gate.promise;
    };
    let finished = false;
    const job = readHomeland(f.client, config, f.options).then(view => { finished = true; return view; });
    await tick();
    assert.deepEqual([...gates.keys()].sort(), ['AllHeroRequest', 'CounterInfoRequest', 'DualCombineInfoRequest', 'ShopInfoRequest']);
    for (const name of ['AllHeroRequest', 'ShopInfoRequest', 'CounterInfoRequest']) gates.get(name).resolve();
    await tick();
    assert.equal(gates.has('AllItemRequest'), false);
    assert.equal(finished, false);
    gates.get('DualCombineInfoRequest').resolve();
    await tick();
    assert(gates.has('AllResourceRequest') && gates.has('AllItemRequest'));
    gates.get('AllItemRequest').resolve(); await tick(); assert.equal(finished, false);
    gates.get('AllResourceRequest').resolve();
    assert.equal((await job).available, true);
    assert.equal(f.state.writes.length, 0);
  });
  await test('读取失败或暂停时排空在途响应，不进入下一组或写入', async () => {
    for (const failure of ['business', 'inventory', 'paused']) {
      const f = h.fixture(), gates = new Map();
      const names = failure === 'inventory' ? ['AllItemRequest', 'AllResourceRequest']
        : ['DualCombineInfoRequest', 'ShopInfoRequest', 'CounterInfoRequest'];
      f.state.beforeRead = name => {
        if (!names.includes(name)) return;
        const gate = deferred(); gates.set(name, gate); return gate.promise;
      };
      let finished = false;
      const job = readHomeland(f.client, h.config, f.options).then(
        () => { finished = true; assert.fail('失败批次不能形成可执行快照'); },
        error => { finished = true; return error; });
      await tick(); assert.equal(gates.size, names.length);
      if (failure === 'paused') { f.enabled = false; gates.get(names[0]).resolve(); }
      else gates.get(names[0]).reject(Error('模拟响应失败'));
      await tick(); assert.equal(finished, false, '首个失败不能提前释放读锁');
      for (const name of names.slice(1)) gates.get(name).resolve();
      assert.match((await job).message, failure === 'paused' ? /暂停/ : /模拟响应失败/);
      if (failure !== 'inventory') assert(!f.state.calls.includes('AllItemRequest'));
      assert.equal(f.state.writes.length, 0);
    }
  });
  await test('读请求等待插读通道时关闭开关，在实际发送前取消', async () => {
    const f = h.fixture(), gate = deferred(), request = f.client.request;
    f.client.request = async (...args) => { await gate.promise; args[4]?.(); return request(...args); };
    const job = assert.rejects(readHomeland(f.client, h.config, f.options), /暂停/);
    f.enabled = false; gate.resolve(); await job;
    assert.equal(f.state.calls.length, 0);
  });
  await test('分批成功后快速接续，耗尽体力、未知结果和读取失败恢复普通间隔', async () => {
    const f = setup();
    await runHomeland(f.client, h.config, { ...f.options, maxActions: 2 });
    assert.equal(f.state.writes.length, 2);
    assert.equal(homelandNextCheck(f.client, f.options), clock(f.client) + 1);
    const calls = f.state.calls.length;
    await runHomeland(f.client, h.config, f.options); assert.equal(f.state.calls.length, calls);
    f.client.serverClockOffsetMs += 1000;
    await runHomeland(f.client, h.config, f.options);
    assert.equal(f.state.orders.length, 0);
    assert.equal(f.state.writes.filter(row => row.name === 'DualCombineProduceRequest').length, 4);
    assert.equal(homelandNextCheck(f.client, f.options), clock(f.client) + 300);
    for (const kind of ['stamina', 'pending', 'failed', 'identity']) {
      const g = setup();
      if (kind === 'stamina') g.state.stamina = 0;
      if (kind === 'pending') g.state.drop = 'DualCombineProduceRequest';
      if (kind === 'failed') g.state.beforeRead = () => { throw Error('模拟读取失败'); };
      if (kind === 'identity') delete g.player.playerId;
      const run = runHomeland(g.client, h.config, { ...g.options, maxActions: 1 });
      if (kind === 'failed' || kind === 'identity') await assert.rejects(run, /模拟读取失败|无法确认家园角色/); else await run;
      assert.equal(homelandNextCheck(g.client, g.options), clock(g.client) + 300, kind);
      assert.equal(g.state.writes.length, kind === 'pending' ? 1 : 0);
      if (kind === 'pending') {
        g.client.serverClockOffsetMs += 301000; g.state.drop = null;
        await runHomeland(g.client, h.config, g.options);
        assert.equal(g.state.writes.length, 1, '未知生产不能重发');
        assert.equal(g.ledger.snapshot().uncertain, 1);
      }
    }
  });
  await test('每日领取已完成时不重复读取或形成到期忙轮询，换日重新检查', async () => {
    const f = h.fixture();
    Object.assign(f.settings.homeland, { enabled: true, freeStamina: true, freeBox: true });
    await runHomeland(f.client, h.config, f.options);
    const calls = f.state.calls.length;
    f.client.serverClockOffsetMs += 301000;
    await runHomeland(f.client, h.config, f.options);
    assert.equal(f.state.calls.length, calls);
    assert.equal(homelandNextCheck(f.client, f.options), clock(f.client) + 300);
    f.client.serverClockOffsetMs += 86400000;
    assert.equal(homelandNextCheck(f.client, f.options), clock(f.client));
    await runHomeland(f.client, h.config, f.options);
    assert.equal(f.state.writes.filter(row => row.name === 'DualCombineBuyStaminaRequest').length, 2);
  });
  await test('达到批次时限或出现排队操作，在当前动作确认后让出', async () => {
    const originalNow = Date.now;
    try {
      let now = originalNow(); Date.now = () => now;
      for (const reason of ['duration', 'queued']) {
        const f = setup(); let waiting = false;
        f.state.beforeWrite = () => { if (reason === 'duration') now += 2100; else waiting = true; };
        await runHomeland(f.client, h.config, { ...f.options, maxActions: 4, maxBatchMs: 2000, shouldYieldQueue: () => waiting });
        assert.equal(f.state.writes.length, 1);
        assert.equal(f.ledger.snapshot().uncertain, 0);
        assert.equal(homelandNextCheck(f.client, f.options), clock(f.client) + 1);
      }
    } finally { Date.now = originalNow; }
  });
  await test('实际挂机调度在轮间接续新订单，账号队列中的其他工作可先执行', async () => {
    const f = setup(), originalNow = Date.now;
    let now = Math.floor(originalNow() / 1000) * 1000, queued = false, tail = Promise.resolve(), waiting = 0;
    const base = now, batches = [], waits = [], events = [];
    const schedule = work => {
      waiting++;
      const job = tail.then(async () => {
        waiting--; assert.equal(queued, false); queued = true;
        const start = f.state.writes.length;
        try { return await work(); } finally { batches.push(f.state.writes.length - start); queued = false; }
      });
      tail = job.catch(() => {}); return job;
    };
    f.state.beforeWrite = name => {
      assert(queued); events.push(name);
      if (events.length === 1) void schedule(() => events.push('其他排队操作'));
    };
    const request = f.client.request;
    f.client.request = async (...args) => { assert(queued, '查询也必须留在账号队列内'); return request(...args); };
    const sendWatch = f.client.sendWatch;
    let submitted = 0, completedAt = null;
    f.client.sendWatch = async (...args) => {
      const result = await sendWatch(...args);
      if (args[0] === 'DualCombineSubmitOrderRequest') {
        if (++submitted === 1) f.state.orders = [{ slot: 1, orderId: 2, reqs: [{ pieceCfgId: '鱼2', count: 1 }] }];
        else completedAt = now;
      }
      return result;
    };
    try {
      Date.now = () => now;
      await runLoop(f.client, h.protocol, { config: h.config, player: f.player, rounds: 2, everyMs: 60000,
        allowMutate: true, isEnabled: () => false, getSettings: () => f.settings, usageLedger: f.ledger,
        schedule, shouldYieldQueue: () => waiting > 0,
        sleep: async ms => { assert(waits.length < 20, '不能忙轮询'); waits.push(ms); now += ms; } });
      assert.equal(submitted, 2);
      assert(completedAt - base < 10000, '有活可做时无需等待 300 秒或完整主轮');
      assert.deepEqual(events.slice(0, 2), ['DualCombineProduceRequest', '其他排队操作']);
      assert(batches.every(size => size <= 4), JSON.stringify(batches));
      assert(waits.some(ms => ms <= 1000));
      assert.equal(f.state.stamina, 44);
      assert.equal(f.ledger.snapshot().uncertain, 0);
    } finally { Date.now = originalNow; }
  });
  await test('快速接续期间暂停、断线或关闭细项，不会继续发送；配置变化可提前唤醒', async () => {
    for (const mode of ['pause', 'disconnect', 'disable']) {
      const f = setup(), controller = new AbortController(), originalNow = Date.now;
      let now = Math.floor(originalNow() / 1000) * 1000, changed = false;
      try {
        Date.now = () => now;
        await runLoop(f.client, h.protocol, { config: h.config, player: f.player, rounds: 2, everyMs: 60000,
          allowMutate: true, isEnabled: () => false, getSettings: () => f.settings, usageLedger: f.ledger, stop: controller.signal,
          sleep: async ms => {
            now += ms;
            if (changed) return;
            changed = true;
            if (mode === 'pause') controller.abort();
            if (mode === 'disconnect') { f.client.connected = false; f.client.emit('close'); }
            if (mode === 'disable') { f.settings.homeland.submitOrders = false; f.client.emit('automationSettingsChanged'); }
          } });
        assert(changed);
        assert.equal(f.state.writes.length, 4, mode);
      } finally { Date.now = originalNow; }
    }
    const f = setup(); f.state.stamina = 0;
    await runHomeland(f.client, h.config, f.options);
    assert(homelandNextCheck(f.client, f.options) > clock(f.client));
    f.settings.homeland.freeStamina = true;
    assert.equal(homelandNextCheck(f.client, f.options), clock(f.client));
    f.settings.homeland.enabled = false;
    assert.equal(homelandNextCheck(f.client, f.options), Infinity);
  });
  console.log(`家园并发与接续验收通过 ${passed} 项`);
} finally { await h.close(); }
