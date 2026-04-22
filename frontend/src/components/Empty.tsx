import type { ReactNode } from 'react';

interface EmptyProps {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}

export function Empty({ title, subtitle, action }: EmptyProps) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {subtitle && (
        <div style={{ fontSize: 12.5, marginBottom: 14 }}>{subtitle}</div>
      )}
      {action}
    </div>
  );
}
