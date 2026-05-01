import React from 'react';
import { Link } from 'react-router-dom';
import StatsBar from '../components/StatsBar.jsx';

const SERVICES = [
  {
    title: 'Project Management Consultancy',
    desc: 'End-to-end PMC delivery — scoping, WBS development, CPM scheduling, S-curves, look-ahead planning, critical path tracking, and earned value analysis. We manage your project from concept through to handover.',
    icon: (
      <svg width="24" height="24" fill="none" stroke="#0066FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
        <path d="M2 20h20M6 20V10l6-8 6 8v10M10 20v-5h4v5"/>
      </svg>
    ),
  },
  {
    title: 'Quality Assurance & Control',
    desc: 'ITP management, NCR tracking, method statements, and third-party inspections. ISO-aligned QA/QC documentation and independent quality verification for chemical, pharmaceutical, and industrial projects.',
    icon: (
      <svg width="24" height="24" fill="none" stroke="#0066FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
    ),
  },
  {
    title: 'Commercial & Contract Management',
    desc: 'BOQ validation, progress measurements, RA bill processing, cost control, and change order management. Complete commercial management ensuring transparency and financial accuracy on every project.',
    icon: (
      <svg width="24" height="24" fill="none" stroke="#0066FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
        <rect x="2" y="3" width="20" height="14" rx="2"/>
        <path d="M8 21h8M12 17v4"/>
      </svg>
    ),
  },
  {
    title: 'Planning & Scheduling Services',
    desc: 'Detailed project scheduling using industry-standard tools — WBS development, resource allocation, S-curve tracking, and look-ahead plans. Critical path method analysis to ensure on-time delivery.',
    icon: (
      <svg width="24" height="24" fill="none" stroke="#0066FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
        <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>
      </svg>
    ),
  },
  {
    title: 'Safety Management & Auditing',
    desc: 'Safety audit trails, toolbox talks, incident investigation, and PPE compliance documentation. Risk assessment and safety training coordination for site operations meeting statutory requirements.',
    icon: (
      <svg width="24" height="24" fill="none" stroke="#0066FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        <path d="M9 12l2 2 4-4"/>
      </svg>
    ),
  },
  {
    title: 'Billing Verification & Quantity Audit',
    desc: 'Independent quantity verification, billing audit, and financial reconciliation. Transparent RA bill processing and cost control for developers, contractors, and project owners needing credible third-party validation.',
    icon: (
      <svg width="24" height="24" fill="none" stroke="#0066FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
        <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>
      </svg>
    ),
  },
];

const PROCESS = [
  { num: '01', title: 'Scope Definition', desc: 'Project brief development, site survey, feasibility analysis, and scope documentation for industrial, commercial, and residential projects.' },
  { num: '02', title: 'Planning & Scheduling', desc: 'WBS development, scheduling, resource allocation, risk register, and procurement strategy aligned to project timelines.' },
  { num: '03', title: 'Execution & Oversight', desc: 'On-ground supervision, QA/QC, progress tracking, billing management, safety audits, and regular stakeholder reporting.' },
  { num: '04', title: 'Handover & Closure', desc: 'Handover documentation, final billing reconciliation, compliance certificates, and project closure reports.' },
];

const PROJECT_TEASERS = [
  {
    name: 'PMC for Chemical Processing Facility — Cuddalore',
    sector: 'Chemical / PMC',
    desc: 'End-to-end project management consultancy for a major chemical facility — earthworks, structural concrete, process foundations, pipeline routing, and PCPCB compliance documentation.',
    metric: 'Large-Scale Chemical Facility',
    image: '/project-chemical.jpg',
  },
  {
    name: 'PMC for Pharmaceutical Manufacturing Facility — Chennai',
    sector: 'Pharma / PMC',
    desc: 'Full-scope construction PMC for a GMP-certified pharmaceutical plant — civil works, utility installation, cleanroom infrastructure, and regulatory compliance aligned to Schedule II.',
    metric: 'GMP-Certified Pharma Facility',
    image: '/project-pharma.jpg',
  },
];

const SECTORS = [
  { label: 'Chemical & Pharmaceutical', icon: '🏭' },
  { label: 'Residential & Townships', icon: '🏗️' },
  { label: 'Commercial Buildings', icon: '🏬' },
  { label: 'Warehouses & Logistics', icon: '📦' },
  { label: 'Industrial Structures', icon: '⚙️' },
  { label: 'Infrastructure Projects', icon: '🛣️' },
];

export default function Home() {
  return (
    <>
      {/* HERO */}
      <section className="hero">
        <div className="hero-image-wrap">
          <img
            className="hero-img"
            src="/hero-site.jpg"
            alt="Construction site — ACS Chennai project"
          />
          <div className="hero-img-overlay" />
        </div>
        <div className="hero-orb hero-orb-1" />
        <div className="hero-orb hero-orb-2" />
        <div className="hero-content container">
          <div className="hero-eyebrow">
            <span className="dot" />
            Oragadam, Chennai — Serving Pan-India
          </div>
          <h1 className="display-xl">
            Building Tomorrow,<br />
            <span className="accent">Remotely</span> & Reliably.
          </h1>
          <p className="body-lg">
            We are a construction project management consultancy serving chemical, pharmaceutical, residential, and industrial clients across India. From project scoping and scheduling to execution oversight and handover — we deliver every stage with rigour and transparency.
          </p>
          <div className="hero-ctas">
            <Link to="/projects" className="btn btn-primary">
              Our Projects
              <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </Link>
            <Link to="/about" className="btn btn-ghost">
              Who We Are
            </Link>
          </div>
        </div>
      </section>

      {/* STATS BAR */}
      <StatsBar />

      {/* SERVICES */}
      <section className="section alt">
        <div className="container">
          <div className="section-header">
            <span className="section-eyebrow reveal" data-reveal>What We Do</span>
            <h2 className="section-title reveal" data-reveal>Our Core Services</h2>
            <p className="section-sub reveal" data-reveal>
              Six integrated practice areas covering the full construction project lifecycle — from planning and scheduling through to execution oversight, quality control, and commercial management.
            </p>
          </div>
          <div className="services-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            {SERVICES.map((svc) => (
              <div className="service-card reveal" data-reveal key={svc.title}>
                <div className="service-icon">{svc.icon}</div>
                <h3>{svc.title}</h3>
                <p>{svc.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* SECTORS */}
      <section className="section">
        <div className="container">
          <div className="section-header">
            <span className="section-eyebrow reveal" data-reveal>Where We Work</span>
            <h2 className="section-title reveal" data-reveal>Industries We Serve</h2>
            <p className="section-sub reveal" data-reveal>
              Our PMC expertise spans chemical, pharmaceutical, residential, commercial, industrial, and infrastructure projects across Tamil Nadu and South India.
            </p>
          </div>
          <div className="grid-3" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            {SECTORS.map((s) => (
              <div className="service-card reveal" data-reveal key={s.label}>
                <span style={{ fontSize: '2rem', marginBottom: '0.5rem', display: 'block' }}>{s.icon}</span>
                <h4>{s.label}</h4>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ABOUT STRIP */}
      <section className="section alt">
        <div className="container">
          <div className="about-strip">
            <div className="about-strip-img">
              <img
                src="/about-team.jpg"
                alt="ACS Chennai team at project site"
              />
            </div>
            <div className="about-strip-text">
              <span className="section-eyebrow reveal" data-reveal>About ACS Chennai</span>
              <h2 className="section-title reveal" data-reveal>35+ Years of Construction PMC Experience</h2>
              <p className="body-lg reveal" data-reveal>
                Based in Oragadam, Chennai, we serve clients across India on chemical, pharmaceutical, residential, commercial, and industrial projects. From earthworks and structural concrete to plant installation and regulatory compliance — we manage every stage of construction delivery with rigour and transparency.
              </p>
              <p className="body-md reveal" data-reveal style={{ marginTop: '1rem' }}>
                Our team has delivered advisory roles and PMC mandates for leading chemical manufacturers, pharmaceutical companies, real estate developers, data centre operators, and logistics operators across Tamil Nadu and South India.
              </p>
              <div style={{ marginTop: '1.5rem' }}>
                <Link to="/about" className="btn btn-primary">
                  Learn More About Us
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* PROCESS */}
      <section className="section">
        <div className="container">
          <div className="section-header">
            <span className="section-eyebrow reveal" data-reveal>How We Work</span>
            <h2 className="section-title reveal" data-reveal>A Disciplined 4-Step Process</h2>
            <p className="section-sub reveal" data-reveal>
              Every project follows the same battle-tested workflow — from initial scope definition through to final handover and compliance documentation.
            </p>
          </div>
          <div className="process-steps">
            {PROCESS.map((step) => (
              <div className="process-step reveal" data-reveal key={step.num}>
                <div className="process-num">{step.num}</div>
                <h4>{step.title}</h4>
                <p>{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* PROJECTS TEASER */}
      <section className="section alt">
        <div className="container">
          <div className="section-header">
            <span className="section-eyebrow reveal" data-reveal>Our Work</span>
            <h2 className="section-title reveal" data-reveal>Projects We've Delivered</h2>
            <p className="section-sub reveal" data-reveal>
              PMC mandates across chemical, pharmaceutical, commercial, and logistics infrastructure — serving leading developers and industrial clients.
            </p>
          </div>
          <div className="grid-2">
            {PROJECT_TEASERS.map((p) => (
              <div className="project-card reveal" data-reveal key={p.name}>
                <img className="cover" src={p.image} alt={p.name} loading="lazy" />
                <div className="project-card-body">
                  <span className="project-tag">{p.sector}</span>
                  <h3>{p.name}</h3>
                  <p>{p.desc}</p>
                  <div className="project-metric">
                    <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
                    {p.metric}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ textAlign: 'center', marginTop: '2.5rem' }}>
            <Link to="/projects" className="btn btn-ghost">View All Projects</Link>
          </div>
        </div>
      </section>

      {/* CTA BANNER */}
      <section className="section" style={{ background: 'var(--navy)', padding: '4rem 0' }}>
        <div className="container" style={{ textAlign: 'center' }}>
          <span className="section-eyebrow reveal" data-reveal style={{ color: 'var(--amber)' }}>Let's Talk</span>
          <h2 className="section-title reveal" data-reveal style={{ color: '#fff', marginBottom: '1rem' }}>Start a Conversation</h2>
          <p className="body-lg reveal" data-reveal style={{ margin: '0 auto 2rem', maxWidth: '520px', color: 'rgba(255,255,255,0.6)' }}>
            Whether you have a specific project scope or just want to explore options — reach out directly or fill out our project brief form.
          </p>
          <div style={{ display: 'flex', gap: '0.9rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link to="/contact" className="btn btn-amber">
              <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/></svg>
              Get a Quote
            </Link>
            <a href="https://wa.me/919876543210" target="_blank" rel="noopener noreferrer" className="btn btn-ghost" style={{ background: '#fff', color: 'var(--navy)' }}>
              <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.296-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
              WhatsApp Us
            </a>
          </div>
        </div>
      </section>
    </>
  );
}