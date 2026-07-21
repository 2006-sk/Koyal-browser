import { requireBaseUrl } from '../config.js';
import { Interact } from '../agent/interact.js';
import { SiteState } from '../agent/site-state.js';
import type { StatementClass } from '../agent/statements.js';

/** Interactive KB browser — reclassify statements, approve flows, prune recipes/allowlist. */
export async function reviewCommand(): Promise<void> {
  const state = new SiteState(requireBaseUrl());
  const interact = new Interact(state.inboxDir);

  try {
    for (;;) {
      console.log(`\n=== autoqa review — ${state.hostname} ===`);
      console.log(`  statements: ${state.statements.length}`);
      const exploratory = state.sitemap.flows.filter((f) => f.status === 'exploratory').length;
      const deterministic = state.sitemap.flows.filter((f) => f.status === 'deterministic').length;
      console.log(`  flows: ${state.sitemap.flows.length} (${exploratory} exploratory, ${deterministic} deterministic)`);
      console.log(`  walks: ${Object.keys(state.sitemap.walks ?? {}).length}`);
      console.log(`  recipes: ${Object.keys(state.recipes).length}`);
      console.log(`  allowlist: ${Object.keys(state.allowlist).length}`);

      const area = await interact.askChoice(
        'Review what?',
        ['statements', 'flows', 'walks', 'recipes', 'allowlist', 'quit'],
        'quit',
      );
      if (area === 'quit') break;

      if (area === 'walks') {
        const walks = Object.values(state.sitemap.walks ?? {});
        if (!walks.length) {
          console.log('  (none yet — deep walks happen during `autoqa explore`)');
          continue;
        }
        walks.forEach((w, i) => {
          const pages = w.steps.map((s) => s.pageId).filter((p, idx, arr) => arr.indexOf(p) === idx);
          console.log(`  ${i + 1}. ${w.id} — ${w.outcome}, ${w.steps.length} steps: ${pages.join(' → ')}`);
        });
        const pick = await interact.ask('Number to inspect/delete (or blank)', { default: '' });
        const idx = Number(pick) - 1;
        if (Number.isInteger(idx) && walks[idx]) {
          const walk = walks[idx];
          for (const s of walk.steps) {
            const bits = [
              `#${s.index} ${s.pageId} [${s.kind}]`,
              s.action ? `action: ${s.action.type}${s.action.label ? ` "${s.action.label}"` : ''}` : '',
              s.landmark ? `landmark: "${s.landmark}"` : '',
              s.processingMs ? `processed in ${Math.round(s.processingMs / 1000)}s` : '',
            ].filter(Boolean);
            console.log(`    ${bits.join(' | ')}`);
          }
          const action = await interact.askChoice('Delete this walk (forces re-walk next explore)?', ['keep', 'delete'], 'keep');
          if (action === 'delete') {
            delete state.sitemap.walks![walk.id];
            if (walk.generatedFlowId) {
              state.sitemap.flows = state.sitemap.flows.filter((f) => f.id !== walk.generatedFlowId);
            }
            state.saveSitemap();
            console.log('  deleted (and its generated flow).');
          }
        }
      }

      if (area === 'statements') {
        if (!state.statements.length) {
          console.log('  (none yet)');
          continue;
        }
        state.statements.forEach((s, i) => {
          console.log(`  ${i + 1}. [${s.classification}] (${s.kind}, seen ${s.seenCount}x) "${s.raw}"`);
        });
        const pick = await interact.ask('Number to reclassify/delete (or blank to go back)', { default: '' });
        const idx = Number(pick) - 1;
        if (Number.isInteger(idx) && state.statements[idx]) {
          const action = await interact.askChoice(
            `"${state.statements[idx].raw}" →`,
            ['success', 'failure', 'noise', 'delete'],
            state.statements[idx].classification,
          );
          if (action === 'delete') {
            state.statements.splice(idx, 1);
          } else {
            state.statements[idx].classification = action as StatementClass;
            state.statements[idx].decidedAt = new Date().toISOString();
          }
          state.saveStatements();
          console.log('  saved.');
        }
      }

      if (area === 'flows') {
        if (!state.sitemap.flows.length) {
          console.log('  (none yet — run `autoqa explore`)');
          continue;
        }
        state.sitemap.flows.forEach((f, i) => {
          const last = f.lastResult ? ` last: ${f.lastResult.verdict}` : '';
          console.log(`  ${i + 1}. [${f.status}] ${f.title} (${f.milestones.length} milestones)${last}`);
        });
        const pick = await interact.ask('Number to toggle exploratory/skip (or blank)', { default: '' });
        const idx = Number(pick) - 1;
        if (Number.isInteger(idx) && state.sitemap.flows[idx]) {
          const flow = state.sitemap.flows[idx];
          if (flow.status === 'exploratory' || flow.status === 'deterministic' || flow.status === 'approved') {
            flow.status = 'skipped';
            flow.qualification = undefined;
          } else {
            flow.status = 'exploratory';
            flow.qualification = { phase: 'learning' };
          }
          state.saveSitemap();
          console.log(`  ${flow.id} → ${flow.status}`);
        }
      }

      if (area === 'recipes') {
        const ids = Object.keys(state.recipes);
        if (!ids.length) {
          console.log('  (none yet)');
          continue;
        }
        ids.forEach((id, i) => {
          const r = state.recipes[id];
          console.log(`  ${i + 1}. ${id} — ${r.steps.length} steps, ${r.stats.successes}✓/${r.stats.failures}✗`);
        });
        const pick = await interact.ask('Number to delete (or blank)', { default: '' });
        const idx = Number(pick) - 1;
        if (Number.isInteger(idx) && ids[idx]) {
          delete state.recipes[ids[idx]];
          state.saveRecipes();
          console.log('  deleted.');
        }
      }

      if (area === 'allowlist') {
        const keys = Object.keys(state.allowlist);
        if (!keys.length) {
          console.log('  (none yet)');
          continue;
        }
        keys.forEach((k, i) => console.log(`  ${i + 1}. ${k} → ${state.allowlist[k]}`));
        const pick = await interact.ask('Number to clear (or blank)', { default: '' });
        const idx = Number(pick) - 1;
        if (Number.isInteger(idx) && keys[idx]) {
          delete state.allowlist[keys[idx]];
          state.saveAllowlist();
          console.log('  cleared.');
        }
      }
    }
  } finally {
    interact.close();
  }
}
