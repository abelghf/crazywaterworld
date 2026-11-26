// 批量运行离线竞争情景；子进程输出分别落盘，失败保留 stderr。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const [jobsFile, output, concurrencyArg = '6'] = process.argv.slice(2);
const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
const concurrency = Number(concurrencyArg);
if (!Array.isArray(jobs) || !jobs.length || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32)
  throw Error('需要非空任务数组，并行数为1～32');
if (jobs.some(job => !Number.isSafeInteger(job.seeds) || job.seeds < 1 || !Number.isSafeInteger(job.firstSeed) ||
  job.firstSeed < 1 || !Number.isSafeInteger(job.rivals) || job.rivals < 0 || !Array.isArray(job.variants) || !job.variants.length))
  throw Error('每项需要有效的 seeds、firstSeed、rivals 和 variants');
fs.mkdirSync(output, { recursive: true });
for (let i = 0; i < jobs.length; i++) for (const extension of ['.jsonl', '.stderr'])
  if (fs.existsSync(path.join(output, String(i).padStart(3, '0') + extension))) throw Error('输出批次已存在，请使用新目录');
let next = 0, completed = 0, failed = 0;
async function worker() {
  while (next < jobs.length) {
    const index = next++, job = jobs[index], name = String(index).padStart(3, '0');
    const out = fs.openSync(path.join(output, name + '.jsonl'), 'wx');
    const err = fs.openSync(path.join(output, name + '.stderr'), 'wx');
    const args = ['tools/merchant-competition-sim.mjs', job.input ?? process.env.MC_INPUT ?? 'output/merchant-4005-20261125-1611.json',
      String(job.seeds), job.rewards ?? process.env.MC_REWARDS ?? 'output/merchant-4005-preset-rewards.json',
      String(job.firstSeed), 'sprint', String(job.initialPins ?? (job.cap ?? 220) - 51), 'v70'];
    const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', out, err], env: { ...process.env,
      MC_RIVALS: String(job.rivals), MC_VARIANTS: job.variants.join(','), MC_CAP: String(job.cap ?? 220),
      MC_INTEL: job.intel ?? 'normal', MC_RIVAL_STEP: String(job.rivalStep ?? 30),
      MC_RIVAL_WINDOW: String(job.rivalWindow ?? 30), MC_RIVAL_DAILY: String(job.rivalDailyLimit ?? 100),
      MC_DISTRIBUTION: job.distribution ?? 'greedy',
      MC_ENGINE_ROOT: job.engineRoot ?? path.resolve(import.meta.dirname, '..'), MC_ENGINE_LABEL: job.engine ?? 'current',
      MC_SELF_STEP: String(job.selfStep ?? 103), MC_POLL_SECONDS: String(job.pollSeconds ?? job.selfStep ?? 103), MC_TRACE: '0' } });
    const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
    fs.closeSync(out); fs.closeSync(err);
    if (code !== 0) { failed++; console.error('FAILED', index, JSON.stringify(job)); }
    completed++;
    console.log(JSON.stringify({ completed, jobs: jobs.length, failed, job: index }));
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
process.exitCode = failed ? 1 : 0;
