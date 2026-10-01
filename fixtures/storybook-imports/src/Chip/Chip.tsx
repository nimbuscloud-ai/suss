export function Chip({ label, size }: { label: string; size?: "sm" | "md" }) {
  return <span data-size={size}>{label}</span>;
}
