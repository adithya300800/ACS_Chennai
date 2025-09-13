import React from 'react';

const members = [
  { name: "Adithya Mohanavel", role: "Founder & CEO", bio: "Expert in construction & tech." },
  { name: "Nisha K", role: "Operations Manager", bio: "Ensures smooth execution of all projects." },
  { name: "Rahul S", role: "Lead Developer", bio: "Architects our digital platforms and apps." }
  // Add more members as needed
];

export default function Team() {
  return (
    <section className="section alt">
      <div className="container">
        <h2>Our Team</h2>
        <div className="team-list">
          {members.map((m, idx) => (
            <div key={idx} className="team-member">
              <h3>{m.name}</h3>
              <p><b>{m.role}</b></p>
              <p>{m.bio}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}