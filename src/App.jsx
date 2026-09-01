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
import Blog from './pages/Blog.jsx';
import Careers from './pages/Careers.jsx';
import NotFound from './pages/NotFound.jsx';
import PortalLogin from './pages/PortalLogin.jsx';
import Attendance from './pages/portal/Attendance.jsx';
import AdminOverview from './pages/admin/AdminOverview.jsx';
import AdminAttendance from './pages/portal/Admin.jsx'; // renamed semantically; kept file path stable
import Leave from './pages/portal/Leave.jsx';
import DprSubmit from './pages/portal/DprSubmit.jsx';
import DprList from './pages/portal/DprList.jsx';
import DprDashboard from './pages/admin/DprDashboard.jsx';
import LeaveDashboard from './pages/admin/LeaveDashboard.jsx';
import InspectionSubmit from './pages/portal/InspectionSubmit.jsx';
import InspectionList from './pages/portal/InspectionList.jsx';
import InspectionAll from './pages/portal/InspectionAll.jsx';
import InspectionDetail from './pages/portal/InspectionDetail.jsx';
import InspectionDashboard from './pages/admin/InspectionDashboard.jsx';
import Training from './pages/portal/Training.jsx';
import TrainingDetail from './pages/portal/TrainingDetail.jsx';
import TrainingDashboard from './pages/admin/TrainingDashboard.jsx';
import TrainingCourseNew from './pages/admin/TrainingCourseNew.jsx';
// Round-17 C-14: shared Coming Soon placeholder (was inline in App.jsx).
import ComingSoon from './components/ComingSoon.jsx';

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
          {/* /portal/admin = new overview hub (A-01). /portal/admin/attendance
              keeps the org-wide attendance grid so the existing
              "All Attendance" tile and admin nav item still have a target. */}
          <Route path="admin" element={<AdminOverview />} />
          <Route path="admin/attendance" element={<AdminAttendance />} />
          <Route path="leave" element={<Leave />} />
          <Route path="dpr/submit" element={<DprSubmit />} />
          <Route path="dpr/my" element={<DprList />} />
          <Route path="admin/dpr" element={<DprDashboard />} />
          <Route path="admin/leave" element={<LeaveDashboard />} />
          <Route path="inspection/submit" element={<InspectionSubmit />} />
          <Route path="inspection/my" element={<InspectionList />} />
          {/* A-13: dead link /portal/inspection/all (rendered for admins from
              InspectionList.jsx) now resolves to a real cross-org list. */}
          <Route path="inspection/all" element={<InspectionAll />} />
          <Route path="inspection/:id" element={<InspectionDetail />} />
          <Route path="admin/inspection" element={<InspectionDashboard />} />
          {/* Round-14: Employee Training — employee hub, player page, and admin views.
              /training            = employee "My Learning" hub
              /training/:id        = single-course player page (employee owner only)
              /admin/training      = admin dashboard (course library + enrollment queue)
              /admin/training/new  = create course + bulk-assign */}
          <Route path="training" element={<Training />} />
          <Route path="training/:id" element={<TrainingDetail />} />
          <Route path="admin/training" element={<TrainingDashboard />} />
          <Route path="admin/training/new" element={<TrainingCourseNew />} />
          <Route path="assets" element={<ComingSoon name="Assets" />} />
          {/* P0/A-02: landing branches on role. Employees → Attendance; admins → Admin Overview. */}
          <Route path="" element={<RoleBranchLanding />} />
        </Route>

        {/* Public routes with header/footer */}
        <Route
          path="/*"
          element={
            <>
              <Header />
              <main id="main-content">
                <Routes>
                  <Route path="/" element={<Home />} />
                  <Route path="/about" element={<About />} />
                  <Route path="/projects" element={<Projects />} />
                  <Route path="/contact" element={<Contact />} />
                  {/* A-05: Blog + Careers route stubs wired up so Header/Footer
                      links resolve to a real page instead of bouncing to Home. */}
                  <Route path="/blog" element={<Blog />} />
                  <Route path="/careers" element={<Careers />} />
                  {/* A-12: visible 404 for typo'd public URLs (was silent Home render). */}
                  <Route path="*" element={<NotFound />} />
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

// P0/A-02: branches /portal/ (empty path) to Admin Overview for admins and
// Attendance for employees. Lives here because the redirect target must be
// rendered under <PortalLayout> (auth-gated), not the public tree.
function RoleBranchLanding() {
  // useAuth is provided via ProtectedRoute → PortalLayout → Outlet tree,
  // but this component is rendered as a sibling of <PortalLayout> so it
  // can't read context. Use the localStorage hint as a minimal signal —
  // if employee missing or not admin, default to Attendance.
  let isAdmin = false;
  try {
    const raw = localStorage.getItem('acs_employee');
    if (raw) isAdmin = !!(JSON.parse(raw)?.isAdmin);
  } catch (e) { /* ignore parse errors */ }
  return isAdmin ? <AdminOverview /> : <Navigate to="attendance" replace />;
}

// Round-17 C-14: the inline ComingSoon component was hoisted into
// src/components/ComingSoon.jsx so the Assets stub and any future "Soon"
// surfaces share the same look. The legacy inline definition was removed;
// the shared component is imported at the top of this file.

export default App;
