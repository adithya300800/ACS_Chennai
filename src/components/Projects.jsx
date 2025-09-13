import React from "react";

const projects = [
  {
    name: "Skyline Commercial Towers",
    image: "/images/project1.jpg",
    desc: "PMC for a 25-storey commercial complex, delivering on-time with advanced structural methods."
  },
  {
    name: "Elite Residential Enclave",
    image: "/images/project2.jpg",
    desc: "Managed all phases from foundation to finish for a premium housing project."
  },
  {
    name: "Industrial Logistics Hub",
    image: "/images/project3.jpg",
    desc: "Oversaw large-scale warehouse and logistics park with precision project controls."
  },
];

export default function Projects() {
  return (
    <section id="projects" className="py-24 px-4 md:px-16 bg-white text-acsdark">
      <div className="max-w-5xl mx-auto">
        <h2 className="text-4xl font-bold mb-10 text-center">Key Projects</h2>
        <div className="grid md:grid-cols-3 gap-8">
          {projects.map(({ name, image, desc }) => (
            <div key={name} className="bg-gradient-to-br from-blue-100 to-blue-200 rounded-lg shadow-xl p-6 flex flex-col items-center">
              <img src={image} alt={name} className="rounded-lg w-full h-40 object-cover mb-4"/>
              <h3 className="text-xl font-bold mb-2">{name}</h3>
              <p className="text-base text-center">{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}