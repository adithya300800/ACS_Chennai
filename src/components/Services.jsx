import React from "react";

const services = [
  {
    title: "Project Planning & Scheduling",
    image: "/images/service1.jpg",
    desc: "Robust planning, resource allocation, and project scheduling for timely and cost-effective delivery."
  },
  {
    title: "Quality & Safety Management",
    image: "/images/service2.jpg",
    desc: "Strict adherence to quality standards and safety protocols, ensuring compliance and reliability."
  },
  {
    title: "Cost Control & Procurement",
    image: "/images/service3.jpg",
    desc: "Transparent budgeting, effective procurement, and cost tracking for optimized project value."
  },
  {
    title: "Construction Supervision",
    image: "/images/service4.jpg",
    desc: "On-site supervision by experienced engineers for seamless execution and minimal delays."
  },
];

export default function Services() {
  return (
    <section id="services" className="py-24 px-4 md:px-16 bg-gradient-to-b from-white to-blue-50 text-acsdark">
      <div className="max-w-5xl mx-auto">
        <h2 className="text-4xl font-bold mb-10 text-center">Our Services</h2>
        <div className="grid md:grid-cols-2 gap-10">
          {services.map(({ title, image, desc }) => (
            <div key={title} className="bg-white rounded-lg shadow-xl p-8 flex flex-col items-center hover:shadow-2xl transition">
              <img src={image} alt={title} className="w-28 h-28 rounded-full object-cover mb-4 border-2 border-acsblue"/>
              <h3 className="text-2xl font-semibold mb-3">{title}</h3>
              <p className="text-base text-center">{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}