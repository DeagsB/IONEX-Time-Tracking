import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';

interface Option {
  value: string;
  label: string;
}

interface SearchableSelectProps {
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  emptyOption?: { value: string; label: string };
  style?: React.CSSProperties;
  className?: string;
}

export interface SearchableSelectRef {
  focus: () => void;
}

const SearchableSelect = forwardRef<SearchableSelectRef, SearchableSelectProps>(function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = 'Search...',
  emptyOption,
  style,
  className,
}, ref) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => {
      setSearchQuery('');
      setIsOpen(true);
    },
  }), []);

  // Get the display label for the current value
  const getDisplayLabel = () => {
    if (!value && emptyOption) return emptyOption.label;
    const selected = options.find(opt => opt.value === value);
    return selected?.label || '';
  };

  // Filter options based on search query
  const filteredOptions = options.filter(opt =>
    opt.label.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearchQuery('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus input when dropdown opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  const handleSelect = (optionValue: string) => {
    onChange(optionValue);
    setIsOpen(false);
    setSearchQuery('');
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setIsOpen(false);
      setSearchQuery('');
    } else if (e.key === 'Enter' && filteredOptions.length > 0) {
      handleSelect(filteredOptions[0].value);
    }
  };

  return (
    <div ref={containerRef} style={{ position: 'relative', ...style }} className={className}>
      {/* Display button - shows current selection */}
      <div
        onClick={() => setIsOpen(!isOpen)}
        style={{
          width: '100%',
          padding: '10px',
          backgroundColor: 'var(--bg-primary)',
          border: '1px solid var(--border-color)',
          borderRadius: '6px',
          color: value ? 'var(--text-primary)' : 'var(--text-secondary)',
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          boxSizing: 'border-box',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {getDisplayLabel() || placeholder}
        </span>
        <span style={{ marginLeft: '8px', fontSize: '10px', opacity: 0.6 }}>▼</span>
      </div>

      {/* Dropdown */}
      {isOpen && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: '4px',
            backgroundColor: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)',
            borderRadius: '6px',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
            zIndex: 1000,
            maxHeight: '250px',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Search input */}
          <div style={{ padding: '8px', borderBottom: '1px solid var(--border-color)' }}>
            <input
              ref={inputRef}
              type="text"
              value={searchQuery}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              style={{
                width: '100%',
                padding: '8px',
                backgroundColor: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '4px',
                color: 'var(--text-primary)',
                fontSize: '14px',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Options list */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {/* Empty option if provided */}
            {emptyOption && (!searchQuery || emptyOption.label.toLowerCase().includes(searchQuery.toLowerCase())) && (
              <div
                onClick={() => handleSelect(emptyOption.value)}
                style={{
                  padding: '10px 12px',
                  cursor: 'pointer',
                  backgroundColor: value === emptyOption.value ? 'var(--bg-hover)' : 'transparent',
                  color: 'var(--text-secondary)',
                  fontStyle: 'italic',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-hover)')}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = value === emptyOption.value ? 'var(--bg-hover)' : 'transparent')}
              >
                {emptyOption.label}
              </div>
            )}
            
            {/* Filtered options */}
            {filteredOptions.map((option) => (
              <div
                key={option.value}
                onClick={() => handleSelect(option.value)}
                style={{
                  padding: '10px 12px',
                  cursor: 'pointer',
                  backgroundColor: value === option.value ? 'var(--bg-hover)' : 'transparent',
                  color: 'var(--text-primary)',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-hover)')}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = value === option.value ? 'var(--bg-hover)' : 'transparent')}
              >
                {option.label}
              </div>
            ))}

            {/* No results message */}
            {filteredOptions.length === 0 && searchQuery && (
              <div
                style={{
                  padding: '12px',
                  color: 'var(--text-secondary)',
                  textAlign: 'center',
                  fontStyle: 'italic',
                }}
              >
                No matches found
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

export default SearchableSelect;
