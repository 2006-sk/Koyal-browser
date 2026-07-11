/** Post-login sidebar navigation targets (beta.koyal.ai). */
export interface AppShellNavItem {
  id: string;
  linkPattern: RegExp;
  /** Expected URL path segment after navigation */
  urlPattern: RegExp;
  /** At least one must appear in snapshot after load */
  snapshotHints: string[];
}

export const APP_SHELL_NAV_ITEMS: AppShellNavItem[] = [
  {
    id: 'dashboard',
    linkPattern: /link "Dashboard"/i,
    urlPattern: /\/dashboard/,
    snapshotHints: ['dashboard', 'good afternoon'],
  },
  {
    id: 'projects',
    linkPattern: /link "Projects"/i,
    urlPattern: /\/projects/,
    snapshotHints: ['your projects', 'projects', 'create project'],
  },
  {
    id: 'collaborated-projects',
    linkPattern: /link "Collaborated Projects"/i,
    urlPattern: /collaborated/,
    snapshotHints: ['collaborated'],
  },
  {
    id: 'characters',
    linkPattern: /link "Characters"/i,
    urlPattern: /characters/,
    snapshotHints: ['character'],
  },
  {
    id: 'assets',
    linkPattern: /link "Assets"/i,
    urlPattern: /\/assets(?:\/|$|\?)/,
    snapshotHints: ['asset'],
  },
  {
    id: 'locations',
    linkPattern: /link "Locations"/i,
    urlPattern: /locations/,
    snapshotHints: ['location'],
  },
  {
    id: 'outfits',
    linkPattern: /link "Outfits"/i,
    urlPattern: /outfits/,
    snapshotHints: ['outfit'],
  },
];

export function isAppShellSnapshot(snapshot: string): boolean {
  return APP_SHELL_NAV_ITEMS.some((item) => item.linkPattern.test(snapshot));
}
