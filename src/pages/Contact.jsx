import React, { useState } from 'react';

export default function Contact() {
  const [status, setStatus] = useState('idle'); // idle | sending | ok | err
  const [err, setErr] = useState('');
  const FORM_ID = import.meta.env.VITE_FORMSPREE_ID;

  async function handleSubmit(e) {
    e.preventDefault();
    setErr('');
    if (!FORM_ID) {
      setErr('Contact form is not configured. Please set VITE_FORMSPREE_ID.');
      return;
    }
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      setStatus('sending');
      const res = await fetch(`https://formspree.io/f/${FORM_ID}`, {
        method: 'POST',
        headers: { 'Accept': 'application/json' },
        body: new FormData(form)
      });
      if (!res.ok) throw new Error('Failed to send');
      setStatus('ok');
      form.reset();
    } catch (e) {
      setStatus('err');
      setErr('Could not send your message. Please try again later.');
    }
  }

  return (
    <section className="section">
      <div className="container">
        <h2 className="section-title">Contact Us</h2>
        {status === 'ok' ? (
          <p className="muted">Your message has been sent. Thank you!</p>
        ) : (
          <form onSubmit={handleSubmit}>
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
            <div>
              <button type="submit" className="btn btn-primary" disabled={status==='sending' || !FORM_ID}>
                {status==='sending' ? 'Sending…' : 'Send'}
              </button>
            </div>
            {!FORM_ID && (
              <p className="muted" style={{marginTop:'0.6rem'}}>
                To enable the form, set <code>VITE_FORMSPREE_ID</code> in your environment.
              </p>
            )}
            {status==='err' && <p style={{color:'#b91c1c'}}>{err}</p>}
          </form>
        )}
      </div>
    </section>
  );
}
