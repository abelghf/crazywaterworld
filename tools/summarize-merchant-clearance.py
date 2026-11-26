"""Validate paired clearance experiments and summarize capital, score and pointers."""
import json
import sys
from collections import defaultdict
from pathlib import Path
from statistics import median

jobs = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
root = Path(sys.argv[2])
rows = []
identities = set()
groups = defaultdict(lambda: defaultdict(dict))
for index, job in enumerate(jobs):
    name = f"{index:03d}"
    error = root / (name + ".stderr")
    if not error.exists() or error.stat().st_size:
        raise RuntimeError(f"Missing or failed batch: {name}")
    batch = [json.loads(line) for line in (root / (name + ".jsonl")).read_text(encoding="utf-8").splitlines()]
    expected = {(seed, variant) for seed in range(job["firstSeed"], job["firstSeed"] + job["seeds"])
                for variant in job["variants"]}
    if len(batch) != len(expected) or {(r["seed"], r["variant"]) for r in batch} != expected:
        raise RuntimeError(f"Incomplete or duplicate batch: {name}")
    for row in batch:
        if (row["rivalCount"], row["actionSeconds"], row["rivalDistribution"]) != (
                job["rivals"], job["selfStep"], job["distribution"]):
            raise RuntimeError(f"Scenario mismatch: {name}")
        if row["modelRevision"] != "clearance-v1-separated-batches":
            raise RuntimeError("Models with different transaction timing cannot be pooled")
        if row["profit"] - row["grossLoss"] != row["netGain"] or row["cash"] + row["heldCost"] != 10000 + row["netGain"]:
            raise RuntimeError(f"Profit/capital mismatch: {name}")
        if row["cap"] != job.get("cap", 220) or row["pins"] > row["cap"]:
            raise RuntimeError(f"Pointer budget mismatch: {name}")
        scenario = (row["cap"], row["rivalCount"], row["actionSeconds"], row["rivalDistribution"])
        identity = (*scenario, row["seed"], row["variant"])
        if identity in identities:
            raise RuntimeError(f"Duplicate scenario: {identity}")
        identities.add(identity)
        groups[scenario][row["variant"]][row["seed"]] = row
        rows.append(row)

summary = []
for key, variants in sorted(groups.items()):
    baseline = variants["baseline"]
    for variant, samples in variants.items():
        if samples.keys() != baseline.keys():
            raise RuntimeError(f"Unpaired seeds: {key}, {variant}")
        values = list(samples.values())
        pairs = [(baseline[seed], row) for seed, row in samples.items()]
        both = [(a, b) for a, b in pairs if a["goalAt"] is not None and b["goalAt"] is not None]
        deltas = [b["profit"] - a["profit"] for a, b in pairs]
        summary.append(dict(zip(("cap", "rivals", "actionSeconds", "distribution"), key)) | {
            "variant": variant, "runs": len(values), "hits": sum(r["profit"] >= 50000000 for r in values),
            "medianProfit": median(r["profit"] for r in values), "medianPins": median(r["pins"] for r in values),
            "medianNetGain": median(r["netGain"] for r in values), "medianGrossLoss": median(r["grossLoss"] for r in values),
            "maxGrossLoss": max(r["grossLoss"] for r in values), "minCapital": min(r["minCapital"] for r in values),
            "maxDrawdownPercent": max(r["maxDrawdownPercent"] for r in values),
            "triggeredRuns": sum(r["experimentSales"] > 0 for r in values),
            "experimentSales": sum(r["experimentSales"] for r in values),
            "lossTriggeredRuns": sum(r["experimentLossSales"] > 0 for r in values),
            "experimentLossSales": sum(r["experimentLossSales"] for r in values),
            "experimentLoss": sum(r["experimentLoss"] for r in values),
            "winsTiesLosses": [sum(v > 0 for v in deltas), sum(v == 0 for v in deltas), sum(v < 0 for v in deltas)],
            "medianProfitDelta": median(deltas), "minProfitDelta": min(deltas), "maxProfitDelta": max(deltas),
            "rescuedHits": sum(a["profit"] < 50000000 <= b["profit"] for a, b in pairs),
            "lostHits": sum(b["profit"] < 50000000 <= a["profit"] for a, b in pairs),
            "medianPinsDelta": median(b["pins"] - a["pins"] for a, b in pairs),
            "medianGoalHoursDeltaBothHit": median((b["goalAt"] - a["goalAt"]) / 3600 for a, b in both) if both else None,
        })
print(json.dumps({"runs": len(rows), "groups": summary}, ensure_ascii=False, indent=2))
