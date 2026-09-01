import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';

const JOBS = [
  {
    title: 'Construction Project Manager',
    location: 'Chennai, India',
    type: 'Full-Time',
    description: 'Own end-to-end project delivery — planning, contractor coordination, QA/QC, safety oversight, progress reporting, and stakeholder communication.',
    tags: ['PMC', 'QA/QC', 'Planning', 'Coordination'],
  },
  {
    title: 'Planning Engineer',
    location: 'Chennai, India',
    type: 'Full-Time',
    description: 'Create and manage project schedules, progress tracking, S-curves, look-ahead plans, and analytics dashboards for active construction projects.',
    tags: ['CPM', 'S-Curves', 'Analytics', 'Planning'],
  },
  {
    title: 'React Developer — Internal Tools',
    location: 'Remote / Chennai',
    type: 'Full-Time / Contract',
    description: 'Build internal dashboards, reporting tools, and collaboration platforms using React, Vite, and modern charting libraries.',
    tags: ['React', 'Vite', 'Charts', 'Dashboards'],
  },
];

const BENEFITS = [
  {
    icon: (
      <svg width="24" height="24" fill="none" stroke="#3385FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
    ),
    title: 'Stable Projects',
    desc: 'Long-running infrastructure and digital transformation projects — not temporary gigs.',
  },
  {
    icon: (
      <svg width="24" height="24" fill="none" stroke="#3385FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
    ),
    title: 'Expert Team',
    desc: 'Work alongside 30+ year industry veterans and modern SaaS specialists.',
  },
  {
    icon: (
      <svg width="24" height="24" fill="none" stroke="#3385FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
    ),
    title: 'Real Impact',
    desc: 'Your work directly shapes project outcomes and client operations at scale.',
  },
  {
    icon: (
      <svg width="24" height="24" fill="none" stroke="#3385FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
    ),
    title: 'Work-Life Balance',
    desc: 'Structured hours, remote options, and a culture that respects your time.',
  },
];

function ApplyModal({ job, onClose }) {
  const [form, setForm] = useState({ name: '', email: '', phone: '', linkedin: '', message: '' });
  const [sent, setSent] = useState(false);

  const handleChange = (e) => setForm((f) => ({ ...f, [e.target.name]: e.target.value }));

  const handleSubmit = (e) => {
    e.preventDefault();
    const subject = encodeURIComponent(`Job Application — ${job.title} at ACS Chennai`);
    const body = encodeURIComponent(
      `Name: ${form.name}\nEmail: ${form.email}\nPhone: ${form.phone}\nLinkedIn: ${form.linkedin}\n\nApplying for: ${job.title}\n\nCover note:\n${form.message}`
    );
    window.location.href = `mailto:careers@acschennai.com?subject=${subject}&body=${body}`;
    setSent(true);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(11,25,41,0.6)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem'
    }} onClick={onClose}>
      <div style={{
        background: 'var(--white)', borderRadius: 'var(--radius-lg)',
        padding: '2rem', maxWidth: '560px', width: '100%',
        boxShadow: 'var(--shadow-xl)', position: 'relative'
      }} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} style={{
          position: 'absolute', top: '1rem', right: '1rem',
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--steel)', fontSize: '1.2rem', lineHeight: 1
        }}>
          <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>

        <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: '700', fontSize: '1.1rem', color: 'var(--navy)', marginBottom: '0.25rem' }}>
          Apply for {job.title}
        </h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--steel)', marginBottom: '1.4rem' }}>{job.location} · {job.type}</p>

        {sent ? (
          <div className="form-success">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>
              Email client opened
            </div>
            <p style={{ fontSize: '0.87rem', fontWeight: '400' }}>Please send the email to complete your application. You can also email us directly at <a href="mailto:careers@acschennai.com">careers@acschennai.com</a>.</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="app-name">Full Name *</label>
                <input id="app-name" name="name" type="text" className="form-input" placeholder="Priya Sharma" value={form.name} onChange={handleChange} required />
              </div>
              <div className="form-group">
                <label htmlFor="app-email">Email *</label>
                <input id="app-email" name="email" type="email" className="form-input" placeholder="priya@company.com" value={form.email} onChange={handleChange} required />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="app-phone">Phone</label>
                <input id="app-phone" name="phone" type="tel" className="form-input" placeholder="+91 98xxx xxxxx" value={form.phone} onChange={handleChange} />
              </div>
              <div className="form-group">
                <label htmlFor="app-linkedin">LinkedIn URL</label>
                <input id="app-linkedin" name="linkedin" type="url" className="form-input" placeholder="https://linkedin.com/in/yourprofile" value={form.linkedin} onChange={handleChange} />
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="app-message">Cover Note *</label>
              <textarea id="app-message" name="message" className="form-input" rows="4"
                placeholder="Tell us about your relevant experience, what draws you to this role, and any specific projects you've worked on..."
                value={form.message} onChange={handleChange} required style={{ resize: 'vertical', minHeight: '90px' }} />
            </div>
            <button type="submit" className="btn btn-primary" style={{ justifyContent: 'center', padding: '0.8rem' }}>
              Send Application
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function Careers() {
  useDocumentTitle(
    'Careers',
    'Join ACS Chennai — open roles for engineers, project managers, and site supervisors.'
  );
  const [applyingFor, setApplyingFor] = useState(null);

  return (
    <>
      {applyingFor && <ApplyModal job={applyingFor} onClose={() => setApplyingFor(null)} />}
      <section className="section">
        <div className="container">
          <div className="section-header">
            <span className="section-eyebrow reveal" data-reveal>We're Hiring</span>
            <h2 className="section-title reveal" data-reveal>Join the ACS Chennai Team</h2>
            <p className="section-sub reveal" data-reveal>
              Work on real infrastructure and digital transformation projects with a team that values precision, transparency, and long-term careers.
            </p>
          </div>

          {/* BENEFITS */}
          <div className="grid-4" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1.2rem', marginBottom: '3.5rem' }}>
            {BENEFITS.map((b) => (
              <div className="benefit-card reveal" data-reveal key={b.title}>
                <div style={{ display: 'grid', placeItems: 'center', width: 48, height: 48, background: 'rgba(0,102,255,0.15)', borderRadius: 12, margin: '0 auto' }}>
                  {b.icon}
                </div>
                <h4>{b.title}</h4>
                <p>{b.desc}</p>
              </div>
            ))}
          </div>

          {/* JOBS */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.2rem' }}>
            {JOBS.map((job) => (
              <div className="job-card reveal" data-reveal key={job.title}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.8rem' }}>
                  <div>
                    <h3>{job.title}</h3>
                    <div className="job-location">{job.location} · {job.type}</div>
                    <p style={{ fontSize: '0.9rem', color: 'var(--steel)', margin: '0.6rem 0 0.8rem', lineHeight: 1.6, maxWidth: 600 }}>{job.description}</p>
                    <div className="job-tags">
                      {job.tags.map((t) => <span className="job-tag" key={t}>{t}</span>)}
                    </div>
                  </div>
                  <button onClick={() => setApplyingFor(job)} className="btn btn-primary" style={{ whiteSpace: 'nowrap' }}>Apply Now</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
