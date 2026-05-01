import React, { useState } from 'react';
import { Resend } from 'resend';

const resend = new Resend(import.meta.env.VITE_RESEND_API_KEY);

export default function Contact() {
  const [form, setForm] = useState({
    name: '',
    company: '',
    email: '',
    phone: '',
    projectType: '',
    message: '',
  });
  const [status, setStatus] = useState('idle'); // 'idle' | 'loading' | 'success' | 'error'

  const handleChange = (e) => {
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setStatus('loading');

    try {
      const { data, error } = await resend.emails.send({
        from: 'ACS Chennai <onboarding@resend.dev>',
        to: ['info@acschennai.com'],
        subject: `Project Enquiry${form.projectType ? ` — ${form.projectType}` : ''} from ${form.name}`,
        html: `
          <h2>New Project Enquiry</h2>
          <p><strong>Name:</strong> ${form.name}</p>
          <p><strong>Company:</strong> ${form.company || 'N/A'}</p>
          <p><strong>Email:</strong> ${form.email}</p>
          <p><strong>Phone:</strong> ${form.phone || 'N/A'}</p>
          <p><strong>Project Type:</strong> ${form.projectType || 'Not specified'}</p>
          <hr />
          <p><strong>Message:</strong></p>
          <p>${form.message.replace(/\n/g, '<br/>')}</p>
        `,
        reply_to: form.email,
      });

      if (error) {
        throw new Error(error.message || 'Failed to send email');
      }

      setStatus('success');
      setForm({ name: '', company: '', email: '', phone: '', projectType: '', message: '' });
    } catch (err) {
      setStatus('error');
      console.error('Email send error:', err);
    }
  };

  return (
    <section className="section alt">
      <div className="container">
        <div className="section-header">
          <span className="section-eyebrow reveal" data-reveal>Get In Touch</span>
          <h2 className="section-title reveal" data-reveal>Let's Talk About Your Project</h2>
          <p className="section-sub reveal" data-reveal>
            Fill out the form below or reach us directly — we respond within 24 hours on business days.
          </p>
        </div>

        <div className="contact-split">
          {/* LEFT — Contact info cards */}
          <div className="reveal" data-reveal>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.2rem' }}>
              {/* Phone */}
              <div className="contact-card">
                <div className="contact-icon-wrap" style={{ background: 'rgba(0,102,255,0.08)' }}>
                  <svg width="20" height="20" fill="none" stroke="#0066FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/>
                  </svg>
                </div>
                <div>
                  <div className="contact-card-label">Phone</div>
                  <div className="contact-card-value">+91 6382 591 110</div>
                  <div className="contact-card-sub">Mon–Sat, 9am–6pm IST</div>
                </div>
              </div>

              {/* Mobile / WhatsApp */}
              <div className="contact-card">
                <div className="contact-icon-wrap" style={{ background: 'rgba(37,211,102,0.1)' }}>
                  <svg width="20" height="20" fill="none" stroke="#25D366" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/>
                  </svg>
                </div>
                <div>
                  <div className="contact-card-label">WhatsApp</div>
                  <div className="contact-card-value">+91 6382 591 110</div>
                  <div className="contact-card-sub">Quick responses, share documents directly</div>
                </div>
              </div>

              {/* Email */}
              <div className="contact-card">
                <div className="contact-icon-wrap" style={{ background: 'rgba(0,102,255,0.08)' }}>
                  <svg width="20" height="20" fill="none" stroke="#0066FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                    <path d="M22 6l-10 7L2 6"/>
                  </svg>
                </div>
                <div>
                  <div className="contact-card-label">Email</div>
                  <div className="contact-card-value">info@acschennai.com</div>
                  <div className="contact-card-sub">For project enquiries and proposals</div>
                </div>
              </div>

              {/* Office address */}
              <div className="contact-card">
                <div className="contact-icon-wrap" style={{ background: 'rgba(0,102,255,0.08)' }}>
                  <svg width="20" height="20" fill="none" stroke="#0066FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/>
                    <circle cx="12" cy="10" r="3"/>
                  </svg>
                </div>
                <div>
                  <div className="contact-card-label">Office</div>
                  <div className="contact-card-value">Oragadam, Sriperumbudur Taluk,<br />Chennai, Tamil Nadu 602105, India</div>
                </div>
              </div>
            </div>

            {/* Big WhatsApp CTA */}
            <div style={{ marginTop: '1.5rem' }}>
              <a
                href="https://wa.me/916382591110"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-amber"
                style={{ width: '100%', justifyContent: 'center', fontSize: '1rem', padding: '0.9rem 1.5rem' }}
              >
                <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.296-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                </svg>
                Message Us on WhatsApp
              </a>
            </div>
          </div>

          {/* RIGHT — Inquiry form */}
          <div className="reveal" data-reveal>
            <div style={{ background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '2rem', boxShadow: 'var(--shadow-md)' }}>
              <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: '700', fontSize: '1.15rem', color: 'var(--navy)', marginBottom: '0.3rem' }}>
                Send a Project Brief
              </h3>
              <p style={{ fontSize: '0.88rem', color: 'var(--steel)', marginBottom: '1.5rem' }}>
                Tell us about your project and we'll get back within 24 hours.
              </p>

              {status === 'success' ? (
                <div className="form-success">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    <svg width="18" height="18" fill="none" stroke="#16A34A" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>
                    Enquiry sent successfully!
                  </div>
                  <p style={{ fontSize: '0.87rem', fontWeight: '400', color: '#16A34A' }}>We've received your message and will get back to you within 24 hours on business days.</p>
                </div>
              ) : status === 'error' ? (
                <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12, padding: '1.2rem', marginBottom: '0.5rem' }}>
                  <p style={{ fontSize: '0.87rem', color: '#DC2626', fontWeight: '600', marginBottom: '0.3rem' }}>Failed to send message.</p>
                  <p style={{ fontSize: '0.82rem', color: '#991B1B' }}>Please try again or reach us directly via phone or WhatsApp.</p>
                </div>
              ) : (
                <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="name">Full Name *</label>
                      <input
                        id="name"
                        name="name"
                        type="text"
                        className="form-input"
                        placeholder="Rajesh Kumar"
                        value={form.name}
                        onChange={handleChange}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="company">Company / Organisation</label>
                      <input
                        id="company"
                        name="company"
                        type="text"
                        className="form-input"
                        placeholder="Kumar Infrastructure Pvt Ltd"
                        value={form.company}
                        onChange={handleChange}
                      />
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="email">Email Address *</label>
                      <input
                        id="email"
                        name="email"
                        type="email"
                        className="form-input"
                        placeholder="rajesh@kumarinfra.com"
                        value={form.email}
                        onChange={handleChange}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="phone">Phone Number</label>
                      <input
                        id="phone"
                        name="phone"
                        type="tel"
                        className="form-input"
                        placeholder="+91 98xxx xxxxx"
                        value={form.phone}
                        onChange={handleChange}
                      />
                    </div>
                  </div>
                  <div className="form-group">
                    <label htmlFor="projectType">Project Type</label>
                    <select
                      id="projectType"
                      name="projectType"
                      className="form-input"
                      value={form.projectType}
                      onChange={handleChange}
                    >
                      <option value="">Select a project type</option>
                      <option value="PMC / Project Management Consultancy">PMC / Project Management Consultancy</option>
                      <option value="Chemical / Pharmaceutical Facility">Chemical / Pharmaceutical Facility</option>
                      <option value="Residential / Township Development">Residential / Township Development</option>
                      <option value="Commercial Complex">Commercial Complex</option>
                      <option value="Warehouse / Logistics Infrastructure">Warehouse / Logistics Infrastructure</option>
                      <option value="Industrial Structure / Factory">Industrial Structure / Factory</option>
                      <option value="Quantity Verification & Billing Audit">Quantity Verification & Billing Audit</option>
                      <option value="QA/QC Consulting">QA/QC Consulting</option>
                      <option value="Planning & Scheduling Services">Planning & Scheduling Services</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label htmlFor="message">Project Brief *</label>
                    <textarea
                      id="message"
                      name="message"
                      className="form-input"
                      rows="4"
                      placeholder="Describe your project — location, scope, current stage, estimated value, and any specific requirements..."
                      value={form.message}
                      onChange={handleChange}
                      required
                      style={{ resize: 'vertical', minHeight: '100px' }}
                    />
                  </div>
                  <button type="submit" className="btn btn-primary" style={{ justifyContent: 'center', padding: '0.85rem' }} disabled={status === 'loading'}>
                    {status === 'loading' ? 'Sending...' : (
                      <>
                        <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0 2-.9 2-2V6c0-1.1.9-2 2-2z"/><path d="M22 6l-10 7L2 6"/></svg>
                        Send Enquiry
                      </>
                    )}
                  </button>
                </form>
              )}
            </div>

            <div style={{ marginTop: '1.2rem', background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 'var(--radius-lg)', padding: '1.3rem', textAlign: 'center' }}>
              <div style={{ fontSize: '0.82rem', fontWeight: '700', color: 'var(--amber)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.4rem' }}>
                Preferred Response Time
              </div>
              <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: '800', fontSize: '1.4rem', color: 'var(--navy)' }}>
                Within 24 Hours
              </div>
              <div style={{ fontSize: '0.82rem', color: 'var(--steel)', marginTop: '0.3rem' }}>
                on business days (Mon–Sat, 9am–6pm IST)
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
