import React from 'react';
import { Link, useParams } from 'react-router-dom';

const POSTS = [
  {
    slug: 'construction-schedule-failing',
    title: 'Why Your Construction Schedule Keeps Failing (And What to Do About It)',
    date: '2026-04-15',
    excerpt: 'Most project schedules fail not because of bad tools, but because of how they\'re built and tracked. Here\'s the battle-tested approach we use on every ACS Chennai project.',
    readTime: '6 min read',
    tag: 'Planning',
    content: `Most project schedules fail not because of bad tools, but because of how they're built and tracked. Here's the battle-tested approach we use on every ACS Chennai project.

## The Real Problem With Construction Scheduling

Construction schedules fail at their root — not because a piece of software didn't warn you, but because the person building the schedule didn't have buy-in from the people who actually execute. A schedule is only as good as the information fed into it by site engineers, subcontractors, and procurement teams.

## The ACS Chennai Approach

On every project, we start with a complete Work Breakdown Structure before anyone touches a Gantt chart. Every activity is tied to a responsible party who has signed off on the duration. Floats are calculated not by software defaults but by the specific conditions of your site — soil conditions, monsoon windows, labour availability, and material lead times.

## What We Track

Weekly look-ahead plans are non-negotiable. Every Friday, the site team reviews the next two weeks in detail. Slippages are identified early, not at the monthly review. By the time a delay becomes critical, we've already re-sequenced the work around it.

## S-Curves That Actually Mean Something

We don't produce S-curves for the sake of reporting. Every S-curve we generate is tied to a measurement metric agreed with the client upfront — measured quantity, labour-hours, or equipment-hours. If the curve drifts, we know exactly why before the client asks.`,
  },
  {
    slug: 'qa-qc-that-works',
    title: 'QA/QC That Actually Works on Site: Our ITP Framework',
    date: '2026-03-28',
    excerpt: 'Inspection & Test Plans are often treated as paperwork. We\'ve built a framework that makes them living, enforceable documents that site teams actually use.',
    readTime: '5 min read',
    tag: 'QA/QC',
    content: `Inspection & Test Plans are often treated as paperwork. We've built a framework that makes them living, enforceable documents that site teams actually use.

## Why Traditional ITPs Fail

Most ITPs are written once at project start, printed, signed, filed, and forgotten. They become a compliance exercise rather than a quality management tool. The moment a site condition changes — a material substitution, a method deviation — the ITP is already outdated.

## Our Framework

Each ITP is a living document updated at every project milestone. Pre-activity checklists are reviewed with the contractor before any new work package begins. NCRs (Non-Conformance Reports) are logged, tracked, and closed out in the same system, not in separate spreadsheets.

## What Makes It Different

We tie every inspection hold point to a specific responsible inspector and a specific method statement. Inspections aren't generic — "inspect rebar" becomes "inspect rebar cage dimensions per drawing Rev C, witnessed by QC engineer Rajan, against method statement MS-CIV-004."

This level of specificity eliminates the ambiguity that causes quality failures. When someone asks "was this inspected?", the answer is in the log with the inspector's name, date, and reference document.`,
  },
  {
    slug: 'ra-bills-payment-delays',
    title: 'RA Bills and Payment Delays: How to Fix the Commercial Bottleneck',
    date: '2026-03-10',
    excerpt: 'Delayed RA bills kill contractor relationships and slow down projects. Here\'s how we manage commercial tracking so payments flow on schedule.',
    readTime: '7 min read',
    tag: 'Commercial',
    content: `Delayed RA bills kill contractor relationships and slow down projects. Here's how we manage commercial tracking so payments flow on schedule.

## The Root Cause

Running Account (RA) bills fail at measurement. The contractor does the work, but the measurement is disputed, delayed, or poorly documented. Every disputed line item is a delay in payment. Every delayed payment is a contractor who is less motivated to maintain pace.

## Our Measurement Protocol

We agree on measurement formats before a project starts. Every line item in the BOQ has a defined unit of measurement, a defined measurement method, and a defined documentation standard. Photos are taken at every measurement milestone — not as evidence gathering after the fact, but as a standard part of the measurement process.

## Progress Documentation

Each RA bill cycle has a fixed calendar — work measurement on the 20th, contractor submission by the 25th, our review by the 28th, client submission by the 5th of the following month. These dates are shared with the client at project start and are built into the project schedule. No RA bill surprises.

## Change Order Management

Every change order is documented before the work begins. We don't scope creep and then argue about payment later. If the client wants a variation, we document the cost impact, get approval, and only then proceed. This eliminates the billing disputes that kill commercial relationships.`,
  },
  {
    slug: 'multiple-contractors',
    title: 'Managing Multiple Contractors on a Large Industrial Site',
    date: '2026-02-20',
    excerpt: 'Coordinating civil, mechanical, and electrical contractors on a live industrial site requires a structured approach. Here\'s what works for us after 30+ years.',
    readTime: '8 min read',
    tag: 'Site Management',
    content: `Coordinating civil, mechanical, and electrical contractors on a live industrial site requires a structured approach. Here's what works for us after 30+ years.

## The Coordination Problem

On large industrial projects, you've got three to six contractors operating in the same physical space, often doing work that is sequentially dependent but also partially overlapping. Civil contractors need to complete foundations before mechanical contractors can set equipment. Electrical has to run cable trays before final connections can be made. The sequencing sounds simple on paper — in practice it's a daily negotiation.

## Our Coordination Structure

Every morning we run a short coordination meeting — 20 minutes maximum — with representatives from each active contractor on site. We use a shared daily log. Issues are escalated through a defined chain. No one waits until the weekly review to raise a spatial conflict.

## Space Management

We divide the site into zones. Each zone has a defined primary contractor at any given time. Cross-trade interference is flagged in the weekly look-ahead plan, not discovered on the day. When two contractors need the same space, we pre-sequence the work or add a shift — we don't let them figure it out on the ground.

## Defect Management

When one contractor's work damages another's — and it will — we document it immediately. We don't let defect liability become a blame game that delays repair. The defect is documented, photographed, responsibility is agreed at the coordination meeting, and the repair is scheduled.`,
  },
];

function BlogList() {
  return (
    <section className="section alt">
      <div className="container">
        <div className="section-header">
          <span className="section-eyebrow reveal" data-reveal>Insights</span>
          <h2 className="section-title reveal" data-reveal>The ACS Chennai Blog</h2>
          <p className="section-sub reveal" data-reveal>
            Practical perspectives on construction project management, site quality, commercial tracking, and industrial construction in South India.
          </p>
        </div>

        <div className="grid-2" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
          {POSTS.map((post) => (
            <div className="blog-card reveal" data-reveal key={post.slug}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.8rem' }}>
                <span className="project-tag" style={{ fontSize: '0.68rem' }}>{post.tag}</span>
                <span className="date">{post.date} · {post.readTime}</span>
              </div>
              <h3>{post.title}</h3>
              <p>{post.excerpt}</p>
              <Link to={`/blog/${post.slug}`} className="read-more" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                Read Article
                <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function BlogArticle() {
  const { slug } = useParams();
  const post = POSTS.find((p) => p.slug === slug);

  if (!post) {
    return (
      <section className="section alt">
        <div className="container" style={{ textAlign: 'center', padding: '4rem 0' }}>
          <h2>Article not found</h2>
          <p style={{ color: 'var(--steel)', marginTop: '0.5rem' }}>The article you're looking for doesn't exist.</p>
          <Link to="/blog" className="btn btn-primary" style={{ marginTop: '1.5rem' }}>Back to Blog</Link>
        </div>
      </section>
    );
  }

  return (
    <section className="section alt">
      <div className="container" style={{ maxWidth: '760px' }}>
        <Link to="/blog" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', color: 'var(--steel)', fontSize: '0.88rem', marginBottom: '2rem', textDecoration: 'none' }}>
          <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
          Back to Blog
        </Link>

        <div style={{ marginBottom: '1.2rem' }}>
          <span className="project-tag" style={{ fontSize: '0.68rem', marginRight: '0.8rem' }}>{post.tag}</span>
          <span className="date">{post.date} · {post.readTime}</span>
        </div>

        <h1 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 'clamp(1.8rem, 4vw, 2.4rem)', fontWeight: '800', color: 'var(--navy)', lineHeight: 1.2, marginBottom: '2rem' }}>{post.title}</h1>

        <div style={{ color: 'var(--steel)', lineHeight: 1.8, fontSize: '1.05rem' }}>
          {post.content.split('\n\n').map((para, i) => {
            if (para.startsWith('## ')) return <h2 key={i} style={{ fontSize: '1.3rem', fontWeight: '700', color: 'var(--navy)', marginTop: '2rem', marginBottom: '0.6rem' }}>{para.replace('## ', '')}</h2>;
            return <p key={i} style={{ marginBottom: '1rem' }}>{para}</p>;
          })}
        </div>

        <div style={{ marginTop: '3rem', paddingTop: '2rem', borderTop: '1px solid var(--border)' }}>
          <Link to="/blog" className="btn btn-ghost">More Articles</Link>
        </div>
      </div>
    </section>
  );
}

export default function Blog() {
  const { slug } = useParams();
  if (slug) return <BlogArticle />;
  return <BlogList />;
}
