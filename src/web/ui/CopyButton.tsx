import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from './Button.tsx';

type Props = {
  value: string;
  label: string;
  copiedLabel: string;
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'md' | 'lg';
};

export function CopyButton({ value, label, copiedLabel, variant = 'secondary', size = 'md' }: Props) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      variant={variant}
      size={size}
      icon={copied ? <Check className="size-4 animate-pop" /> : <Copy className="size-4" />}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
      }}
    >
      {copied ? copiedLabel : label}
    </Button>
  );
}
