import { describe, it, expect } from 'vitest';
import { navItems, visibleNavItems } from './navItems';

const USER_PATHS = ['/intraday', '/swing', '/positions', '/settings'];

describe('visibleNavItems', () => {
  it('USER sees exactly the four product items', () => {
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
