import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { SiteState } from './site-state.js';

test('replay-validation qualification survives startup when recipes are incomplete', () => {
  const url = `https://replay-startup-${randomUUID()}.invalid`;
  const seed = new SiteState(url);
  try {
    seed.sitemap.flows.push({
      id: 'partially-compiled',
      title: 'Partially compiled flow',
      description: 'Qualified by a high-coverage terminal learning run',
      status: 'exploratory',
      qualification: {
        phase: 'replay-validation',
        learnedAt: '2026-07-29T00:00:00.000Z',
        terminalArtifactVerifiedAt: '2026-07-29T00:00:00.000Z',
      },
      entry: { pageId: 'start' },
      milestones: [
        { id: 'm1', goal: 'Open the workflow', kind: 'navigate' },
        { id: 'm2', goal: 'Finish the workflow', kind: 'verify' },
      ],
    });
    seed.recipes['flow:partially-compiled:m1'] = {
      id: 'flow:partially-compiled:m1',
      goal: 'Open the workflow',
      steps: [],
      successCheck: {},
      stats: { successes: 1, failures: 0 },
    };
    seed.saveSitemap();
    seed.saveRecipes();

    const reloaded = new SiteState(url);
    const flow = reloaded.sitemap.flows.find((candidate) => candidate.id === 'partially-compiled');
    assert.equal(flow?.status, 'exploratory');
    assert.equal(flow?.qualification?.phase, 'replay-validation');
    assert.equal(flow?.qualification?.learnedAt, '2026-07-29T00:00:00.000Z');
    assert.equal(flow?.qualification?.terminalArtifactVerifiedAt, '2026-07-29T00:00:00.000Z');
    assert.equal(fs.existsSync(reloaded.recipesPath), true);
  } finally {
    seed.reset({ all: true });
  }
});
