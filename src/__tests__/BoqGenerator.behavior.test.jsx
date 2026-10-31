import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockApi = {
  getProjects: jest.fn(async () => ({ projects: [], discovered: [] })),
    resolveProject: jest.fn(async (name) => ({ id: 'project-new', name, isActive: true, allocationPending: true, uploadsAllowed: true, linkedTotal: 0 })),
  boqGenerator: {
    access: jest.fn(async () => ({ isPilot: true, pilotEnabled: false })),
    meta: jest.fn(async () => ({
      effectiveStatus: 'SAMPLE', productionMode: false,
      rateSources: [{ name: 'TN_PWD_SOR', isSample: true }],
      supportedInputTypes: ['dxf', 'ifc'],
      scaleGuidance: 'Confirm real-world size divided by size as drawn.',
      scaleSuggestion: 100,
      scalePresets: [{ id: 'full_size', drawingScale: 1, guidance: 'Full-size model.' }],
    })),
    listJobs: jest.fn(async () => ({ jobs: [] })),
    presignUpload: jest.fn(async () => ({ uploadId: `upload-${mockApi.boqGenerator.presignUpload.mock.calls.length}`, sasUrl: 'https://upload.test/signed' })),
    confirmUpload: jest.fn(async () => ({ verified: true })),
    createJob: jest.fn(async () => ({ id: 'job-new', projectId: 'project-new', status: 'SUBMITTED' })),
    getJob: jest.fn(async () => ({ id: 'job-new', status: 'SUBMITTED' })),
    getBoq: jest.fn(async () => ({ lines: [], withheld: [], totals: {} })),
    save: jest.fn(), correctLine: jest.fn(), acknowledgeExport: jest.fn(), downloadExport: jest.fn(),
  },
};
const mockToastPush = jest.fn();
const mockUploadBlob = jest.fn(async () => {});
let mockEmployee = { id: 'employee-test', isAdmin: false };

jest.mock('../lib/api.js', () => ({ api: mockApi }));
jest.mock('../contexts/AuthContext.jsx', () => ({ useAuth: () => ({ accessToken: 'test-token', employee: mockEmployee, isAdmin: mockEmployee.isAdmin }) }));
jest.mock('../contexts/ToastContext.jsx', () => ({ useToast: () => ({ push: mockToastPush }) }));
jest.mock('../lib/blobUpload.js', () => ({ uploadBlob: (...args) => mockUploadBlob(...args) }));

const BoqGenerator = require('../pages/portal/BoqGenerator.jsx').default;

describe('BOQ Generator user workflow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockEmployee = { id: 'employee-test', isAdmin: false };
    mockApi.getProjects.mockResolvedValue({ projects: [], discovered: [] });
    mockApi.boqGenerator.meta.mockResolvedValue({
      effectiveStatus: 'SAMPLE', productionMode: false,
      rateSources: [{ name: 'TN_PWD_SOR', isSample: true }],
      supportedInputTypes: ['dxf', 'ifc'],
      scaleGuidance: 'Confirm real-world size divided by size as drawn.',
      scaleSuggestion: 100,
      scalePresets: [{ id: 'full_size', drawingScale: 1, guidance: 'Full-size model.' }],
    });
    mockApi.boqGenerator.listJobs.mockResolvedValue({ jobs: [] });
    mockApi.boqGenerator.access.mockResolvedValue({ isPilot: true, pilotEnabled: false });
  });

  test('lets the creator upload drawings while the new project awaits admin allocation', async () => {
    mockApi.resolveProject.mockResolvedValueOnce({
      id: 'project-new', name: 'North Tower', isActive: true, allocationPending: true, uploadsAllowed: true,
    });
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><BoqGenerator /></MemoryRouter>);

    await screen.findByText('No assigned projects yet. Add a project to get started.');
    fireEvent.click(screen.getByRole('button', { name: '+ Add project' }));
    fireEvent.change(screen.getByLabelText('New project name'), { target: { value: 'North Tower' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(mockApi.resolveProject).toHaveBeenCalledWith('North Tower', 'test-token'));
    expect(await screen.findByText(/Pending administrator allocation/i)).toBeInTheDocument();
    expect(screen.getByText(/You can upload drawings now/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Select model drawings')).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Select model drawings'), {
      target: { files: [new File(['ISO-10303-21;'], 'tower.ifc', { type: 'application/octet-stream' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload drawings' }));

    expect(await screen.findByText(/Drawings for “North Tower” are uploaded privately/i)).toBeInTheDocument();
    expect(screen.getByText('tower.ifc')).toBeInTheDocument();
    expect(mockApi.boqGenerator.presignUpload).toHaveBeenCalledTimes(1);
    expect(mockApi.boqGenerator.confirmUpload).toHaveBeenCalledTimes(1);
    expect(mockApi.boqGenerator.createJob).not.toHaveBeenCalled();
  });

  test('restores the upload-only flow when the creator resolves an existing unassigned project', async () => {
    mockApi.resolveProject.mockResolvedValueOnce({
      id: 'project-existing', name: 'North Tower', isActive: true, allocationPending: true, uploadsAllowed: true,
    });
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><BoqGenerator /></MemoryRouter>);

    await screen.findByText('No assigned projects yet. Add a project to get started.');
    fireEvent.click(screen.getByRole('button', { name: '+ Add project' }));
    fireEvent.change(screen.getByLabelText('New project name'), { target: { value: 'North Tower' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    expect(await screen.findByText(/Pending administrator allocation/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Select model drawings'), {
      target: { files: [new File(['ISO-10303-21;'], 'tower.ifc', { type: 'application/octet-stream' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload drawings' }));

    expect(await screen.findByText(/Drawings for “North Tower” are uploaded privately/i)).toBeInTheDocument();
    expect(mockApi.boqGenerator.createJob).not.toHaveBeenCalled();
  });

  test('uses normal BOQ generation when resolving an existing project that has already been assigned', async () => {
    mockApi.resolveProject.mockResolvedValueOnce({ id: 'project-assigned', name: 'North Tower', isActive: true });
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><BoqGenerator /></MemoryRouter>);

    await screen.findByText('No assigned projects yet. Add a project to get started.');
    fireEvent.click(screen.getByRole('button', { name: '+ Add project' }));
    fireEvent.change(screen.getByLabelText('New project name'), { target: { value: 'North Tower' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    expect(await screen.findByRole('button', { name: 'Generate BOQ' })).toBeInTheDocument();
  });

  test('lets admins generate immediately when project resolution has no pending allocation flag', async () => {
    mockEmployee = { id: 'admin-test', isAdmin: true };
    mockApi.resolveProject.mockResolvedValueOnce({ id: 'project-admin-new', name: 'Admin Project', isActive: true });
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><BoqGenerator /></MemoryRouter>);

    await screen.findByText('No assigned projects yet. Add a project to get started.');
    fireEvent.click(screen.getByRole('button', { name: '+ Add project' }));
    fireEvent.change(screen.getByLabelText('New project name'), { target: { value: 'Admin Project' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    expect(await screen.findByRole('button', { name: 'Generate BOQ' })).toBeInTheDocument();
  });

  test('re-resolves upload eligibility when allocation is checked in an open page', async () => {
    const pending = { id: 'project-new', name: 'North Tower', isActive: true, allocationPending: true, uploadsAllowed: true };
    mockApi.resolveProject.mockResolvedValue(pending);
    mockApi.getProjects.mockResolvedValue({ projects: [], discovered: [] });
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><BoqGenerator /></MemoryRouter>);
    await screen.findByText('No assigned projects yet. Add a project to get started.');
    fireEvent.click(screen.getByRole('button', { name: '+ Add project' }));
    fireEvent.change(screen.getByLabelText('New project name'), { target: { value: 'North Tower' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByRole('button', { name: 'Upload drawings' })).toBeInTheDocument();

    mockApi.resolveProject.mockResolvedValueOnce({ ...pending, uploadsAllowed: false });
    fireEvent.click(screen.getByRole('button', { name: 'Check allocation' }));

    expect(await screen.findByText(/assigned to another employee\. You cannot upload or generate BOQs until you are assigned/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload drawings' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate BOQ' })).toBeDisabled();
  });

  test('restores confirmed pending uploads after reload and reuses them after assignment', async () => {
    mockApi.resolveProject.mockResolvedValue({
      id: 'project-new', name: 'North Tower', isActive: true, allocationPending: true, uploadsAllowed: true,
    });
    const firstPage = render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><BoqGenerator /></MemoryRouter>);
    await screen.findByText('No assigned projects yet. Add a project to get started.');
    fireEvent.click(screen.getByRole('button', { name: '+ Add project' }));
    fireEvent.change(screen.getByLabelText('New project name'), { target: { value: 'North Tower' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await screen.findByText(/Pending administrator allocation/i);
    fireEvent.change(screen.getByLabelText('Select model drawings'), {
      target: { files: [new File(['ISO-10303-21;'], 'tower.ifc', { type: 'application/octet-stream' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload drawings' }));
    await screen.findByText(/Drawings for “North Tower” are uploaded privately/i);
    const savedUploadId = JSON.parse(localStorage.getItem('boq_pending_uploads_v1:employee-test')).files[0].uploadId;

    firstPage.unmount();
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><BoqGenerator /></MemoryRouter>);
    expect(await screen.findByText(/Pending administrator allocation/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Upload drawings' }));
    await screen.findByText(/Drawings for “North Tower” are uploaded privately/i);
    expect(mockApi.boqGenerator.presignUpload).toHaveBeenCalledTimes(1);

    cleanup();
    mockApi.getProjects.mockResolvedValue({ projects: [{ id: 'project-new', name: 'North Tower' }], discovered: [] });
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><BoqGenerator /></MemoryRouter>);

    expect(await screen.findByText('tower.ifc')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Generate BOQ' }));
    await waitFor(() => expect(mockApi.boqGenerator.createJob).toHaveBeenCalledTimes(1));
    expect(mockApi.boqGenerator.createJob.mock.calls[0][0].uploads).toEqual([savedUploadId]);
    expect(mockApi.boqGenerator.presignUpload).toHaveBeenCalledTimes(1);
  });

  test('does not hide the page behind loading again when job search params change', async () => {
    mockApi.getProjects.mockResolvedValue({ projects: [{ id: 'project-assigned', name: 'Assigned Project' }], discovered: [] });
    mockApi.boqGenerator.listJobs.mockResolvedValue({ jobs: [{ id: 'job-sample', projectId: 'project-assigned', status: 'COMPLETED', createdAt: '2026-10-28T00:00:00Z' }] });
    mockApi.boqGenerator.getJob.mockResolvedValue({
      id: 'job-sample', projectId: 'project-assigned', status: 'COMPLETED',
      dataStatus: 'SAMPLE', productionMode: false, snapshot: { dataStatus: 'SAMPLE', productionMode: false },
    });
    mockApi.boqGenerator.listJobs.mockResolvedValue({ jobs: [{ id: 'job-sample', projectId: 'project-assigned', status: 'COMPLETED', createdAt: '2026-10-28T00:00:00Z' }] });
    mockApi.boqGenerator.getBoq.mockResolvedValue({ lines: [], withheld: [], totals: {} });

    render(<MemoryRouter initialEntries={['/portal/boq-generator?projectId=project-assigned']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><BoqGenerator /></MemoryRouter>);
    await screen.findByRole('option', { name: 'Assigned Project' });
    await waitFor(() => expect(mockApi.boqGenerator.listJobs).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));

    expect(await screen.findByRole('heading', { name: 'Review your take-off' })).toBeInTheDocument();
    expect(screen.getAllByText(/SAMPLE DATA/)).toHaveLength(1);
  });

  test('shows saved SAMPLE status when current service metadata is real', async () => {
    mockApi.getProjects.mockResolvedValue({ projects: [{ id: 'project-assigned', name: 'Assigned Project' }], discovered: [] });
    mockApi.boqGenerator.meta.mockResolvedValue({ effectiveStatus: 'REAL', productionMode: true, rateSources: [{ name: 'TN_PWD_SOR', isSample: false }] });
    mockApi.boqGenerator.listJobs.mockResolvedValue({ jobs: [{ id: 'job-old-sample', projectId: 'project-assigned', status: 'COMPLETED', createdAt: '2026-10-28T00:00:00Z' }] });
    mockApi.boqGenerator.getJob.mockResolvedValue({ id: 'job-old-sample', projectId: 'project-assigned', status: 'COMPLETED', dataStatus: 'SAMPLE', productionMode: false, snapshot: { dataStatus: 'SAMPLE', productionMode: false } });
    mockApi.boqGenerator.listJobs.mockResolvedValue({ jobs: [{ id: 'job-old-sample', projectId: 'project-assigned', status: 'COMPLETED', createdAt: '2026-10-28T00:00:00Z' }] });
    mockApi.boqGenerator.getBoq.mockResolvedValue({ lines: [], withheld: [], totals: {} });

    render(<MemoryRouter initialEntries={['/portal/boq-generator?projectId=project-assigned']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><BoqGenerator /></MemoryRouter>);
    await screen.findByRole('option', { name: 'Assigned Project' });
    await waitFor(() => expect(mockApi.boqGenerator.listJobs).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));

    expect(await screen.findByRole('heading', { name: 'Review your take-off' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/SAMPLE DATA — NOT AN ESTIMATE/);
  });

  test('requires acknowledgement of each corrected result revision', async () => {
    mockApi.getProjects.mockResolvedValue({ projects: [{ id: 'project-assigned', name: 'Assigned Project' }], discovered: [] });
    mockApi.boqGenerator.getJob.mockResolvedValue({ id: 'job-corrected', projectId: 'project-assigned', status: 'COMPLETED', dataStatus: 'SAMPLE', snapshot: { revision: 1, dataStatus: 'SAMPLE', productionMode: false } });
    mockApi.boqGenerator.listJobs.mockResolvedValue({ jobs: [{ id: 'job-corrected', projectId: 'project-assigned', status: 'COMPLETED', createdAt: '2026-10-28T00:00:00Z' }] });
    mockApi.boqGenerator.getBoq.mockResolvedValue({
      lines: [{ line_id: 'line-1', qty: 2, rate: 10, amount: 20 }], flags: [{ line_id: 'line-1' }], withheld: [], totals: {},
    });
    mockApi.boqGenerator.correctLine.mockResolvedValue({ revision: 2 });

    render(<MemoryRouter initialEntries={['/portal/boq-generator?projectId=project-assigned']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><BoqGenerator /></MemoryRouter>);
    await screen.findByRole('option', { name: 'Assigned Project' });
    await waitFor(() => expect(mockApi.boqGenerator.listJobs).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await screen.findByRole('heading', { name: 'Review your take-off' });
    fireEvent.click(screen.getByRole('checkbox', { name: /reviewed revision/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply correction' }));

    await waitFor(() => expect(mockApi.boqGenerator.correctLine).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /reviewed revision/i })).not.toBeChecked());
  });

  test('renders LOST recent jobs with a rerun recovery action', async () => {
    mockApi.getProjects.mockResolvedValue({ projects: [{ id: 'project-assigned', name: 'Assigned Project' }], discovered: [] });
    mockApi.boqGenerator.listJobs.mockResolvedValue({ jobs: [
      { id: 'job-lost', projectId: 'project-assigned', status: 'LOST', createdAt: '2026-10-28T00:00:00Z' },
    ] });
    mockApi.boqGenerator.getJob.mockResolvedValue({ id: 'job-lost', projectId: 'project-assigned', status: 'LOST' });

    render(<MemoryRouter initialEntries={['/portal/boq-generator?projectId=project-assigned&jobId=job-lost']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><BoqGenerator /></MemoryRouter>);
    await screen.findByRole('option', { name: 'Assigned Project' });
    expect(await screen.findByRole('button', { name: /run again/i })).toBeInTheDocument();
  });

  test('lets an assigned employee start a job with the one required DXF scale confirmation', async () => {
    mockApi.getProjects.mockResolvedValue({ projects: [{ id: 'project-assigned', name: 'Assigned Project' }], discovered: [] });
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><BoqGenerator /></MemoryRouter>);
    await screen.findByRole('option', { name: 'Assigned Project' });
    await screen.findByRole('button', { name: 'Choose DXF or IFC drawing files' });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'project-assigned' } });
    await screen.findByLabelText('Select model drawings');
    const file = new File(['0\nSECTION\n'], 'plan.dxf', { type: 'application/octet-stream' });
    fireEvent.change(screen.getByLabelText('Select model drawings'), { target: { files: [file] } });
    expect(screen.getByLabelText('Scale factor for plan.dxf')).toHaveValue(1);
    const generateButton = screen.getByRole('button', { name: 'Generate BOQ' });
    expect(generateButton).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Confirm scale for plan.dxf'));
    expect(generateButton).toBeEnabled();
    fireEvent.click(generateButton);
    await waitFor(() => expect(mockApi.boqGenerator.createJob).toHaveBeenCalledTimes(1));
    expect(mockApi.boqGenerator.createJob.mock.calls[0][0].dxfScale).toBe(1);
  });

  test('retains selected drawings after a failed service submission so the user can retry', async () => {
    mockApi.getProjects.mockResolvedValue({ projects: [{ id: 'project-assigned', name: 'Assigned Project' }], discovered: [] });
    mockApi.boqGenerator.createJob.mockRejectedValueOnce(Object.assign(new Error('Drawing service is starting'), { code: 'BOQ_TIMEOUT' }));
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><BoqGenerator /></MemoryRouter>);
    await screen.findByRole('option', { name: 'Assigned Project' });
    await screen.findByRole('button', { name: 'Choose DXF or IFC drawing files' });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'project-assigned' } });
    await screen.findByLabelText('Select model drawings');
    const file = new File(['ISO-10303-21;'], 'tower.ifc', { type: 'application/octet-stream' });
    fireEvent.change(screen.getByLabelText('Select model drawings'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate BOQ' }));
    await waitFor(() => expect(mockApi.boqGenerator.createJob).toHaveBeenCalledTimes(1));
    expect(screen.getByText('tower.ifc')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('taking longer than expected');
    expect(screen.getByRole('button', { name: 'Generate BOQ' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Generate BOQ' }));
    await waitFor(() => expect(mockApi.boqGenerator.createJob).toHaveBeenCalledTimes(2));
    expect(mockApi.boqGenerator.presignUpload).toHaveBeenCalledTimes(1);
    expect(mockApi.boqGenerator.createJob.mock.calls[1][0].uploads).toEqual(mockApi.boqGenerator.createJob.mock.calls[0][0].uploads);
    expect(mockApi.boqGenerator.createJob.mock.calls[1][2]).toBe(mockApi.boqGenerator.createJob.mock.calls[0][2]);
  });

  test('directs service configuration failures to an administrator without claiming uploads are safe', async () => {
    mockApi.getProjects.mockResolvedValue({ projects: [{ id: 'project-assigned', name: 'Assigned Project' }], discovered: [] });
    mockApi.boqGenerator.createJob.mockRejectedValueOnce(Object.assign(
      new Error('The drawing service is not configured'),
      { code: 'BOQ_SERVICE_UNAVAILABLE' },
    ));
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><BoqGenerator /></MemoryRouter>);
    await screen.findByRole('option', { name: 'Assigned Project' });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'project-assigned' } });
    fireEvent.change(screen.getByLabelText('Select model drawings'), {
      target: { files: [new File(['ISO-10303-21;'], 'tower.ifc', { type: 'application/octet-stream' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate BOQ' }));

    await waitFor(() => expect(mockApi.boqGenerator.createJob).toHaveBeenCalledTimes(1));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/processor connection is not configured/i);
    expect(alert).toHaveTextContent('BOQ_BASE_URL');
    expect(alert).toHaveTextContent('BOQ_API_TOKEN');
    expect(alert).not.toHaveTextContent(/upload is safe|try again shortly/i);
    expect(screen.getByText('tower.ifc')).toBeInTheDocument();
  });

  test('directs processor credential rejection to an administrator', async () => {
    mockApi.getProjects.mockResolvedValue({ projects: [{ id: 'project-assigned', name: 'Assigned Project' }], discovered: [] });
    mockApi.boqGenerator.createJob.mockRejectedValueOnce(Object.assign(
      new Error('The BOQ processor rejected the portal credentials'),
      { code: 'BOQ_SERVICE_AUTH_FAILED' },
    ));
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><BoqGenerator /></MemoryRouter>);
    await screen.findByRole('option', { name: 'Assigned Project' });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'project-assigned' } });
    fireEvent.change(screen.getByLabelText('Select model drawings'), {
      target: { files: [new File(['ISO-10303-21;'], 'tower.ifc', { type: 'application/octet-stream' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate BOQ' }));

    await waitFor(() => expect(mockApi.boqGenerator.createJob).toHaveBeenCalledTimes(1));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/processor rejected the portal credentials/i);
    expect(alert).toHaveTextContent('BOQ_API_TOKEN');
    expect(screen.getByText('tower.ifc')).toBeInTheDocument();
  });

  test('shows actual result flags, defaults to flagged and unpriced lines, and exposes alternatives', async () => {
    mockApi.getProjects.mockResolvedValue({ projects: [{ id: 'project-assigned', name: 'Assigned Project' }], discovered: [] });
    mockApi.boqGenerator.listJobs.mockResolvedValue({ jobs: [{
      id: 'job-done', projectId: 'project-assigned', status: 'COMPLETED', createdAt: '2026-10-28T00:00:00Z',
    }] });
    mockApi.boqGenerator.getJob.mockResolvedValue({
      id: 'job-done', projectId: 'project-assigned', status: 'COMPLETED',
      snapshot: { pricedLineCount: 1, unpricedLineCount: 2 },
      scaleSuggestion: { drawing_scale: 50, source: 'job geometry' },
    });
    mockApi.boqGenerator.getBoq.mockResolvedValue({
      totals: { line_count: 3, unpriced_line_count: 1, withheld_count: 2, amount: 10, currency: 'INR' },
      lines: [
        { line_id: 'normal', item_code: 'N', description: 'Normal computed line', rate: 10, reason_codes: ['GEOMETRY_COMPUTED'], flags: [] },
        { line_id: 'flagged', item_code: 'F', description: 'Flagged wall', rate: 10, element_ids: ['el-flagged'], provenance: { sor_code: '05.001' }, alternatives: [{ code: 'ALT-1', description: 'Alternative rate', rate: 20, source: 'TN_PWD_SOR', score: 0.8 }] },
        { line_id: 'unpriced', item_code: 'U', description: 'Unpriced item', rate: null, element_ids: ['el-unpriced'], flags: [] },
      ],
      flags: [
        { reason_code: 'SCALE_IMPLAUSIBLE', description: 'Verify model scale', detail: 'Quantities are unchanged.' },
        { reason_code: 'LOW_CONFIDENCE', element_id: 'el-flagged' },
      ],
      withheld: [{ element_id: 'el-unpriced', item_code: 'U', description: 'Unpriced item', reason_code: 'NO_RATE' }],
    });

    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><BoqGenerator /></MemoryRouter>);
    await screen.findByRole('option', { name: 'Assigned Project' });
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));

    await screen.findByRole('heading', { name: 'Review your take-off' });
    expect(await screen.findByText('Flagged wall')).toBeInTheDocument();
    expect(screen.getByText('Unpriced item')).toBeInTheDocument();
    expect(screen.queryByText('Normal computed line')).not.toBeInTheDocument();
    expect(screen.getByText(/SCALE_IMPLAUSIBLE/)).toBeInTheDocument();
    expect(mockApi.boqGenerator.getJob).toHaveBeenCalled();
    expect(screen.getByText(/1 unpriced/)).toBeInTheDocument();
    expect(screen.getByText('Saved coverage: 1 priced · 2 unpriced')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Review' })[0]);
    expect(screen.getByText(/SOR code: 05\.001/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Alternative rates (1)'));
    expect(screen.getByText(/₹20\.00/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show all 3 lines' }));
    expect(screen.getByText('Normal computed line')).toBeInTheDocument();
  });

  test('restores the selected completed run from the URL query', async () => {
    mockApi.getProjects.mockResolvedValue({ projects: [{ id: 'project-assigned', name: 'Assigned Project' }], discovered: [] });
    mockApi.boqGenerator.getJob.mockResolvedValue({ id: 'job-deep-link', projectId: 'project-assigned', status: 'COMPLETED' });
    mockApi.boqGenerator.getBoq.mockResolvedValue({ lines: [{ line_id: 'deep-line', item_code: 'D', description: 'Deep-linked line', rate: 4 }], withheld: [], totals: {} });

    render(<MemoryRouter initialEntries={['/portal/boq-generator?projectId=project-assigned&jobId=job-deep-link']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><BoqGenerator /></MemoryRouter>);

    await waitFor(() => expect(mockApi.boqGenerator.getJob).toHaveBeenCalledWith('job-deep-link', 'test-token'));
    await screen.findByRole('heading', { name: 'Review your take-off' });
    expect(await screen.findByRole('button', { name: /Show all/ })).toBeInTheDocument();
  });

  test('uses a separate confirmed scale for each DXF in a mixed-scale batch', async () => {
    mockApi.getProjects.mockResolvedValue({ projects: [{ id: 'project-assigned', name: 'Assigned Project' }], discovered: [] });
    mockApi.boqGenerator.listJobs.mockResolvedValue({ jobs: [] });
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><BoqGenerator /></MemoryRouter>);
    await screen.findByRole('option', { name: 'Assigned Project' });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'project-assigned' } });
    const files = [
      new File(['0\nSECTION\n'], 'floor-a.dxf', { type: 'application/octet-stream' }),
      new File(['0\nSECTION\n'], 'floor-b.dxf', { type: 'application/octet-stream' }),
    ];
    fireEvent.change(screen.getByLabelText('Select model drawings'), { target: { files } });
    expect(screen.getByLabelText('Scale factor for floor-a.dxf')).toHaveValue(1);
    expect(screen.getByLabelText('Scale factor for floor-b.dxf')).toHaveValue(1);
    fireEvent.change(screen.getByLabelText('Scale factor for floor-a.dxf'), { target: { value: '100' } });
    fireEvent.click(screen.getByLabelText('Confirm scale for floor-a.dxf'));
    fireEvent.click(screen.getByLabelText('Confirm scale for floor-b.dxf'));
    fireEvent.click(screen.getByRole('button', { name: 'Generate BOQ' }));
    await waitFor(() => expect(mockApi.boqGenerator.createJob).toHaveBeenCalledTimes(2));
    expect(mockApi.boqGenerator.createJob.mock.calls.map(([data]) => data.dxfScale).sort()).toEqual([1, 100]);
  });

  test('keeps one sample-data warning visible during result review', async () => {
    mockApi.getProjects.mockResolvedValue({ projects: [{ id: 'project-assigned', name: 'Assigned Project' }], discovered: [] });
    mockApi.boqGenerator.listJobs.mockResolvedValue({ jobs: [{
      id: 'job-sample', projectId: 'project-assigned', status: 'COMPLETED', createdAt: '2026-10-28T00:00:00Z',
    }] });
    mockApi.boqGenerator.getJob.mockResolvedValue({ id: 'job-sample', projectId: 'project-assigned', status: 'COMPLETED' });
    mockApi.boqGenerator.listJobs.mockResolvedValue({ jobs: [{ id: 'job-sample', projectId: 'project-assigned', status: 'COMPLETED', createdAt: '2026-10-28T00:00:00Z' }] });
    mockApi.boqGenerator.getBoq.mockResolvedValue({ lines: [], withheld: [], totals: {} });

    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><BoqGenerator /></MemoryRouter>);
    await screen.findByRole('option', { name: 'Assigned Project' });
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));

    await screen.findByRole('heading', { name: 'Review your take-off' });
    expect(screen.getAllByText(/SAMPLE DATA/)).toHaveLength(1);
  });
});