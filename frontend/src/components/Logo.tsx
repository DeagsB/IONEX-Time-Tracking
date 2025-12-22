import React from 'react';

interface LogoProps {
  size?: 'small' | 'medium' | 'large';
  variant?: 'full' | 'icon';
}

export default function Logo({ size = 'medium', variant = 'full' }: LogoProps) {
  const sizes = {
    small: { width: 140, height: 50, fontSize: 18 },
    medium: { width: 180, height: 65, fontSize: 24 },
    large: { width: 220, height: 80, fontSize: 30 },
  };

  const { width, height, fontSize } = sizes[size];
  const logoRed = '#dc2626'; // Bright red
  const textBlack = '#000000'; // Pure black

  return (
    <div style={{ 
      display: 'flex', 
      alignItems: 'center',
      position: 'relative',
      width: variant === 'full' ? width : 50,
      height: height,
    }}>
      <svg 
        width={variant === 'full' ? width : 50} 
        height={height} 
        viewBox="0 0 180 65"
        style={{ overflow: 'visible' }}
      >
        {/* Red curved line - smooth upward arc, tapering slightly */}
        <path
          d="M 8 20 Q 70 8 155 18"
          stroke={logoRed}
          strokeWidth="4"
          fill="none"
          strokeLinecap="round"
          style={{
            filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.1))'
          }}
        />
        
        {/* Black gear icon at the end of the red line */}
        <g transform="translate(158, 14)">
          {/* Gear outer circle */}
          <circle cx="0" cy="0" r="10" fill={textBlack} />
          {/* Center hole */}
          <circle cx="0" cy="0" r="3.5" fill="white" />
          {/* Gear teeth - 8 teeth for standard gear look */}
          {[0, 45, 90, 135, 180, 225, 270, 315].map((angle, i) => {
            const rad = (angle * Math.PI) / 180;
            const innerR = 7;
            const outerR = 10;
            const x1 = Math.cos(rad) * innerR;
            const y1 = Math.sin(rad) * innerR;
            const x2 = Math.cos(rad) * outerR;
            const y2 = Math.sin(rad) * outerR;
            return (
              <line
                key={i}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={textBlack}
                strokeWidth="3"
                strokeLinecap="round"
              />
            );
          })}
        </g>
        
        {/* IONEX text - bold, uppercase, tightly spaced */}
        {variant === 'full' && (
          <text
            x="10"
            y="48"
            fontSize={fontSize}
            fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', sans-serif"
            fontWeight="700"
            letterSpacing="-0.03em"
            style={{ textTransform: 'uppercase' }}
          >
            <tspan fill={textBlack}>IO</tspan>
            <tspan fill={logoRed}>NEX</tspan>
          </text>
        )}
      </svg>
    </div>
  );
}
