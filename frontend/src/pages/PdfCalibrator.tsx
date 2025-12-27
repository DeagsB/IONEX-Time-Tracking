import { useState, useRef, useEffect } from 'react';

// Field definitions with bounding boxes (x, y is bottom-left corner in PDF coordinates)
const INITIAL_FIELDS: { [key: string]: { x: number; y: number; width: number; height: number; label: string; color: string } } = {
  ticketNumber: { x: 500, y: 748, width: 90, height: 14, label: 'Ticket #', color: '#ff6b6b' },
  customerName: { x: 415, y: 688, width: 175, height: 12, label: 'Customer Name', color: '#4ecdc4' },
  billingAddress: { x: 415, y: 672, width: 175, height: 12, label: 'Billing Address', color: '#4ecdc4' },
  cityProvince: { x: 415, y: 656, width: 175, height: 12, label: 'City/Province', color: '#4ecdc4' },
  postalCode: { x: 415, y: 640, width: 175, height: 12, label: 'Postal Code', color: '#4ecdc4' },
  contactName: { x: 415, y: 624, width: 175, height: 12, label: 'Contact Name', color: '#4ecdc4' },
  contactPhone: { x: 415, y: 608, width: 175, height: 12, label: 'Contact Phone', color: '#4ecdc4' },
  contactEmail: { x: 415, y: 592, width: 175, height: 12, label: 'Contact Email', color: '#4ecdc4' },
  serviceLocation: { x: 415, y: 576, width: 175, height: 12, label: 'Service Location', color: '#4ecdc4' },
  poCcAfe: { x: 415, y: 560, width: 175, height: 12, label: 'PO/CC/AFE', color: '#4ecdc4' },
  jobId: { x: 80, y: 622, width: 80, height: 12, label: 'Job ID', color: '#ffe66d' },
  jobType: { x: 200, y: 622, width: 80, height: 12, label: 'Job Type', color: '#ffe66d' },
  techName: { x: 80, y: 604, width: 160, height: 12, label: 'Tech', color: '#ffe66d' },
  date: { x: 80, y: 586, width: 80, height: 12, label: 'Date', color: '#ffe66d' },
  descRow1: { x: 55, y: 532, width: 350, height: 12, label: 'Desc Row 1', color: '#a29bfe' },
  descRow2: { x: 55, y: 518, width: 350, height: 12, label: 'Desc Row 2', color: '#a29bfe' },
  rtColumn: { x: 420, y: 532, width: 30, height: 12, label: 'RT', color: '#74b9ff' },
  ttColumn: { x: 455, y: 532, width: 30, height: 12, label: 'TT', color: '#74b9ff' },
  ftColumn: { x: 490, y: 532, width: 30, height: 12, label: 'FT', color: '#74b9ff' },
  otColumn: { x: 525, y: 532, width: 30, height: 12, label: 'OT', color: '#74b9ff' },
  totalRtHours: { x: 420, y: 395, width: 30, height: 12, label: 'Tot RT Hrs', color: '#fd79a8' },
  totalTtHours: { x: 455, y: 395, width: 30, height: 12, label: 'Tot TT Hrs', color: '#fd79a8' },
  totalFtHours: { x: 490, y: 395, width: 30, height: 12, label: 'Tot FT Hrs', color: '#fd79a8' },
  totalOtHours: { x: 525, y: 395, width: 30, height: 12, label: 'Tot OT Hrs', color: '#fd79a8' },
  rtRate: { x: 120, y: 375, width: 50, height: 12, label: 'RT Rate', color: '#00cec9' },
  ftRate: { x: 265, y: 375, width: 50, height: 12, label: 'FT Rate', color: '#00cec9' },
  sumRt: { x: 500, y: 238, width: 80, height: 12, label: 'Sum RT $', color: '#e17055' },
  sumTt: { x: 500, y: 223, width: 80, height: 12, label: 'Sum TT $', color: '#e17055' },
  sumFt: { x: 500, y: 208, width: 80, height: 12, label: 'Sum FT $', color: '#e17055' },
  sumOt: { x: 500, y: 193, width: 80, height: 12, label: 'Sum OT $', color: '#e17055' },
  sumExpenses: { x: 500, y: 178, width: 80, height: 12, label: 'Sum Expenses', color: '#e17055' },
  grandTotal: { x: 500, y: 158, width: 80, height: 14, label: 'Grand Total', color: '#e17055' },
  afeValue: { x: 80, y: 218, width: 100, height: 12, label: 'AFE', color: '#81ecec' },
  ccValue: { x: 80, y: 198, width: 100, height: 12, label: 'CC', color: '#81ecec' },
};

// PDF dimensions
const PDF_WIDTH = 612;
const PDF_HEIGHT = 792;

const GRID_SIZE = 5;

const snapToGrid = (value: number): number => {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
};

type DragMode = 'move' | 'resize-right' | 'resize-bottom' | 'resize-corner' | null;

export default function PdfCalibrator() {
  const [fields, setFields] = useState(INITIAL_FIELDS);
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [showGrid, setShowGrid] = useState(false);
  const [opacity, setOpacity] = useState(0.4);
  const containerRef = useRef<HTMLDivElement>(null);
  const pdfContainerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [dragMode, setDragMode] = useState<DragMode>(null);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [fieldStart, setFieldStart] = useState({ x: 0, y: 0, width: 0, height: 0 });

  // Convert PDF coordinates to screen coordinates (PDF y=0 is bottom)
  const pdfToScreen = (x: number, y: number, height: number) => ({
    x: x * scale,
    y: (PDF_HEIGHT - y - height) * scale,
  });

  const screenToPdfDelta = (dx: number, dy: number) => ({
    dx: snapToGrid(dx / scale),
    dy: snapToGrid(-dy / scale), // Flip Y
  });

  const handleMouseDown = (e: React.MouseEvent, fieldKey: string, mode: DragMode) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedField(fieldKey);
    setDragMode(mode);
    setDragStart({ x: e.clientX, y: e.clientY });
    setFieldStart({
      x: fields[fieldKey].x,
      y: fields[fieldKey].y,
      width: fields[fieldKey].width,
      height: fields[fieldKey].height,
    });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragMode || !selectedField) return;

    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    const { dx: pdfDx, dy: pdfDy } = screenToPdfDelta(dx, dy);

    setFields((prev) => {
      const field = { ...prev[selectedField] };
      
      if (dragMode === 'move') {
        field.x = Math.max(0, Math.min(PDF_WIDTH - field.width, fieldStart.x + pdfDx));
        field.y = Math.max(0, Math.min(PDF_HEIGHT - field.height, fieldStart.y + pdfDy));
      } else if (dragMode === 'resize-right') {
        field.width = Math.max(20, snapToGrid(fieldStart.width + pdfDx));
      } else if (dragMode === 'resize-bottom') {
        field.height = Math.max(8, snapToGrid(fieldStart.height - pdfDy));
        field.y = fieldStart.y + pdfDy;
      } else if (dragMode === 'resize-corner') {
        field.width = Math.max(20, snapToGrid(fieldStart.width + pdfDx));
        field.height = Math.max(8, snapToGrid(fieldStart.height - pdfDy));
        field.y = fieldStart.y + pdfDy;
      }

      return { ...prev, [selectedField]: field };
    });
  };

  const handleMouseUp = () => {
    setDragMode(null);
  };

  // Generate code output
  const generateCode = () => {
    const code = `// PDF Field Layout Coordinates (x, y = bottom-left corner)
const LAYOUT = {
  ticketNumber: { x: ${fields.ticketNumber.x}, y: ${fields.ticketNumber.y}, w: ${fields.ticketNumber.width}, h: ${fields.ticketNumber.height} },
  
  // Customer section
  customerName: { x: ${fields.customerName.x}, y: ${fields.customerName.y}, w: ${fields.customerName.width} },
  billingAddress: { x: ${fields.billingAddress.x}, y: ${fields.billingAddress.y}, w: ${fields.billingAddress.width} },
  cityProvince: { x: ${fields.cityProvince.x}, y: ${fields.cityProvince.y}, w: ${fields.cityProvince.width} },
  postalCode: { x: ${fields.postalCode.x}, y: ${fields.postalCode.y}, w: ${fields.postalCode.width} },
  contactName: { x: ${fields.contactName.x}, y: ${fields.contactName.y}, w: ${fields.contactName.width} },
  contactPhone: { x: ${fields.contactPhone.x}, y: ${fields.contactPhone.y}, w: ${fields.contactPhone.width} },
  contactEmail: { x: ${fields.contactEmail.x}, y: ${fields.contactEmail.y}, w: ${fields.contactEmail.width} },
  serviceLocation: { x: ${fields.serviceLocation.x}, y: ${fields.serviceLocation.y}, w: ${fields.serviceLocation.width} },
  poCcAfe: { x: ${fields.poCcAfe.x}, y: ${fields.poCcAfe.y}, w: ${fields.poCcAfe.width} },
  
  // Service Info
  jobId: { x: ${fields.jobId.x}, y: ${fields.jobId.y}, w: ${fields.jobId.width} },
  jobType: { x: ${fields.jobType.x}, y: ${fields.jobType.y}, w: ${fields.jobType.width} },
  techName: { x: ${fields.techName.x}, y: ${fields.techName.y}, w: ${fields.techName.width} },
  date: { x: ${fields.date.x}, y: ${fields.date.y}, w: ${fields.date.width} },
  
  // Description rows
  descRow1: { x: ${fields.descRow1.x}, y: ${fields.descRow1.y}, w: ${fields.descRow1.width} },
  descRow2: { x: ${fields.descRow2.x}, y: ${fields.descRow2.y}, w: ${fields.descRow2.width} },
  
  // Hours columns
  rtColumn: { x: ${fields.rtColumn.x}, y: ${fields.rtColumn.y}, w: ${fields.rtColumn.width} },
  ttColumn: { x: ${fields.ttColumn.x}, y: ${fields.ttColumn.y}, w: ${fields.ttColumn.width} },
  ftColumn: { x: ${fields.ftColumn.x}, y: ${fields.ftColumn.y}, w: ${fields.ftColumn.width} },
  otColumn: { x: ${fields.otColumn.x}, y: ${fields.otColumn.y}, w: ${fields.otColumn.width} },
  
  // Hour totals
  totalRtHours: { x: ${fields.totalRtHours.x}, y: ${fields.totalRtHours.y} },
  totalTtHours: { x: ${fields.totalTtHours.x}, y: ${fields.totalTtHours.y} },
  totalFtHours: { x: ${fields.totalFtHours.x}, y: ${fields.totalFtHours.y} },
  totalOtHours: { x: ${fields.totalOtHours.x}, y: ${fields.totalOtHours.y} },
  
  // Rates
  rtRate: { x: ${fields.rtRate.x}, y: ${fields.rtRate.y} },
  ftRate: { x: ${fields.ftRate.x}, y: ${fields.ftRate.y} },
  
  // Summary amounts
  sumRt: { x: ${fields.sumRt.x}, y: ${fields.sumRt.y} },
  sumTt: { x: ${fields.sumTt.x}, y: ${fields.sumTt.y} },
  sumFt: { x: ${fields.sumFt.x}, y: ${fields.sumFt.y} },
  sumOt: { x: ${fields.sumOt.x}, y: ${fields.sumOt.y} },
  sumExpenses: { x: ${fields.sumExpenses.x}, y: ${fields.sumExpenses.y} },
  grandTotal: { x: ${fields.grandTotal.x}, y: ${fields.grandTotal.y} },
  
  // Customer Approval
  afeValue: { x: ${fields.afeValue.x}, y: ${fields.afeValue.y} },
  ccValue: { x: ${fields.ccValue.x}, y: ${fields.ccValue.y} },
};`;
    
    navigator.clipboard.writeText(code);
    alert('Coordinates copied to clipboard!');
  };

  // Calculate scale based on window height
  useEffect(() => {
    const updateScale = () => {
      const availableHeight = window.innerHeight - 140;
      const newScale = Math.min(availableHeight / PDF_HEIGHT, 1.3);
      setScale(Math.max(0.8, newScale));
    };
    
    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, []);

  // Scroll to top on mount
  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, []);

  return (
    <div style={{ padding: '16px', height: 'calc(100vh - 80px)', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '10px' }}>
        <h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: '18px' }}>PDF Field Calibrator</h2>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            <input
              type="checkbox"
              checked={showGrid}
              onChange={(e) => setShowGrid(e.target.checked)}
            />
            Grid
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            Opacity:
            <input
              type="range"
              min="0.1"
              max="0.8"
              step="0.1"
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
              style={{ width: '60px' }}
            />
          </label>
          <button className="button button-secondary" onClick={() => setFields(INITIAL_FIELDS)} style={{ padding: '6px 12px', fontSize: '12px' }}>
            Reset
          </button>
          <button className="button button-primary" onClick={generateCode} style={{ backgroundColor: '#4caf50', borderColor: '#4caf50', padding: '6px 12px', fontSize: '12px' }}>
            📋 Copy Coordinates
          </button>
        </div>
      </div>

      <div ref={containerRef} style={{ display: 'flex', gap: '16px', flex: 1, overflow: 'hidden' }}>
        {/* PDF Canvas */}
        <div
          ref={scrollContainerRef}
          style={{
            flex: 1,
            backgroundColor: '#16213e',
            borderRadius: '8px',
            overflow: 'auto',
            padding: '16px',
          }}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <div
            ref={pdfContainerRef}
            style={{
              width: PDF_WIDTH * scale,
              height: PDF_HEIGHT * scale,
              position: 'relative',
              backgroundColor: '#fff',
              boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
              margin: '0 auto',
            }}
          >
            {/* PDF Background */}
            <iframe
              src="/templates/Service-Ticket-Example.pdf#toolbar=0&navpanes=0&scrollbar=0"
              style={{
                width: '100%',
                height: '100%',
                border: 'none',
                pointerEvents: 'none',
              }}
            />

            {/* Grid Overlay */}
            {showGrid && (
              <svg
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: '100%',
                  pointerEvents: 'none',
                }}
              >
                {Array.from({ length: Math.ceil(PDF_WIDTH / 50) + 1 }, (_, i) => (
                  <line
                    key={`v-${i}`}
                    x1={i * 50 * scale}
                    y1={0}
                    x2={i * 50 * scale}
                    y2={PDF_HEIGHT * scale}
                    stroke="rgba(0,100,255,0.3)"
                    strokeWidth={1}
                  />
                ))}
                {Array.from({ length: Math.ceil(PDF_HEIGHT / 50) + 1 }, (_, i) => (
                  <line
                    key={`h-${i}`}
                    x1={0}
                    y1={i * 50 * scale}
                    x2={PDF_WIDTH * scale}
                    y2={i * 50 * scale}
                    stroke="rgba(255,0,100,0.3)"
                    strokeWidth={1}
                  />
                ))}
              </svg>
            )}

            {/* Field rectangles */}
            {Object.entries(fields).map(([key, field]) => {
              const screenPos = pdfToScreen(field.x, field.y, field.height);
              const isSelected = selectedField === key;
              const screenWidth = field.width * scale;
              const screenHeight = field.height * scale;

              return (
                <div
                  key={key}
                  style={{
                    position: 'absolute',
                    left: screenPos.x,
                    top: screenPos.y,
                    width: screenWidth,
                    height: screenHeight,
                    backgroundColor: `${field.color}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`,
                    border: `2px solid ${field.color}`,
                    borderRadius: '2px',
                    cursor: dragMode === 'move' ? 'grabbing' : 'grab',
                    boxShadow: isSelected ? `0 0 0 2px #fff, 0 0 8px ${field.color}` : 'none',
                    zIndex: isSelected ? 100 : 10,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    overflow: 'hidden',
                  }}
                  onMouseDown={(e) => handleMouseDown(e, key, 'move')}
                  onClick={() => setSelectedField(key)}
                >
                  {/* Field label */}
                  <span
                    style={{
                      fontSize: Math.max(8, Math.min(10, screenHeight - 2)),
                      fontWeight: 'bold',
                      color: '#000',
                      textShadow: '0 0 2px #fff, 0 0 2px #fff',
                      whiteSpace: 'nowrap',
                      pointerEvents: 'none',
                      userSelect: 'none',
                    }}
                  >
                    {field.label}
                  </span>

                  {/* Resize handles (only show when selected) */}
                  {isSelected && (
                    <>
                      {/* Right edge resize */}
                      <div
                        onMouseDown={(e) => handleMouseDown(e, key, 'resize-right')}
                        style={{
                          position: 'absolute',
                          right: -4,
                          top: 0,
                          width: 8,
                          height: '100%',
                          cursor: 'ew-resize',
                          backgroundColor: 'transparent',
                        }}
                      />
                      {/* Bottom edge resize */}
                      <div
                        onMouseDown={(e) => handleMouseDown(e, key, 'resize-bottom')}
                        style={{
                          position: 'absolute',
                          left: 0,
                          bottom: -4,
                          width: '100%',
                          height: 8,
                          cursor: 'ns-resize',
                          backgroundColor: 'transparent',
                        }}
                      />
                      {/* Corner resize */}
                      <div
                        onMouseDown={(e) => handleMouseDown(e, key, 'resize-corner')}
                        style={{
                          position: 'absolute',
                          right: -4,
                          bottom: -4,
                          width: 10,
                          height: 10,
                          cursor: 'nwse-resize',
                          backgroundColor: '#fff',
                          border: `2px solid ${field.color}`,
                          borderRadius: '2px',
                        }}
                      />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Field List Sidebar */}
        <div
          style={{
            width: '260px',
            backgroundColor: 'var(--bg-secondary)',
            borderRadius: '8px',
            padding: '12px',
            overflowY: 'auto',
            flexShrink: 0,
          }}
        >
          <h3 style={{ margin: '0 0 12px 0', color: 'var(--text-primary)', fontSize: '13px' }}>Fields</h3>
          
          {Object.entries(fields).map(([key, field]) => (
            <div
              key={key}
              onClick={() => setSelectedField(key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '8px',
                marginBottom: '2px',
                borderRadius: '4px',
                backgroundColor: selectedField === key ? 'var(--primary-light)' : 'transparent',
                cursor: 'pointer',
                border: selectedField === key ? `2px solid ${field.color}` : '2px solid transparent',
              }}
            >
              <div
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: '2px',
                  backgroundColor: field.color,
                  marginRight: '8px',
                  flexShrink: 0,
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '11px', fontWeight: '600', color: 'var(--text-primary)' }}>
                  {field.label}
                </div>
                <div style={{ fontSize: '9px', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                  {field.x}, {field.y} | {field.width}×{field.height}
                </div>
              </div>
            </div>
          ))}
          
          <div style={{ marginTop: '16px', padding: '10px', backgroundColor: 'var(--bg-primary)', borderRadius: '6px', fontSize: '10px', color: 'var(--text-secondary)' }}>
            <strong>How to use:</strong>
            <ul style={{ margin: '6px 0 0 0', paddingLeft: '14px', lineHeight: '1.5' }}>
              <li>Drag boxes to move them</li>
              <li>Drag edges/corner to resize</li>
              <li>Adjust opacity slider to see PDF</li>
              <li>Copy coordinates when done</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
