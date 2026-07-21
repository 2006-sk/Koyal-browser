#!/usr/bin/env node
import { applyCliOverrides, requireBaseUrl } from './config.js';
import { SiteState } from './agent/site-state.js';
import { exploreCommand } from './commands/explore.js';
import { reviewCommand } from './commands/review.js';
import { runCommand } from './commands/run.js';
import { testCommand } from './commands/test.js';

const HELP = `autoqa — autonomous site-agnostic QA agent

Usage: npm run qa -- <command> --url <URL> [flags]

Commands:
  run       explore-if-needed, then test selected exploratory/deterministic flows   (default)
  explore   crawl the site, build/refresh the sitemap, propose flows
  test      run selected flows (--flow id[,id] to filter)
  review    browse/reclassify the knowledge base (statements, flows, recipes, allowlist)
  reset     clear saved state (--sitemap --statements --recipes --auth or --all)

Flags:
  --url <URL>        target site (or AUTOQA_URL in .env)
  --flow id[,id]     only these flow ids (test/run)
  --fresh            re-explore even if a sitemap exists (run)
  --wipeout          delete all saved state for this site, then explore + test from zero (run)
  --max-pages N      crawl page cap (default 25)
  --max-steps N      LLM steps per goal (default 12)
  --budget N         hard cap on total LLM calls (default unlimited)
  --headless         run the browser headless
  --deep-flows N     deep walks per explore (default 3)
  --no-deep          skip deep exploration (shallow crawl only)
  --quick            skip QA probes during testing (back/forward, matrices, edit sweeps)
  --upload-file <p>  force this file for every upload this run (format-parity testing)
`;

function flagValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv.find((a) => !a.startsWith('--')) ?? 'run';

  if (command === 'help' || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return 0;
  }

  applyCliOverrides({
    url: flagValue(argv, '--url'),
    maxPages: flagValue(argv, '--max-pages') ? Number(flagValue(argv, '--max-pages')) : undefined,
    maxSteps: flagValue(argv, '--max-steps') ? Number(flagValue(argv, '--max-steps')) : undefined,
    headless: argv.includes('--headless'),
    budget: flagValue(argv, '--budget') ? Number(flagValue(argv, '--budget')) : undefined,
    deepFlows: flagValue(argv, '--deep-flows') ? Number(flagValue(argv, '--deep-flows')) : undefined,
    noDeep: argv.includes('--no-deep'),
    quick: argv.includes('--quick'),
    uploadFile: flagValue(argv, '--upload-file'),
  });

  const only = flagValue(argv, '--flow')?.split(',').map((s) => s.trim()).filter(Boolean);

  switch (command) {
    case 'run':
      if (argv.includes('--wipeout')) {
        const state = new SiteState(requireBaseUrl());
        const removed = state.reset({ all: true });
        console.log(
          removed.length
            ? `[autoqa] --wipeout removed:\n${removed.map((item) => `  ${item}`).join('\n')}`
            : '[autoqa] --wipeout: no prior site state existed',
        );
      }
      return runCommand({ fresh: argv.includes('--fresh'), only });
    case 'explore':
      await exploreCommand();
      return 0;
    case 'test': {
      const { failed } = await testCommand({ only });
      return failed > 0 ? 1 : 0;
    }
    case 'review':
      await reviewCommand();
      return 0;
    case 'reset': {
      const state = new SiteState(requireBaseUrl());
      const removed = state.reset({
        sitemap: argv.includes('--sitemap'),
        statements: argv.includes('--statements'),
        recipes: argv.includes('--recipes'),
        auth: argv.includes('--auth'),
        all: argv.includes('--all'),
      });
      console.log(removed.length ? `Removed:\n${removed.map((r) => `  ${r}`).join('\n')}` : 'Nothing removed (pass --sitemap/--statements/--recipes/--auth/--all)');
      return 0;
    }
    default:
      console.error(`Unknown command "${command}"\n`);
      console.log(HELP);
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`\n[autoqa] fatal: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
