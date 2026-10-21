import { applyOverrides, computeTotals, DEFAULT_TRUCKS } from './catalog.js';
import * as db from './db.js';

export function readOffice() {
  const row = db.getSettings();
  let trucks = DEFAULT_TRUCKS;
  let overrides = [];
  try {
    if (row.trucks_json) trucks = JSON.parse(row.trucks_json);
  } catch {
    trucks = DEFAULT_TRUCKS;
  }
  try {
    if (row.catalog_json) overrides = JSON.parse(row.catalog_json);
  } catch {
    overrides = [];
  }
  if (!Array.isArray(trucks) || trucks.length === 0) trucks = DEFAULT_TRUCKS;
  return {
    companyName: row.company_name,
    tagline: row.tagline,
    lbsPerCuft: row.lbs_per_cuft,
    trucks,
    overrides: Array.isArray(overrides) ? overrides : [],
    catalog: applyOverrides(Array.isArray(overrides) ? overrides : []),
  };
}

export function publicItem(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    roomLabel: row.room_label,
    catalogKey: row.catalog_key,
    name: row.name,
    sizeLabel: row.size_label,
    quantity: row.quantity,
    cubicFeet: row.cubic_feet,
    confidence: row.confidence,
    source: row.source,
    notMoving: Boolean(row.not_moving),
    notes: row.notes,
    recordingId: row.recording_id,
    updatedAt: row.updated_at,
  };
}

export function inventoryView(roomId) {
  const office = readOffice();
  const items = db.listInventory(roomId).map(publicItem);
  return {
    items,
    totals: computeTotals(items, office.lbsPerCuft, office.trucks),
    companyName: office.companyName,
  };
}
