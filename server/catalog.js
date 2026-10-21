export const ROOMS = [
  'Living room',
  'Bedroom 1',
  'Bedroom 2',
  'Bedroom 3',
  'Kitchen',
  'Dining room',
  'Office',
  'Garage',
  'Basement',
  'Storage',
  'Bathroom',
  'Nursery',
];

export const DEFAULT_TRUCKS = [
  { id: 'van', name: 'Cargo van', cubicFeet: 300 },
  { id: '12', name: '12 ft truck', cubicFeet: 450 },
  { id: '15', name: '15 ft truck', cubicFeet: 800 },
  { id: '17', name: '17 ft truck', cubicFeet: 900 },
  { id: '20', name: '20 ft truck', cubicFeet: 1100 },
  { id: '26', name: '26 ft truck', cubicFeet: 1700 },
];

const item = (key, name, cubicFeet, group, aliases = []) => ({ key, name, cubicFeet, group, aliases });

export const CATALOG = [
  item('box-small', 'Box, small (1.5 cu ft)', 1.5, 'Boxes', ['small box', 'book box']),
  item('box-medium', 'Box, medium (3 cu ft)', 3, 'Boxes', ['medium box']),
  item('box-large', 'Box, large (4.5 cu ft)', 4.5, 'Boxes', ['large box']),
  item('box-xl', 'Box, extra large (6 cu ft)', 6, 'Boxes', ['xl box', 'extra large box']),
  item('box-dish', 'Dish pack', 6, 'Boxes', ['dish barrel', 'dish box']),
  item('box-wardrobe', 'Wardrobe box', 14, 'Boxes', ['wardrobe carton']),
  item('box-mirror', 'Mirror carton', 5, 'Boxes', ['picture carton']),
  item('sofa-loveseat', 'Loveseat', 35, 'Seating', ['love seat', '2-seat sofa', 'two seat']),
  item('sofa-3', 'Sofa, 3-seat', 50, 'Seating', ['three seat sofa', '3 seat sofa', 'couch']),
  item('sofa-4', 'Sofa, 4-seat', 70, 'Seating', ['four seat']),
  item('sofa-sectional', 'Sectional sofa', 90, 'Seating', ['sectional']),
  item('chair-armchair', 'Armchair', 12, 'Seating', ['accent chair']),
  item('chair-recliner', 'Recliner', 25, 'Seating', ['recliner']),
  item('chair-dining', 'Dining chair', 5, 'Seating', ['side chair']),
  item('chair-office', 'Office chair', 10, 'Seating', ['desk chair']),
  item('ottoman', 'Ottoman', 5, 'Seating', ['footstool']),
  item('bed-twin', 'Bed, twin', 40, 'Bedroom', ['single bed']),
  item('bed-full', 'Bed, full', 50, 'Bedroom', ['double bed']),
  item('bed-queen', 'Bed, queen', 60, 'Bedroom', ['queen bed']),
  item('bed-king', 'Bed, king', 70, 'Bedroom', ['king bed']),
  item('mattress-twin', 'Mattress, twin', 20, 'Bedroom', []),
  item('mattress-full', 'Mattress, full', 25, 'Bedroom', []),
  item('mattress-queen', 'Mattress, queen', 30, 'Bedroom', []),
  item('mattress-king', 'Mattress, king', 35, 'Bedroom', []),
  item('crib', 'Crib', 10, 'Bedroom', []),
  item('bunk', 'Bunk bed', 70, 'Bedroom', []),
  item('nightstand', 'Nightstand', 5, 'Bedroom', ['bedside table']),
  item('dresser-small', 'Dresser, small', 20, 'Bedroom', ['chest of drawers small']),
  item('dresser-medium', 'Dresser, medium', 30, 'Bedroom', ['dresser']),
  item('dresser-large', 'Dresser, large', 40, 'Bedroom', ['double dresser']),
  item('armoire', 'Armoire', 50, 'Bedroom', ['wardrobe cabinet']),
  item('bookshelf-small', 'Bookshelf, small', 10, 'Storage', ['bookcase']),
  item('bookshelf-large', 'Bookshelf, large', 20, 'Storage', []),
  item('filing-cabinet', 'Filing cabinet', 10, 'Storage', []),
  item('coffee-table', 'Coffee table', 10, 'Tables', []),
  item('end-table', 'End table', 4, 'Tables', ['side table']),
  item('dining-small', 'Dining table, seats 4', 20, 'Tables', ['small dining table']),
  item('dining-large', 'Dining table, seats 6–8', 30, 'Tables', ['large dining table']),
  item('desk-small', 'Desk, small', 15, 'Tables', ['writing desk']),
  item('desk', 'Desk', 25, 'Tables', ['office desk']),
  item('fridge', 'Refrigerator', 45, 'Appliances', ['fridge']),
  item('fridge-compact', 'Refrigerator, compact', 20, 'Appliances', ['mini fridge']),
  item('washer', 'Washer', 25, 'Appliances', ['washing machine']),
  item('dryer', 'Dryer', 25, 'Appliances', []),
  item('stove', 'Range / stove', 30, 'Appliances', ['oven', 'stove']),
  item('dishwasher', 'Dishwasher', 20, 'Appliances', []),
  item('microwave', 'Microwave', 4, 'Appliances', []),
  item('tv-small', 'Television, up to 43 in', 5, 'Electronics', ['tv', 'small tv']),
  item('tv-large', 'Television, 50 in or larger', 10, 'Electronics', ['large tv']),
  item('tv-stand', 'TV stand', 15, 'Electronics', ['media console']),
  item('lamp-table', 'Table lamp', 2, 'Other', []),
  item('lamp-floor', 'Floor lamp', 3, 'Other', []),
  item('rug-small', 'Rug, small', 3, 'Other', []),
  item('rug-large', 'Rug, large', 8, 'Other', []),
  item('mirror-large', 'Large mirror', 5, 'Other', []),
  item('piano-upright', 'Piano, upright', 60, 'Other', ['upright piano']),
  item('piano-grand', 'Piano, baby grand', 80, 'Other', ['grand piano']),
  item('treadmill', 'Treadmill', 30, 'Other', []),
  item('grill', 'Barbecue grill', 15, 'Other', ['bbq']),
  item('bike', 'Bicycle', 8, 'Other', ['bike']),
  item('plant-large', 'Large plant', 5, 'Other', []),
];

const byKey = new Map(CATALOG.map((entry) => [entry.key, entry]));

export function getCatalogItem(key) {
  return byKey.get(key) || null;
}

export function searchCatalog(query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return CATALOG;
  return CATALOG.filter((entry) => {
    const hay = `${entry.name} ${entry.group} ${entry.aliases.join(' ')} ${entry.key}`.toLowerCase();
    return hay.includes(needle);
  });
}

export function resolveCatalogItem(key, name) {
  if (key && byKey.has(key)) return byKey.get(key);
  const text = String(name || '').toLowerCase();
  if (!text) return null;
  let best = null;
  for (const entry of CATALOG) {
    const names = [entry.name, ...entry.aliases, entry.key.replaceAll('-', ' ')];
    if (names.some((label) => text.includes(label.toLowerCase()))) {
      if (!best || entry.name.length > best.name.length) best = entry;
    }
  }
  return best;
}

export function roundHalf(value) {
  return Math.round(Number(value) * 2) / 2;
}

export function refineCubicFeet(baseline, dimensions) {
  const width = Number(dimensions?.w);
  const height = Number(dimensions?.h);
  const depth = Number(dimensions?.d);
  if (!(width > 0 && height > 0 && depth > 0) || !(baseline > 0)) {
    return { cubicFeet: baseline, usedDimensions: false, disagreed: false };
  }
  const raw = (width * height * depth) / 1728;
  if (raw >= baseline * 0.4 && raw <= baseline * 2.2) {
    return { cubicFeet: roundHalf(raw), usedDimensions: true, disagreed: false };
  }
  return { cubicFeet: baseline, usedDimensions: false, disagreed: true };
}

export function suggestTruck(cubicFeet, trucks = DEFAULT_TRUCKS) {
  const list = [...trucks].filter((truck) => truck.cubicFeet > 0).sort((a, b) => a.cubicFeet - b.cubicFeet);
  const needed = cubicFeet * 1.1;
  const fit = list.find((truck) => truck.cubicFeet >= needed);
  if (fit) return { ...fit, overflow: false };
  const largest = list[list.length - 1];
  if (!largest) return { id: 'unknown', name: 'Truck size not set', cubicFeet: null, overflow: true };
  return {
    id: largest.id,
    name: `${largest.name} plus a second truck`,
    cubicFeet: largest.cubicFeet,
    overflow: true,
  };
}

export function computeTotals(items, lbsPerCuft = 7, trucks = DEFAULT_TRUCKS) {
  const rooms = new Map();
  let cubicFeet = 0;
  for (const itemRow of items) {
    const notMoving = Boolean(itemRow.notMoving ?? itemRow.not_moving);
    if (notMoving) continue;
    const quantity = Number(itemRow.quantity) || 0;
    const each = Number(itemRow.cubicFeet ?? itemRow.cubic_feet);
    if (!Number.isFinite(each) || quantity <= 0) continue;
    const line = quantity * each;
    cubicFeet += line;
    const label = itemRow.roomLabel || itemRow.room_label || 'Unassigned';
    rooms.set(label, (rooms.get(label) || 0) + line);
  }
  cubicFeet = roundHalf(cubicFeet);
  const weight = Number(lbsPerCuft);
  const safeWeight = Number.isFinite(weight) && weight > 0 ? weight : 7;
  return {
    cubicFeet,
    weightLbs: Math.round(cubicFeet * safeWeight),
    lbsPerCuft: safeWeight,
    rooms: [...rooms.entries()].map(([room, feet]) => ({ room, cubicFeet: roundHalf(feet) })),
    truck: suggestTruck(cubicFeet, trucks),
  };
}

export function applyOverrides(overrides) {
  const map = new Map(CATALOG.map((entry) => [entry.key, { ...entry }]));
  for (const override of overrides || []) {
    const current = map.get(override.key);
    const cubicFeet = Number(override.cubicFeet);
    if (!current || !Number.isFinite(cubicFeet) || cubicFeet < 0 || cubicFeet > 500) continue;
    current.cubicFeet = cubicFeet;
    current.overridden = true;
  }
  return [...map.values()];
}
