/**
 * Nightly entry point (GitHub Actions cron or manual). Each source is an
 * independent job: a failure is logged and recorded but never blocks the rest.
 * Exits non-zero if any job failed so CI surfaces it.
 */
import { log } from './lib/log.ts';
import { runAppleIngest } from './jobs/ingest-apple.ts';
import { runPlayIngest } from './jobs/ingest-play.ts';
import { runProductHuntIngest } from './jobs/ingest-producthunt.ts';
import { runXIngest } from './jobs/ingest-x.ts';
import { runScoring } from './jobs/score.ts';
import { runFactCheck } from './jobs/factcheck.ts';
import { runAnalyze } from './jobs/analyze.ts';
import { runApolloEnrichment } from './jobs/enrich-apollo.ts';
import { runXIdeaIngest } from './jobs/ingest-x-ideas.ts';
import { runLinkedInIngest } from './jobs/ingest-linkedin.ts';
import { runIdeaAnalysis } from './jobs/analyze-ideas.ts';
import { buildDashboard } from './jobs/build-dashboard.ts';

type Job = { name: string; run: () => Promise<unknown> };

const jobs: Job[] = [
  { name: 'ingest-apple', run: runAppleIngest },
  { name: 'ingest-play', run: runPlayIngest },
  { name: 'ingest-producthunt', run: runProductHuntIngest },
  { name: 'ingest-x', run: runXIngest },
  { name: 'score', run: runScoring },
  { name: 'factcheck', run: runFactCheck },
  { name: 'analyze', run: runAnalyze },
  { name: 'enrich-apollo', run: runApolloEnrichment },
  { name: 'ingest-x-ideas', run: runXIdeaIngest },
  { name: 'ingest-linkedin', run: runLinkedInIngest },
  { name: 'analyze-ideas', run: runIdeaAnalysis },
  { name: 'build-dashboard', run: buildDashboard },
];

// Leads jobs (instantly_sync, funnel_rollup, suggestion_engine) bolt on here
// when present, same isolation rules.
try {
  const leads = await import('./leads/jobs.ts');
  jobs.push(...leads.nightlyJobs);
} catch {
  log.info('leads jobs not present, skipping');
}

let failures = 0;
for (const job of jobs) {
  const t0 = Date.now();
  try {
    const result = await job.run();
    log.info(`✓ ${job.name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`, { result: result as Record<string, unknown> });
  } catch (err) {
    failures++;
    log.error(`✗ ${job.name} failed`, { err: String(err) });
  }
}

log.info(`nightly done: ${jobs.length - failures}/${jobs.length} jobs ok`);
process.exit(failures ? 1 : 0);
