export const sku = {
  id: 'A1',
  name: 'Matcha Cloud',
  category: 'Zero-Cook Dessert + Wellness',
  robotReadiness: 86,
  greenhouseLinks: ['Uji Matcha Leaf Pod', 'Mint Tower Basil', 'Hydro Oat Culture'],
  ingredients: [
    { name: 'Ceremonial matcha', qty: '3 g' },
    { name: 'Cloud cream base', qty: '120 ml' },
    { name: 'Chia silk', qty: '15 g' },
    { name: 'Ice pearls', qty: '80 g' }
  ],
  options: {
    dairy: ['Whole milk foam', 'Coconut foam', 'Oat foam'],
    sugar: ['Raw cane syrup', 'Monk fruit syrup'],
    gluten: ['Granola dust', 'GF almond crunch']
  },
  tools: ['Precision scale', 'Cold whisk canister', 'Foam wand', 'Stainless cup'],
  media: ['Hero image', 'Top-down prep video', 'Texture close-up'],
  workflow: [
    { step: 'Tare cup on scale and add cloud cream base.', target: '120 ml', tool: 'Precision scale', timer: 20 },
    { step: 'Sift matcha and whisk until smooth suspension.', target: '3 g matcha', tool: 'Cold whisk canister', timer: 35 },
    { step: 'Inject chosen foam and stabilize with wand.', target: '40 ml foam', tool: 'Foam wand', timer: 30 },
    { step: 'Finish with chia silk, crunch variant, and mint leaf.', target: '15 g topping', tool: 'Stainless cup', timer: 25 }
  ]
}

export const pages = [
  'Dashboard','SKU Library','SKU Detail','Operator Mode','Ingredient Inventory','Motion Library','Media Library','Variant Builder'
]
