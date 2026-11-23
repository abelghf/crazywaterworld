// Keep the order solver's timeline fixed. Preview the next queue-sized batch
// per factory, using spare materials and machine time from that same snapshot.
export function planStockRefills(snapshot, input, firm, target) {
  if (!(target > 0) || !['optimal', 'best-known'].includes(firm.status)) return [];
  const budget = new Map(snapshot.factories.map(f => [f.id, f.capacity]));
  const lanes = input.machines.map(machine => {
    const factory = machine.id.replace(/:\d+$/, '');
    return { ...machine, factory, freeAt: machine.availableAt,
      booked: firm.timeline.filter(job => job.machineId === machine.id),
      recipes: input.recipes.filter(recipe => recipe.enabled && recipe.machineIds.includes(machine.id)) };
  }).filter(lane => budget.get(lane.factory) > 0 && lane.recipes.length);
  if (!lanes.length) return [];

  // Surplus can go negative until enough protected materials actually arrive.
  // Occupancy includes all promised outputs, even future order production.
  const surplus = new Map(input.inventory.map(v => [v.itemId, v.quantity]));
  const occupancy = new Map(snapshot.inventory.map(v => [v.id, v.num]));
  const add = (map, key, delta) => map.set(key, (map.get(key) ?? 0) + delta);
  const events = new Map([[0, []]]);
  const at = (time, effect) => {
    if (!events.has(time)) events.set(time, []);
    if (effect) events.get(time).push(effect);
  };
  function bookOutput(id, count, finish) {
    add(occupancy, id, count);
    at(finish, () => add(surplus, id, count));
  }
  function protect(items, spendTime) {
    for (const { itemId, quantity } of items) {
      add(surplus, itemId, -quantity);
      if (spendTime != null) at(spendTime, () => add(occupancy, itemId, -quantity));
    }
  }
  for (const item of input.incoming) bookOutput(item.itemId, item.quantity, item.readyAt);
  for (const job of firm.timeline) {
    bookOutput(job.itemId, job.quantity, job.end);
    protect(job.inputs, job.start);
  }
  for (const order of input.orders) {
    const delivery = firm.orderCompletions.find(row => row.orderId === order.id);
    protect(order.requirements, order.consumeOnCompletion ? delivery.completedAt : null);
  }
  for (const lane of lanes) at(lane.freeAt);

  const jobs = [];
  while (events.size) {
    const time = Math.min(...events.keys());
    for (const effect of events.get(time)) effect();
    events.delete(time);
    for (const lane of lanes) {
      if (lane.freeAt > time || !budget.get(lane.factory)) continue;
      const next = lane.booked.find(job => job.end > time);
      if (next && next.start <= time) continue;
      const until = Math.min(next?.start ?? Infinity, lane.availableUntil ?? Infinity);
      const candidates = [];
      for (const recipe of lane.recipes) {
        const seconds = recipe.durationByMachine[lane.id];
        const occupied = occupancy.get(recipe.itemId) ?? 0;
        if (!(seconds > 0) || time + seconds > until || time > (recipe.availableUntil ?? Infinity)
          || occupied + recipe.outputQuantity > Math.min(target, input.stockCaps[recipe.itemId])
          || recipe.inputs.some(item => (surplus.get(item.itemId) ?? 0) < item.quantity)) continue;
        candidates.push({ recipe, seconds, occupied });
      }
      candidates.sort((a, b) => a.seconds - b.seconds || a.occupied - b.occupied);
      if (!candidates.length) continue;
      const { recipe, seconds } = candidates[0];
      for (const item of recipe.inputs) {
        add(surplus, item.itemId, -item.quantity);
        add(occupancy, item.itemId, -item.quantity);
      }
      lane.freeAt = time + seconds;
      budget.set(lane.factory, budget.get(lane.factory) - 1);
      bookOutput(recipe.itemId, recipe.outputQuantity, lane.freeAt);
      // Spending a full intermediate can free space at a factory visited earlier.
      if (recipe.inputs.length) at(time);
      jobs.push({ kind: 'restock', recipeId: recipe.id, machineId: lane.id, itemId: recipe.itemId,
        quantity: recipe.outputQuantity, start: time, end: lane.freeAt, inputs: recipe.inputs });
    }
  }
  return jobs;
}
