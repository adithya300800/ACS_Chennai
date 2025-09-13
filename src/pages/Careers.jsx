import React from 'react';

const jobs = [
  {
    title: "Construction Project Manager",
    location: "Chennai, India",
    description: "Oversee construction projects, manage teams, deliver on time and budget."
  },
  {
    title: "React Developer",
    location: "Remote/Chennai",
    description: "Build and scale our VirtualOffice platform with React and modern web tools."
  }
  // Add more jobs as needed
];

export default function Careers() {
  return (
    <section className="section">
      <div className="container">
        <h2>Careers</h2>
        <p>We're hiring! Join our growing team.</p>
        {jobs.map((job, idx) => (
          <div className="job-posting" key={idx}>
            <h3>{job.title}</h3>
            <p><b>Location:</b> {job.location}</p>
            <p>{job.description}</p>
            <a href="/contact" className="apply-btn">Apply Now</a>
          </div>
        ))}
      </div>
    </section>
  );
}