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

// Grid snap size
const GRID_SIZE = 5;

// Snap value to grid
const snapToGrid = (value: number): number => {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
};

export default function PdfCalibrator() {
  const [positions, setPositions] = useState(INITIAL_POSITIONS);
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [showGrid, setShowGrid] = useState(true);
  const [gridSize, setGridSize] = useState(GRID_SIZE);
  const containerRef = useRef<HTMLDivElement>(null);
  const pdfContainerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  // Convert PDF coordinates to screen coordinates
  const pdfToScreen = (x: number, y: number) => ({
    x: x * scale,
    y: (PDF_HEIGHT - y) * scale, // Flip Y axis (PDF is bottom-up)
  });

  // Convert screen coordinates to PDF coordinates with grid snap
  const screenToPdf = (screenX: number, screenY: number) => {
    const rawX = screenX / scale;
    const rawY = PDF_HEIGHT - screenY / scale;
    return {
      x: snapToGrid(rawX),
      y: snapToGrid(rawY),
    };
  };

  const handleMouseDown = (e: React.MouseEvent, fieldKey: string) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedField(fieldKey);
    setDragging(true);
    
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    setDragOffset({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging || !selectedField || !pdfContainerRef.current) return;

    const containerRect = pdfContainerRef.current.getBoundingClientRect();
    const screenX = e.clientX - containerRect.left - dragOffset.x + 8;
    const screenY = e.clientY - containerRect.top - dragOffset.y + 8;

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
    alert('Coordinates copied to clipboard! Share this with me to apply the changes.');
  };

  // Calculate scale to fill available space
  useEffect(() => {
    const updateScale = () => {
      if (containerRef.current) {
        const containerHeight = window.innerHeight - 180;
        const containerWidth = containerRef.current.offsetWidth - 320; // Account for sidebar
        
        const scaleByHeight = containerHeight / PDF_HEIGHT;
        const scaleByWidth = containerWidth / PDF_WIDTH;
        
        // Use the larger scale that fits, but cap at 1.5
        const newScale = Math.min(Math.max(scaleByHeight, scaleByWidth), 1.5);
        setScale(newScale);
      }
    };
    
    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, []);

  // Generate grid lines
  const gridLines = [];
  if (showGrid) {
    // Vertical lines
    for (let x = 0; x <= PDF_WIDTH; x += gridSize * 2) {
      const screenX = x * scale;
      gridLines.push(
        <line
          key={`v-${x}`}
          x1={screenX}
          y1={0}
          x2={screenX}
          y2={PDF_HEIGHT * scale}
          stroke={x % 50 === 0 ? 'rgba(100, 100, 255, 0.3)' : 'rgba(100, 100, 255, 0.1)'}
          strokeWidth={x % 50 === 0 ? 1 : 0.5}
        />
      );
    }
    // Horizontal lines
    for (let y = 0; y <= PDF_HEIGHT; y += gridSize * 2) {
      const screenY = y * scale;
      gridLines.push(
        <line
          key={`h-${y}`}
          x1={0}
          y1={screenY}
          x2={PDF_WIDTH * scale}
          y2={screenY}
          stroke={y % 50 === 0 ? 'rgba(255, 100, 100, 0.3)' : 'rgba(255, 100, 100, 0.1)'}
          strokeWidth={y % 50 === 0 ? 1 : 0.5}
        />
      );
    }
  }

  return (
    <div style={{ padding: '20px', height: 'calc(100vh - 100px)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={{ margin: 0, color: 'var(--text-primary)' }}>PDF Position Calibrator</h2>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'var(--text-secondary)' }}>
            <input
              type="checkbox"
              checked={showGrid}
              onChange={(e) => setShowGrid(e.target.checked)}
              style={{ width: '16px', height: '16px' }}
            />
            Show Grid
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'var(--text-secondary)' }}>
            Snap:
            <select
              value={gridSize}
              onChange={(e) => setGridSize(Number(e.target.value))}
              style={{
                padding: '4px 8px',
                backgroundColor: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '4px',
                color: 'var(--text-primary)',
              }}
            >
              <option value="1">1px</option>
              <option value="5">5px</option>
              <option value="10">10px</option>
              <option value="25">25px</option>
            </select>
          </label>
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

      <div ref={containerRef} style={{ display: 'flex', gap: '20px', flex: 1, overflow: 'hidden' }}>
        {/* PDF Canvas */}
        <div
          style={{
            flex: 1,
            position: 'relative',
            backgroundColor: '#1a1a2e',
            borderRadius: '8px',
            overflow: 'auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {/* PDF Container */}
          <div
            ref={pdfContainerRef}
            style={{
              width: PDF_WIDTH * scale,
              height: PDF_HEIGHT * scale,
              position: 'relative',
              backgroundColor: '#fff',
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              flexShrink: 0,
            }}
          >
            {/* PDF Background */}
            <iframe
              src="/templates/Service-Ticket-Example.pdf#toolbar=0&navpanes=0"
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
                {gridLines}
              </svg>
            )}

            {/* Draggable markers */}
            {Object.entries(positions).map(([key, pos]) => {
              const screenPos = pdfToScreen(pos.x, pos.y);
              const isSelected = selectedField === key;
              return (
                <div
                  key={key}
                  onMouseDown={(e) => handleMouseDown(e, key)}
                  style={{
                    position: 'absolute',
                    left: screenPos.x - 8,
                    top: screenPos.y - 8,
                    width: 16,
                    height: 16,
                    backgroundColor: pos.color,
                    borderRadius: '50%',
                    cursor: dragging && isSelected ? 'grabbing' : 'grab',
                    border: isSelected ? '3px solid #fff' : '2px solid rgba(0,0,0,0.4)',
                    boxShadow: isSelected 
                      ? '0 0 12px rgba(255,255,255,0.8), 0 4px 8px rgba(0,0,0,0.4)' 
                      : '0 2px 6px rgba(0,0,0,0.3)',
                    zIndex: isSelected ? 100 : 10,
                    transition: isSelected ? 'none' : 'box-shadow 0.2s',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  title={`${pos.label} (${pos.x}, ${pos.y})`}
                >
                  {isSelected && (
                    <div
                      style={{
                        position: 'absolute',
                        top: -28,
                        left: '50%',
                        transform: 'translateX(-50%)',
                        backgroundColor: 'rgba(0,0,0,0.9)',
                        color: '#fff',
                        padding: '4px 8px',
                        borderRadius: '4px',
                        fontSize: '11px',
                        whiteSpace: 'nowrap',
                        fontFamily: 'monospace',
                        fontWeight: 'bold',
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
            width: '300px',
            backgroundColor: 'var(--bg-secondary)',
            borderRadius: '8px',
            padding: '16px',
            overflowY: 'auto',
            flexShrink: 0,
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
                padding: '10px',
                marginBottom: '4px',
                borderRadius: '6px',
                backgroundColor: selectedField === key ? 'var(--primary-light)' : 'transparent',
                cursor: 'pointer',
                transition: 'background-color 0.2s',
                border: selectedField === key ? `2px solid ${pos.color}` : '2px solid transparent',
              }}
            >
              <div
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  backgroundColor: pos.color,
                  marginRight: '10px',
                  flexShrink: 0,
                  boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '12px', fontWeight: '600', color: 'var(--text-primary)' }}>
                  {pos.label}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                  x: {pos.x}, y: {pos.y}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '3px' }}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setPositions((prev) => ({
                      ...prev,
                      [key]: { ...prev[key], x: snapToGrid(prev[key].x - gridSize) },
                    }));
                  }}
                  style={{
                    width: 24,
                    height: 24,
                    border: '1px solid var(--border-color)',
                    borderRadius: '4px',
                    backgroundColor: 'var(--bg-primary)',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    fontSize: '12px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  title="Move left"
                >
                  ←
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setPositions((prev) => ({
                      ...prev,
                      [key]: { ...prev[key], x: snapToGrid(prev[key].x + gridSize) },
                    }));
                  }}
                  style={{
                    width: 24,
                    height: 24,
                    border: '1px solid var(--border-color)',
                    borderRadius: '4px',
                    backgroundColor: 'var(--bg-primary)',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    fontSize: '12px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  title="Move right"
                >
                  →
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setPositions((prev) => ({
                      ...prev,
                      [key]: { ...prev[key], y: snapToGrid(prev[key].y + gridSize) },
                    }));
                  }}
                  style={{
                    width: 24,
                    height: 24,
                    border: '1px solid var(--border-color)',
                    borderRadius: '4px',
                    backgroundColor: 'var(--bg-primary)',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    fontSize: '12px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  title="Move up"
                >
                  ↑
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setPositions((prev) => ({
                      ...prev,
                      [key]: { ...prev[key], y: snapToGrid(prev[key].y - gridSize) },
                    }));
                  }}
                  style={{
                    width: 24,
                    height: 24,
                    border: '1px solid var(--border-color)',
                    borderRadius: '4px',
                    backgroundColor: 'var(--bg-primary)',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    fontSize: '12px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  title="Move down"
                >
                  ↓
                </button>
              </div>
            </div>
          ))}
          
          <div style={{ marginTop: '20px', padding: '12px', backgroundColor: 'var(--bg-primary)', borderRadius: '6px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
              💡 <strong>Tips:</strong>
            </div>
            <ul style={{ fontSize: '11px', color: 'var(--text-secondary)', margin: 0, paddingLeft: '16px', lineHeight: '1.6' }}>
              <li>Drag dots to position fields</li>
              <li>Positions snap to grid ({gridSize}px)</li>
              <li>Use arrow buttons for fine-tuning</li>
              <li>Toggle grid visibility above</li>
              <li>Click "Copy Coordinates" when done</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
