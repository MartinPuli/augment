import type { InternalAdapter } from "../types";
import { aircraftService } from "./aircraft";
import { calendarService } from "./calendar";
import { cryptoService } from "./crypto";
import { earthquakesService } from "./earthquakes";
import { geocodeService } from "./geocode";
import { googleService } from "./google";
import { newsService } from "./news";
import { transitService } from "./transit";
import { weatherService } from "./weather";
import { wikipediaService } from "./wikipedia";
import { youtubeService } from "./youtube";

/** Digital-service adapters (one device each): weather, news, wikipedia, video, calendar, transit, aircraft, quakes, crypto, geocode. */
export const serviceAdapters: InternalAdapter[] = [
  weatherService,
  newsService,
  wikipediaService,
  youtubeService,
  calendarService,
  transitService,
  aircraftService,
  earthquakesService,
  cryptoService,
  geocodeService,
  googleService,
];
