"""Compare matched port-choice / acceleration-window scenarios."""
import json
from collections import Counter, defaultdict
from pathlib import Path
from statistics import mean, median
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else 'output/merchant-competition-distribution-20261126')
groups = defaultdict(list)
for file in (root / 'runs').glob('*.jsonl'):
    for line in file.read_text(encoding='utf-8').splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        groups[(row['rivalCount'], row['rivalDistribution'], row['variant'])].append(row)

summaries = []
for (rivals, distribution, variant), rows in sorted(groups.items()):
    rounds = [r for row in rows for r in row['distribution']['byRound']]
    peaks = Counter()
    for row in rows:
        peaks.update({int(k): v for k, v in row['distribution']['maxAtPortHistogram'].items()})
    occupied = [k for k, v in peaks.items() for _ in range(v) if k > 0]
    successes = [r for r in rows if r['profit'] >= 50_000_000]
    result = {
        'rivals': rivals, 'distribution': distribution, 'variant': variant, 'n': len(rows), 'hits': len(successes),
        'profitMedianWan': median(r['profit'] for r in rows) / 10_000,
        'pinsMedianAll': median(r['pins'] for r in rows),
        'pinsAtGoalMedian': median(r['milestones']['50000000'] for r in successes) if successes else None,
        'portsWithPurchasesPerRoundMean': mean(r['portsWithPurchases'] for r in rounds),
        'largestPortVolumeSharePerRoundMean': mean(r['largestPortVolumeShare'] for r in rounds),
        'largestPortUniqueBuyersPerRoundMean': mean(r['maxUniqueBuyersAtPort'] for r in rounds),
        'busiestDockMedianWhenAnyDocked': median(occupied) if occupied else 0,
        'busiestDockMax': max(peaks, default=0),
        'dockedShipsMean': mean(r['distribution']['dockedShipsSum'] / r['distribution']['samples'] for r in rows),
        'rivalTotalPurchasedCellsMean': mean(sum(p['cellsBought'] for p in r['distribution']['byRound']) for r in rows),
        'rivalProfitMedianWan': median(b['profit'] for r in rows for b in r['rivals']) / 10_000,
        'rivalPinsMedian': median(b['pins'] for r in rows for b in r['rivals']),
    }
    summaries.append(result)
    print(rivals, distribution, variant, f"{result['hits']}/{result['n']}",
          f"profit={result['profitMedianWan']:.0f}万", f"pins={result['pinsMedianAll']}",
          f"ports/round={result['portsWithPurchasesPerRoundMean']:.1f}",
          f"topPortShare={result['largestPortVolumeSharePerRoundMean']:.1%}")

paired = []
for key, rows in sorted(groups.items()):
    reference = groups.get((key[0], 'greedy', key[2]), [])
    reference = {r['seed']: r for r in reference}
    pairs = [(r, reference[r['seed']]) for r in rows if r['seed'] in reference]
    if key[1] == 'greedy' or not pairs:
        continue
    paired.append({'rivals': key[0], 'distribution': key[1], 'variant': key[2], 'n': len(pairs),
                   'profitDeltaMedianWan': median((a['profit'] - b['profit']) / 10_000 for a, b in pairs),
                   'rescuedFailures': sum(a['profit'] >= 50_000_000 > b['profit'] for a, b in pairs),
                   'newFailures': sum(b['profit'] >= 50_000_000 > a['profit'] for a, b in pairs)})
(root / 'summary.json').write_text(json.dumps({'runs': sum(map(len, groups.values())), 'groups': summaries, 'paired': paired},
                                           ensure_ascii=False, indent=2), encoding='utf-8')
