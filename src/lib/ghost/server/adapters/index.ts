import type { InternalAdapter } from "./types";
import { caltransAdapter } from "./caltrans";
import { noaaAdapter } from "./noaa";
import { lanAdapter } from "./lan";

/** Hardware and operator-published physical observations only. */
export const internalAdapters: InternalAdapter[] = [caltransAdapter, noaaAdapter, lanAdapter];
