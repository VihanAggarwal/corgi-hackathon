/**
 * THE 24 AXES. FROZEN CONTRACT.
 *
 * Do not add, remove, or reorder. Index position IS the vector position.
 * If you think an axis is wrong, raise it in the group chat. Do not edit.
 *
 * All values are z-scored, roughly -3..3. 0 = population mean.
 * `label` is what the LLM renderer is allowed to say out loud.
 */

export const AXES = [
  { key: 'heat_capsaicin',      label: 'chili heat',              low: 'mild',            high: 'seriously hot' },
  { key: 'heat_numbing',        label: 'numbing heat',            low: 'none',            high: 'mala' },
  { key: 'acid',                label: 'acidity',                 low: 'round, low acid', high: 'sharp and sour' },
  { key: 'salt',                label: 'salt level',              low: 'restrained',      high: 'aggressively salted' },
  { key: 'sweetness_savory',    label: 'sweetness in savory food',low: 'never',           high: 'welcome' },
  { key: 'sweetness_dessert',   label: 'sweetness in dessert',    low: 'barely sweet',    high: 'full sugar' },
  { key: 'fat_richness',        label: 'richness',                low: 'lean',            high: 'unctuous' },
  { key: 'umami_depth',         label: 'savory depth',            low: 'light',           high: 'deep and brothy' },
  { key: 'bitterness',          label: 'bitterness',              low: 'avoids',          high: 'seeks out' },
  { key: 'funk_ferment',        label: 'ferment and funk',        low: 'clean flavors',   high: 'funky' },
  { key: 'char_smoke',          label: 'char and smoke',          low: 'gentle cooking',  high: 'burnt edges' },
  { key: 'herb_freshness',      label: 'fresh herbs',             low: 'sparse',          high: 'herb forward' },
  { key: 'aromatic_spice',      label: 'warm spice',              low: 'plain',           high: 'heavily spiced' },
  { key: 'garlic_allium',       label: 'garlic and onion',        low: 'restrained',      high: 'loaded' },
  { key: 'texture_crunch',      label: 'crunch',                  low: 'soft',            high: 'crisp' },
  { key: 'texture_chew',        label: 'chew',                    low: 'tender',          high: 'chewy and springy' },
  { key: 'texture_creamy',      label: 'creaminess',              low: 'dry',             high: 'silky' },
  { key: 'temp_served',         label: 'serving temperature',     low: 'cold dishes',     high: 'hot dishes' },
  { key: 'portion_format',      label: 'format',                  low: 'shared plates',   high: 'one plate, yours' },
  { key: 'protein_prominence',  label: 'protein centrality',      low: 'vegetable led',   high: 'meat led' },
  { key: 'prep_novelty',        label: 'preparation novelty',     low: 'classic',         high: 'unusual technique' },
  { key: 'ingredient_familiar', label: 'ingredient familiarity',  low: 'adventurous',     high: 'recognizable' },
  { key: 'price_per_satiety',   label: 'value density',           low: 'small and dear',  high: 'filling and cheap' },
  { key: 'effort_to_eat',       label: 'effort to eat',           low: 'fork and done',   high: 'hands, mess, work' },
] as const;

export type AxisKey = (typeof AXES)[number]['key'];
export const AXIS_COUNT = 24;
export const AXIS_KEYS = AXES.map(a => a.key) as AxisKey[];

/** Index of an axis key in the vector. Throws on unknown key. */
export function axisIndex(key: AxisKey): number {
  const i = AXIS_KEYS.indexOf(key);
  if (i < 0) throw new Error(`Unknown axis: ${key}`);
  return i;
}
