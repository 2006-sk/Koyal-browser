import assert from 'node:assert/strict';
import test from 'node:test';
import { isPersistentWizardNavigationEntry } from './crawler.js';
import type { PageNode, SiteMap } from './sitemap.js';

function wizard(
  id: string,
  interactives: PageNode['interactives'],
): PageNode {
  return {
    id,
    title: id,
    description: '',
    kind: 'wizard-step',
    urlPatterns: [`/${id}`],
    detection: { snapshotAnyOf: [id] },
    requiresAuth: true,
    interactives,
    firstSeenAt: '',
    lastSeenAt: '',
  };
}

test('repeated wizard Upload file controls remain mapped but are not separate deep-walk entries', () => {
  const storyUpload = { label: 'Upload file', role: 'generic', category: 'nav' as const };
  const themeUpload = { label: 'Upload file', role: 'button', category: 'nav' as const };
  const scenesUpload = { label: 'Upload file', role: 'button', category: 'upload' as const };
  const pages = {
    story: wizard('story', [storyUpload]),
    theme: wizard('theme', [themeUpload]),
    scenes: wizard('scenes', [scenesUpload]),
  };
  const sitemap: SiteMap = {
    origin: 'https://example.test',
    updatedAt: '',
    pages,
    edges: [
      { from: 'story', actionLabel: 'Upload file', to: 'upload' },
      { from: 'theme', actionLabel: 'Upload file', to: 'upload' },
    ],
    flows: [],
    walks: {},
    siteHints: [],
  };

  assert.equal(isPersistentWizardNavigationEntry(sitemap, pages.story, storyUpload), true);
  assert.equal(isPersistentWizardNavigationEntry(sitemap, pages.theme, themeUpload), true);
  assert.equal(isPersistentWizardNavigationEntry(sitemap, pages.scenes, scenesUpload), true);
  assert.equal(pages.story.interactives.length, 1);
  assert.equal(sitemap.edges.length, 2);
});

test('unique creation controls and repeated non-wizard controls remain eligible', () => {
  const addLocation = { label: 'Add New Location', role: 'button', category: 'create' as const };
  const back = { label: 'Go back to upload audio', role: 'button', category: 'nav' as const };
  const locations = wizard('locations', [addLocation]);
  const story = wizard('story', [back]);
  const list: PageNode = {
    ...wizard('assets', [{ label: 'Upload file', role: 'button', category: 'upload' }]),
    kind: 'page',
  };
  const sitemap: SiteMap = {
    origin: 'https://example.test',
    updatedAt: '',
    pages: { locations, story, list },
    edges: [],
    flows: [],
    walks: {},
    siteHints: [],
  };

  assert.equal(isPersistentWizardNavigationEntry(sitemap, locations, addLocation), false);
  assert.equal(isPersistentWizardNavigationEntry(sitemap, story, back), true);
  assert.equal(
    isPersistentWizardNavigationEntry(sitemap, list, list.interactives[0]),
    false,
  );
});
