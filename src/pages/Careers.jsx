import React from 'react';

const jobs = [
  {
    title: "Construction Project Manager",
    location: "Chennai, India",
    description: "Own project delivery—planning, contractor coordination, QA/QC, safety, and reporting.",
    tags: ["PMC", "Coordination", "QA/QC"],
  },
  {
    title: "Planning Engineer",
    location: "Chennai, India",
    description: "Create and manage schedules, progress tracking, S‑curves, and analytics.",
    tags: ["Planning", "CPM", "Analytics"],
  },
  {
    title: "React Developer",
    location: "Remote / Chennai",
    description: "Build internal dashboards and reporting tools to streamline our delivery.",
    tags: ["React", "Vite", "Charts"],
  }
  // Add more jobs as needed
];

export default function Careers() {
  return (
    <section className="section">
      <div className="container">
        <h2 className="section-title reveal" data-reveal>Careers</h2>
        <p className="section-sub reveal" data-reveal>Join a team with 30+ years of industrial experience</p>
        {jobs.map((job, idx) => (
          <div className="card job-posting reveal" data-reveal key={idx}>
            <h3>{job.title}</h3>
            <p className="muted"><b>Location:</b> {job.location}</p>
            <p>{job.description}</p>
            {job.tags && (
              <p className="muted">{job.tags.map((t) => `#${t}`).join(' ')}</p>
            )}
            <a href="#/contact" className="btn btn-primary" style={{marginTop:'.5rem'}}>Apply Now</a>
          </div>
        ))}
      </div>
    </section>
  );
}
