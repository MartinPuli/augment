import type { InternalAdapter } from "./types";
import { caltransAdapter } from "./caltrans";
import { noaaAdapter } from "./noaa";
import { lanAdapter } from "./lan";

/** All in-process adapters. The coordinator registers each at boot. */
export const internalAdapters: InternalAdapter[] = [caltransAdapter, noaaAdapter, lanAdapter];
