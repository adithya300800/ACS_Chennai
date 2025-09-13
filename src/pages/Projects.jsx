import React from 'react';

const PROJECTS = [
  {
    name: 'Skyline Commercial Towers',
    image: 'https://images.unsplash.com/photo-1469474968028-56623f02e42e?q=80&w=1200&auto=format&fit=crop',
    scope: 'PMC, structural supervision, QA/QC, contractor coordination',
  },
  {
    name: 'Elite Residential Enclave',
    image: 'https://images.unsplash.com/photo-1501183638710-841dd1904471?q=80&w=1200&auto=format&fit=crop',
    scope: 'Planning, cost control, finishing QA, handover documentation',
  },
  {
    name: 'Industrial Logistics Hub',
    image: 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?q=80&w=1200&auto=format&fit=crop',
    scope: 'Schedule controls, quality assurance, safety compliance, billing checks',
  },
];

export default function Projects() {
  return (
    <section className="section alt">
      <div className="container">
        <h2 className="section-title reveal" data-reveal>Current Projects</h2>
        <p className="section-sub reveal" data-reveal>Sample portfolio backed by 30+ years of industrial experience</p>
        <div className="grid-cards">
          {PROJECTS.map((p) => (
            <div key={p.name} className="card reveal" data-reveal>
              <img className="cover" src={p.image} alt={p.name} />
              <h3 style={{marginTop:'0.8rem'}}>{p.name}</h3>
              <p className="muted">{p.scope}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
