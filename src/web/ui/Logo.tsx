export function Logo({ className = 'size-8' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="var(--accent)" />
      <path
        d="M20 40V24a4 4 0 0 1 4-4h10a8 8 0 0 1 0 16h-8"
        fill="none"
        stroke="var(--on-accent)"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="44" cy="44" r="4" fill="var(--on-accent)" />
    </svg>
  );
}
