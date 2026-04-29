import skus from './data/skus.json';
import inventory from './data/inventory.json';
import motions from './data/motions.json';
import media from './data/media.json';
import SectionCard from './components/SectionCard';

const sku = skus[0];

export default function App() {
  return (
    <main className="mx-auto max-w-7xl p-6">
      <header className="mb-8">
        <p className="text-xs uppercase tracking-[0.2em] text-emerald-400">Living Dessert Lab OS</p>
        <h1 className="mt-2 text-3xl font-bold">Dessert Operations Console</h1>
        <p className="mt-2 text-slate-400">Seeded SKU: {sku.id} {sku.name}</p>
      </header>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <SectionCard title="Dashboard">
          <p>Total SKUs: {skus.length}</p>
          <p>Inventory items: {inventory.length}</p>
          <p>Motion presets: {motions.length}</p>
        </SectionCard>

        <SectionCard title="SKU Library">
          {skus.map((item) => (
            <p key={item.id}>{item.id} · {item.name} · {item.status}</p>
          ))}
        </SectionCard>

        <SectionCard title="SKU Detail">
          <p>{sku.name} ({sku.category})</p>
          <p>Base price: ${sku.basePrice.toFixed(2)}</p>
          <p>Variants: {sku.variants.join(', ')}</p>
        </SectionCard>

        <SectionCard title="Operator Mode">
          <p>Recipe motion: {sku.motionPreset}</p>
          <p>Step checklist ready.</p>
          <p>Media cues loaded: {sku.media.join(', ')}</p>
        </SectionCard>

        <SectionCard title="Ingredient Inventory">
          {inventory.map((item) => (
            <p key={item.ingredient}>{item.ingredient}: {item.stock}{item.unit} (reorder {item.reorderAt}{item.unit})</p>
          ))}
        </SectionCard>

        <SectionCard title="Motion Library">
          {motions.map((m) => (
            <p key={m.name}>{m.name} · {m.duration} · {m.intensity}</p>
          ))}
        </SectionCard>

        <SectionCard title="Media Library">
          {media.map((m) => (
            <p key={m.asset}>{m.asset} · {m.type} · {m.tag}</p>
          ))}
        </SectionCard>

        <SectionCard title="Variant Builder">
          <p>Current template from {sku.id} {sku.name}</p>
          <p>Available: {sku.variants.join(' / ')}</p>
          <p>Add-on slots: Foam, Dusting, Syrup</p>
        </SectionCard>
      </div>
    </main>
  );
}
