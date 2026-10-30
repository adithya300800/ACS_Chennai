import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockApi = {
  getProjects: jest.fn(async () => ({ projects: [], discovered: [] })),
    resolveProject: jest.fn(async (name) => ({ id: 'project-new', name, isActive: true, linkedTotal: 0 })),
  boqGenerator: {
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

jest.mock('../lib/api.js', () => ({ api: mockApi }));
jest.mock('../contexts/AuthContext.jsx', () => ({ useAuth: () => ({ accessToken: 'test-token' }) }));
jest.mock('../contexts/ToastContext.jsx', () => ({ useToast: () => ({ push: mockToastPush }) }));
jest.mock('../lib/blobUpload.js', () => ({ uploadBlob: (...args) => mockUploadBlob(...args) }));

const BoqGenerator = require('../pages/portal/BoqGenerator.jsx').default;

describe('BOQ Generator user workflow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
  });

  test('creates a project from the empty state, uploads an IFC and starts its take-off', async () => {
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><BoqGenerator /></MemoryRouter>);

    await screen.findByText('No assigned projects yet. Add a project to get started.');
    fireEvent.click(screen.getByRole('button', { name: '+ Add project' }));
    fireEvent.change(screen.getByLabelText('New project name'), { target: { value: 'North Tower' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(mockApi.resolveProject).toHaveBeenCalledWith('North Tower', 'test-token'));
    await screen.findByRole('option', { name: 'North Tower' });
    await screen.findByLabelText('Select model drawings');
    const file = new File(['ISO-10303-21;'], 'tower.ifc', { type: 'application/octet-stream' });
    fireEvent.change(screen.getByLabelText('Select model drawings'), { target: { files: [file] } });
    expect(screen.queryByLabelText('Confirm the DXF model scale')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate BOQ' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Generate BOQ' }));
    await waitFor(() => expect(mockApi.boqGenerator.presignUpload).toHaveBeenCalled());
    await waitFor(() => {
      expect(mockApi.boqGenerator.createJob).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 'project-new', uploads: ['upload-1'], rateSource: 'TN_PWD_SOR',
      }), 'test-token', expect.any(String));
    });
    expect(mockUploadBlob).toHaveBeenCalledWith('https://upload.test/signed', file, expect.objectContaining({
      contentType: 'application/octet-stream',
    }));
    expect(mockApi.boqGenerator.confirmUpload).toHaveBeenCalledWith('upload-1', 'test-token');
    expect(await screen.findByText('Your take-off is processing. You can leave this page; your run will be in Recent runs.')).toBeInTheDocument();
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
    expect(screen.getByText('3. Confirm drawing scale')).toBeInTheDocument();
    expect(screen.getByText('Confirm real-world size divided by size as drawn.')).toBeInTheDocument();
    expect(screen.getByText(/Layer-map scale suggestion: factor 100/)).toBeInTheDocument();
    expect(screen.getByLabelText('Drawing scale factor')).toHaveValue(1);
    fireEvent.click(screen.getByRole('button', { name: 'Full size (1)' }));
    const generateButton = screen.getByRole('button', { name: 'Generate BOQ' });
    expect(generateButton).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Confirm the DXF model scale'));
    expect(generateButton).toBeEnabled();
    fireEvent.click(generateButton);
    await waitFor(() => expect(mockApi.boqGenerator.createJob).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-assigned', dxfScale: 1,
    }), 'test-token', expect.any(String)));
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
    expect(screen.getByText(/Job-specific scale suggestion: factor 50/)).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: /Show all/ }));
    expect(await screen.findByText('Deep-linked line')).toBeInTheDocument();
  });

  test('keeps one sample-data warning visible during result review', async () => {
    mockApi.getProjects.mockResolvedValue({ projects: [{ id: 'project-assigned', name: 'Assigned Project' }], discovered: [] });
    mockApi.boqGenerator.listJobs.mockResolvedValue({ jobs: [{
      id: 'job-sample', projectId: 'project-assigned', status: 'COMPLETED', createdAt: '2026-10-28T00:00:00Z',
    }] });
    mockApi.boqGenerator.getJob.mockResolvedValue({ id: 'job-sample', projectId: 'project-assigned', status: 'COMPLETED' });
    mockApi.boqGenerator.getBoq.mockResolvedValue({ lines: [], withheld: [], totals: {} });

    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><BoqGenerator /></MemoryRouter>);
    await screen.findByRole('option', { name: 'Assigned Project' });
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));

    await screen.findByRole('heading', { name: 'Review your take-off' });
    expect(screen.getAllByText(/SAMPLE DATA/)).toHaveLength(1);
  });
});