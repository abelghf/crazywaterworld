export const residentMaterialReasons = {
  blockedMaterials: '包含不准消耗的材料',
  skipCrops: '已设置跳过农作物订单',
  skipProduction: '可用库存不足，已设置跳过需生产的订单',
};

export function hasResidentMaterialRules(resident) {
  return !!(resident?.skipCrops || resident?.skipProduction || resident?.blockedMaterials?.length);
}

// available 只计算可支配的现货。整单命中任一项，其他材料也无需预留或排产。
export function residentMaterialRule(resident, requirements, crops, available) {
  if (!resident?.enabled) return null;
  if (requirements.some(item => resident.blockedMaterials?.includes(item.id))) return 'blockedMaterials';
  if (resident.skipCrops && requirements.some(item => crops.has(item.id))) return 'skipCrops';
  if (resident.skipProduction && available && requirements.some(item => available(item.id) < item.num)) return 'skipProduction';
  return null;
}
