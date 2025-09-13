import React, { useState } from 'react';

export default function Contact() {
  const [sent, setSent] = useState(false);

  return (
    <section className="section">
      <div className="container">
        <h2>Contact Us</h2>
        {sent ? (
          <p>Your message has been sent. Thank you!</p>
        ) : (
        <form 
          action="https://formspree.io/f/yourFormID" 
          method="POST"
          onSubmit={() => setSent(true)}
        >
          <label>
            Name
            <input type="text" name="name" required />
          </label>
          <label>
            Email
            <input type="email" name="email" required />
          </label>
          <label>
            Message
            <textarea name="message" rows={5} required></textarea>
          </label>
          <button type="submit">Send</button>
        </form>
        )}
      </div>
    </section>
  );
}