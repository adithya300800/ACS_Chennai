import React, { useState } from 'react';
// Round-12: Inspection & Compliance Records.
//
// This component is a near-clone of DprWorkEntryAdder.jsx — same three-step
// picker (section → sub-type → form). We deliberately don't share the
// component instance because:
//   1. The two pages live in different URLs and need independent mount/unmount
//      lifecycles (saving-as-draft patterns will differ as the Inspection
//      page matures).
//   2. The Inspection submit page needs the `dprId` / `reportDate` context
//      already on hand — passing that through a shared component would mean
//      prop-drilling that's just noise here.
//   3. Future divergence (e.g. NCR workflow buttons on the inspection form)
//      will diverge anyway; better to start clean.
//
// The single source of truth for the 15 sub-types + their fields is still
// DprWorkTypes.jsx — we import from there, not duplicate the config.
import { WORK_TYPE_SECTIONS, SUB_WORK_TYPE_OPTIONS } from './DprWorkTypes.jsx';
import InspectionWorkEntryForm from './InspectionWorkEntryForm.jsx';

export default function InspectionWorkEntryAdder({ onAdd }) {
  const [selectedSection, setSelectedSection] = useState(null);
  const [selectedSubType, setSelectedSubType] = useState(null);
  const [showForm, setShowForm] = useState(false);

  const sectionEntries = selectedSection
    ? SUB_WORK_TYPE_OPTIONS.filter((s) => s.section === selectedSection)
    : [];

  const handleSectionSelect = (section) => {
    setSelectedSection(section);
    setSelectedSubType(null);
    setShowForm(false);
  };

  const handleSubTypeSelect = (subType) => {
    setSelectedSubType(subType);
    setShowForm(true);
  };

  const handleAdd = (entry) => {
    onAdd(entry);
    setSelectedSection(null);
    setSelectedSubType(null);
    setShowForm(false);
  };

  const handleCancel = () => {
    setSelectedSection(null);
    setSelectedSubType(null);
    setShowForm(false);
  };

  return (
    <div className="work-entry-adder">
      {!selectedSection && !showForm && (
        <>
          <label className="section-label">Add Inspection Record</label>
          <div className="work-section-grid">
            {Object.entries(WORK_TYPE_SECTIONS).map(([key, section]) => (
              <button
                key={key}
                type="button"
                className="work-section-btn"
                onClick={() => handleSectionSelect(key)}
                style={{ '--section-color': section.color }}
              >
                <span className="work-section-icon">{section.icon}</span>
                <span className="work-section-label">{section.label}</span>
                <span className="work-section-count">{section.workTypes.length} types</span>
              </button>
            ))}
          </div>
        </>
      )}

      {selectedSection && !showForm && (
        <div className="sub-type-picker">
          <div className="sub-type-header">
            <span className="sub-type-title">
              {WORK_TYPE_SECTIONS[selectedSection].icon} {WORK_TYPE_SECTIONS[selectedSection].label}
            </span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleCancel}>
              ← Back
            </button>
          </div>
          <div className="sub-type-list">
            {sectionEntries.map((sub) => (
              <button
                key={sub.value}
                type="button"
                className="sub-type-btn"
                onClick={() => handleSubTypeSelect(sub.value)}
              >
                {sub.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {showForm && selectedSubType && (
        <div className="work-entry-form-wrapper">
          <div className="sub-type-header">
            <span className="sub-type-title">
              {WORK_TYPE_SECTIONS[selectedSection].icon} {WORK_TYPE_SECTIONS[selectedSection].label}
            </span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleCancel}>
              ← Back
            </button>
          </div>
          <InspectionWorkEntryForm
            workType={selectedSubType}
            onAdd={handleAdd}
            onCancel={handleCancel}
          />
        </div>
      )}
    </div>
  );
}
