// DR-041 — /blog/:slug route mounted + unknown-slug intentional fallback.
//
// Bug: src/pages/Blog.jsx renders both list and article view from one
// default export, gated on `useParams().slug`. The article view even
// rendered its own not-found state for unknown slugs. But the only
// route wired up in App.jsx was `<Route path="/blog" element={<Blog />}/>`
// — so clicking a "Read Article" link (to=`/blog/<slug>`) fell through
// to the public `*` route and rendered NotFound. Same shape on reload
// or direct URL: 404.
//
// Fix: mount a second route `<Route path="/blog/:slug" element={<Blog />}/>`
// in App.jsx, with the literal `/blog` route first so HashRouter matches
// the list before the param (same lesson pinned on /training, /projects,
// /admin/drawings, /admin/training). The Blog component itself already
// handles the slug view + unknown-slug fallback; nothing in Blog.jsx
// had to change.
//
// We pin this with two complementary layers:
//   (a) source-text checks against App.jsx that lock the route order
//       AND the unknown-slug fallback inside Blog.jsx (the contract
//       is "in-route not-found", not "404 from the catch-all"). A
//       source-only regression here is exactly the bug the audit
//       flagged (route missing entirely).
//   (b) behavioural tests under MemoryRouter that mount the real
//       Blog component (zero router-graph cost) and exercise the
//       three states the audit called out: list, article (clicked),
//       article (deep-link), and unknown-slug.

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const read = (rel) => readFileSync(resolvePath(__dirname, '..', rel), 'utf8');

const appSrc = read('App.jsx');
const blogSrc = read('pages/Blog.jsx');

// ──── (a) Source-text pins ─────────────────────────────────────────────────

describe('DR-041 — /blog/:slug route (App.jsx wiring)', () => {
  test('App.jsx mounts a literal /blog route BEFORE /blog/:slug (route-order lesson)', () => {
    // HashRouter matches the FIRST matching route. If /blog/:slug came
    // first, the literal /blog would render with :slug="blog" and the
    // article view would render with the "not found" fallback for a
    // legitimate list view. Same lesson pinned on /training,
    // /admin/drawings, /admin/training in App.jsx comments.
    const blogLiteralIdx = appSrc.indexOf('path="/blog"');
    const blogSlugIdx = appSrc.indexOf('path="/blog/:slug"');
    expect(blogLiteralIdx).toBeGreaterThan(-1);
    expect(blogSlugIdx).toBeGreaterThan(-1);
    expect(blogLiteralIdx).toBeLessThan(blogSlugIdx);
  });

  test('App.jsx mounts /blog/:slug alongside /blog (both still render <Blog />)', () => {
    // The Blog component already branches on `useParams().slug` to
    // decide list vs. article. No new component is introduced; the
    // audit's "do not build a new CMS" guidance is honored.
    expect(appSrc).toMatch(/path=["']\/blog\/:slug["'][\s\S]{0,200}element=\{<Blog \/>\}/);
  });

  test('the unknown-slug fallback lives inside Blog.jsx (NOT in the global NotFound)', () => {
    // The audit explicitly says: "an unknown slug still produces an
    // intentional not-found state" — and the in-route fallback must
    // exist so the public-site catch-all `*` does not get hijacked
    // by typo'd /blog/<anything> URLs. Pin the literal BlogArticle
    // branch that returns the "Article not found" copy + a "Back to
    // Blog" link.
    expect(blogSrc).toMatch(/BlogArticle/);
    expect(blogSrc).toMatch(/Article not found/);
    expect(blogSrc).toMatch(/Back to Blog/);
  });

  test('Blog default export branches on useParams().slug (list vs. article)', () => {
    // The list-vs-article switch must live in the default export so
    // both /blog and /blog/:slug pick the correct view from a single
    // mount. A regression that splits the component into two files
    // would re-introduce the "two sources of truth" hazard.
    expect(blogSrc).toMatch(/useParams\(\)/);
    expect(blogSrc).toMatch(/if \(slug\) return <BlogArticle \/>;/);
  });

  test('Blog list cards link to /blog/<slug> (the slug-string Link target)', () => {
    // The list creates <Link to={`/blog/${post.slug}`}> for every card.
    // Pin the template literal so a regression that drops the slug
    // (e.g. to="/blog" hard-coded) fails immediately — that bug was
    // the original audit finding.
    expect(blogSrc).toMatch(/to=\{`\/blog\/\$\{post\.slug\}`\}/);
  });
});

// ──── (b) Behavioural mounts ───────────────────────────────────────────────

// Mount Blog inside a real <MemoryRouter> + Routes so the
// `useParams()` hook has a route to match against. Two routes
// (list + slug) mirror the production wiring in App.jsx.
function mountBlog(initialEntries) {
  // require() inside the helper so the lazy chunk graph in App.jsx
  // doesn't drag in 23 pages of unrelated code (App.test.jsx already
  // documented that this exhausts memory in jsdom).
  const { default: Blog } = require('../pages/Blog.jsx');
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/blog" element={<Blog />} />
        <Route path="/blog/:slug" element={<Blog />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('DR-041 — Blog list page', () => {
  test('renders the list with all four article cards', () => {
    mountBlog(['/blog']);
    expect(screen.getByText('The ACS Chennai Blog')).toBeInTheDocument();
    // At least one card title from POSTS must be visible (slug list
    // is hard-coded in Blog.jsx — pick a stable title).
    expect(screen.getByText(/Why Your Construction Schedule Keeps Failing/)).toBeInTheDocument();
    expect(screen.getAllByText(/Read Article/).length).toBeGreaterThanOrEqual(4);
  });
});

describe('DR-041 — clicking an article opens the slug view', () => {
  test('clicking "Read Article" for a known slug renders the article view', async () => {
    mountBlog(['/blog']);

    // Click the first "Read Article" link — the linked slug is
    // construction-schedule-failing (first card in POSTS).
    const links = screen.getAllByText(/Read Article/);
    fireEvent.click(links[0]);

    // The article view replaces the list; the list heading is gone.
    await waitFor(() => {
      expect(screen.queryByText('The ACS Chennai Blog')).not.toBeInTheDocument();
    });

    // Article view: the h1 carries the post title.
    expect(screen.getByRole('heading', { level: 1, name: /Why Your Construction Schedule Keeps Failing/ })).toBeInTheDocument();
    // The "Back to Blog" affordance exists so the user can return.
    expect(screen.getByText(/Back to Blog/)).toBeInTheDocument();
  });
});

describe('DR-041 — direct navigation (deep-link + reload) to /blog/:slug', () => {
  test('mounting at /blog/:slug directly renders the article view', () => {
    // Simulates the deep-link case: the user pastes a URL or reloads
    // the tab while on an article. The previous behavior (NotFound
    // from the public catch-all) is the bug being fixed.
    mountBlog(['/blog/qa-qc-that-works']);

    // Article view: h1 is the post title.
    expect(screen.getByRole('heading', { level: 1, name: /QA\/QC That Actually Works on Site/ })).toBeInTheDocument();
    // List heading is gone.
    expect(screen.queryByText('The ACS Chennai Blog')).not.toBeInTheDocument();
  });

  test('mounting at /blog/<known-slug> renders a non-empty body section', () => {
    // Extra confidence check: the article body (the prose paragraphs)
    // renders. The list view would have an <h2> "The ACS Chennai Blog"
    // instead.
    mountBlog(['/blog/ra-bills-payment-delays']);
    // The first paragraph from the content body is rendered. Picking
    // a stable string that appears in POSTS[2].content.
    expect(screen.getByText(/Delayed RA bills kill contractor relationships/)).toBeInTheDocument();
  });
});

describe('DR-041 — unknown slug renders the intentional in-route fallback', () => {
  test('an unknown slug shows the BlogArticle not-found copy, NOT the public NotFound', () => {
    mountBlog(['/blog/this-slug-does-not-exist']);

    // The intentional in-route fallback:
    expect(screen.getByText(/Article not found/)).toBeInTheDocument();
    // Recovery link is present (audit acceptance: "Back to blog" link).
    const backLink = screen.getByText(/Back to Blog/);
    expect(backLink).toBeInTheDocument();
    expect(backLink.closest('a')).toHaveAttribute('href', '/blog');

    // And the public 404 ("Page not found") MUST NOT have rendered —
    // that would mean the unknown slug fell through to the catch-all.
    expect(screen.queryByText(/Page not found/i)).not.toBeInTheDocument();
  });

  test('clicking "Back to Blog" from the unknown-slug state returns to the list', () => {
    mountBlog(['/blog/garbage-slug']);
    const backLink = screen.getByText(/Back to Blog/);
    fireEvent.click(backLink.closest('a'));

    // List view comes back: the heading is back, the not-found copy
    // is gone.
    return waitFor(() => {
      expect(screen.getByText('The ACS Chennai Blog')).toBeInTheDocument();
      expect(screen.queryByText(/Article not found/)).not.toBeInTheDocument();
    });
  });
});
