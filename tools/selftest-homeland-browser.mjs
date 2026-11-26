import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createHomelandHarness } from './fixtures/homeland-console.mjs';

const h = await createHomelandHarness({ http: true });
const output = path.resolve('output/playwright/homeland');
fs.mkdirSync(output, { recursive: true });
let browser;
try {
  const executablePath = [process.env.CW_BROWSER_TEST_EXECUTABLE, chromium.executablePath(),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && fs.existsSync(file));
  assert(executablePath, '未找到本机验收浏览器');
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(h.root).origin ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [], homelandRequests = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/homeland')) homelandRequests.push(request); });
  await page.goto(h.root + '/#config-group-homeland');
  const settings = page.locator('#config-group-homeland');
  const ready = async () => {
    await settings.waitFor({ state: 'visible' });
    await page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
  };
  await ready();
  assert.equal(await page.locator('[data-resource-tab="homeland"], #tab-homeland, #homeland-root').count(), 0);
  assert.equal(await page.getByText('照料家园，安排工坊日常。', { exact: true }).count(), 0);
  assert.equal(homelandRequests.length, 0);
  console.log('通过：家园独立标签、页面和重复标题移除，挂机配置入口保持可用');

  for (const key of ['enabled', 'submitOrders', 'useSupplies', 'tech', 'upgrade']) {
    const toggle = settings.locator('#config-field-homeland-' + key);
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    const [saved] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings' && response.request().method() === 'POST'),
      toggle.click(),
    ]);
    assert.equal(saved.status(), 200); await ready();
    assert.equal((await h.api('settings')).data.settings.homeland[key], true);
  }
  for (const key of ['mergeOrders', 'produceOrders', 'buildProducers', 'takeWarehouse', 'warehouseBuffer', 'keepStamina', 'dailyStaminaLimit',
    'keepCoins', 'dailyCoinLimit', 'targetTech', 'targetLevel'])
    assert.equal(await settings.locator('#config-field-homeland-' + key).count(), 0);
  assert.doesNotMatch(await settings.textContent(), /保留家园币|每日家园币上限|科技目标等级|家园目标等级/);
  assert.equal(h.fixtures.get('a').state.writes.length, 0);
  const [preview] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings/preview'),
    page.locator('#config-preview').click(),
  ]);
  assert.equal(preview.status(), 200);
  assert.equal(preview.request().postDataJSON().category, 'homeland');
  const planned = await preview.json();
  assert(planned.actions.length > 0, '家园配置预览仍提供执行计划');
  await page.locator('#config-preview').filter({ hasText: '只读预览' }).waitFor();
  assert.equal(h.fixtures.get('a').state.writes.length, 0);
  assert.equal(homelandRequests.length, 0);
  console.log('通过：家园开关保存、订单与补给选择、只读计划预览均保留且不执行游戏操作');

  for (const previous of [{ tab: 'resources', resource: 'homeland' }, { tab: 'homeland' }]) {
    await page.evaluate(previous => history.replaceState({ consoleView: previous }, '', location.pathname), previous);
    await page.reload(); await ready();
    assert.equal(new URL(page.url()).hash, '#config-group-homeland');
    assert.equal(await page.locator('#tabs [data-tab="settings"]').getAttribute('aria-current'), 'page');
    assert.equal(await settings.locator('#config-field-homeland-submitOrders').getAttribute('aria-checked'), 'true');
  }
  // An explicit link remains authoritative over the retired saved tab.
  await page.evaluate(() => history.replaceState({ consoleView: { tab: 'resources', resource: 'homeland' } }, '', '#config-group-building'));
  await page.reload();
  await page.locator('#config-group-building').waitFor({ state: 'visible' });
  assert.equal(new URL(page.url()).hash, '#config-group-building');
  await page.goto(h.root + '/#config-group-homeland'); await ready();
  console.log('通过：旧家园页面记录回退到家园挂机配置，显式配置链接优先');

  await page.screenshot({ path: path.join(output, 'settings-only-desktop.png'), fullPage: true });
  for (const theme of ['dark', 'light']) {
    await page.locator('#theme-trigger').click();
    await page.locator('[data-theme-option="' + theme + '"]').click();
    for (const width of [360, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: path.join(output, `settings-only-${theme}-${width}.png`), fullPage: true });
    }
  }
  await page.locator('#tabs [data-tab="resources"]').click();
  assert.equal(await page.locator('[data-resource-tab="homeland"]').count(), 0);
  assert.equal(await page.locator('#resource-tabs').isVisible(), true);
  assert.equal(homelandRequests.length, 0);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('通过：深浅主题、360/320 像素配置布局、杂项导航与页面脚本正常');
} finally { if (browser) await browser.close(); await h.close(); }
