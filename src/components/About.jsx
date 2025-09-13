import React from "react";

export default function About() {
  return (
    <section id="about" className="py-24 px-4 md:px-16 bg-white text-acsdark">
      <div className="max-w-4xl mx-auto text-center">
        <h2 className="text-4xl font-bold mb-6">About ACS Chennai</h2>
        <p className="text-lg mb-4">
          <b>ACS Chennai</b> is a leading Project Management Consultancy (PMC) specializing in civil engineering. With decades of experience, we deliver comprehensive solutions for infrastructure, commercial, and industrial projects—ensuring technical excellence at every stage.
        </p>
        <img src="/images/about.jpg" alt="Civil Engineering Team" className="rounded-xl mx-auto shadow-lg w-full max-w-lg mt-6"/>
        <p className="mt-6 text-base">
          Our team brings together expertise across planning, execution, monitoring, and delivery, transforming visions into reality with precision and commitment.
        </p>
      </div>
    </section>
  );
}