import React, { useState } from 'react';
import { WORK_TYPE_SECTIONS, SUB_WORK_TYPE_OPTIONS, WORK_TYPE_OPTIONS } from './WorkTypes.jsx';
import DprWorkEntryForm from './DprWorkEntryForm.jsx';

export default function DprWorkEntryAdder({ onAdd }) {
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
          <label className="section-label">Add Work Entry</label>
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
          <DprWorkEntryForm
            workType={selectedSubType}
            onAdd={handleAdd}
            onCancel={handleCancel}
          />
        </div>
      )}
    </div>
  );
}
