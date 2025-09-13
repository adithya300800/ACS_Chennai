import React from 'react';

export default function About() {
  return (
    <section className="section">
      <div className="container">
        <h2 className="section-title reveal" data-reveal>About ACS Chennai</h2>
        <p className="section-sub reveal" data-reveal>Project Management Consultancy for Civil Engineering Works</p>
        <p className="reveal" data-reveal>
          With 30+ years of industrial experience, we are a Chennai‑based PMC focused on
          delivering civil engineering projects with precision and transparency. Our team
          brings site‑tested processes and modern digital tooling together—so stakeholders
          get predictable schedules, quality, and cost control.
        </p>

        <h3 className="reveal" data-reveal>Technical Profile</h3>
        <ul>
          <li className="reveal" data-reveal><b>Planning & Controls:</b> Work breakdown structures, resource planning, CPM, look‑ahead, S‑curves.</li>
          <li className="reveal" data-reveal><b>QA/QC & Safety:</b> ITPs, method statements, inspection logs, NCR tracking, safety toolbox and audits.</li>
          <li className="reveal" data-reveal><b>Commercials:</b> BOQ validation, progress measurements, RA bills, reconciliations, and change orders.</li>
          <li className="reveal" data-reveal><b>Digital Workflows:</b> Cloud docs, approvals, role‑based access, and automated reporting.</li>
          <li className="reveal" data-reveal><b>Compliance:</b> Material submittals, test reports, and site documentation aligned to standards.</li>
        </ul>

        <img
          src="https://images.unsplash.com/photo-1531834685032-c34bf0d84c77?q=80&w=1400&auto=format&fit=crop"
          alt="Team at construction site"
          className="reveal"
          data-reveal
          style={{ width:'100%', borderRadius:12, marginTop:'1rem', boxShadow:'var(--shadow)'}}
        />
      </div>
    </section>
  );
}
