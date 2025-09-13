import React from 'react';

const posts = [
  {
    title: "Launching VirtualOffice 2.0",
    date: "2025-09-01",
    excerpt: "Our new digital collaboration platform is live, offering SMEs secure email, Zoho WorkDrive integration, and more.",
    url: "#"
  },
  {
    title: "Digital HR Stack Now Available",
    date: "2025-08-15",
    excerpt: "ACS Chennai releases an end-to-end HR onboarding and compliance platform for the construction sector.",
    url: "#"
  }
  // Add more posts as needed
];

export default function Blog() {
  return (
    <section className="section alt">
      <div className="container">
        <h2>Blog</h2>
        {posts.map((post, idx) => (
          <div className="blog-post" key={idx}>
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