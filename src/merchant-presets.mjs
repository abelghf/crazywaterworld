import { DEFAULT_SETTINGS } from './automation-settings.mjs';
import { merchantPresetSettings } from './merchant-preset-settings.mjs';

const policies = merchantPresetSettings(DEFAULT_SETTINGS.merchant);
const schedule = { merchantTrade: true, merchantRewards: true, tradeTasks: true };

export const merchantPresets = [
  { id: 'free', label: '免费跑船', description: '零针自然航行，优先可接下一程的盈利港。解锁后用钻石升船。', forecast: '按第 4005 期样本模拟四天，24 组行情的累计利润中位数为 91 万，用针 0 根。',
    settings: { merchant: policies.free, schedule } },
  { id: 'eventFree', label: '仅用本期免费针', description: '保留原有库存，用本期新领的免费针加速，解锁后用钻石升船。',
    forecast: '只用已核实的免费余额，每日最多 100 根，每程 4 根。按 51 根分批到账模拟，四天利润中位数为 1,423 万，实耗中位数为 50 根。',
    settings: { merchant: policies.eventFree, schedule } },
  { id: 'sprint', label: '冲刺 5,000 万（达标优先）', description: '前期加速载货回款升船，最后一个交易日优先加速成交。累计利润达到 5,000 万后停针，继续自然走商。',
    forecast: '每日最多 100 根，每程最多 4 根。开局库存 139、180、220 根，再按记录分批领 51 根，24 组行情中分别有 17、23、24 组达标。',
    settings: { merchant: policies.sprint, schedule } },
];

export function merchantPresetOptions(settings) {
  return merchantPresets.map(({ id, label, description, forecast, settings: preset }) => ({
    id, label, description, forecast, totalPointers: preset.merchant.speedUpMode === 'eventFree' ? null : preset.merchant.periodPointerLimit,
    active: Object.entries(preset).every(([group, values]) =>
      Object.entries(values).every(([key, value]) => settings[group][key] === value)),
  }));
}
