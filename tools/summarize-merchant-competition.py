"""Summarize matched shared-inventory simulations without treating failed runs as cheap successes."""
from pathlib import Path
from collections import defaultdict
from statistics import median, mean
import json
import math
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else 'output/merchant-competition-20261126')

def wilson(hits, n):
    z = 1.959963984540054
    c = (hits / n + z * z / (2 * n)) / (1 + z * z / n)
    w = z * math.sqrt((hits / n) * (1 - hits / n) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return [max(0, c - w), min(1, c + w)]

def quantile(xs, p):
    xs = sorted(xs)
    at = (len(xs) - 1) * p
    a = math.floor(at)
    return xs[a] + (xs[min(a + 1, len(xs) - 1)] - xs[a]) * (at - a)

groups = defaultdict(list)
all_rows = []
for stage in ['screening', 'validation', 'followup', 'controls', 'preclear-validation']:
    for file in (root / stage).glob('*.jsonl'):
        for line in file.read_text(encoding='utf-8').splitlines():
            if not line.strip():
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue  # A running worker may be partway through its final line.
            key = (stage, r['rivalCount'], r['actionSeconds'], r.get('rivalDailyLimit', 100), r['intel'], r['cap'], r['variant'])
            groups[key].append(r)
            all_rows.append((stage, r))

summary = []
for key, rows in sorted(groups.items()):
    hits = [r for r in rows if r['profit'] >= 50_000_000]
    failures = [r for r in rows if r['profit'] < 50_000_000]
    successful_pins = [r['milestones']['50000000'] for r in hits]
    row = dict(zip(['stage', 'rivals', 'selfStep', 'rivalDailyLimit', 'intel', 'cap', 'variant'], key))
    row.update(n=len(rows), hits=len(hits), hitRate=len(hits) / len(rows), hitRateWilson95=wilson(len(hits), len(rows)),
               profitMedianWan=median(r['profit'] for r in rows) / 10_000,
               profitP10Wan=quantile([r['profit'] for r in rows], .1) / 10_000,
               profitMinWan=min(r['profit'] for r in rows) / 10_000,
               pinsMedianAll=median(r['pins'] for r in rows),
               pinsAtGoalMedian=median(successful_pins) if hits else None,
               pinsAtGoalRange=[min(successful_pins), max(successful_pins)] if hits else None,
               failurePinsMedian=median(r['pins'] for r in failures) if failures else None,
               failuresWith20PinsLeft=sum(r['cap'] - r['pins'] >= 20 for r in failures),
               movesMedian=median(r['moves'] for r in rows),
               dailyPinsMedian=[median(r['dailyPins'][d] for r in rows) for d in range(4)],
               refreshPurchaseShare=mean(r.get('refreshBoughtCells', 0) / max(1, r['boughtCells']) for r in rows),
               emptyDeparturesMedian=median(r['emptyDepartures'] for r in rows),
               optimisticWaitHoursMedian=median(r.get('optimisticWaitHours', 0) for r in rows))
    summary.append(row)
    print(f"{key}: {len(hits)}/{len(rows)} profit={row['profitMedianWan']:.0f}万 allPins={row['pinsMedianAll']} hitPins={row['pinsAtGoalMedian']}")

paired = []
for key, rows in sorted(groups.items()):
    if key[-1] == 'baseline':
        continue
    baseline = {r['seed']: r for r in groups.get(key[:-1] + ('baseline',), [])}
    both = [(r, baseline[r['seed']]) for r in rows if r['seed'] in baseline]
    if not both:
        continue
    paired.append(dict(zip(['stage', 'rivals', 'selfStep', 'rivalDailyLimit', 'intel', 'cap', 'variant'], key)) | {
        'n': len(both), 'profitWins': sum(a['profit'] > b['profit'] for a, b in both),
        'profitDeltaMedianWan': median((a['profit'] - b['profit']) / 10_000 for a, b in both),
        'rescuedFailures': sum(a['profit'] >= 50_000_000 > b['profit'] for a, b in both),
        'newFailures': sum(b['profit'] >= 50_000_000 > a['profit'] for a, b in both),
        'bothSuccessful': sum(a['profit'] >= 50_000_000 and b['profit'] >= 50_000_000 for a, b in both),
    })

(root / 'summary.json').write_text(json.dumps({'runs': len(all_rows), 'groups': summary, 'paired': paired}, ensure_ascii=False, indent=2), encoding='utf-8')
print('TOTAL', len(all_rows))
