import type { SportPlugin } from "./types.js";
import { cricket } from "./cricket.js";
import { football } from "./football.js";
import { tennis } from "./tennis.js";

// The registry. Match Engine looks a plugin up by sportId at reduce time.
// New sport = add a file + one line here. No core service changes.
const REGISTRY: Record<string, SportPlugin> = {
  [cricket.id]: cricket,
  [football.id]: football,
  [tennis.id]: tennis,
};

export function getPlugin(sportId: string): SportPlugin {
  const plugin = REGISTRY[sportId];
  if (!plugin) throw new Error(`No sport plugin registered for '${sportId}'`);
  return plugin;
}

export type { SportPlugin } from "./types.js";
