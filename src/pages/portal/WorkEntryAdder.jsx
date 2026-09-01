import React, { useState } from 'react';
// C-02 (round-15+): unified section → sub-type → form picker. Replaces
// DprWorkEntryAdder.jsx + InspectionWorkEntryAdder.jsx — both were
// ~100-line clones rendering the same three-step flow.
//
// Differences between the originals:
//   - Section header label ("Add Work Entry" vs "Add Inspection Record")
//     is now controlled by the `sectionLabel` prop.
//   - The original DprWorkEntryAdder imported a dead `WORK_TYPE_OPTIONS`
//     symbol that was never referenced. Dropped during merge.
//   - Both originals delegated the inner form to their own copy of
//     DprWorkEntryForm / InspectionWorkEntryForm. After C-01 they both
//     point at the unified WorkEntryForm.
//
// The submit callback signature is unchanged — callers still receive the
// full entry object from WorkEntryForm: `{ workType, data, addedAt }`.
import { WORK_TYPE_SECTIONS, SUB_WORK_TYPE_OPTIONS } from './WorkTypes.jsx';
import WorkEntryForm from './WorkEntryForm.jsx';

export default function WorkEntryAdder({ onAdd, sectionLabel = 'Add Work Entry' }) {
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
          <label className="section-label">{sectionLabel}</label>
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
          <WorkEntryForm
            workType={selectedSubType}
            onAdd={handleAdd}
            onCancel={handleCancel}
          />
        </div>
      )}
    </div>
  );
}
