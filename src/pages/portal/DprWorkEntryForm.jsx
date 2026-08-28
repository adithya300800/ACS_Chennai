import React, { useState } from 'react';
import { WORK_TYPE_FIELDS, SUB_WORK_TYPE_OPTIONS } from './DprWorkTypes.jsx';

export default function DprWorkEntryForm({ workType, onAdd, onCancel }) {
  const config = WORK_TYPE_FIELDS[workType];
  const [formData, setFormData] = useState({});
  const [errors, setErrors] = useState({});

  if (!config) return null;

  const handleChange = (name, value) => {
    setFormData((f) => ({ ...f, [name]: value }));
    if (errors[name]) setErrors((e) => ({ ...e, [name]: null }));
  };

  const validate = () => {
    const newErrors = {};
    config.fields.forEach((field) => {
      if (field.required && !formData[field.name]) {
        newErrors[field.name] = 'This field is required';
      }
    });
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!validate()) return;
    onAdd({ workType, data: formData, addedAt: new Date().toISOString() });
  };

  const meta = SUB_WORK_TYPE_OPTIONS.find((s) => s.value === workType);

  return (
    <div className="work-entry-form">
      <div className="work-entry-form-header">
        <div>
          <span className={`work-entry-badge ${config.isCritical ? 'critical' : ''}`}>
            {config.isCritical && '⚠️ '}{meta?.label || workType}
          </span>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="work-entry-fields">
          {config.fields.map((field) => (
            <div key={field.name} className="work-entry-field">
              {field.type === 'select' ? (
                <div className="form-group">
                  <label htmlFor={field.name}>
                    {field.label}
                    {field.required && <span className="required">*</span>}
                  </label>
                  <select
                    id={field.name}
                    name={field.name}
                    className={`form-input ${errors[field.name] ? 'input-error' : ''}`}
                    value={formData[field.name] || ''}
                    onChange={(e) => handleChange(field.name, e.target.value)}
                  >
                    <option value="">Select...</option>
                    {field.options.map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                  {errors[field.name] && <span className="field-error">{errors[field.name]}</span>}
                </div>
              ) : field.type === 'textarea' ? (
                <div className="form-group">
                  <label htmlFor={field.name}>
                    {field.label}
                    {field.required && <span className="required">*</span>}
                  </label>
                  <textarea
                    id={field.name}
                    name={field.name}
                    className={`form-input ${errors[field.name] ? 'input-error' : ''}`}
                    rows={3}
                    value={formData[field.name] || ''}
                    onChange={(e) => handleChange(field.name, e.target.value)}
                    placeholder={field.placeholder || ''}
                  />
                  {errors[field.name] && <span className="field-error">{errors[field.name]}</span>}
                </div>
              ) : field.type === 'checklist' ? (
                <div className="form-group">
                  <label>{field.label}{field.required && <span className="required">*</span>}</label>
                  <div className="checklist-grid">
                    {field.options.map((opt) => (
                      <label key={opt} className="checklist-item">
                        <input
                          type="checkbox"
                          checked={formData[field.name]?.includes(opt) || false}
                          onChange={(e) => {
                            const current = formData[field.name] || [];
                            const updated = e.target.checked
                              ? [...current, opt]
                              : current.filter((o) => o !== opt);
                            handleChange(field.name, updated);
                          }}
                        />
                        <span>{opt}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : field.type === 'number' ? (
                <div className="form-group">
                  <label htmlFor={field.name}>
                    {field.label}
                    {field.required && <span className="required">*</span>}
                  </label>
                  <input
                    id={field.name}
                    name={field.name}
                    type="number"
                    className={`form-input ${errors[field.name] ? 'input-error' : ''}`}
                    value={formData[field.name] || ''}
                    onChange={(e) => handleChange(field.name, e.target.value)}
                    placeholder={field.placeholder || ''}
                    min={field.min}
                    max={field.max}
                  />
                  {errors[field.name] && <span className="field-error">{errors[field.name]}</span>}
                </div>
              ) : field.type === 'time' ? (
                <div className="form-group">
                  <label htmlFor={field.name}>
                    {field.label}
                    {field.required && <span className="required">*</span>}
                  </label>
                  <input
                    id={field.name}
                    name={field.name}
                    type="time"
                    className={`form-input ${errors[field.name] ? 'input-error' : ''}`}
                    value={formData[field.name] || ''}
                    onChange={(e) => handleChange(field.name, e.target.value)}
                  />
                  {errors[field.name] && <span className="field-error">{errors[field.name]}</span>}
                </div>
              ) : (
                <div className="form-group">
                  <label htmlFor={field.name}>
                    {field.label}
                    {field.required && <span className="required">*</span>}
                  </label>
                  <input
                    id={field.name}
                    name={field.name}
                    type={field.type || 'text'}
                    className={`form-input ${errors[field.name] ? 'input-error' : ''}`}
                    value={formData[field.name] || ''}
                    onChange={(e) => handleChange(field.name, e.target.value)}
                    placeholder={field.placeholder || ''}
                  />
                  {errors[field.name] && <span className="field-error">{errors[field.name]}</span>}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="work-entry-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Add Entry
          </button>
        </div>
      </form>
    </div>
  );
}
