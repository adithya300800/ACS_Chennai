import React from 'react';
import { Link } from 'react-router-dom';

const DIFFERENTIATORS = [
  '35+ years of construction PMC experience across chemical, pharmaceutical, residential, and industrial projects.',
  'Full project lifecycle delivery — from scope definition and scheduling through to execution oversight and handover.',
  'ISO-aligned QA/QC documentation and safety audit trails on every project.',
  'Transparent progress reporting — S-curves, earned value analysis, and critical path tracking.',
  'Independent billing verification and quantity audit for developers, contractors, and project owners.',
  'Deep expertise in Tamil Nadu and South Indian industrial development with regulatory compliance knowledge.',
  'PMC mandates for leading chemical manufacturers, pharmaceutical companies, and real estate developers.',
];

const CAPABILITIES = [
  { title: 'Project Management Consultancy', desc: 'End-to-end PMC delivery — WBS development, CPM scheduling, S-curves, look-ahead planning, critical path tracking, and earned value analysis for projects of any scale.' },
  { title: 'Quality Assurance & Control', desc: 'ITP management, NCR tracking, method statements, third-party inspections, and ISO-aligned documentation for chemical, pharma, and industrial projects.' },
  { title: 'Commercial & Contract Management', desc: 'BOQ validation, progress measurements, RA bills, cost control, reconciliation, and change order management for fair and transparent billing.' },
  { title: 'Planning & Scheduling Services', desc: 'Detailed project scheduling using industry-standard tools — resource allocation, S-curve tracking, and look-ahead plans to ensure on-time delivery.' },
  { title: 'Safety Management & Auditing', desc: 'Safety audit trails, toolbox talks, incident investigation, PPE compliance, and safety training coordination meeting statutory requirements.' },
  { title: 'Regulatory & Compliance', desc: 'Pollution Control Board, GMP, Schedule II documentation, and environmental compliance for pharma and chemical projects across Tamil Nadu.' },
];

const TEAM_INFO = [
  { label: 'Based In', value: 'Oragadam, Chennai' },
  { label: 'Experience', value: '35+ Years' },
  { label: 'Coverage', value: 'Pan-India' },
  { label: 'Projects', value: '300+' },
];

export default function About() {
  return (
    <section className="section">
      <div className="container">
        {/* HEADER */}
        <div className="section-header">
          <span className="section-eyebrow reveal" data-reveal>About Us</span>
          <h2 className="section-title reveal" data-reveal>Who We Are</h2>
          <p className="section-sub reveal" data-reveal>
            Construction project management consultancy based in Oragadam, Chennai. Serving chemical, pharmaceutical, residential, and industrial clients across India with end-to-end PMC delivery.
          </p>
        </div>

        {/* MAIN GRID */}
        <div className="about-grid">
          <div>
            <p className="body-lg reveal" data-reveal style={{ marginBottom: '1.5rem' }}>
              With <strong style={{ color: 'var(--amber)' }}>35+ years of experience</strong>, ACS Chennai delivers construction project management consultancy across the full project lifecycle. We manage civil engineering and industrial projects from concept through to handover — with a focus on quality, safety, schedule, and cost control at every stage.
            </p>
            <p className="body-md reveal" data-reveal style={{ marginBottom: '2rem' }}>
              Based in Oragadam, Chennai, we have delivered advisory roles and PMC mandates for leading chemical manufacturers, pharmaceutical companies, real estate developers, data centre operators, and logistics operators across Tamil Nadu and South India. Our team brings site-tested processes and hands-on expertise to every engagement.
            </p>
            <ul className="check-list">
              {DIFFERENTIATORS.map((d) => (
                <li className="reveal" data-reveal key={d}>
                  <div className="check-icon">
                    <svg width="10" height="10" fill="none" stroke="#0066FF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>
                  </div>
                  {d}
                </li>
              ))}
            </ul>
            <div className="trust-badges reveal" data-reveal>
              <span className="trust-badge">
                <svg width="12" height="12" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                ISO Compliant
              </span>
              <span className="trust-badge">
                <svg width="12" height="12" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                PCBF Compliant
              </span>
              <span className="trust-badge">
                <svg width="12" height="12" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                GMP Ready
              </span>
            </div>
          </div>

          <div className="reveal" data-reveal>
            <img
              src="./about-team.jpg"
              alt="ACS Chennai team at project site"
              style={{ width: '100%', borderRadius: 16, boxShadow: 'var(--shadow-lg)' }}
            />
            <div style={{ marginTop: '1.5rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              {TEAM_INFO.map((item) => (
                <div key={item.label} style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid var(--border)', borderRadius: 12, padding: '0.9rem' }}>
                  <div style={{ fontSize: '0.72rem', color: 'var(--steel)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.25rem' }}>{item.label}</div>
                  <div style={{ fontWeight: '700', color: 'var(--navy)', fontSize: '0.9rem' }}>{item.value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* CAPABILITIES */}
        <div style={{ marginTop: '4rem' }}>
          <div className="section-header">
            <span className="section-eyebrow reveal" data-reveal>Capabilities</span>
            <h2 className="section-title reveal" data-reveal>What We Bring to Every Project</h2>
          </div>
          <div className="grid-3">
            {CAPABILITIES.map((cap) => (
              <div className="service-card reveal" data-reveal key={cap.title}>
                <h3 style={{ fontSize: '1rem' }}>{cap.title}</h3>
                <p style={{ fontSize: '0.88rem' }}>{cap.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* CTA */}
        <div style={{ textAlign: 'center', marginTop: '3.5rem' }}>
          <p className="body-lg reveal" data-reveal style={{ marginBottom: '1.5rem' }}>
            Ready to see what 35+ years of construction PMC experience looks like in practice?
          </p>
          <div style={{ display: 'flex', gap: '0.9rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link to="/projects" className="btn btn-primary">View Our Projects</Link>
            <Link to="/contact" className="btn btn-ghost">Talk to Us</Link>
          </div>
        </div>
      </div>
    </section>
  );
}