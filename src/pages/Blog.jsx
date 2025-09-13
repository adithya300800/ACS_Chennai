import React from 'react';

const posts = [
  {
    title: "Planning Controls that Stick",
    date: "2025-08-20",
    excerpt: "Practical tips for building schedules that survive real‑world execution.",
    url: "#"
  },
  {
    title: "Quality & Safety—No Compromises",
    date: "2025-08-10",
    excerpt: "How robust ITPs and safety routines reduce rework and risk.",
    url: "#"
  }
  // Add more posts as needed
];

export default function Blog() {
  return (
    <section className="section alt">
      <div className="container">
        <h2 className="section-title reveal" data-reveal>Blog</h2>
        {posts.map((post, idx) => (
          <div className="card blog-post reveal" data-reveal key={idx}>
            <h3>{post.title}</h3>
            <small>{post.date}</small>
            <p>{post.excerpt}</p>
            <a href={post.url}>Read More</a>
          </div>
        ))}
      </div>
    </section>
  );
}
