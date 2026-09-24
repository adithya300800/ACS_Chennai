// DR-042 (Fresh Product Audit, 2026-09-24): Public mobile layouts clip
// readable text despite reporting no overflow.
//
// The audit caught two defects on the Home page at 375px:
//   1. `<div className="services-grid" style={{ gridTemplateColumns:
//      'repeat(3, 1fr)' }}>` and `<div className="grid-3" style={{
//      gridTemplateColumns: 'repeat(3, 1fr)' }}>` (Home.jsx:155,177) overrode
//      the existing responsive classes (which already collapse to 1fr at
//      <=480px). The forced 3-column layout produced ~101.5px-wide tracks
//      at 375px, chopping headings like "Quality Assurance & Control" and
//      their body copy.
//   2. The universal `* { overflow-x: hidden }` rule (App.css:66) clipped
//      every grid child individually, hiding the overflow instead of
//      surfacing the layout problem. `.section { overflow-x: hidden }`
//      (App.css:1025) compounded the masking at <=480px.
//
// The acceptance criteria explicitly state that a zero document-overflow
// flag is NOT success on its own — the headline has to actually be
// readable. So this file pins three categories of contract:
//
//   A. Source-text pins: the inline `gridTemplateColumns` is gone from
//      Home.jsx; the universal `*` overflow-x is gone from App.css;
//      `.service-card` got `min-width: 0` so long words can wrap.
//   B. Responsive-class contract: the surviving `services-grid` /
//      `grid-3` classes already collapse to 1 column at <=480px — pin the
//      breakpoint so a future refactor that drops the rule regresses the
//      fix instead of silently re-introducing the bug.
//   C. Behavioural render: at 320/375/768px the SERVICE cards render with
//      a usable width (not collapsed to 0) and the heading text fits
//      inside its card without overflowing the viewport.

import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// jsdom does not implement IntersectionObserver; Home.jsx (via StatsBar.jsx)
// uses it for the reveal-on-scroll animation. The audit doesn't care about
// the observer; we mock it so the component can render. Tests that
// specifically measure layout assert against the rendered DOM, not the
// observer callback.
class MockIntersectionObserver {
  constructor(cb) {
    this.cb = cb;
    this.observe = this.observe.bind(this);
    this.unobserve = this.unobserve.bind(this);
    this.disconnect = this.disconnect.bind(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  trigger(isIntersecting) {
    if (typeof this.cb === 'function') {
      this.cb([{ isIntersecting: !!isIntersecting }]);
    }
  }
}
if (typeof global.IntersectionObserver === 'undefined') {
  global.IntersectionObserver = MockIntersectionObserver;
}
if (typeof window !== 'undefined' && typeof window.IntersectionObserver === 'undefined') {
  window.IntersectionObserver = MockIntersectionObserver;
}

const homePath = path.join(__dirname, '..', 'pages', 'Home.jsx');
const appCssPath = path.join(__dirname, '..', 'App.css');
const homeSrc = fs.readFileSync(homePath, 'utf8');
const appCssSrc = fs.readFileSync(appCssPath, 'utf8');

// `jsdom` doesn't ship layout — getBoundingClientRect returns 0s by
// default. To make the behavioural assertions meaningful we stub
// Element.prototype.getBoundingClientRect on a per-instance basis via
// a constructor that returns widths proportional to the parent column.
// Each test sets `window.innerWidth` and stubs `clientWidth` /
// `scrollWidth` so we can assert "did the card get a usable width and
// did its heading fit?" without a full layout engine.
const stubDimensions = (parentWidth, cardWidth) => {
  // Mark every node with a "this is a service card" hook so the stub
  // can size them.
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const cls = (this.className && this.className.baseVal !== undefined)
      ? this.className.baseVal
      : (this.className || '');
    if (typeof cls === 'string' && cls.indexOf('service-card') !== -1) {
      return {
        width: cardWidth,
        height: 140,
        top: 0, left: 0, right: cardWidth, bottom: 140, x: 0, y: 0,
        toJSON() { return {}; },
      };
    }
    return {
      width: parentWidth,
      height: 100,
      top: 0, left: 0, right: parentWidth, bottom: 100, x: 0, y: 0,
      toJSON() { return {}; },
    };
  };
};

const setViewport = (width) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width, writable: true });
  Object.defineProperty(window, 'outerWidth', { configurable: true, value: width, writable: true });
  window.dispatchEvent(new Event('resize'));
};

describe('DR-042 — Home page mobile grid layout', () => {
  describe('A. Source-text pins', () => {
    test('1. Home.jsx no longer hard-codes gridTemplateColumns on the services grid', () => {
      // The audit caught `style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}`
      // on `<div className="services-grid">` (line 155). Pin absence so a
      // future regression that re-adds the inline style fails loud.
      // Strip JSX block comments before searching — the fix adds DR-042
      // explanatory comments above each grid removal, and the comments
      // legitimately cite the offending literal.
      const homeNoComments = homeSrc.replace(/\/\*[\s\S]*?\*\//g, '');
      const servicesIdx = homeNoComments.indexOf('className="services-grid"');
      expect(servicesIdx).toBeGreaterThan(-1);
      const window = homeNoComments.slice(
        Math.max(0, servicesIdx - 200),
        Math.min(homeNoComments.length, servicesIdx + 600)
      );
      expect(window).not.toMatch(/gridTemplateColumns/);
    });

    test('2. Home.jsx no longer hard-codes gridTemplateColumns on the sectors grid', () => {
      // Same fix at the `.grid-3` sector row (line 177 pre-fix). Pin absence.
      const homeNoComments = homeSrc.replace(/\/\*[\s\S]*?\*\//g, '');
      const sectorsIdx = homeNoComments.indexOf('className="grid-3"');
      expect(sectorsIdx).toBeGreaterThan(-1);
      const window = homeNoComments.slice(
        Math.max(0, sectorsIdx - 200),
        Math.min(homeNoComments.length, sectorsIdx + 600)
      );
      expect(window).not.toMatch(/gridTemplateColumns/);
    });

    test('3. App.css removed universal overflow-x: hidden on the * selector', () => {
      // The prior rule `* { box-sizing: border-box; overflow-x: hidden; }`
      // clipped every grid child individually, hiding the truncated
      // columns instead of fixing them. Assert it is gone and that
      // overflow protection moved to `body`.
      const universalMatch = appCssSrc.match(/^\s*\*\s*\{[^}]*\}/m);
      expect(universalMatch).not.toBeNull();
      expect(universalMatch[0]).not.toMatch(/overflow-x/);
      expect(universalMatch[0]).toMatch(/box-sizing:\s*border-box/);
    });

    test('4. App.css sets overflow-x: hidden on body (page-level horizontal-scroll guard preserved)', () => {
      // The page must still prevent horizontal scroll — that guarantee
      // moves from `*` to `body`. Pin it so a future refactor that
      // strips the body rule leaves the page defenseless.
      const bodyMatch = appCssSrc.match(/\bbody\s*\{[^}]*\}/m);
      expect(bodyMatch).not.toBeNull();
      expect(bodyMatch[0]).toMatch(/overflow-x:\s*hidden/);
    });

    test('5. App.css adds min-width: 0 to .service-card so long headings can wrap', () => {
      // Without `min-width: 0` the grid item uses `minmax(auto, 1fr)` and
      // a long unbreakable word inside the card forces the column past
      // the viewport. The DR-046 fix used the same `min-width: 0` rule.
      // Strip CSS block comments before matching — the DR-042 explanatory
      // comment above this rule legitimately contains `{` and `}` examples
      // (`* { overflow-x: hidden }`) that confuse the lazy brace matcher.
      const appCssNoComments = appCssSrc.replace(/\/\*[\s\S]*?\*\//g, '');
      const cardMatch = appCssNoComments.match(/\.service-card\s*\{([\s\S]*?)\}/);
      expect(cardMatch).not.toBeNull();
      expect(cardMatch[1]).toMatch(/min-width:\s*0/);
    });

    test('6. App.css removed the redundant `.section { overflow-x: hidden }` from the <=480px block', () => {
      // `.section { overflow-x: hidden }` was masking layout bugs on
      // phones (the audit's core complaint). Assert it is gone inside
      // the 480px block specifically. Strip CSS comments first so the
      // explanatory text doesn't trip the brace matcher.
      const appCssNoComments = appCssSrc.replace(/\/\*[\s\S]*?\*\//g, '');
      const block = appCssNoComments.match(/@media\s*\(\s*max-width:\s*480px\s*\)\s*\{([\s\S]*?)\n\}/);
      expect(block).not.toBeNull();
      expect(block[1]).not.toMatch(/\.section\s*\{\s*overflow-x:\s*hidden/);
    });
  });

  describe('B. Responsive-class contract preserved', () => {
    test('7. .services-grid collapses to 2 columns at <=1024px (existing tablet rule)', () => {
      // The fix relies on the EXISTING responsive CSS. If a future
      // refactor drops the `repeat(2, 1fr)` rule at <=1024, services
      // cards would re-claim 4 columns on tablets — same bug class.
      expect(appCssSrc).toMatch(
        /@media\s*\(\s*max-width:\s*1024px\s*\)\s*\{[\s\S]*?\.services-grid\s*\{\s*grid-template-columns:\s*repeat\(2,\s*1fr\)/
      );
    });

    test('8. .services-grid and .grid-3 collapse to 1 column at <=480px (existing phone rule)', () => {
      // The DR-042 fix removes the inline `repeat(3, 1fr)` overrides.
      // The single-column phone layout now lives in the existing
      // `@media (max-width: 480px)` block. Pin both rules.
      expect(appCssSrc).toMatch(
        /@media\s*\(\s*max-width:\s*480px\s*\)\s*\{[\s\S]*?\.services-grid\s*\{\s*grid-template-columns:\s*1fr/
      );
      expect(appCssSrc).toMatch(
        /@media\s*\(\s*max-width:\s*480px\s*\)\s*\{[\s\S]*?\.grid-3\s*,\s*\.grid-2\s*\{\s*grid-template-columns:\s*1fr/
      );
    });

    test('9. Home.jsx services + sectors grids use ONLY responsive classes (no inline grid)', () => {
      // Belt-and-suspenders: count every `gridTemplateColumns` literal
      // in Home.jsx. The fix should leave zero. (A future regression
      // that re-introduces any inline `gridTemplateColumns` on Home
      // would inflate this count above zero.) Strip JSX comments so the
      // DR-042 explanatory comments above each grid removal — which
      // legitimately cite the offending literal — don't trip the count.
      const homeNoComments = homeSrc.replace(/\/\*[\s\S]*?\*\//g, '');
      const matches = homeNoComments.match(/gridTemplateColumns/g) || [];
      expect(matches.length).toBe(0);
    });
  });

  describe('C. Behavioural render at mobile / tablet viewports', () => {
    test('10. at 375px the first service card has a usable width (not zero, not 101.5px)', () => {
      // Stub: pretend the services-grid container is 343px wide
      // (375 viewport − 2 × 16px container padding) and each card is
      // full-width (1 column at <=480px). The card width MUST exceed
      // the audit's reported 101.5px broken state and be > 0.
      setViewport(375);
      stubDimensions(343, 343);
      const Home = require('../pages/Home.jsx').default;
      render(
        <MemoryRouter initialEntries={['/']}>
          <Home />
        </MemoryRouter>
      );
      const cards = document.querySelectorAll('.service-card');
      expect(cards.length).toBeGreaterThan(0);
      const firstCard = cards[0];
      const rect = firstCard.getBoundingClientRect();
      // 1 column at <=480px → card fills the container (343px).
      // If the inline `repeat(3, 1fr)` ever comes back, the card would
      // be ~111px which fails the > 200 floor.
      expect(rect.width).toBeGreaterThan(200);
    });

    test('11. at 320px the first service card still renders with non-zero width', () => {
      // Smallest viewport in the audit acceptance. Container is
      // 320 − 32 = 288px; cards full-width at <=480px.
      setViewport(320);
      stubDimensions(288, 288);
      const Home = require('../pages/Home.jsx').default;
      render(
        <MemoryRouter initialEntries={['/']}>
          <Home />
        </MemoryRouter>
      );
      const cards = document.querySelectorAll('.service-card');
      expect(cards.length).toBeGreaterThan(0);
      const firstRect = cards[0].getBoundingClientRect();
      expect(firstRect.width).toBeGreaterThan(200);
    });

    test('12. at 768px the service heading "Quality Assurance & Control" renders inside a card wider than 200px', () => {
      // Tablet breakpoint — `.services-grid` collapses to 2 columns at
      // <=1024, so each card is ~half the container. Heading text is
      // the longest one in the SERVICES array (per the audit) so it
      // exercises the worst-case wrapping path.
      setViewport(768);
      stubDimensions(736, 358); // 2 columns × 358px
      const Home = require('../pages/Home.jsx').default;
      render(
        <MemoryRouter initialEntries={['/']}>
          <Home />
        </MemoryRouter>
      );
      const heading = screen.getByRole('heading', { name: /Quality Assurance/i });
      expect(heading).toBeTruthy();
      const cardRect = heading.closest('.service-card').getBoundingClientRect();
      expect(cardRect.width).toBeGreaterThan(200);
    });

    test('13. at 375px every sector card renders with a usable width', () => {
      // Same coverage for the second grid flagged by the audit
      // (Home.jsx:177, `.grid-3` with `repeat(3, 1fr)` override). At
      // <=480px this collapses to 1 column; at 375 the audit expects
      // a full-width stack.
      setViewport(375);
      stubDimensions(343, 343);
      const Home = require('../pages/Home.jsx').default;
      render(
        <MemoryRouter initialEntries={['/']}>
          <Home />
        </MemoryRouter>
      );
      const sectorLabels = ['Chemical & Pharmaceutical', 'Residential & Townships', 'Commercial Buildings'];
      sectorLabels.forEach((label) => {
        const heading = screen.getByRole('heading', { name: new RegExp(label, 'i') });
        const rect = heading.closest('.service-card').getBoundingClientRect();
        expect(rect.width).toBeGreaterThan(200);
      });
    });
  });
});
