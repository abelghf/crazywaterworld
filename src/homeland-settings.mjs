export const HOMELAND_DEFAULTS = {
  enabled: false, freeStamina: false, freeBox: false, submitOrders: false,
  mergeOrders: false, warehouseBuffer: false, produceOrders: false,
  buildProducers: false, useSupplies: false,
  takeWarehouse: false, unlockFloors: false, clean: false, tech: false, upgrade: false,
  keepCoins: 0, dailyCoinLimit: 500, targetLevel: 30, targetTech: 180, checkEverySeconds: 300,
  keepStamina: 0, dailyStaminaLimit: 500,
};
export const HOMELAND_ACTIONS = {
  freeStamina: '领取每日免费体力', freeBox: '领取工坊免费宝箱', submitOrders: '提交工坊订单',
  mergeOrders: '合成订单所需物品',
  produceOrders: '生产订单所需原料',
  takeRewards: '取出工坊奖励', openSupplies: '打开资源补给', mergeSupplies: '合并资源棋子', useSupplies: '领取资源棋子',
  warehouseBuffer: '存入仓库腾出合成空位',
  takeWarehouse: '取出订单所需仓库物品', unlockFloors: '解锁家园楼层', clean: '打扫家园',
  tech: '升级家园科技', upgrade: '升级家园',
};
export const homelandEnabled = settings => settings?.loop?.world === true && settings?.homeland?.enabled === true;

export function homelandActionEnabled(pref, action) {
  if (action.forSupply) return pref.useSupplies === true
    && (action.kind !== 'takeWarehouse' || pref.takeWarehouse === true)
    && (action.kind !== 'warehouseBuffer' || pref.takeWarehouse === true && pref.warehouseBuffer === true);
  return pref[action.kind] === true
    && (!['takeWarehouse', 'mergeOrders', 'warehouseBuffer'].includes(action.kind) || pref.submitOrders === true)
    && (action.kind !== 'warehouseBuffer' || pref.takeWarehouse === true)
    && (!action.forMerge || pref.mergeOrders === true && pref.submitOrders === true)
    && (!action.forProduction || pref.produceOrders === true)
    && (!action.forProducer || pref.buildProducers === true)
    && (action.kind !== 'upgrade' || action.target <= pref.targetLevel)
    && (action.kind !== 'tech' || action.target <= pref.targetTech);
}
