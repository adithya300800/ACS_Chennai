import React, { useEffect, useRef } from 'react';

function StatItem({ end, suffix, label }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let counted = false;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !counted) {
        counted = true;
        const duration = 1800;
        const start = Date.now();
        const update = () => {
          const elapsed = Date.now() - start;
          const progress = Math.min(elapsed / duration, 1);
          const eased = 1 - Math.pow(1 - progress, 3);
          el.textContent = Math.round(eased * end).toString() + suffix;
          if (progress < 1) requestAnimationFrame(update);
        };
        requestAnimationFrame(update);
      }
    }, { threshold: 0.5 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [end, suffix]);
  return (
    <div className="stat-item">
      <div className="stat-number" ref={ref}>0{suffix}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export default function StatsBar() {
  return (
    <div className="stats-bar">
      <div className="container">
        <div className="stats-grid">
          <StatItem end={35} suffix="+" label="Years Experience" />
          <StatItem end={300} suffix="+" label="Projects Completed" />
          <StatItem end={200} suffix="+" label="Clients Served" />
          <StatItem end={24} suffix="/7" label="Support Available" />
        </div>
      </div>
    </div>
  );
}
