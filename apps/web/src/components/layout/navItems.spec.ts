import { describe, it, expect } from 'vitest';
import { navItems, visibleNavItems } from './navItems';

// The USER-visible product surface (must mirror USER_VISIBLE in navItems.ts).
const USER_PATHS = [
  '/',
  '/intraday',
  '/swing',
  '/positions',
  '/portfolio',
  '/monitor',
  '/payments',
  '/market',
  '/charts',
  '/settings',
];

describe('visibleNavItems', () => {
  it('USER sees exactly the product items (Dashboard/Intraday/Swing/Positions/Portfolio/Monitor/Payments/Market/Charts/Settings)', () => {
    expect(visibleNavItems('USER').map((i) => i.path).sort()).toEqual([...USER_PATHS].sort());
  });

  it('ADMIN sees every item', () => {
    expect(visibleNavItems('ADMIN').length).toBe(navItems.length);
  });

  it('treats null/unknown role as USER (fail closed)', () => {
    expect(visibleNavItems(null).map((i) => i.path).sort()).toEqual([...USER_PATHS].sort());
    expect(visibleNavItems(undefined).map((i) => i.path).sort()).toEqual([...USER_PATHS].sort());
    expect(visibleNavItems('SOMETHING_ELSE').map((i) => i.path).sort()).toEqual(
      [...USER_PATHS].sort(),
    );
  });
});

describe('Core Journal (SP2 M5)', () => {
  it('ADMIN (the owner) sees Core Journal right after Core Risk; USER does not', () => {
    const admin = visibleNavItems('ADMIN').map((i) => i.path);
    expect(admin).toContain('/core-journal');
    expect(admin.indexOf('/core-journal')).toBe(admin.indexOf('/core-risk') + 1);
    expect(visibleNavItems('USER').map((i) => i.path)).not.toContain('/core-journal');
  });
});
