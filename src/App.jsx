import React, { useEffect } from 'react';
import { Routes, Route, useLocation, Navigate } from 'react-router-dom';
import Header from './components/Header.jsx';
import Footer from './components/Footer.jsx';
import ScrollToTop from './components/ScrollToTop.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import PortalLayout from './components/PortalLayout.jsx';
import Home from './pages/Home.jsx';
import About from './pages/About.jsx';
import Projects from './pages/Projects.jsx';
import Contact from './pages/Contact.jsx';
import PortalLogin from './pages/PortalLogin.jsx';
import Attendance from './pages/portal/Attendance.jsx';
import Admin from './pages/portal/Admin.jsx';
import Leave from './pages/portal/Leave.jsx';
import DprSubmit from './pages/portal/DprSubmit.jsx';
import DprList from './pages/portal/DprList.jsx';
import DprDashboard from './pages/admin/DprDashboard.jsx';
import LeaveDashboard from './pages/admin/LeaveDashboard.jsx';
import InspectionSubmit from './pages/portal/InspectionSubmit.jsx';
import InspectionList from './pages/portal/InspectionList.jsx';
import InspectionDetail from './pages/portal/InspectionDetail.jsx';
import InspectionDashboard from './pages/admin/InspectionDashboard.jsx';

function App() {
  const location = useLocation();

  useEffect(() => {
    const els = Array.from(document.querySelectorAll('[data-reveal]'));
    if (!('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('reveal-visible'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('reveal-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 });
    els.forEach((el, i) => {
      el.style.transitionDelay = `${Math.min(i * 60, 360)}ms`;
      io.observe(el);
    });
    return () => io.disconnect();
  }, [location.pathname]);

  return (
    <div className="app">
      <ScrollToTop />
      <Routes>
        {/* Public site */}
        <Route path="/portal/login" element={<PortalLogin />} />
        <Route
          path="/portal/*"
          element={
            <ProtectedRoute>
              <PortalLayout />
            </ProtectedRoute>
          }
        >
          <Route path="attendance" element={<Attendance />} />
          <Route path="admin" element={<Admin />} />
          <Route path="leave" element={<Leave />} />
          <Route path="dpr/submit" element={<DprSubmit />} />
          <Route path="dpr/my" element={<DprList />} />
          <Route path="admin/dpr" element={<DprDashboard />} />
          <Route path="admin/leave" element={<LeaveDashboard />} />
          <Route path="inspection/submit" element={<InspectionSubmit />} />
          <Route path="inspection/my" element={<InspectionList />} />
          <Route path="inspection/:id" element={<InspectionDetail />} />
          <Route path="admin/inspection" element={<InspectionDashboard />} />
          <Route path="training" element={<ComingSoon name="Training" />} />
          <Route path="assets" element={<ComingSoon name="Assets" />} />
          <Route path="" element={<Navigate to="attendance" replace />} />
        </Route>

        {/* Public routes with header/footer */}
        <Route
          path="/*"
          element={
            <>
              <Header />
              <main>
                <Routes>
                  <Route path="/" element={<Home />} />
                  <Route path="/about" element={<About />} />
                  <Route path="/projects" element={<Projects />} />
                  <Route path="/contact" element={<Contact />} />
                  <Route path="*" element={<Home />} />
                </Routes>
              </main>
              <Footer />
            </>
          }
        />
      </Routes>
    </div>
  );
}

// Simple Coming Soon placeholder for stubbed portal pages
function ComingSoon({ name }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: '1rem', textAlign: 'center', padding: '2rem' }}>
      <div style={{ fontSize: '3rem' }}>🚧</div>
      <h2 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '1.5rem', fontWeight: '700', color: 'var(--navy)' }}>
        {name} — Coming Soon
      </h2>
      <p style={{ color: 'var(--steel)', maxWidth: '400px' }}>
        This feature is on our roadmap and will be available in a future update.
      </p>
      <a href="/" style={{ color: 'var(--blue)', fontSize: '0.9rem', textDecoration: 'none' }}>← Back to website</a>
    </div>
  );
}

export default App;
