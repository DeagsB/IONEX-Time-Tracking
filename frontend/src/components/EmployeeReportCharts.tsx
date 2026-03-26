import { useMemo } from 'react';
import {
  EmployeeMetrics,
  TrendData,
  RateTypeBreakdown,
  formatCurrency,
  formatHours,
} from '../utils/employeeReports';

interface TrendChartProps {
  data: TrendData[];
  height?: number;
}

// Simple bar chart for trends (no external library needed)
export function TrendChart({ data, height = 150 }: TrendChartProps) {
  if (!data || data.length === 0) {
    return (
      <div style={{ 
        height, 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        color: 'var(--text-secondary)',
        fontSize: '13px'
      }}>
        No trend data available
      </div>
    );
  }

  const maxHours = Math.max(...data.map(d => d.hours), 1);

  return (
    <div style={{ height, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: '4px', paddingBottom: '20px' }}>
        {data.map((point, index) => {
          const barHeight = (point.hours / maxHours) * 100;
          const date = new Date(point.date);
          const dayLabel = date.toLocaleDateString('en-US', { weekday: 'short' }).charAt(0);
          
          return (
            <div 
              key={index}
              style={{ 
                flex: 1, 
                display: 'flex', 
                flexDirection: 'column', 
                alignItems: 'center',
                gap: '4px'
              }}
            >
              <div 
                style={{
                  width: '100%',
                  maxWidth: '40px',
                  height: `${barHeight}%`,
                  minHeight: point.hours > 0 ? '4px' : '0',
                  backgroundColor: 'var(--primary-color)',
                  borderRadius: '4px 4px 0 0',
                  transition: 'height 0.3s ease'
                }}
                title={`${point.date}: ${formatHours(point.hours)} hours, ${formatCurrency(point.revenue)} revenue`}
              />
              <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>{dayLabel}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface RateTypeChartProps {
  breakdown: RateTypeBreakdown;
  showRevenue?: boolean;
}

// Horizontal bar chart for rate type breakdown
export function RateTypeChart({ breakdown, showRevenue = false }: RateTypeChartProps) {
  const data = useMemo(() => [
    { label: 'Shop Time', value: showRevenue ? breakdown.shopTime.revenue : breakdown.shopTime.hours, color: '#3b82f6' },
    { label: 'Field Time', value: showRevenue ? breakdown.fieldTime.revenue : breakdown.fieldTime.hours, color: '#10b981' },
    { label: 'Travel Time', value: showRevenue ? breakdown.travelTime.revenue : breakdown.travelTime.hours, color: '#f59e0b' },
    { label: 'Shop OT', value: showRevenue ? breakdown.shopOvertime.revenue : breakdown.shopOvertime.hours, color: '#8b5cf6' },
    { label: 'Field OT', value: showRevenue ? breakdown.fieldOvertime.revenue : breakdown.fieldOvertime.hours, color: '#ec4899' },
  ], [breakdown, showRevenue]);

  const maxValue = Math.max(...data.map(d => d.value), 1);
  const total = data.reduce((sum, d) => sum + d.value, 0);

  if (total === 0) {
    return (
      <div style={{ 
        padding: '20px',
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        color: 'var(--text-secondary)',
        fontSize: '13px'
      }}>
        No data available
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {data.map((item, index) => (
        <div key={index} style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '80px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            {item.label}
          </div>
          <div style={{ flex: 1, height: '16px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '8px', overflow: 'hidden' }}>
            <div 
              style={{
                width: `${(item.value / maxValue) * 100}%`,
                height: '100%',
                backgroundColor: item.color,
                borderRadius: '8px',
                transition: 'width 0.3s ease'
              }}
            />
          </div>
          <div style={{ width: '80px', fontSize: '12px', textAlign: 'right' }}>
            {showRevenue ? formatCurrency(item.value) : formatHours(item.value)}
          </div>
        </div>
      ))}
    </div>
  );
}

interface PieChartProps {
  data: { label: string; value: number; color: string }[];
  size?: number;
}

// Simple donut chart
export function DonutChart({ data, size = 120 }: PieChartProps) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  
  if (total === 0) {
    return (
      <div style={{ 
        width: size, 
        height: size, 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        color: 'var(--text-secondary)',
        fontSize: '12px'
      }}>
        No data
      </div>
    );
  }

  // Create CSS conic gradient
  let currentAngle = 0;
  const gradientStops = data.map(item => {
    const percentage = (item.value / total) * 100;
    const stop = `${item.color} ${currentAngle}% ${currentAngle + percentage}%`;
    currentAngle += percentage;
    return stop;
  }).join(', ');

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
      <div 
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          background: `conic-gradient(${gradientStops})`,
          position: 'relative'
        }}
      >
        {/* Inner circle for donut effect */}
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: size * 0.6,
          height: size * 0.6,
          borderRadius: '50%',
          backgroundColor: 'var(--bg-primary)'
        }} />
      </div>
      
      {/* Legend */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {data.filter(d => d.value > 0).map((item, index) => (
          <div key={index} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{
              width: '10px',
              height: '10px',
              borderRadius: '2px',
              backgroundColor: item.color
            }} />
            <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
              {item.label}: {((item.value / total) * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface EfficiencyGaugeProps {
  efficiency: number;
  size?: number;
}

// Efficiency gauge (semi-circle)
export function EfficiencyGauge({ efficiency, size = 100 }: EfficiencyGaugeProps) {
  const clampedEfficiency = Math.min(Math.max(efficiency, 0), 100);
  const rotation = (clampedEfficiency / 100) * 180 - 90; // -90 to 90 degrees
  
  const getColor = (value: number) => {
    if (value >= 80) return '#28a745';
    if (value >= 60) return '#ffc107';
    return '#dc3545';
  };

  return (
    <div style={{ 
      width: size, 
      height: size / 2 + 20,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center'
    }}>
      <div style={{
        width: size,
        height: size / 2,
        borderRadius: `${size}px ${size}px 0 0`,
        background: `conic-gradient(
          from -90deg at 50% 100%,
          #dc3545 0deg,
          #ffc107 60deg,
          #28a745 120deg,
          #28a745 180deg,
          transparent 180deg
        )`,
        position: 'relative',
        overflow: 'hidden'
      }}>
        {/* Inner semi-circle */}
        <div style={{
          position: 'absolute',
          bottom: 0,
          left: '50%',
          transform: 'translateX(-50%)',
          width: size * 0.7,
          height: size * 0.35,
          borderRadius: `${size}px ${size}px 0 0`,
          backgroundColor: 'var(--bg-primary)'
        }} />
        
        {/* Needle */}
        <div style={{
          position: 'absolute',
          bottom: 0,
          left: '50%',
          width: '2px',
          height: size * 0.4,
          backgroundColor: getColor(clampedEfficiency),
          transformOrigin: 'bottom center',
          transform: `translateX(-50%) rotate(${rotation}deg)`,
          transition: 'transform 0.5s ease'
        }} />
        
        {/* Center dot */}
        <div style={{
          position: 'absolute',
          bottom: -4,
          left: '50%',
          transform: 'translateX(-50%)',
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          backgroundColor: getColor(clampedEfficiency)
        }} />
      </div>
      
      <div style={{ 
        fontSize: '14px', 
        fontWeight: '600', 
        color: getColor(clampedEfficiency),
        marginTop: '4px'
      }}>
        {clampedEfficiency.toFixed(0)}%
      </div>
    </div>
  );
}

interface EmployeeComparisonChartProps {
  employees: EmployeeMetrics[];
  metric: 'totalHours' | 'billableHours' | 'totalRevenue' | 'efficiency';
  maxItems?: number;
}

// Horizontal bar chart for comparing employees
export function EmployeeComparisonChart({ 
  employees, 
  metric, 
  maxItems = 10 
}: EmployeeComparisonChartProps) {
  const sortedEmployees = [...employees]
    .sort((a, b) => (b[metric] as number) - (a[metric] as number))
    .slice(0, maxItems);

  if (sortedEmployees.length === 0) {
    return (
      <div style={{ 
        padding: '20px',
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        color: 'var(--text-secondary)',
        fontSize: '13px'
      }}>
        No employee data
      </div>
    );
  }

  const maxValue = Math.max(...sortedEmployees.map(e => e[metric] as number), 1);

  const formatValue = (value: number) => {
    if (metric === 'totalRevenue') return formatCurrency(value);
    if (metric === 'efficiency') return `${value.toFixed(0)}%`;
    return formatHours(value);
  };

  const getBarColor = (index: number) => {
    const colors = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1', '#14b8a6'];
    return colors[index % colors.length];
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {sortedEmployees.map((emp, index) => (
        <div key={emp.userId} style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ 
            width: '120px', 
            fontSize: '12px', 
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}>
            {emp.employeeName}
          </div>
          <div style={{ flex: 1, height: '20px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '4px', overflow: 'hidden' }}>
            <div 
              style={{
                width: `${((emp[metric] as number) / maxValue) * 100}%`,
                height: '100%',
                backgroundColor: getBarColor(index),
                borderRadius: '4px',
                transition: 'width 0.3s ease'
              }}
            />
          </div>
          <div style={{ width: '80px', fontSize: '12px', textAlign: 'right', fontWeight: '500' }}>
            {formatValue(emp[metric] as number)}
          </div>
        </div>
      ))}
    </div>
  );
}

