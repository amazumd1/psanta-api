export default function SectionCard({ title, children }) {
  return (
    <section className="rounded-xl border border-emerald-900/50 bg-slate-900/80 p-5 shadow-lg shadow-emerald-950/20">
      <h2 className="mb-3 text-lg font-semibold text-emerald-300">{title}</h2>
      <div className="space-y-2 text-sm text-slate-200">{children}</div>
    </section>
  );
}
