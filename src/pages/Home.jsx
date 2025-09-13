import React from 'react';
import { Link } from 'react-router-dom';

const DEFAULT_POSTER =
  'https://images.unsplash.com/photo-1504307651254-35680f356dfd?q=80&w=1600&auto=format&fit=crop';

const PLANNING_IMG =
  'https://images.unsplash.com/photo-1517976487492-576ea67a69a1?ixlib=rb-4.0.3&auto=format&fit=crop&w=1200&q=80';
const PLANNING_FALLBACK =
  'https://images.unsplash.com/photo-1503387762-592deb58ef4e?ixlib=rb-4.0.3&auto=format&fit=crop&w=1200&q=80';

export default function Home() {
  const videoUrl = import.meta.env.VITE_HERO_VIDEO_URL;
  const posterUrl = import.meta.env.VITE_HERO_POSTER_URL || DEFAULT_POSTER;

  return (
    <>
      <section className="hero-modern">
        {videoUrl ? (
          <video
            className="hero-media"
            src={videoUrl}
            poster={posterUrl}
            autoPlay
            muted
            loop
            playsInline
          />
        ) : (
          <img className="hero-media" src={posterUrl} alt="Construction hero" />
        )}
        <div className="hero-overlay" />
        <div className="orb orb1" />
        <div className="orb orb2" />
        <div className="hero-content container">
          <h2 className="hero-title">ACS Chennai — Project Management Consultancy</h2>
          <p className="hero-text">
            Bringing 30+ years of industrial experience to deliver end‑to‑end PMC for
            civil engineering projects: planning, scheduling, cost control, QA/QC,
            safety, and site supervision — powered by modern digital workflows and
            real‑time reporting.
          </p>
          <div className="btn-row">
            <Link to="/projects" className="btn btn-primary">View Projects</Link>
            <Link to="/contact" className="btn btn-ghost">Request Consultation</Link>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <h2 className="section-title reveal" data-reveal>What We Do</h2>
          <p className="section-sub reveal" data-reveal>Technical oversight across the full project lifecycle</p>
          <div className="grid-cards">
            <div className="card reveal" data-reveal>
              <img
                className="cover"
                src={PLANNING_IMG}
                alt="Planning and scheduling"
                referrerPolicy="no-referrer"
                onError={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = PLANNING_FALLBACK; }}
              />
              <h3>Planning & Scheduling</h3>
              <p className="muted">Baseline creation, resource planning, look‑ahead schedules, and progress tracking with critical‑path control.</p>
            </div>
            <div className="card reveal" data-reveal>
              <img className="cover" src="https://images.unsplash.com/photo-1512428559087-560fa5ceab42?q=80&w=1200&auto=format&fit=crop" alt="Quality and safety" />
              <h3>Quality & Safety</h3>
              <p className="muted">QA/QC procedures, ITPs, material approvals, and safety audits aligned to project and regulatory standards.</p>
            </div>
            <div className="card reveal" data-reveal>
              <img className="cover" src="https://images.unsplash.com/photo-1519389950473-47ba0277781c?q=80&w=1200&auto=format&fit=crop" alt="Cost and reporting" />
              <h3>Cost & Reporting</h3>
              <p className="muted">BOQ validations, cost control, contractor billing checks, and clear dashboards for stakeholders.</p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
