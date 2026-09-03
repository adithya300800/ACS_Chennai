import React, { useEffect, Suspense } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import Header from './components/Header.jsx';
import Footer from './components/Footer.jsx';
import ScrollToTop from './components/ScrollToTop.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import PortalLayout from './components/PortalLayout.jsx';
import PageLoader from './components/PageLoader.jsx';
import RoleBranchLanding from './components/RoleBranchLanding.jsx';
// G-03: route-level code splitting. Every page-level component is lazy-loaded
// so the initial bundle ships only the shell + auth/portal chrome. Each route
// pulls its own chunk on first navigation.
const Home = React.lazy(() => import('./pages/Home.jsx'));
const About = React.lazy(() => import('./pages/About.jsx'));
const Projects = React.lazy(() => import('./pages/Projects.jsx'));
const Contact = React.lazy(() => import('./pages/Contact.jsx'));
const Blog = React.lazy(() => import('./pages/Blog.jsx'));
const Careers = React.lazy(() => import('./pages/Careers.jsx'));
const NotFound = React.lazy(() => import('./pages/NotFound.jsx'));
const PortalLogin = React.lazy(() => import('./pages/PortalLogin.jsx'));
const Attendance = React.lazy(() => import('./pages/portal/Attendance.jsx'));
// SOL-P2#16: employee home dashboard — the new landing for non-admin
// employees, replacing the previous direct redirect into Attendance.
const EmployeeDashboard = React.lazy(() => import('./pages/portal/EmployeeDashboard.jsx'));
const AdminOverview = React.lazy(() => import('./pages/admin/AdminOverview.jsx'));
const AdminAttendance = React.lazy(() => import('./pages/portal/Admin.jsx')); // renamed semantically; kept file path stable
const Leave = React.lazy(() => import('./pages/portal/Leave.jsx'));
const DprSubmit = React.lazy(() => import('./pages/portal/DprSubmit.jsx'));
const DprList = React.lazy(() => import('./pages/portal/DprList.jsx'));
// Round-22: admin cross-org DPR list — mirrors InspectionAll. Sidebar entry
// for "All Daily Reports Records" lives in PortalLayout.jsx under the Admin
// group and points here.
const DprAll = React.lazy(() => import('./pages/portal/DprAll.jsx'));
const DprDashboard = React.lazy(() => import('./pages/admin/DprDashboard.jsx'));
const LeaveDashboard = React.lazy(() => import('./pages/admin/LeaveDashboard.jsx'));
const InspectionSubmit = React.lazy(() => import('./pages/portal/InspectionSubmit.jsx'));
const InspectionList = React.lazy(() => import('./pages/portal/InspectionList.jsx'));
const InspectionAll = React.lazy(() => import('./pages/portal/InspectionAll.jsx'));
const InspectionDetail = React.lazy(() => import('./pages/portal/InspectionDetail.jsx'));
const InspectionDashboard = React.lazy(() => import('./pages/admin/InspectionDashboard.jsx'));
const Training = React.lazy(() => import('./pages/portal/Training.jsx'));
const TrainingDetail = React.lazy(() => import('./pages/portal/TrainingDetail.jsx'));
const TrainingDashboard = React.lazy(() => import('./pages/admin/TrainingDashboard.jsx'));
const TrainingCourseNew = React.lazy(() => import('./pages/admin/TrainingCourseNew.jsx'));
// Round-24: admin course detail + edit pages. Lazy-loaded with the rest so
// they share the admin chunk group. The detail page hosts the reassign
// modal (deep-linkable via ?reassign=1).
const TrainingCourseDetail = React.lazy(() => import('./pages/admin/TrainingCourseDetail.jsx'));
const TrainingCourseEdit = React.lazy(() => import('./pages/admin/TrainingCourseEdit.jsx'));
// SOL-P2#18: portal-side 404 — keeps the portal chrome and gives the
// user a familiar recovery path rather than dumping them on the public
// site. Renders inside the protected /portal/* tree.
const PortalNotFound = React.lazy(() => import('./pages/portal/PortalNotFound.jsx'));

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
      {/* G-03: single Suspense boundary around the whole router tree.
          Vite emits one chunk per lazy() page; the boundary shows the
          shared PageLoader while the chunk for the matched route loads. */}
      <Suspense fallback={<PageLoader />}>
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
          {/* SOL-P2#16: employee home dashboard. */}
          <Route path="dashboard" element={<EmployeeDashboard />} />
          {/* /portal/admin = new overview hub (A-01). /portal/admin/attendance
              keeps the org-wide attendance grid so the existing
              "All Attendance" tile and admin nav item still have a target. */}
          <Route path="admin" element={<AdminOverview />} />
          <Route path="admin/attendance" element={<AdminAttendance />} />
          <Route path="leave" element={<Leave />} />
          <Route path="dpr/submit" element={<DprSubmit />} />
          <Route path="dpr/my" element={<DprList />} />
          {/* Round-22: admin cross-org DPR list — mirrors InspectionAll. */}
          <Route path="dpr/all" element={<DprAll />} />
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
              /training                 = employee "My Learning" hub
              /training/:id             = single-course player page (employee owner only)
              /admin/training           = admin dashboard (course library + enrollment queue)
              /admin/training/new       = create course + bulk-assign
              /admin/training/:id       = admin course detail (view + reassign + archive) — round 24
              /admin/training/:id/edit  = admin course edit form — round 24
              NOTE: literal /new MUST come before param :id so HashRouter matches
              "/new" instead of treating it as :id="new" (round-20 lesson). */}
          <Route path="training" element={<Training />} />
          <Route path="training/:id" element={<TrainingDetail />} />
          <Route path="admin/training" element={<TrainingDashboard />} />
          <Route path="admin/training/new" element={<TrainingCourseNew />} />
          <Route path="admin/training/:id" element={<TrainingCourseDetail />} />
          <Route path="admin/training/:id/edit" element={<TrainingCourseEdit />} />
          {/* P0/A-02: landing branches on role. Employees → Dashboard; admins → Admin Overview.
              SOL-P2#17: removed /portal/assets stub (and ComingSoon component) —
              the item was advertised as "coming soon" but had no roadmap date.
              DR-020: RoleBranchLanding now reads role from AuthContext (not the stale
              acs_employee localStorage key). */}
          <Route path="" element={<RoleBranchLanding renderAdmin={() => <AdminOverview />} />} />
          {/* SOL-P2#18: portal catch-all 404. Stays inside PortalLayout chrome so
              the sidebar/topbar are visible — gives the user "Back to dashboard"
              + browser-back recovery instead of the public-site placeholder. */}
          <Route path="*" element={<PortalNotFound />} />
        </Route>

        {/* Public routes with header/footer */}
        <Route
          path="/*"
          element={
            <>
              <Header />
              <main id="main-content" tabIndex={-1}>
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
      </Suspense>
    </div>
  );
}

// P0/A-02: branches /portal/ (empty path) for admins vs employees. The
// role-branch component lives in src/components/RoleBranchLanding.jsx so
// the routing rule can be unit-tested without importing the full App
// dependency graph. See that file for the DR-020 fix notes.

// Round-17 C-14: the inline ComingSoon component was hoisted into
// src/components/ComingSoon.jsx so the Assets stub and any future "Soon"
// surfaces share the same look. The legacy inline definition was removed;
// the shared component is imported at the top of this file.

export default App;
