import type { InternalAdapter } from "./types";
import { caltransAdapter } from "./caltrans";
import { noaaAdapter } from "./noaa";
import { lanAdapter } from "./lan";
import { kernelAdapter } from "./kernel";
import { serviceAdapters } from "./services";

/** All in-process adapters. The coordinator registers each at boot. */
export const internalAdapters: InternalAdapter[] = [caltransAdapter, noaaAdapter, lanAdapter, kernelAdapter, ...serviceAdapters];
