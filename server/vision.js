import { applyOverrides, refineCubicFeet, resolveCatalogItem } from './catalog.js';
import { isProduction } from './env.js';

export function visionMode() {
  if (process.env.OPENAI_API_KEY) return 'live';
  if (!isProduction() && process.env.NODE_ENV === 'test' && process.env.VISION_STUB === '1') return 'stub';
  return 'off';
}

function stubItems() {
  return [
    {
      catalogKey: 'bed-queen',
      name: 'Queen bed',
      quantity: 1,
      confidence: 0.82,
      dimensionsInches: { w: 64, h: 54, d: 86 },
    },
    {
      catalogKey: 'box-medium',
      name: 'Medium box',
      quantity: 2,
      confidence: 0.64,
    },
  ];
}

function clampConfidence(value, disagreed) {
  const number = Number(value);
  const base = Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0.4;
  return Math.round((disagreed ? Math.max(0, base - 0.25) : base) * 100) / 100;
}

export function interpretDetections(rawItems, catalog) {
  const items = [];
  for (const raw of rawItems || []) {
    const match = resolveCatalogItem(raw.catalogKey, raw.name) || catalog.find((entry) => entry.key === raw.catalogKey);
    const quantity = Math.min(99, Math.max(1, Math.round(Number(raw.quantity) || 1)));
    if (!match) {
      items.push({
        catalogKey: null,
        name: String(raw.name || 'Unidentified item').slice(0, 80),
        quantity,
        cubicFeet: null,
        sizeLabel: 'Set size',
        confidence: clampConfidence(raw.confidence, true),
        source: 'ai',
        needsSize: true,
      });
      continue;
    }
    const refined = refineCubicFeet(match.cubicFeet, raw.dimensionsInches);
    items.push({
      catalogKey: match.key,
      name: match.name,
      quantity,
      cubicFeet: refined.cubicFeet,
      sizeLabel: match.name,
      confidence: clampConfidence(raw.confidence, refined.disagreed),
      source: 'ai',
      usedDimensions: refined.usedDimensions,
      needsSize: false,
    });
  }
  return items;
}

async function liveDetections(image, catalog) {
  const keys = catalog.map((entry) => entry.key).join(', ');
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You inventory household furniture and moving boxes in one camera frame. Reply with JSON {"items":[{"catalogKey":"","name":"","quantity":1,"confidence":0.5,"dimensionsInches":{"w":0,"h":0,"d":0}}]}. catalogKey must be one of: ${keys}. Use an empty catalogKey if nothing fits. confidence is 0 to 1. Estimate dimensions in inches only when the object is clearly visible. Do not invent rooms or prices.`,
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'List the furniture and boxes that are clearly visible in this frame.' },
            { type: 'image_url', image_url: { url: image } },
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    const error = new Error('The vision service did not accept this frame.');
    error.status = 502;
    throw error;
  }
  const body = await response.json();
  const text = body.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const error = new Error('The vision service returned an unreadable inventory.');
    error.status = 502;
    throw error;
  }
  return Array.isArray(parsed.items) ? parsed.items : [];
}

export async function scanFrame(image, catalog) {
  const mode = visionMode();
  if (mode === 'off') {
    const error = new Error('AI scanning needs an API key on the server. Add items from the reference list, or set OPENAI_API_KEY.');
    error.status = 409;
    error.code = 'ai_unconfigured';
    throw error;
  }
  const detected = mode === 'stub' ? stubItems() : await liveDetections(image, catalog);
  return { items: interpretDetections(detected, catalog), mode };
}

export function catalogForScan(overrides) {
  return applyOverrides(overrides);
}
