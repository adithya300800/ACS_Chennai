/**
 * DR-017 — Account dropdown (UserMenu) keyboard contract.
 *
 * The audit found that the header avatar dropdown let Tab escape to
 * the cards behind it (six Tab presses moved focus into the page
 * rather than cycling the menu items). The user-visible symptom was
 * that screen-reader / keyboard-only users could not reach Help &
 * Support, Dashboard, Notification preferences, or Logout.
 *
 * This file pins the four behaviors the WAI-ARIA APG menubar/menu
 * pattern requires:
 *
 *   1. ArrowDown / ArrowUp cycle focus through menu items.
 *   2. Home / End jump to first / last item.
 *   3. Only the active item is in the tab order (roving tabindex);
 *      the rest have tabIndex={-1} so Tab leaves the menu after
 *      one stop.
 *   4. Escape closes the menu and returns focus to the trigger.
 *
 * The menu items MUST be in the same order as the render (Help &
 * Support, Dashboard, Notification preferences, Logout) so the index
 * in `menuItems` matches the index in the rendered DOM.
 */

const React = require('react');
const { render, screen, fireEvent, act } = require('@testing-library/react');
const { MemoryRouter } = require('react-router-dom');

// UserMenu imports AuthContext for `useAuth()`. We stub it so the
// component mounts without needing a real provider tree.
jest.mock('../../src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    employee: { id: 'emp-1', name: 'Ada Lovelace', email: 'ada@example.com', isAdmin: false },
    logout: jest.fn(),
  }),
}));

// jsdom does not honor requestAnimationFrame during synchronous test
// code. The UserMenu uses RAF only when opening via keyboard (to move
// focus into the menu). For mouse-open tests this is not on the path,
// but we install a synchronous shim anyway so the keyboard path is
// also deterministic.
beforeAll(() => {
  global.requestAnimationFrame = (cb) => {
    const id = setTimeout(cb, 0);
    return id;
  };
  global.cancelAnimationFrame = (id) => clearTimeout(id);
});

const UserMenu = require('../../src/components/UserMenu.jsx').default;

const MENU_LABELS = ['Help & Support', 'Dashboard', 'Notification preferences', 'Logout'];

// Each menu item is an <a> or <button> with a single <span> child
// holding the visible text. getByText returns the span; tests that
// need to assert on the parent use this helper.
function getMenuItem(label) {
  // user-menu-item is the className on the <a>/<button>.
  return document.querySelector(`.user-menu-item[role="menuitem"]:nth-of-type(${MENU_LABELS.indexOf(label) + 1})`)
    || document.querySelectorAll('.user-menu-item[role="menuitem"]')[MENU_LABELS.indexOf(label)];
}

function openMenu() {
  // The trigger is the button with aria-haspopup="menu".
  const trigger = screen.getByRole('button', { name: /account menu/i });
  fireEvent.click(trigger);
  return trigger;
}

describe('DR-017 — UserMenu keyboard contract', () => {
  it('opens the menu via click and shows all four items', () => {
    render(
      <MemoryRouter>
        <UserMenu />
      </MemoryRouter>
    );
    openMenu();
    for (const label of MENU_LABELS) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('trigger has aria-haspopup="menu" and toggles aria-expanded', () => {
    render(
      <MemoryRouter>
        <UserMenu />
      </MemoryRouter>
    );
    const trigger = screen.getByRole('button', { name: /account menu/i });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('menu sets aria-activedescendant when open', () => {
    render(
      <MemoryRouter>
        <UserMenu />
      </MemoryRouter>
    );
    openMenu();
    const menu = document.querySelector('[role="menu"]');
    // Mouse-open leaves activeIndex at -1, so activedescendant is not set.
    expect(menu.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('ArrowDown on the trigger moves focus into the menu (first item)', async () => {
    render(
      <MemoryRouter>
        <UserMenu />
      </MemoryRouter>
    );
    // Open via Enter (keyboard activation) so focus is moved into the
    // menu. The onKeyDown handler checks `!open` so we must NOT click
    // first — that would set `open` and skip the focus-into-menu path.
    const trigger = screen.getByRole('button', { name: /account menu/i });
    act(() => { trigger.focus(); });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    // Wait for the RAF-scheduled focus to settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // The first menu item should now have focus.
    expect(getMenuItem('Help & Support')).toHaveFocus();
  });

  it('ArrowDown moves focus to the next item, wrapping from last to first', async () => {
    render(
      <MemoryRouter>
        <UserMenu />
      </MemoryRouter>
    );
    const trigger = screen.getByRole('button', { name: /account menu/i });
    act(() => { trigger.focus(); });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // Now focus is on first item. Move to last via ArrowDown (3 times).
    const first = getMenuItem('Help & Support');
    const last = getMenuItem('Logout');
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    fireEvent.keyDown(getMenuItem('Dashboard'), { key: 'ArrowDown' });
    fireEvent.keyDown(getMenuItem('Notification preferences'), { key: 'ArrowDown' });
    expect(last).toHaveFocus();
    // One more ArrowDown wraps to first.
    fireEvent.keyDown(last, { key: 'ArrowDown' });
    expect(first).toHaveFocus();
  });

  it('ArrowUp wraps from first to last', async () => {
    render(
      <MemoryRouter>
        <UserMenu />
      </MemoryRouter>
    );
    const trigger = screen.getByRole('button', { name: /account menu/i });
    act(() => { trigger.focus(); });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const first = getMenuItem('Help & Support');
    const last = getMenuItem('Logout');
    expect(first).toHaveFocus();
    // ArrowUp from first wraps to last.
    fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(last).toHaveFocus();
  });

  it('only the active item has tabIndex=0 (roving tabindex)', async () => {
    render(
      <MemoryRouter>
        <UserMenu />
      </MemoryRouter>
    );
    openMenu();
    // After mouse-click open, activeIndex is -1 so all items are tabIndex={-1}.
    for (const label of MENU_LABELS) {
      const el = getMenuItem(label);
      expect(el).toHaveAttribute('tabindex', '-1');
    }
  });

  it('after Enter-open, only the first item has tabIndex=0', async () => {
    render(
      <MemoryRouter>
        <UserMenu />
      </MemoryRouter>
    );
    const trigger = screen.getByRole('button', { name: /account menu/i });
    act(() => { trigger.focus(); });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(getMenuItem('Help & Support')).toHaveAttribute('tabindex', '0');
    expect(getMenuItem('Dashboard')).toHaveAttribute('tabindex', '-1');
    expect(getMenuItem('Notification preferences')).toHaveAttribute('tabindex', '-1');
    expect(getMenuItem('Logout')).toHaveAttribute('tabindex', '-1');
  });

  it('Escape closes the menu and returns focus to the trigger', async () => {
    render(
      <MemoryRouter>
        <UserMenu />
      </MemoryRouter>
    );
    const trigger = screen.getByRole('button', { name: /account menu/i });
    act(() => { trigger.focus(); });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const first = getMenuItem('Help & Support');
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'Escape' });
    // Menu should close (items unmount).
    expect(document.querySelector('.user-menu-dropdown')).toBeNull();
    // Trigger should regain focus.
    expect(trigger).toHaveFocus();
  });

  it('clicking a menuitem closes the menu', () => {
    render(
      <MemoryRouter>
        <UserMenu />
      </MemoryRouter>
    );
    openMenu();
    fireEvent.click(getMenuItem('Dashboard'));
    // Menu closed.
    expect(document.querySelector('.user-menu-dropdown')).toBeNull();
  });
});
