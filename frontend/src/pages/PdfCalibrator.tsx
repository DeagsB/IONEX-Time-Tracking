import { useState, useRef, useEffect } from 'react';

// Initial positions (current layout)
const INITIAL_POSITIONS: { [key: string]: { x: number; y: number; label: string; color: string } } = {
  ticketNumber: { x: 545, y: 755, label: 'Ticket #', color: '#ff6b6b' },
  customerName: { x: 478, y: 688, label: 'Customer Name', color: '#4ecdc4' },
  billingAddress: { x: 478, y: 672, label: 'Billing Address', color: '#4ecdc4' },
  contactName: { x: 478, y: 640, label: 'Contact Name', color: '#4ecdc4' },
  contactPhone: { x: 478, y: 624, label: 'Contact Phone', color: '#4ecdc4' },
  contactEmail: { x: 478, y: 608, label: 'Contact Email', color: '#4ecdc4' },
  serviceLocation: { x: 478, y: 592, label: 'Service Location', color: '#4ecdc4' },
  poCcAfe: { x: 478, y: 576, label: 'PO/CC/AFE', color: '#4ecdc4' },
  jobId: { x: 108, y: 622, label: 'Job ID', color: '#ffe66d' },
  jobType: { x: 235, y: 622, label: 'Job Type', color: '#ffe66d' },
  techName: { x: 108, y: 604, label: 'Tech', color: '#ffe66d' },
  date: { x: 108, y: 586, label: 'Date', color: '#ffe66d' },
  descriptionStart: { x: 75, y: 532, label: 'Desc Start', color: '#a29bfe' },
  rtColumn: { x: 430, y: 532, label: 'RT Col', color: '#74b9ff' },
  ttColumn: { x: 462, y: 532, label: 'TT Col', color: '#74b9ff' },
  ftColumn: { x: 494, y: 532, label: 'FT Col', color: '#74b9ff' },
  otColumn: { x: 526, y: 532, label: 'OT Col', color: '#74b9ff' },
  totalsRow: { x: 430, y: 395, label: 'Totals Row', color: '#fd79a8' },
  rtRate: { x: 145, y: 375, label: 'RT Rate', color: '#00cec9' },
  ftRate: { x: 290, y: 375, label: 'FT Rate', color: '#00cec9' },
  sumRt: { x: 528, y: 238, label: 'Sum RT', color: '#e17055' },
  sumTt: { x: 528, y: 223, label: 'Sum TT', color: '#e17055' },
  sumFt: { x: 528, y: 208, label: 'Sum FT', color: '#e17055' },
  sumOt: { x: 528, y: 193, label: 'Sum OT', color: '#e17055' },
  sumExpenses: { x: 528, y: 178, label: 'Sum Expenses', color: '#e17055' },
  grandTotal: { x: 528, y: 158, label: 'Grand Total', color: '#e17055' },
  afeValue: { x: 105, y: 218, label: 'AFE', color: '#81ecec' },
  ccValue: { x: 105, y: 198, label: 'CC', color: '#81ecec' },
};

// PDF dimensions
const PDF_WIDTH = 612;
const PDF_HEIGHT = 792;

export default function PdfCalibrator() {
  const [positions, setPositions] = useState(INITIAL_POSITIONS);
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [pdfLoaded, setPdfLoaded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  // Convert PDF coordinates to screen coordinates
  const pdfToScreen = (x: number, y: number) => ({
    x: x * scale,
    y: (PDF_HEIGHT - y) * scale, // Flip Y axis (PDF is bottom-up)
  });

  // Convert screen coordinates to PDF coordinates
  const screenToPdf = (screenX: number, screenY: number) => ({
    x: Math.round(screenX / scale),
    y: Math.round(PDF_HEIGHT - screenY / scale),
  });

  const handleMouseDown = (e: React.MouseEvent, fieldKey: string) => {
    e.preventDefault();
    setSelectedField(fieldKey);
    setDragging(true);
    
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    setDragOffset({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging || !selectedField || !containerRef.current) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const screenX = e.clientX - containerRect.left - dragOffset.x + 6;
    const screenY = e.clientY - containerRect.top - dragOffset.y + 6;

    const pdfCoords = screenToPdf(screenX, screenY);

    setPositions((prev) => ({
      ...prev,
      [selectedField]: {
        ...prev[selectedField],
        x: Math.max(0, Math.min(PDF_WIDTH, pdfCoords.x)),
        y: Math.max(0, Math.min(PDF_HEIGHT, pdfCoords.y)),
      },
    }));
  };

  const handleMouseUp = () => {
    setDragging(false);
  };

  // Generate code output
  const generateCode = () => {
    const code = `// Updated PDF Layout Coordinates
const LAYOUT = {
  ticketNumber: { x: ${positions.ticketNumber.x}, y: ${positions.ticketNumber.y} },
  
  // Customer section
  customerName: { x: ${positions.customerName.x}, y: ${positions.customerName.y} },
  billingAddress: { x: ${positions.billingAddress.x}, y: ${positions.billingAddress.y} },
  contactName: { x: ${positions.contactName.x}, y: ${positions.contactName.y} },
  contactPhone: { x: ${positions.contactPhone.x}, y: ${positions.contactPhone.y} },
  contactEmail: { x: ${positions.contactEmail.x}, y: ${positions.contactEmail.y} },
  serviceLocation: { x: ${positions.serviceLocation.x}, y: ${positions.serviceLocation.y} },
  poCcAfe: { x: ${positions.poCcAfe.x}, y: ${positions.poCcAfe.y} },
  
  // Service Info
  jobId: { x: ${positions.jobId.x}, y: ${positions.jobId.y} },
  jobType: { x: ${positions.jobType.x}, y: ${positions.jobType.y} },
  techName: { x: ${positions.techName.x}, y: ${positions.techName.y} },
  date: { x: ${positions.date.x}, y: ${positions.date.y} },
  
  // Description area
  descriptionStartY: ${positions.descriptionStart.y},
  descriptionX: ${positions.descriptionStart.x},
  
  // Hours columns
  hoursColumns: {
    rt: { x: ${positions.rtColumn.x} },
    tt: { x: ${positions.ttColumn.x} },
    ft: { x: ${positions.ftColumn.x} },
    ot: { x: ${positions.otColumn.x} },
  },
  
  // Totals
  totalsY: ${positions.totalsRow.y},
  rtRateValue: { x: ${positions.rtRate.x}, y: ${positions.rtRate.y} },
  ftRateValue: { x: ${positions.ftRate.x}, y: ${positions.ftRate.y} },
  
  // Summary
  summary: {
    totalRt: { x: ${positions.sumRt.x}, y: ${positions.sumRt.y} },
    totalTt: { x: ${positions.sumTt.x}, y: ${positions.sumTt.y} },
    totalFt: { x: ${positions.sumFt.x}, y: ${positions.sumFt.y} },
    totalOt: { x: ${positions.sumOt.x}, y: ${positions.sumOt.y} },
    totalExpenses: { x: ${positions.sumExpenses.x}, y: ${positions.sumExpenses.y} },
    grandTotal: { x: ${positions.grandTotal.x}, y: ${positions.grandTotal.y} },
  },
  
  // Customer Approval
  afeValue: { x: ${positions.afeValue.x}, y: ${positions.afeValue.y} },
  ccValue: { x: ${positions.ccValue.x}, y: ${positions.ccValue.y} },
};`;
    
    navigator.clipboard.writeText(code);
    alert('Coordinates copied to clipboard!');
  };

  // Calculate scale to fit the container
  useEffect(() => {
    const updateScale = () => {
      if (containerRef.current) {
        const containerWidth = containerRef.current.offsetWidth - 40;
        const newScale = Math.min(containerWidth / PDF_WIDTH, 1.2);
        setScale(newScale);
      }
    };
    
    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, []);

  return (
    <div style={{ padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2 style={{ margin: 0, color: 'var(--text-primary)' }}>PDF Position Calibrator</h2>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            className="button button-secondary"
            onClick={() => setPositions(INITIAL_POSITIONS)}
          >
            Reset
          </button>
          <button
            className="button button-primary"
            onClick={generateCode}
            style={{ backgroundColor: '#4caf50', borderColor: '#4caf50' }}
          >
            📋 Copy Coordinates
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '20px' }}>
        {/* PDF Canvas */}
        <div
          ref={containerRef}
          style={{
            flex: 1,
            position: 'relative',
            backgroundColor: '#333',
            borderRadius: '8px',
            overflow: 'hidden',
            cursor: dragging ? 'grabbing' : 'default',
          }}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {/* PDF Background */}
          <div
            style={{
              width: PDF_WIDTH * scale,
              height: PDF_HEIGHT * scale,
              margin: '20px',
              position: 'relative',
              backgroundColor: '#fff',
              boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
            }}
          >
            {/* Load PDF as image via iframe/embed or show placeholder */}
            <iframe
              src="/templates/Service-Ticket-Example.pdf"
              style={{
                width: '100%',
                height: '100%',
                border: 'none',
                pointerEvents: 'none',
              }}
              onLoad={() => setPdfLoaded(true)}
            />

            {/* Draggable markers */}
            {Object.entries(positions).map(([key, pos]) => {
              const screenPos = pdfToScreen(pos.x, pos.y);
              return (
                <div
                  key={key}
                  onMouseDown={(e) => handleMouseDown(e, key)}
                  style={{
                    position: 'absolute',
                    left: screenPos.x - 6,
                    top: screenPos.y - 6,
                    width: 12,
                    height: 12,
                    backgroundColor: pos.color,
                    borderRadius: '50%',
                    cursor: 'grab',
                    border: selectedField === key ? '2px solid #fff' : '2px solid rgba(0,0,0,0.3)',
                    boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
                    zIndex: selectedField === key ? 100 : 10,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  title={`${pos.label} (${pos.x}, ${pos.y})`}
                >
                  {selectedField === key && (
                    <div
                      style={{
                        position: 'absolute',
                        top: -25,
                        left: '50%',
                        transform: 'translateX(-50%)',
                        backgroundColor: 'rgba(0,0,0,0.8)',
                        color: '#fff',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        fontSize: '10px',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {pos.x}, {pos.y}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Field List */}
        <div
          style={{
            width: '280px',
            backgroundColor: 'var(--bg-secondary)',
            borderRadius: '8px',
            padding: '16px',
            maxHeight: '80vh',
            overflowY: 'auto',
          }}
        >
          <h3 style={{ margin: '0 0 16px 0', color: 'var(--text-primary)', fontSize: '14px' }}>
            Field Positions
          </h3>
          
          {Object.entries(positions).map(([key, pos]) => (
            <div
              key={key}
              onClick={() => setSelectedField(key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '8px',
                marginBottom: '4px',
                borderRadius: '6px',
                backgroundColor: selectedField === key ? 'var(--primary-light)' : 'transparent',
                cursor: 'pointer',
                transition: 'background-color 0.2s',
              }}
            >
              <div
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  backgroundColor: pos.color,
                  marginRight: '10px',
                  flexShrink: 0,
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '12px', fontWeight: '500', color: 'var(--text-primary)' }}>
                  {pos.label}
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                  x: {pos.x}, y: {pos.y}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setPositions((prev) => ({
                      ...prev,
                      [key]: { ...prev[key], x: prev[key].x - 5 },
                    }));
                  }}
                  style={{
                    width: 20,
                    height: 20,
                    border: '1px solid var(--border-color)',
                    borderRadius: '4px',
                    backgroundColor: 'var(--bg-primary)',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    fontSize: '10px',
                  }}
                >
                  ←
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setPositions((prev) => ({
                      ...prev,
                      [key]: { ...prev[key], x: prev[key].x + 5 },
                    }));
                  }}
                  style={{
                    width: 20,
                    height: 20,
                    border: '1px solid var(--border-color)',
                    borderRadius: '4px',
                    backgroundColor: 'var(--bg-primary)',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    fontSize: '10px',
                  }}
                >
                  →
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setPositions((prev) => ({
                      ...prev,
                      [key]: { ...prev[key], y: prev[key].y + 5 },
                    }));
                  }}
                  style={{
                    width: 20,
                    height: 20,
                    border: '1px solid var(--border-color)',
                    borderRadius: '4px',
                    backgroundColor: 'var(--bg-primary)',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    fontSize: '10px',
                  }}
                >
                  ↑
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setPositions((prev) => ({
                      ...prev,
                      [key]: { ...prev[key], y: prev[key].y - 5 },
                    }));
                  }}
                  style={{
                    width: 20,
                    height: 20,
                    border: '1px solid var(--border-color)',
                    borderRadius: '4px',
                    backgroundColor: 'var(--bg-primary)',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    fontSize: '10px',
                  }}
                >
                  ↓
                </button>
              </div>
            </div>
          ))}
          
          <div style={{ marginTop: '20px', padding: '12px', backgroundColor: 'var(--bg-primary)', borderRadius: '6px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
              💡 <strong>Tips:</strong>
            </div>
            <ul style={{ fontSize: '10px', color: 'var(--text-secondary)', margin: 0, paddingLeft: '16px' }}>
              <li>Drag dots on PDF to position</li>
              <li>Use arrow buttons for fine-tuning</li>
              <li>Click "Copy Coordinates" when done</li>
              <li>Share the output with me to apply</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

