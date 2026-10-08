import clsx from 'clsx';

const statusStyles = {
  completed: 'bg-green-100 text-green-800',
  success: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  error: 'bg-red-100 text-red-800',
  running: 'bg-blue-100 text-blue-800',
  queued: 'bg-indigo-100 text-indigo-800',
  deferred: 'bg-amber-100 text-amber-800',
  retrying: 'bg-orange-100 text-orange-800',
  dead_letter: 'bg-rose-100 text-rose-800',
  canceled: 'bg-gray-200 text-gray-800',
  pending: 'bg-yellow-100 text-yellow-800',
  active: 'bg-green-100 text-green-800',
  inactive: 'bg-gray-100 text-gray-800',
  global: 'bg-purple-100 text-purple-800',
  multi_tenant: 'bg-blue-100 text-blue-800',
  single_tenant: 'bg-slate-100 text-slate-800',
  // workflow state engine
  normal: 'bg-green-100 text-green-800',
  triggered: 'bg-amber-100 text-amber-800',
  critical: 'bg-red-100 text-red-800',
  sent: 'bg-green-100 text-green-800',
  suppressed: 'bg-gray-100 text-gray-700',
  uncertain: 'bg-orange-100 text-orange-800',
  rca: 'bg-sky-100 text-sky-800',
  daily_insight: 'bg-teal-100 text-teal-800',
};

export default function Badge({ status, children, className }) {
  const text = children || status;
  const style = statusStyles[status?.toLowerCase()] || 'bg-gray-100 text-gray-800';

  return (
    <span
      className={clsx(
        'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize',
        style,
        className
      )}
    >
      {text}
    </span>
  );
}
