/**
 * Connectors gallery catalog. `real` entries are integrations that actually work in this app today;
 * the rest are front-end mocks (Connect shows an OAuth-style consent and remembers it in localStorage).
 */

export const CONNECTOR_CATEGORIES = [
  "Productivity",
  "Communication",
  "Social",
  "Media & Entertainment",
  "Smart Home & Devices",
  "Travel & Transit",
  "Finance",
  "Health",
  "Developer",
  "Data & Knowledge",
] as const;

export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number];

export interface Connector {
  id: string;
  name: string;
  description: string;
  category: ConnectorCategory;
  /** simple-icons slug in BRAND_ICONS; otherwise `lucide` names a lucide-react icon. */
  icon?: string;
  lucide?: string;
  /** Brand color for the lucide fallback tile. */
  color?: string;
  /** Real integration already wired into the app (shown as connected by default). */
  real?: boolean;
  comingSoon?: boolean;
  /** Special flows handled by the gallery. */
  special?: "google";
  /** Scopes shown on the mock consent screen. */
  scopes?: string[];
}

export const CONNECTORS: Connector[] = [
  // Productivity
  { id: "google-workspace", name: "Google Workspace", description: "Gmail, Calendar, Drive and Contacts through one secure OAuth sign-in.", category: "Productivity", icon: "google", special: "google" },
  { id: "gmail", name: "Gmail", description: "Search and read your inbox, draft replies.", category: "Communication", icon: "gmail", scopes: ["Read your email", "Create drafts"] },
  { id: "google-calendar", name: "Google Calendar", description: "See your agenda and schedule new events.", category: "Productivity", icon: "googlecalendar", scopes: ["View and edit events"] },
  { id: "google-drive", name: "Google Drive", description: "Find files and folders across your Drive.", category: "Productivity", icon: "googledrive", scopes: ["View your files"] },
  { id: "google-docs", name: "Google Docs", description: "Read and summarize documents.", category: "Productivity", icon: "googledocs", scopes: ["View your documents"] },
  { id: "google-contacts", name: "Google Contacts", description: "Look up people, phone numbers and emails.", category: "Productivity", icon: "google", scopes: ["View your contacts"] },
  { id: "notion", name: "Notion", description: "Search pages and databases in your workspace.", category: "Productivity", icon: "notion" },
  { id: "dropbox", name: "Dropbox", description: "Browse and fetch files from Dropbox.", category: "Productivity", icon: "dropbox" },
  { id: "onedrive", name: "OneDrive", description: "Files from your Microsoft account.", category: "Productivity", lucide: "Cloud", color: "#0078D4" },
  { id: "todoist", name: "Todoist", description: "Add tasks and read today's to-dos.", category: "Productivity", icon: "todoist" },
  { id: "trello", name: "Trello", description: "Boards, lists and cards.", category: "Productivity", icon: "trello" },
  { id: "asana", name: "Asana", description: "Projects and tasks for your team.", category: "Productivity", icon: "asana" },

  // Communication
  { id: "outlook", name: "Outlook", description: "Microsoft mail and calendar.", category: "Communication", lucide: "Mail", color: "#0078D4" },
  { id: "slack", name: "Slack", description: "Read channels and post messages.", category: "Communication", lucide: "Hash", color: "#4A154B" },
  { id: "whatsapp", name: "WhatsApp", description: "Send and receive messages.", category: "Communication", icon: "whatsapp" },
  { id: "telegram", name: "Telegram", description: "Chat with Polty from Telegram.", category: "Communication", icon: "telegram" },
  { id: "discord", name: "Discord", description: "Servers, channels and DMs.", category: "Communication", icon: "discord" },
  { id: "zoom", name: "Zoom", description: "Join and schedule meetings.", category: "Communication", icon: "zoom" },
  { id: "agentmail", name: "AgentMail", description: "Polty's own inbox: send and receive email.", category: "Communication", lucide: "AtSign", color: "#111827" },
  { id: "elevenlabs", name: "ElevenLabs voice", description: "Realtime speech-to-text and natural voice.", category: "Communication", icon: "elevenlabs", real: true },

  // Social
  { id: "instagram", name: "Instagram", description: "Your feed, stories and DMs.", category: "Social", icon: "instagram" },
  { id: "x", name: "X / Twitter", description: "Timeline, mentions and posting.", category: "Social", icon: "x" },
  { id: "linkedin", name: "LinkedIn", description: "Profile, network and messages.", category: "Social", lucide: "Briefcase", color: "#0A66C2" },
  { id: "facebook", name: "Facebook", description: "Pages, events and Messenger.", category: "Social", icon: "facebook" },
  { id: "reddit", name: "Reddit", description: "Subreddits, threads and saved posts.", category: "Social", icon: "reddit" },
  { id: "pinterest", name: "Pinterest", description: "Boards and pins for inspiration.", category: "Social", icon: "pinterest" },
  { id: "tiktok", name: "TikTok", description: "Trending and saved videos.", category: "Social", icon: "tiktok" },

  // Media & Entertainment
  { id: "youtube", name: "YouTube", description: "Search and play videos on the canvas.", category: "Media & Entertainment", icon: "youtube", real: true },
  { id: "spotify", name: "Spotify", description: "Play music, control playback, see what's on.", category: "Media & Entertainment", icon: "spotify", scopes: ["Control playback", "Read your library"] },
  { id: "sonos", name: "Sonos", description: "Speakers in every room.", category: "Media & Entertainment", icon: "sonos" },
  { id: "netflix", name: "Netflix", description: "What to watch next.", category: "Media & Entertainment", icon: "netflix", comingSoon: true },

  // Smart Home & Devices
  { id: "philips-hue", name: "Philips Hue", description: "Lights, scenes and rooms.", category: "Smart Home & Devices", icon: "philipshue" },
  { id: "home-assistant", name: "Home Assistant", description: "Every device in your smart home.", category: "Smart Home & Devices", icon: "homeassistant" },
  { id: "shelly", name: "Shelly", description: "Relays and plugs on your LAN.", category: "Smart Home & Devices", icon: "shelly" },
  { id: "wled", name: "WLED", description: "Addressable LED strips over Wi-Fi.", category: "Smart Home & Devices", lucide: "Lightbulb", color: "#F59E0B" },
  { id: "arduino", name: "Arduino / USB serial", description: "Plug in a board and drive it over Web Serial.", category: "Smart Home & Devices", icon: "arduino" },
  { id: "ble", name: "Bluetooth LE", description: "Sensors and gadgets over Web Bluetooth.", category: "Smart Home & Devices", icon: "bluetooth" },
  { id: "phone-sensors", name: "Phone sensors", description: "Camera, mic and motion from a paired phone.", category: "Smart Home & Devices", lucide: "Smartphone", color: "#0f766e" },
  { id: "raspberry-pi", name: "Raspberry Pi", description: "GPIO, cameras and sensors on a Pi.", category: "Smart Home & Devices", icon: "raspberrypi" },
  { id: "caltrans", name: "Caltrans cameras", description: "Live California highway cameras.", category: "Smart Home & Devices", lucide: "Cctv", color: "#1d4ed8", real: true },

  // Travel & Transit
  { id: "google-maps", name: "Google Maps", description: "Places, directions and travel times.", category: "Travel & Transit", icon: "googlemaps" },
  { id: "uber", name: "Uber", description: "Request rides and get ETAs.", category: "Travel & Transit", icon: "uber" },
  { id: "lyft", name: "Lyft", description: "Ride estimates and requests.", category: "Travel & Transit", icon: "lyft" },
  { id: "airbnb", name: "Airbnb", description: "Trips, stays and reservations.", category: "Travel & Transit", icon: "airbnb" },
  { id: "bart", name: "BART", description: "Real-time Bay Area train departures.", category: "Travel & Transit", lucide: "TrainFront", color: "#0099D8", real: true },

  // Finance
  { id: "plaid", name: "Plaid", description: "Bank balances and transactions.", category: "Finance", lucide: "Landmark", color: "#111111" },
  { id: "stripe", name: "Stripe", description: "Payments, payouts and customers.", category: "Finance", icon: "stripe" },
  { id: "venmo", name: "Venmo", description: "Send and request money.", category: "Finance", icon: "venmo" },

  // Health
  { id: "apple-health", name: "Apple Health", description: "Steps, sleep and heart rate.", category: "Health", icon: "apple", comingSoon: true },
  { id: "strava", name: "Strava", description: "Runs, rides and personal records.", category: "Health", icon: "strava" },
  { id: "fitbit", name: "Fitbit", description: "Activity, sleep and readiness.", category: "Health", icon: "fitbit" },

  // Developer
  { id: "github", name: "GitHub", description: "Repos, issues and pull requests.", category: "Developer", icon: "github" },
  { id: "linear", name: "Linear", description: "Issues, cycles and projects.", category: "Developer", icon: "linear" },
  { id: "jira", name: "Jira", description: "Tickets and sprint boards.", category: "Developer", icon: "jira" },
  { id: "figma", name: "Figma", description: "Files, frames and comments.", category: "Developer", icon: "figma" },
  { id: "kernel", name: "Kernel browser", description: "A cloud browser Polty can drive for you.", category: "Developer", lucide: "Globe", color: "#7c3aed" },
  { id: "executor-mcp", name: "Executor MCP", description: "Plug any MCP tool server into Polty.", category: "Developer", icon: "modelcontextprotocol" },
  { id: "mastra", name: "Mastra missions", description: "Long-running multi-step agent missions.", category: "Developer", lucide: "Workflow", color: "#0f172a" },

  // Data & Knowledge
  { id: "exa", name: "Exa web search", description: "Neural web search and page reading.", category: "Data & Knowledge", lucide: "Search", color: "#1e40af", real: true },
  { id: "weather", name: "Weather (Open-Meteo)", description: "Forecasts and air quality anywhere.", category: "Data & Knowledge", lucide: "CloudSun", color: "#0ea5e9", real: true },
  { id: "noaa", name: "NOAA", description: "Weather alerts, tides and buoys.", category: "Data & Knowledge", lucide: "Waves", color: "#003087", real: true },
  { id: "wikipedia", name: "Wikipedia", description: "Summaries of any topic.", category: "Data & Knowledge", icon: "wikipedia", real: true },
  { id: "news", name: "News", description: "Top headlines and topic news.", category: "Data & Knowledge", icon: "googlenews", real: true },
];
