"""Aggregate completed simulations by engine, operation time and polling interval."""
import json
import sys
from collections import defaultdict
from pathlib import Path
from statistics import median

groups = defaultdict(list)
seen = set()
for directory in sys.argv[1:]:
    root = Path(directory)
    for error in root.glob('*.stderr'):
        if error.stat().st_size:
            raise RuntimeError(f'Failed batch: {error}')
    for file in sorted(root.glob('*.jsonl')):
        for line in file.read_text(encoding='utf-8').splitlines():
            row = json.loads(line)
            key = (row.get('engine', 'current'), row['rivalCount'], row['rivalDistribution'],
                   row['variant'], row['actionSeconds'], row.get('pollSeconds', row['actionSeconds']), row['cap'])
            identity = (*key, row['seed'])
            if identity in seen:
                raise RuntimeError(f'Duplicate seed/scenario: {identity}')
            seen.add(identity)
            groups[key].append(row)

summary = []
for key, rows in sorted(groups.items()):
    hits = [row for row in rows if row['profit'] >= 50_000_000]
    summary.append(dict(zip(('engine', 'rivals', 'distribution', 'variant', 'actionSeconds', 'pollSeconds', 'cap'), key)) | {
        'runs': len(rows), 'hits': len(hits), 'seeds': sorted(row['seed'] for row in rows),
        'medianProfit': median(row['profit'] for row in rows),
        'medianPinsAllRuns': median(row['pins'] for row in rows),
        'medianPinsSuccessfulRuns': median(row['pins'] for row in hits) if hits else None,
    })
print(json.dumps({'runs': sum(len(rows) for rows in groups.values()), 'groups': summary}, ensure_ascii=False, indent=2))
