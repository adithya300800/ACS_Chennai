import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { api } from '../../lib/api.js';

// Round-25: per-user email notification preferences.
//
// Layout:
//   - Master "Email notifications" switch (kills all sends for this user).
//   - Master "Daily digest" switch + hour picker (8 AM IST default).
//   - One toggle per notification type (11). Grouped by channel: IMMEDIATE
//     first, then DAILY. Per-type mutes are honoured by the backend at
//     dispatch time; the toggle here is a thin UI over NotificationPreference.typeMutes.
//
// State is local — no global store. The page owns the in-flight object
// and PUTs on Save. Cancelled toggle changes are silently dropped on
// navigation. This matches the rest of the portal's "auto-save on change"
// pattern (see Training.jsx for the inverse "explicit save" pattern; we
// picked explicit-save here so a user toggling 11 switches doesn't fire
// 11 PUTs in a row).

const HOURS = Array.from({ length: 24 }, (_, h) => ({
  value: h,
  label: `${String(h).padStart(2, '0')}:00 IST`,
}));

function ToggleRow({ type, label, channel, description, muted, disabled, onToggle }) {
  return (
    <div
      className={`notification-pref-row${disabled ? ' is-disabled' : ''}`}
      data-type={type}
      data-channel={channel}
    >
      <div className="notification-pref-row-text">
        <div className="notification-pref-row-label">
          {label}
          <span className={`notification-pref-channel notification-pref-channel--${channel.toLowerCase()}`}>
            {channel === 'IMMEDIATE' ? 'Immediate' : 'Daily digest'}
          </span>
        </div>
        {description && (
          <div className="notification-pref-row-desc">{description}</div>
        )}
      </div>
      <label className="toggle-switch" aria-label={`Toggle ${label}`}>
        <input
          type="checkbox"
          checked={!muted}
          disabled={disabled}
          onChange={(e) => onToggle(type, !e.target.checked)}
        />
        <span className="toggle-slider" aria-hidden="true" />
      </label>
    </div>
  );
}

export default function NotificationPreferences() {
  useDocumentTitle('Notification preferences');
  // AuthContext exposes `accessToken`, not `token` — destructuring the wrong
  // name silently sends no Authorization header, and `api.js` treats that as a
  // dead session (it 401s and dispatches auth:logout, bouncing the user to
  // /portal/login with "session expired"). Round-25 fix.
  const { accessToken, employee } = useAuth();
  const token = accessToken;
  const { push } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [prefs, setPrefs] = useState({
    emailEnabled: true,
    digestEnabled: true,
    digestHourLocal: 8,
    typeMutes: {},
  });
  const [types, setTypes] = useState([]);

  // Load on mount. The GET returns { preferences, types[] }; we only re-fetch
  // on mount (no polling) — the page is short-lived and edit-in-place.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getNotificationPreferences(token);
        if (cancelled) return;
        setPrefs({
          emailEnabled: res.preferences.emailEnabled,
          digestEnabled: res.preferences.digestEnabled,
          digestHourLocal: res.preferences.digestHourLocal,
          typeMutes: res.preferences.typeMutes || {},
        });
        setTypes(res.types || []);
      } catch (err) {
        if (cancelled) return;
        push(err.message || 'Failed to load preferences', 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Toggle a single type's mute flag. The server stores `typeMutes = { TYPE: true }`
  // where `true` means MUTED — the inverse of the visible switch. Keep that
  // mental model only in this handler; the rest of the page treats the
  // prefs object as the source of truth.
  const handleTypeToggle = useCallback((type, muted) => {
    setPrefs((prev) => {
      const nextMutes = { ...(prev.typeMutes || {}) };
      if (muted) nextMutes[type] = true;
      else delete nextMutes[type];
      return { ...prev, typeMutes: nextMutes };
    });
  }, []);

  // Master switches.
  const handleEmailEnabled = (e) => setPrefs((p) => ({ ...p, emailEnabled: e.target.checked }));
  const handleDigestEnabled = (e) => setPrefs((p) => ({ ...p, digestEnabled: e.target.checked }));
  const handleHourChange = (e) => setPrefs((p) => ({ ...p, digestHourLocal: Number(e.target.value) }));

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.updateNotificationPreferences(prefs, token);
      setPrefs({
        emailEnabled: res.preferences.emailEnabled,
        digestEnabled: res.preferences.digestEnabled,
        digestHourLocal: res.preferences.digestHourLocal,
        typeMutes: res.preferences.typeMutes || {},
      });
      push('Preferences saved', 'success');
    } catch (err) {
      push(err.message || 'Failed to save preferences', 'error');
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    if (!employee?.isAdmin) return;
    setSendingTest(true);
    try {
      const res = await api.sendTestEmail(token);
      push(`Test email sent to ${res.to}`, 'success');
    } catch (err) {
      // 503 with code EMAIL_SEND_FAILED carries the underlying SMTP error;
      // surface it so the operator knows whether it's a credential issue,
      // a network issue, or a recipient-rejection.
      const detail = err.body?.detail || err.message || 'Failed to send test email';
      push(`Test email failed: ${detail}`, 'error');
    } finally {
      setSendingTest(false);
    }
  };

  if (loading) {
    return <div className="notification-pref-page notification-pref-loading">Loading preferences…</div>;
  }

  // Group types: IMMEDIATE first, then DAILY. The server already returns
  // types in this order; we re-sort defensively in case it ever changes.
  const sorted = [...types].sort((a, b) => {
    if (a.channel === b.channel) return 0;
    return a.channel === 'IMMEDIATE' ? -1 : 1;
  });
  const immediateTypes = sorted.filter((t) => t.channel === 'IMMEDIATE');
  const dailyTypes = sorted.filter((t) => t.channel === 'DAILY');

  const emailOff = !prefs.emailEnabled;
  const anyDirty = true; // TODO: dirty tracking — current behavior auto-saves, fine for round 25

  return (
    <div className="notification-pref-page">
      <header className="notification-pref-header">
        <h1>Notification preferences</h1>
        <p className="notification-pref-intro">
          Choose which events trigger an email and when the daily digest lands in your inbox.
          Changes apply to future notifications only — past emails are unaffected.
        </p>
      </header>

      <section className="notification-pref-section" aria-labelledby="pref-masters">
        <h2 id="pref-masters">Master switches</h2>
        <div className="notification-pref-row">
          <div className="notification-pref-row-text">
            <div className="notification-pref-row-label">Email notifications</div>
            <div className="notification-pref-row-desc">
              Master kill switch. When off, the portal will not email you about any
              notification — even those marked Immediate below.
            </div>
          </div>
          <label className="toggle-switch" aria-label="Toggle email notifications">
            <input
              type="checkbox"
              checked={prefs.emailEnabled}
              onChange={handleEmailEnabled}
            />
            <span className="toggle-slider" aria-hidden="true" />
          </label>
        </div>

        <div className="notification-pref-row">
          <div className="notification-pref-row-text">
            <div className="notification-pref-row-label">Daily digest</div>
            <div className="notification-pref-row-desc">
              A single morning email bundling yesterday&rsquo;s non-urgent updates
              (DPR reviews, leave decisions, training progress, etc.).
            </div>
          </div>
          <label className="toggle-switch" aria-label="Toggle daily digest">
            <input
              type="checkbox"
              checked={prefs.digestEnabled}
              onChange={handleDigestEnabled}
              disabled={emailOff}
            />
            <span className="toggle-slider" aria-hidden="true" />
          </label>
        </div>

        <div className={`notification-pref-row${emailOff || !prefs.digestEnabled ? ' is-disabled' : ''}`}>
          <div className="notification-pref-row-text">
            <div className="notification-pref-row-label">Digest delivery hour</div>
            <div className="notification-pref-row-desc">
              Local time (Asia/Kolkata) the digest is delivered. Default is 08:00.
            </div>
          </div>
          <select
            className="notification-pref-hour"
            value={prefs.digestHourLocal}
            onChange={handleHourChange}
            disabled={emailOff || !prefs.digestEnabled}
            aria-label="Digest delivery hour"
          >
            {HOURS.map((h) => (
              <option key={h.value} value={h.value}>{h.label}</option>
            ))}
          </select>
        </div>
      </section>

      <section className="notification-pref-section" aria-labelledby="pref-immediate">
        <h2 id="pref-immediate">Immediate notifications</h2>
        <p className="notification-pref-section-desc">
          These fire a single email the moment the event happens. Turn them off here
          to keep them in the in-app bell only.
        </p>
        {immediateTypes.map((t) => (
          <ToggleRow
            key={t.type}
            type={t.type}
            label={t.label}
            channel={t.channel}
            description={t.description}
            muted={!!prefs.typeMutes?.[t.type]}
            disabled={emailOff}
            onToggle={handleTypeToggle}
          />
        ))}
      </section>

      <section className="notification-pref-section" aria-labelledby="pref-daily">
        <h2 id="pref-daily">Daily digest events</h2>
        <p className="notification-pref-section-desc">
          These roll up into the morning digest. Muted types never appear in the email,
          but you still see them in the in-app bell.
        </p>
        {dailyTypes.map((t) => (
          <ToggleRow
            key={t.type}
            type={t.type}
            label={t.label}
            channel={t.channel}
            description={t.description}
            muted={!!prefs.typeMutes?.[t.type]}
            disabled={emailOff || !prefs.digestEnabled}
            onToggle={handleTypeToggle}
          />
        ))}
      </section>

      {employee?.isAdmin && (
        <section className="notification-pref-section" aria-labelledby="pref-admin">
          <h2 id="pref-admin">Admin: SMTP wire check</h2>
          <p className="notification-pref-section-desc">
            Send a single test email to your own mailbox to verify Resend is
            configured and deliverable. Use this after rotating the API key on
            Render or the Resend dashboard.
          </p>
          <button
            type="button"
            className="btn btn-secondary notification-pref-test-btn"
            onClick={sendTest}
            disabled={sendingTest}
          >
            {sendingTest ? 'Sending…' : 'Send test email to me'}
          </button>
        </section>
      )}

      <div className="notification-pref-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={save}
          disabled={saving || !anyDirty}
        >
          {saving ? 'Saving…' : 'Save preferences'}
        </button>
      </div>
    </div>
  );
}
