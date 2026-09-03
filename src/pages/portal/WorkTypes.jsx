// DPR Work Type Configuration — PMC Civil Engineering Standard
// Organized by 4 sections with 15 work types

export const WORK_TYPE_SECTIONS = {
  MATERIAL_RECEIPT: {
    label: 'Material Receipt & Inspection',
    icon: '📦',
    color: '#3b82f6',
    workTypes: ['material_inspection', 'cement_receipt', 'steel_receipt', 'bulk_materials', 'concrete_receipt', 'other_bulk_materials'],
  },
  QUALITY_TESTING: {
    label: 'Quality & Testing',
    icon: '🔬',
    color: '#8b5cf6',
    workTypes: ['water_quality', 'cube_casting', 'cube_testing'],
  },
  SITE_INSPECTION: {
    label: 'Site Inspection',
    icon: '🏗️',
    color: '#f59e0b',
    workTypes: ['villa_inspection', 'day_activity_inspection', 'waterproofing_inspection'],
  },
  EXCEPTIONS_SAFETY: {
    label: 'Exceptions & Safety',
    icon: '⚠️',
    color: '#ef4444',
    workTypes: ['major_deviation', 'ncr', 'safety_violation'],
  },
};

export const WORK_TYPE_OPTIONS = [
  { value: 'MATERIAL_RECEIPT', label: 'Material Receipt & Inspection' },
  { value: 'QUALITY_TESTING', label: 'Quality & Testing' },
  { value: 'SITE_INSPECTION', label: 'Site Inspection' },
  { value: 'EXCEPTIONS_SAFETY', label: 'Exceptions & Safety' },
];

// Sub-work types within each section
export const SUB_WORK_TYPE_OPTIONS = [
  // MATERIAL_RECEIPT
  { value: 'material_inspection', label: 'Material Inspection', section: 'MATERIAL_RECEIPT' },
  { value: 'cement_receipt', label: 'Cement Receipt', section: 'MATERIAL_RECEIPT' },
  { value: 'steel_receipt', label: 'Steel Receipt (with MTC)', section: 'MATERIAL_RECEIPT' },
  { value: 'bulk_materials', label: 'Bulk Materials (ITP)', section: 'MATERIAL_RECEIPT' },
  { value: 'concrete_receipt', label: 'Concrete Receipt', section: 'MATERIAL_RECEIPT' },
  { value: 'other_bulk_materials', label: 'Other Bulk Materials', section: 'MATERIAL_RECEIPT' },
  // QUALITY_TESTING
  { value: 'water_quality', label: 'Water Quality (ITP)', section: 'QUALITY_TESTING' },
  { value: 'cube_casting', label: 'Cube Casting', section: 'QUALITY_TESTING' },
  { value: 'cube_testing', label: 'Cube Testing', section: 'QUALITY_TESTING' },
  // SITE_INSPECTION
  { value: 'villa_inspection', label: 'Villa/Unit Inspection', section: 'SITE_INSPECTION' },
  { value: 'day_activity_inspection', label: 'Day Activity Inspection', section: 'SITE_INSPECTION' },
  { value: 'waterproofing_inspection', label: 'Waterproofing Inspection', section: 'SITE_INSPECTION' },
  // EXCEPTIONS_SAFETY
  { value: 'major_deviation', label: 'Major Deviation', section: 'EXCEPTIONS_SAFETY' },
  { value: 'ncr', label: 'Non-Conformity Report', section: 'EXCEPTIONS_SAFETY' },
  { value: 'safety_violation', label: 'Safety Violation', section: 'EXCEPTIONS_SAFETY' },
];

// Field definitions per sub-work type
export const WORK_TYPE_FIELDS = {
  // ─── MATERIAL RECEIPT & INSPECTION ───────────────────────────────────────────

  material_inspection: {
    label: 'Material Inspection for the Day',
    fields: [
      { name: 'materialType', label: 'Material Type', type: 'select', required: true, options: ['Cement', 'Steel', 'Sand', 'Aggregates', 'Brick', 'Blocks', 'Tiles', 'Paint', 'Admixture', 'Other'] },
      { name: 'supplierName', label: 'Supplier Name', type: 'text', required: true },
      { name: 'invoiceNumber', label: 'Invoice / Chalan No.', type: 'text', required: true },
      { name: 'quantityReceived', label: 'Quantity Received', type: 'number', required: true },
      { name: 'unit', label: 'Unit', type: 'select', required: true, options: ['MT', 'Bags', 'Cu.m', 'Nos', 'Kg'] },
      { name: 'visualInspectionStatus', label: 'Visual Inspection', type: 'select', required: true, options: ['Pass', 'Fail', 'Partial'] },
      { name: 'inspectedBy', label: 'Inspected By', type: 'text', required: true },
      { name: 'remarks', label: 'Remarks/Observations', type: 'textarea', required: false },
    ],
  },

  cement_receipt: {
    label: 'Cement Receipt',
    fields: [
      { name: 'supplierName', label: 'Supplier Name', type: 'text', required: true },
      { name: 'invoiceNumber', label: 'Invoice / Chalan No.', type: 'text', required: true },
      { name: 'quantityReceived', label: 'Quantity (Bags)', type: 'number', required: true },
      { name: 'cementGrade', label: 'Grade/Type', type: 'select', required: true, options: ['OPC 53S', 'OPC 43S', 'PPC', 'PSC', 'OPC 33S'] },
      { name: 'brand', label: 'Brand', type: 'select', required: true, options: ['ACC', 'UltraTech', 'Ambuja', 'Lafarge', 'Birla', 'Ramco', 'Chettinad', 'Other'] },
      { name: 'manufacturingDate', label: 'Manufacturing Date', type: 'date', required: true },
      { name: 'physicalCondition', label: 'Physical Condition', type: 'select', required: true, options: ['Good', 'Moisture Affected', 'Lumpy', 'Foreign Matter'] },
      { name: 'storedProperly', label: 'Stored Properly (Raised/Covered)', type: 'select', required: true, options: ['Yes', 'No'] },
      { name: 'remarks', label: 'Remarks', type: 'textarea', required: false },
    ],
  },

  steel_receipt: {
    label: 'Steel Receipt (MTC Verification)',
    isCritical: true,
    fields: [
      { name: 'supplierName', label: 'Supplier Name', type: 'text', required: true },
      { name: 'invoiceNumber', label: 'Invoice / Chalan No.', type: 'text', required: true },
      { name: 'quantityReceived', label: 'Quantity (MT)', type: 'number', required: true },
      { name: 'steelGrade', label: 'Grade', type: 'select', required: true, options: ['Fe415', 'Fe500', 'Fe500D', 'Fe550', 'Fe550D', 'TMT500', 'TMT550'] },
      { name: 'brand', label: 'Brand', type: 'select', required: true, options: ['TATA Tiscon', 'SAIL', 'JSW', 'Jindal', 'Kamdhenu', 'Primary Steel', 'Other'] },
      { name: 'batchNumber', label: 'Batch/Lot/Heat No.', type: 'text', required: true },
      { name: 'diameter', label: 'Diameter (mm)', type: 'select', required: true, options: ['6', '8', '10', '12', '16', '20', '25', '28', '32', '36'] },
      { name: 'mtcReceived', label: 'MTC Received', type: 'select', required: true, options: ['Yes', 'No'] },
      { name: 'mtcReferenceNumber', label: 'MTC Reference No.', type: 'text', required: false },
      { name: 'mtcVerified', label: 'MTC Verified Against Spec', type: 'select', required: true, options: ['Yes', 'No', 'Pending'] },
      { name: 'physicalDiameterCheck', label: 'Actual Diameter Check', type: 'select', required: true, options: ['Conform', 'Non-Conform'] },
      { name: 'rustPresent', label: 'Rust Present', type: 'select', required: true, options: ['None', 'Light Surface', 'Heavy', 'Scales'] },
      { name: 'bendsOrDamage', label: 'Bends/Damage', type: 'select', required: true, options: ['None', 'Minor', 'Major'] },
      { name: 'markingVerified', label: 'Grade Marking Visible', type: 'select', required: true, options: ['Yes', 'No'] },
      { name: 'overallStatus', label: 'Overall Status', type: 'select', required: true, options: ['Approved', 'Unapproved', 'Conditional Approval'] },
      { name: 'reasonIfUnapproved', label: 'Reason if Unapproved', type: 'textarea', required: false },
      { name: 'remarks', label: 'Remarks', type: 'textarea', required: false },
    ],
  },

  bulk_materials: {
    label: 'Bulk Materials Received (ITP)',
    fields: [
      { name: 'materialType', label: 'Material Type', type: 'select', required: true, options: ['River Sand', 'M-Sand', 'Crushed Aggregates', 'Fly Ash', 'GGBS', 'Cement Bulk', 'Other'] },
      { name: 'supplierName', label: 'Supplier/Quarry Name', type: 'text', required: true },
      { name: 'sourceLocation', label: 'Source/Quarry Location', type: 'text', required: true },
      { name: 'invoiceNumber', label: 'Invoice / Chalan No.', type: 'text', required: true },
      { name: 'quantityReceived', label: 'Quantity', type: 'number', required: true },
      { name: 'unit', label: 'Unit', type: 'select', required: true, options: ['Cu.m', 'MT', 'Bags'] },
      { name: 'itpReference', label: 'ITP Reference No.', type: 'text', required: true },
      { name: 'inspectionCriteria', label: 'Inspection Criteria', type: 'textarea', required: true },
      { name: 'physicalInspection', label: 'Physical Inspection as per ITP', type: 'select', required: true, options: ['Pass', 'Fail'] },
      { name: 'fmValue', label: 'FM Value (if applicable)', type: 'number', required: false },
      { name: 'moistureContent', label: 'Moisture Content %', type: 'number', required: false },
      { name: 'remarks', label: 'Remarks', type: 'textarea', required: false },
    ],
  },

  concrete_receipt: {
    label: 'Concrete Receipt',
    fields: [
      { name: 'supplierName', label: 'RMC Plant/Supplier', type: 'text', required: true },
      { name: 'invoiceNumber', label: 'Delivery Challan No.', type: 'text', required: true },
      { name: 'mixDesignReference', label: 'Mix Design Reference', type: 'text', required: true },
      { name: 'mixApproved', label: 'Mix Design Approved', type: 'select', required: true, options: ['Yes', 'No', 'Pending'] },
      { name: 'grade', label: 'Grade (M-Size)', type: 'select', required: true, options: ['M15', 'M20', 'M25', 'M30', 'M35', 'M40', 'M45', 'M50'] },
      { name: 'quantity', label: 'Quantity (Cu.m)', type: 'number', required: true },
      { name: 'slumpAtDispatch', label: 'Slump at Dispatch (mm)', type: 'number', required: true },
      { name: 'slumpAtSite', label: 'Slump at Site (mm)', type: 'number', required: true },
      { name: 'pourLocation', label: 'Pour Location (Villa/Unit)', type: 'text', required: true },
      { name: 'pourActivity', label: 'Pour Activity', type: 'select', required: true, options: ['Column', 'Slab', 'Beam', 'Footing', 'Wall', 'Staircase', 'RCC Pad', 'Plinth', 'Other'] },
      { name: 'transitTime', label: 'Transit Time (hrs)', type: 'number', required: true },
      { name: 'vehicleNumber', label: 'Vehicle/Truck No.', type: 'text', required: true },
      { name: 'remarks', label: 'Remarks', type: 'textarea', required: false },
    ],
  },

  other_bulk_materials: {
    label: 'Other Bulk Materials',
    fields: [
      { name: 'materialType', label: 'Material Type', type: 'text', required: true },
      { name: 'supplierName', label: 'Supplier Name', type: 'text', required: true },
      { name: 'invoiceNumber', label: 'Invoice / Chalan No.', type: 'text', required: true },
      { name: 'quantityReceived', label: 'Quantity', type: 'number', required: true },
      { name: 'unit', label: 'Unit', type: 'text', required: true },
      { name: 'inspectionCriteria', label: 'Specific Inspection Criteria', type: 'textarea', required: true },
      { name: 'inspectionStatus', label: 'Inspection Status', type: 'select', required: true, options: ['Pass', 'Fail'] },
      { name: 'remarks', label: 'Remarks', type: 'textarea', required: false },
    ],
  },

  // ─── QUALITY & TESTING ───────────────────────────────────────────────────────

  water_quality: {
    label: 'Water Quality Inspection (ITP)',
    fields: [
      { name: 'source', label: 'Water Source', type: 'select', required: true, options: ['Borewell', 'Municipal Supply', 'Tanker', 'River', 'Recycled', 'Other'] },
      { name: 'sampleCollectionPoint', label: 'Sample Collection Point', type: 'text', required: true },
      { name: 'itpReference', label: 'ITP Reference', type: 'text', required: true },
      { name: 'phValue', label: 'pH Value', type: 'number', required: true },
      { name: 'chlorideContent', label: 'Chloride Content (ppm)', type: 'number', required: true },
      { name: 'sulphateContent', label: 'Sulphate Content (ppm)', type: 'number', required: true },
      { name: 'totalDissolvedSolids', label: 'Total Dissolved Solids (ppm)', type: 'number', required: false },
      { name: 'otherTestsConducted', label: 'Other Tests Conducted', type: 'textarea', required: false },
      { name: 'overallStatus', label: 'Overall Status', type: 'select', required: true, options: ['Pass', 'Fail'] },
      { name: 'labReference', label: 'Lab Reference No. (if sent)', type: 'text', required: false },
      { name: 'remarks', label: 'Remarks', type: 'textarea', required: false },
    ],
  },

  cube_casting: {
    label: 'Cube Casting (ITP)',
    fields: [
      { name: 'cubeId', label: 'Cube Identification No.', type: 'text', required: true, placeholder: 'e.g., C-2024-001' },
      { name: 'grade', label: 'Grade of Concrete', type: 'select', required: true, options: ['M15', 'M20', 'M25', 'M30', 'M35', 'M40', 'M45', 'M50'] },
      { name: 'pourLocation', label: 'Pour Location (Villa/Unit)', type: 'text', required: true },
      { name: 'pourActivity', label: 'Pour Activity', type: 'select', required: true, options: ['Column', 'Slab', 'Beam', 'Footing', 'Wall', 'Staircase', 'RCC Pad', 'Plinth', 'Other'] },
      { name: 'quantityOfConcrete', label: 'Qty of Concrete Used (Cu.m)', type: 'number', required: true },
      { name: 'cubeSize', label: 'Cube Size', type: 'select', required: true, options: ['150mm x 150mm x 150mm', '100mm x 100mm x 100mm'] },
      { name: 'numberOfCubes', label: 'Number of Cubes Cast', type: 'number', required: true },
      { name: 'curingMethod', label: 'Curing Method', type: 'select', required: true, options: ['Ponding', 'Sprinkling', 'Wet Hessian', 'Curing Compound', 'Steam Curing'] },
      { name: 'daysToTest', label: 'Days to Test', type: 'select', required: true, options: ['7 Days', '14 Days', '28 Days', '56 Days', 'Other'] },
      { name: 'mixDesignRef', label: 'Mix Design Reference', type: 'text', required: true },
      { name: 'slumpRecorded', label: 'Slump Recorded (mm)', type: 'number', required: true },
      { name: 'castBy', label: 'Cast By (Name)', type: 'text', required: true },
      { name: 'supervisedBy', label: 'Supervised By (Name)', type: 'text', required: true },
      { name: 'remarks', label: 'Remarks', type: 'textarea', required: false },
    ],
  },

  cube_testing: {
    label: 'Cube Testing Conducted',
    isCritical: true,
    fields: [
      { name: 'cubeId', label: 'Cube Identification No.', type: 'text', required: true },
      { name: 'grade', label: 'Grade', type: 'select', required: true, options: ['M15', 'M20', 'M25', 'M30', 'M35', 'M40', 'M45', 'M50'] },
      { name: 'ageOfCube', label: 'Age of Cube (Days)', type: 'number', required: true },
      { name: 'castingDate', label: 'Casting Date', type: 'date', required: true },
      { name: 'loadAtFailure', label: 'Load at Failure (kN)', type: 'number', required: true },
      { name: 'compressiveStrength', label: 'Compressive Strength (N/mm²)', type: 'number', required: true },
      { name: 'requiredStrength', label: 'Required Strength (N/mm²)', type: 'number', required: true },
      { name: 'percentageOfRequired', label: '% of Required Strength', type: 'number', required: true },
      { name: 'result', label: 'Result', type: 'select', required: true, options: ['Pass', 'Fail'] },
      { name: 'testingMachineId', label: 'Testing Machine ID', type: 'text', required: true },
      { name: 'testedBy', label: 'Tested By', type: 'text', required: true },
      { name: 'remarks', label: 'Remarks', type: 'textarea', required: false },
    ],
  },

  // ─── SITE INSPECTION ────────────────────────────────────────────────────────

  villa_inspection: {
    label: 'Site Inspection - Villa/Unit',
    fields: [
      { name: 'villaUnitNumber', label: 'Villa/Unit Number', type: 'text', required: true },
      { name: 'stageOfConstruction', label: 'Stage of Construction', type: 'select', required: true, options: ['Foundation', 'Plinth', 'Columns', 'Slab Casting', 'Brick Work', 'Plastering', 'Flooring', 'Finishing', 'Handover', 'Defect Liability'] },
      { name: 'activitiesInspected', label: 'Activities Inspected', type: 'textarea', required: true },
      { name: 'complianceStatus', label: 'Compliance Status', type: 'select', required: true, options: ['Complying', 'Non-Complying', 'Partial'] },
      { name: 'observations', label: 'Observations', type: 'textarea', required: true },
      { name: 'specificationReference', label: 'Project Specification Reference', type: 'text', required: false },
      { name: 'inspectedBy', label: 'Inspected By', type: 'text', required: true },
      { name: 'remarks', label: 'Remarks', type: 'textarea', required: false },
    ],
  },

  day_activity_inspection: {
    label: 'Physical Inspection of Day Activity',
    fields: [
      { name: 'activityType', label: 'Activity Type', type: 'select', required: true, options: ['Excavation', 'Shuttering', 'Reinforcement', 'Concrete Pouring', 'Curing', 'Brick Work', 'Plastering', 'Waterproofing', 'Flooring', 'Plumbing', 'Electrical', 'Painting', 'Other'] },
      { name: 'location', label: 'Location/Area', type: 'text', required: true },
      { name: 'checklistItems', label: 'Inspection Checklist', type: 'checklist', required: true, options: ['As per drawings', 'As per specifications', 'Material quality verified', 'Workmanship acceptable', 'Safety norms followed', 'ITP requirements met', 'QA/QC parameters checked'] },
      { name: 'overallStatus', label: 'Overall Status', type: 'select', required: true, options: ['Pass', 'Fail', 'Conditional'] },
      { name: 'observations', label: 'Detailed Observations', type: 'textarea', required: true },
      { name: 'inspectedBy', label: 'Inspected By', type: 'text', required: true },
      { name: 'remarks', label: 'Remarks', type: 'textarea', required: false },
    ],
  },

  waterproofing_inspection: {
    label: 'Water Proofing Inspection',
    isCritical: true,
    fields: [
      { name: 'villaUnitNumber', label: 'Villa/Unit Number', type: 'text', required: true },
      { name: 'areaInspected', label: 'Area Inspected', type: 'select', required: true, options: ['Roof/Terrace', 'Bathroom', 'Kitchen', 'Balcony', 'Compound Wall', 'Basement', 'Water Tank', 'Sump', 'Other'] },
      { name: 'stage', label: 'Waterproofing Stage', type: 'select', required: true, options: ['Before Application', 'During Application', 'After Application - Before Backfill', 'After Complete'] },
      { name: 'materialUsed', label: 'Material/Brand Used', type: 'text', required: true },
      { name: 'methodStatementRef', label: 'Method Statement Reference', type: 'text', required: false },
      { name: 'surfacePreparation', label: 'Surface Preparation', type: 'select', required: true, options: ['Satisfactory', 'Unsatisfactory'] },
      { name: 'applicationMethod', label: 'Application Method', type: 'select', required: true, options: ['Brush', 'Roller', 'Spray', 'Trowel', 'Membrane'] },
      { name: 'coverageThickness', label: 'Coverage/Thickness', type: 'text', required: true },
      { name: 'visualInspection', label: 'Visual Inspection Status', type: 'select', required: true, options: ['Pass', 'Fail'] },
      { name: 'waterTestConducted', label: 'Water Test Conducted', type: 'select', required: true, options: ['Yes', 'No'] },
      { name: 'waterTestResult', label: 'Water Test Result', type: 'select', required: false, options: ['Pass', 'Fail', 'No Leakage', 'Leakage Observed'] },
      { name: 'noOfCoats', label: 'Number of Coats Applied', type: 'number', required: true },
      { name: 'intervalBetweenCoats', label: 'Interval Between Coats (hrs)', type: 'number', required: false },
      { name: 'reinforcementMesh', label: 'Reinforcement Mesh Laid', type: 'select', required: false, options: ['Yes', 'No', 'NA'] },
      { name: 'inspectedBy', label: 'Inspected By', type: 'text', required: true },
      { name: 'remarks', label: 'Remarks', type: 'textarea', required: false },
    ],
  },

  // ─── EXCEPTIONS & SAFETY ────────────────────────────────────────────────────

  major_deviation: {
    label: 'Record of Major Deviation',
    isCritical: true,
    fields: [
      { name: 'location', label: 'Location (Villa/Unit/Area)', type: 'text', required: true },
      { name: 'descriptionOfDeviation', label: 'Description of Deviation', type: 'textarea', required: true },
      { name: 'referenceSpec', label: 'Reference to Spec/Standard', type: 'text', required: true },
      { name: 'deviationCategory', label: 'Category', type: 'select', required: true, options: ['Design Change', 'Material Substitution', 'Workmanship', 'Specification Breach', 'Method Deviation', 'Other'] },
      { name: 'impactAssessment', label: 'Impact Assessment', type: 'select', required: true, options: ['Minor', 'Major', 'Critical'] },
      { name: 'structuralImpact', label: 'Structural Impact', type: 'select', required: true, options: ['None', 'Minor', 'Significant', 'Severe'] },
      { name: 'recommendedAction', label: 'Recommended Action', type: 'textarea', required: true },
      { name: 'immediateActionTaken', label: 'Immediate Action Taken', type: 'textarea', required: false },
      { name: 'photographRef', label: 'Photograph Reference', type: 'text', required: false },
      { name: 'recordedBy', label: 'Recorded By', type: 'text', required: true },
      { name: 'acknowledgedBy', label: 'Acknowledged By (Contractor)', type: 'text', required: true },
      { name: 'status', label: 'Status', type: 'select', required: true, options: ['Open', 'Under Review', 'Resolved', 'Closed'] },
      { name: 'remarks', label: 'Remarks', type: 'textarea', required: false },
    ],
  },

  ncr: {
    label: 'Non-Conformity Report (NCR)',
    isCritical: true,
    fields: [
      { name: 'location', label: 'Location (Villa/Unit)', type: 'text', required: true },
      { name: 'description', label: 'Description of Non-Conformance', type: 'textarea', required: true },
      { name: 'referenceStandard', label: 'Reference Standard/Spec', type: 'text', required: true },
      { name: 'category', label: 'Category', type: 'select', required: true, options: ['Material', 'Workmanship', 'Design', 'Equipment', 'Personnel', 'Method', 'Other'] },
      { name: 'identifiedBy', label: 'Identified By', type: 'select', required: true, options: ['PMC Engineer', 'QA/QC Engineer', 'Client Representative', 'Contractor', 'Third Party', 'Other'] },
      { name: 'rootCauseAnalysis', label: 'Root Cause Analysis', type: 'textarea', required: true },
      { name: 'immediateContainment', label: 'Immediate Containment Action', type: 'textarea', required: true },
      { name: 'proposedCorrectiveAction', label: 'Proposed Corrective Action', type: 'textarea', required: true },
      { name: 'preventiveAction', label: 'Preventive Action', type: 'textarea', required: true },
      { name: 'responsibility', label: 'Responsibility', type: 'text', required: true },
      { name: 'targetDate', label: 'Target Completion Date', type: 'date', required: true },
      { name: 'status', label: 'Status', type: 'select', required: true, options: ['Open', 'In Progress', 'Pending Verification', 'Closed', 'Rejected'] },
      { name: 'verifiedBy', label: 'Verified By', type: 'text', required: false },
      { name: 'closureRemarks', label: 'Closure Remarks', type: 'textarea', required: false },
      { name: 'remarks', label: 'Additional Remarks', type: 'textarea', required: false },
    ],
  },

  safety_violation: {
    label: 'Safety Violation',
    isCritical: true,
    fields: [
      { name: 'violationTime', label: 'Time', type: 'time', required: true },
      { name: 'location', label: 'Location', type: 'text', required: true },
      { name: 'violationType', label: 'Type of Violation', type: 'select', required: true, options: ['PPE Violation', 'Fall Protection', 'Electrical Hazard', 'Housekeeping', 'Fire Safety', 'Environmental', 'Scaffolding', 'Excavation', 'Lifting Operations', 'Confined Space', 'Traffic Management', 'Other'] },
      { name: 'description', label: 'Description of Violation', type: 'textarea', required: true },
      { name: 'severity', label: 'Severity', type: 'select', required: true, options: ['Near Miss', 'Minor', 'Major', 'Critical'] },
      { name: 'personsInvolved', label: 'Persons Involved (Name/Mob No.)', type: 'textarea', required: true },
      { name: 'contractorOrWorker', label: 'Violation Issued To', type: 'select', required: true, options: ['Main Contractor', 'Sub-Contractor', 'Worker', 'Visitor', 'Driver', 'Other'] },
      { name: 'immediateAction', label: 'Immediate Action Taken', type: 'textarea', required: true },
      { name: 'stopWorkOrder', label: 'Stop Work Order Issued', type: 'select', required: true, options: ['Yes', 'No'] },
      { name: 'photographRef', label: 'Photograph Reference', type: 'text', required: false },
      { name: 'fineAmount', label: 'Fine Amount (Rs.)', type: 'number', required: false },
      { name: 'actionStatus', label: 'Action Status', type: 'select', required: true, options: ['Pending', 'Under Investigation', 'Action Taken', 'Closed'] },
      { name: 'safetyOfficer', label: 'Safety Officer/Site Engineer', type: 'text', required: true },
      { name: 'remarks', label: 'Remarks', type: 'textarea', required: false },
    ],
  },
};
