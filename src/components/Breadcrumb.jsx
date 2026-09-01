import React from 'react';
import { Link } from 'react-router-dom';

// B-03 (round-17): shared breadcrumb trail for detail pages. Renders a
// `<nav aria-label="Breadcrumb">` with the last item as the current page
// (rendered as plain text, not a link). Use for InspectionDetail,
// TrainingDetail, and the DPR detail modal.
//
// `items`: array of { label: string, to?: string }. The last item must NOT
// have `to` — it is treated as the current page. Other items are rendered
// as Links.

export default function Breadcrumb({ items }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className="breadcrumb">
      <ol className="breadcrumb-list">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <li key={i} className="breadcrumb-item">
              {isLast || !item.to ? (
                <span aria-current="page" className="breadcrumb-current">{item.label}</span>
              ) : (
                <Link to={item.to} className="breadcrumb-link">{item.label}</Link>
              )}
              {!isLast && <span aria-hidden="true" className="breadcrumb-sep">›</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
