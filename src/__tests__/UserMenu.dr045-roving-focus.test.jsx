// DR-045 (Fresh24 Wave 3) — UserMenu roving tabindex stays synchronized
// with DOM focus.
//
// Bug: the Account menu uses a roving tabindex pattern. End focused
// Logout but left activeIndex at whatever was previously selected, so
// the next ArrowDown computed next from the stale state and landed on
// Dashboard instead of wrapping back to Help. Home had the symmetric
// bug (stale activeIndex → ArrowUp landed somewhere other than Logout).
// Both also left aria-activedescendant (the screen-reader announcer)
// pinned to the stale index.
//
// Fix contract: a single helper synchronizes activeIndex state with
// DOM focus. Home / End / ArrowDown / ArrowUp all route through it so
// the two can never drift.
//
// Run: cd src && npx jest --testPathPattern="UserMenu.dr045"

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const mockLogout = jest.fn();

jest.mock('../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    employee: {
      id: 'emp-1',
      name: 'Test User',
      email: 'test@example.com',
      isAdmin: false,
    },
    logout: mockLogout,
  }),
}));

jest.mock('../contexts/ToastContext.jsx', () => ({
  useToast: () => ({ push: jest.fn(), dismiss: jest.fn() }),
}));

const userMenuSrc = readFileSync(
  resolvePath(__dirname, '../components/UserMenu.jsx'),
  'utf8',
);

const renderMenu = () =>
  render(
    <MemoryRouter initialEntries={['/portal/dashboard']}>
      {/* eslint-disable-next-line global-require */}
      {React.createElement(require('../components/UserMenu.jsx').default)}
    </MemoryRouter>,
  );

// Open the menu via a mouse click on the trigger button. After this,
// focus remains on the trigger (the onClick calls openMenu(false)).
// jsdom does NOT move focus on click the way a real browser does, so
// we explicitly focus the trigger to mirror the post-click focus state
// a sighted user would have. Without this the document-level keydown
// handler would short-circuit on `if (!insideMenu && !insideTrigger)`.
const openMenu = () => {
  const trigger = screen.getByRole('button', { name: /Account menu/i });
  fireEvent.click(trigger);
  trigger.focus();
  return trigger;
};

// Helper: dispatch a keydown on the currently focused element. The
// production handler listens at the document level so any focused
// descendant inside the menu bubbles to it.
const press = (key) => {
  fireEvent.keyDown(document.activeElement || document.body, { key });
};

const getActiveDescendant = () => {
  const menu = document.querySelector('[role="menu"]');
  return menu ? menu.getAttribute('aria-activedescendant') : null;
};

const itemEl = (idx) => document.getElementById(`user-menu-item-${idx}`);

describe('DR-045 — UserMenu roving tabindex stays synchronized with DOM focus', () => {
  beforeEach(() => {
    mockLogout.mockReset();
  });

  test('source: a single helper synchronizes state + focus, used by all four keys', () => {
    // The structural fix: extract one helper that updates both
    // activeIndex state AND DOM focus, then route every key handler
    // through it. A regression that re-introduces a "focus only" path
    // (the pre-fix bug) would fail these regex pins.
    expect(userMenuSrc).toMatch(/const\s+focusMenuItem\s*=\s*\(\s*idx\s*\)\s*=>/);
    expect(userMenuSrc).toMatch(/focusMenuItem\(lastIndex\)/);
    expect(userMenuSrc).toMatch(/focusMenuItem\(0\)/);
    // The helper must update BOTH state and focus — partial fixes
    // (e.g. setActiveIndex(idx) without focus(), or focus() without
    // setActiveIndex) are exactly what DR-045 closes.
    const helper = userMenuSrc.match(
      /const\s+focusMenuItem\s*=\s*\(\s*idx\s*\)\s*=>\s*\{([\s\S]*?)\}/,
    );
    expect(helper).not.toBeNull();
    expect(helper[1]).toMatch(/setActiveIndex\(\s*idx\s*\)/);
    expect(helper[1]).toMatch(/itemRefs\.current\[\s*idx\s*\][\s\S]*?\.focus\(/);
  });

  test('1. End → ArrowDown wraps Logout → Help (the headline bug)', () => {
    renderMenu();
    const trigger = openMenu();
    // Enter the menu: ArrowDown on trigger sets activeIndex=0 + focuses Help.
    press('ArrowDown');
    expect(itemEl(0)).toHaveFocus();
    expect(getActiveDescendant()).toBe('user-menu-item-0');

    // End → focus Logout, activeIndex must also become 3 (was 0 pre-fix).
    press('End');
    expect(itemEl(3)).toHaveFocus();
    expect(getActiveDescendant()).toBe('user-menu-item-3');

    // ArrowDown from Logout must wrap to Help (index 0).
    // Pre-fix: activeIndex was stale at 0, so next = 0 + 1 = 1,
    // landing on Dashboard instead of wrapping.
    press('ArrowDown');
    expect(itemEl(0)).toHaveFocus();
    expect(getActiveDescendant()).toBe('user-menu-item-0');
  });

  test('2. Home → ArrowUp wraps Help → Logout (symmetric case)', () => {
    renderMenu();
    const trigger = openMenu();
    press('ArrowDown'); // → Help (0)
    expect(itemEl(0)).toHaveFocus();

    // Home while already on Help: focus and activeIndex both stay at 0.
    press('Home');
    expect(itemEl(0)).toHaveFocus();
    expect(getActiveDescendant()).toBe('user-menu-item-0');

    // ArrowUp from Help must wrap to Logout (index 3).
    // Pre-fix: aria-activedescendant was stale → ArrowUp landed on
    // the stale index - 1 (Dashboard) instead of Logout.
    press('ArrowUp');
    expect(itemEl(3)).toHaveFocus();
    expect(getActiveDescendant()).toBe('user-menu-item-3');
  });

  test('3. Enter activates the currently focused item (Logout triggers handleLogout)', () => {
    renderMenu();
    openMenu();
    press('ArrowDown');   // → Help (0)
    press('End');         // → Logout (3)
    expect(itemEl(3)).toHaveFocus();
    // Fire a keydown for Enter; the native <button> click handler runs
    // via React's onKeyDown → onClick synthetic chain for button
    // elements, so dispatching a 'click' is what actually invokes
    // handleLogout. Simulate the user pressing Enter by firing click.
    fireEvent.click(itemEl(3));
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  test('4. Escape closes the menu and returns focus to the trigger', () => {
    renderMenu();
    const trigger = openMenu();
    press('ArrowDown');
    expect(itemEl(0)).toHaveFocus();
    press('Escape');
    expect(trigger).toHaveFocus();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  test('5. ArrowDown walks through items in order (basic flow)', () => {
    renderMenu();
    openMenu();
    press('ArrowDown'); // → Help (0)
    expect(itemEl(0)).toHaveFocus();
    press('ArrowDown'); // → Dashboard (1)
    expect(itemEl(1)).toHaveFocus();
    expect(getActiveDescendant()).toBe('user-menu-item-1');
    press('ArrowDown'); // → Notif Prefs (2)
    expect(itemEl(2)).toHaveFocus();
    press('ArrowDown'); // → Logout (3)
    expect(itemEl(3)).toHaveFocus();
    expect(getActiveDescendant()).toBe('user-menu-item-3');
  });

  test('6. Home after navigating away resets focus to Help AND activeIndex to 0', () => {
    renderMenu();
    openMenu();
    press('ArrowDown'); // → Help (0)
    press('End');       // → Logout (3) — activeIndex must be 3
    expect(getActiveDescendant()).toBe('user-menu-item-3');

    // Home: focus Help (0) and activeIndex (the screen-reader
    // announcer) must both return to Help.
    press('Home');
    expect(itemEl(0)).toHaveFocus();
    expect(getActiveDescendant()).toBe('user-menu-item-0');
  });

  test('7. End after Home lands focus on Logout and activeIndex on 3', () => {
    renderMenu();
    openMenu();
    press('ArrowDown'); // → Help (0)
    press('Home');      // → Help (0) — still activeIndex 0
    expect(getActiveDescendant()).toBe('user-menu-item-0');

    press('End');
    expect(itemEl(3)).toHaveFocus();
    expect(getActiveDescendant()).toBe('user-menu-item-3');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// §8.10 (Fresh24 Wave 4, 2026-09-24) — Help & Support menu item retargets
// to the new /portal/support employee page, not the public /contact form.
//
// Pre-§8.10 the UserMenu's first item was the public "Send a Project Brief"
// form (to=/contact). Signed-in employees want the login / attendance /
// leave / training FAQ map instead, so the link target moved to
// /portal/support. This test pins the new target so a future refactor that
// silently flips it back (or to a wrong hash) trips the test before the
// regression ships.
//
// Asserts BOTH the menuItems array AND the rendered <Link href> so a change
// in either side of the contract is caught.
// ────────────────────────────────────────────────────────────────────────────

describe('§8.10 — UserMenu "Help & Support" link target', () => {
  test('8. menuItems entry for Help & Support points to /portal/support (not /contact)', () => {
    // Source-text pin — covers the menuItems array literal so a
    // refactor that drops the new target but leaves the rendered href
    // (or vice-versa) still trips at least one assertion below.
    expect(userMenuSrc).toMatch(/to:\s*['"]\/portal\/support['"][\s\S]{0,200}?label:\s*['"]Help & Support['"]/);
    // And the previous public-form target must NOT survive in the
    // menuItems array. (The /contact route still exists for the public
    // site footer; just not as the dropdown target.)
    const menuItemsBlock = userMenuSrc.match(
      /const\s+menuItems\s*=\s*\[[\s\S]*?\]/,
    );
    expect(menuItemsBlock).not.toBeNull();
    expect(menuItemsBlock[0]).not.toMatch(/to:\s*['"]\/contact['"][\s\S]*?Help & Support/);
  });

  test('9. rendered <Link id="user-menu-item-0"> href is /portal/support', () => {
    // Mount-time pin — ensures the JSX href matches the menuItems
    // entry above. The menu only mounts after openMenu() fires
    // (the dropdown is portalled to document.body), so the item
    // element is null until the click handler runs.
    renderMenu();
    openMenu();
    const helpItem = document.getElementById('user-menu-item-0');
    expect(helpItem).not.toBeNull();
    expect(helpItem.getAttribute('href')).toBe('/portal/support');
    // And the rendered label is still "Help & Support" — not silently
    // relabelled to something generic.
    expect(helpItem.textContent).toMatch(/Help & Support/);
  });
});