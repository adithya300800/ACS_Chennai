import React from 'react';
import { Link } from 'react-router-dom';

const PROJECTS = [
  {
    name: 'PMC for Chemical Manufacturing Facility — Cuddalore',
    sector: 'Chemical / PMC',
    desc: 'End-to-end project management consultancy for a chemical manufacturing facility in Cuddalore — earthworks, structural concrete, process equipment foundations, pipeline routing, and Pollution Control Board compliance documentation.',
    metric: 'Large-Scale Chemical Facility',
    metricLabel: 'Project Type',
    image: './project-chemical.jpg',
  },
  {
    name: 'PMC for Pharmaceutical Manufacturing Facility — Chennai',
    sector: 'Pharma / PMC',
    desc: 'Full-scope construction PMC for a GMP-certified pharmaceutical plant — civil structural works, utility installation, cleanroom infrastructure, and regulatory compliance aligned to Schedule II and ISO standards.',
    metric: 'GMP-Certified Pharma Facility',
    metricLabel: 'Project Type',
    image: './project-pharma.jpg',
  },
  {
    name: 'Quantity Verification & Billing Audit — Leading Developer',
    sector: 'Commercial / QA',
    desc: 'Independent quantity verification and billing audit for a major residential township development — RA bill processing, cost control, reconciliation, and change order management ensuring financial transparency.',
    metric: 'Large-Scale Billing Audit',
    metricLabel: 'Project Type',
    image: './project-logistics.jpg',
  },
  {
    name: 'PMC for Data Centre Facility — Bangalore',
    sector: 'Industrial / PMC',
    desc: 'Construction project management for a data centre facility — civil works, electrical infrastructure, cooling systems, and peripheral development with strict timeline adherence and quality standards.',
    metric: 'Data Centre Infrastructure',
    metricLabel: 'Project Type',
    image: './project-chemical.jpg',
  },
  {
    name: 'Procurement Advisory — Religious Infrastructure Project, Bangalore',
    sector: 'Advisory / Procurement',
    desc: 'Procurement advisory role for a multi-level prayer hall construction — procurement strategy, vendor coordination, cost optimization, and quality assurance for religious infrastructure.',
    metric: 'Cultural Infrastructure',
    metricLabel: 'Project Type',
    image: './project-pharma.jpg',
  },
  {
    name: 'Cost Estimation for Multi-Tower Residential Development — Chennai',
    sector: 'Residential / PMC',
    desc: 'Comprehensive cost estimation for a multi-tower residential complex — detailed BOQ validation, progress measurements, cost control, and financial reconciliation for large-scale housing project.',
    metric: 'Multi-Tower Residential Complex',
    metricLabel: 'Project Type',
    image: './project-logistics.jpg',
  },
  {
    name: 'Independent Quality Monitoring — Warehouse Development',
    sector: 'Logistics / QA',
    desc: 'Independent quality audit service for warehouse development — QA/QC inspection, method statement review, safety audit trails, and compliance documentation for logistics infrastructure.',
    metric: 'Independent Quality Audit',
    metricLabel: 'Project Type',
    image: './project-chemical.jpg',
  },
];

export default function Projects() {
  return (
    <section className="section alt">
      <div className="container">
        <div className="section-header">
          <span className="section-eyebrow reveal" data-reveal>Our Work</span>
          <h2 className="section-title reveal" data-reveal>Projects We've Delivered</h2>
          <p className="section-sub reveal" data-reveal>
            PMC mandates across chemical, pharmaceutical, residential, commercial, and industrial construction — serving leading developers and industrial clients across Tamil Nadu and South India.
          </p>
        </div>

        <div className="grid-2" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
          {PROJECTS.map((p) => (
            <div className="project-card reveal" data-reveal key={p.name}>
              <img className="cover" src={p.image} alt={p.name} loading="lazy" />
              <div className="project-card-body">
                <span className="project-tag">{p.sector}</span>
                <h3>{p.name}</h3>
                <p>{p.desc}</p>
                <div className="project-metric">
                  <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
                  {p.metric} — {p.metricLabel}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ textAlign: 'center', marginTop: '3rem' }}>
          <p className="body-md muted reveal" data-reveal style={{ marginBottom: '1.2rem' }}>
            Have a project in mind? Let's discuss how we can help.
          </p>
          <Link to="/contact" className="btn btn-primary">Start a Conversation</Link>
        </div>
      </div>
    </section>
  );
}