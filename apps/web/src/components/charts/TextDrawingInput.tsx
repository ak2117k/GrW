import { useEffect, useRef, useState } from 'react';

interface TextDrawingInputProps {
  initialText?: string;
  x: number;
  y: number;
  onCommit: (text: string) => void;
  onCancel: () => void;
}

export default function TextDrawingInput({ initialText = '', x, y, onCommit, onCancel }: TextDrawingInputProps) {
  const [text, setText] = useState(initialText);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      type="text"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { if (text.trim()) onCommit(text.trim()); else onCancel(); }
        if (e.key === 'Escape') onCancel();
      }}
      onBlur={() => { if (text.trim()) onCommit(text.trim()); else onCancel(); }}
      style={{
        position: 'absolute', left: x, top: y, zIndex: 150,
        background: 'rgba(10, 10, 26, 0.95)',
        border: '1px solid #06b6d4',
        color: 'white', padding: '2px 4px', fontSize: 12, minWidth: 80,
      }}
    />
  );
}
