/**
 * DR-017 — Accessible modal dialog primitive.
 *
 * The audit found the DPR detail dialog let Tab escape to the cards
 * behind it (six Tab presses focused report cards, not dialog
 * controls). The root cause was missing focus management: there was
 * no initial focus, no containment (focus trap), and no focus-return
 * after close. The user-visible symptom was that screen-reader /
 * keyboard-only users could not reach the dialog's action buttons.
 *
 * This file pins the four behaviors the WAI-ARIA APG dialog-modal
 * pattern requires:
 *
 *   1. Initial focus: the first focusable child receives focus on
 *      mount. Pass `initialFocusRef` to override.
 *   2. Containment: Tab and Shift+Tab cycle within the dialog.
 *   3. Escape closes the dialog when `dismissable`.
 *   4. Focus returns to the trigger on close.
 *
 * Plus the supporting behaviors the audit called out: ARIA semantics,
 * backdrop-click dismissal, body scroll lock.
 */

const React = require('react');
const { render, screen, act, fireEvent, waitFor } = require('@testing-library/react');

// Modal schedules initial focus + focus return via requestAnimationFrame
// to avoid a race with first paint. jsdom does not run RAF callbacks
// during synchronous test code, so we replace it with a synchronous
// wrapper that fires on the next microtask. Tests can then `await` the
// assertion naturally (the effect cleanup still runs because React
// already invoked `cancelAnimationFrame` after the synchronous cb).
beforeAll(() => {
  global.requestAnimationFrame = (cb) => {
    const id = setTimeout(cb, 0);
    return id;
  };
  global.cancelAnimationFrame = (id) => clearTimeout(id);
});

const Modal = require('../../src/components/Modal.jsx').default;

describe('DR-017 — Modal primitive', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <Modal open={false} onClose={() => {}} ariaLabel="Test">
        <p>content</p>
      </Modal>
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders the dialog with role and aria-modal when open=true', () => {
    render(
      <Modal open onClose={() => {}} ariaLabel="Test dialog">
        <p>content</p>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'Test dialog');
  });

  it('prefers aria-labelledby when both label props are supplied (overrides aria-label)', () => {
    render(
      <Modal
        open
        onClose={() => {}}
        ariaLabel="label-as-fallback"
        ariaLabelledBy="my-title"
      >
        <h2 id="my-title">Title</h2>
        <p>content</p>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-labelledby', 'my-title');
  });

  it('focuses the first focusable child on mount', async () => {
    render(
      <Modal open onClose={() => {}} ariaLabel="Test">
        <button type="button">first</button>
        <button type="button">second</button>
      </Modal>
    );
    await waitFor(() => expect(screen.getByText('first')).toHaveFocus());
  });

  it('honors initialFocusRef override', async () => {
    const initialRef = React.createRef();
    render(
      <Modal
        open
        onClose={() => {}}
        ariaLabel="Test"
        initialFocusRef={initialRef}
      >
        <button type="button">first</button>
        <button type="button" ref={initialRef}>override-target</button>
      </Modal>
    );
    await waitFor(() => expect(screen.getByText('override-target')).toHaveFocus());
  });

  it('Tab on the last focusable wraps to the first (focus trap)', () => {
    render(
      <Modal open onClose={() => {}} ariaLabel="Test">
        <button type="button">first</button>
        <button type="button">second</button>
        <button type="button">last</button>
      </Modal>
    );
    const last = screen.getByText('last');
    const first = screen.getByText('first');
    // Move focus to last, then Tab → should wrap to first.
    act(() => { last.focus(); });
    fireEvent.keyDown(document.activeElement, { key: 'Tab' });
    expect(first).toHaveFocus();
  });

  it('Shift+Tab on the first focusable wraps to the last', () => {
    render(
      <Modal open onClose={() => {}} ariaLabel="Test">
        <button type="button">first</button>
        <button type="button">second</button>
        <button type="button">last</button>
      </Modal>
    );
    const first = screen.getByText('first');
    const last = screen.getByText('last');
    act(() => { first.focus(); });
    fireEvent.keyDown(document.activeElement, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('Escape closes the dialog when dismissable=true', () => {
    const onClose = jest.fn();
    render(
      <Modal open onClose={onClose} ariaLabel="Test" dismissable>
        <p>content</p>
      </Modal>
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape does NOT close when dismissable=false', () => {
    const onClose = jest.fn();
    render(
      <Modal open onClose={onClose} ariaLabel="Test" dismissable={false}>
        <p>content</p>
      </Modal>
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('backdrop click closes the dialog when dismissable=true', () => {
    const onClose = jest.fn();
    render(
      <Modal open onClose={onClose} ariaLabel="Test" dismissable>
        <p>content</p>
      </Modal>
    );
    // The backdrop is the role="dialog" element itself; the inner
    // <div> stopPropagation's clicks.
    const backdrop = screen.getByRole('dialog');
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('click on the inner content does NOT close', () => {
    const onClose = jest.fn();
    render(
      <Modal open onClose={onClose} ariaLabel="Test" dismissable>
        <p data-testid="inner">content</p>
      </Modal>
    );
    fireEvent.click(screen.getByTestId('inner'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('returns focus to the trigger on close (returnFocusRef)', async () => {
    const triggerRef = React.createRef();
    // Render a trigger button in the same document so we can verify
    // focus return to it.
    const { rerender } = render(
      <div>
        <button type="button" ref={triggerRef}>trigger</button>
      </div>
    );
    // Focus the trigger.
    act(() => { triggerRef.current.focus(); });
    expect(triggerRef.current).toHaveFocus();

    // Render Modal open with returnFocusRef pointing at the trigger.
    rerender(
      <div>
        <button type="button" ref={triggerRef}>trigger</button>
        <Modal
          open
          onClose={() => {}}
          ariaLabel="Test"
          returnFocusRef={triggerRef}
        >
          <button type="button">inside</button>
        </Modal>
      </div>
    );
    // First focusable inside the modal receives focus on mount.
    await waitFor(() => expect(screen.getByText('inside')).toHaveFocus());

    // Close the modal → focus should return to the trigger.
    rerender(
      <div>
        <button type="button" ref={triggerRef}>trigger</button>
        <Modal
          open={false}
          onClose={() => {}}
          ariaLabel="Test"
          returnFocusRef={triggerRef}
        >
          <button type="button">inside</button>
        </Modal>
      </div>
    );
    await waitFor(() => expect(triggerRef.current).toHaveFocus());
  });

  it('locks body scroll while open and restores it on close', () => {
    const prev = document.body.style.overflow;
    const { rerender } = render(
      <Modal open onClose={() => {}} ariaLabel="Test">
        <p>content</p>
      </Modal>
    );
    expect(document.body.style.overflow).toBe('hidden');
    rerender(
      <Modal open={false} onClose={() => {}} ariaLabel="Test">
        <p>content</p>
      </Modal>
    );
    expect(document.body.style.overflow).toBe(prev);
  });

  it('renders to document.body via portal (escapes parent stacking context)', () => {
    // The portal must render the dialog as a child of document.body,
    // not inside any inline <div> we wrap it in. This pins the round-
    // 21 lesson — clipping by ancestor stacking contexts is exactly
    // what portals fix.
    const { container } = render(
      <div data-testid="wrap">
        <Modal open onClose={() => {}} ariaLabel="Test">
          <p>portalled content</p>
        </Modal>
      </div>
    );
    // The wrap does not contain the dialog.
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    // The body (jsdom document) does.
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
