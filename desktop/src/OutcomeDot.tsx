export default function OutcomeDot({ failed, label }: { failed: boolean; label: string }) {
  return <span className={`outcome-dot ${failed ? 'outcome-failed' : 'outcome-succeeded'}`} role="img" aria-label={label} title={label} />;
}
