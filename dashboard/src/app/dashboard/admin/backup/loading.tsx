export default function AdminBackupLoading() {
  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] p-4">
        <div className="space-y-2">
          <div className="h-7 w-56 animate-pulse rounded-md bg-[var(--surface-muted)]" />
          <div className="h-3 w-80 animate-pulse rounded-md bg-[var(--surface-muted)]" />
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        {Array.from({ length: 4 }).map((_, idx) => (
          <div key={`backup-card-${idx}`} className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] p-4">
            <div className="space-y-2">
              <div className="h-5 w-44 animate-pulse rounded bg-[var(--surface-muted)]" />
              <div className="h-3 w-64 animate-pulse rounded bg-[var(--surface-muted)]" />
            </div>
            <div className="mt-4 space-y-3">
              <div className="h-10 w-full animate-pulse rounded-md bg-[var(--surface-muted)]" />
              <div className="h-8 w-40 animate-pulse rounded-full bg-[var(--surface-muted)]" />
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
