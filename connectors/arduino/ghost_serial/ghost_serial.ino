/*
 * GHOST serial line protocol v0.1 - reference firmware (Arduino Uno / Nano / any AVR or ARM board)
 *
 * Wiring
 *   Servo (SG90):   signal -> D9 (SERVO_PIN), V+ -> 5V, GND -> GND
 *                   (for bigger servos use an external 5V supply and join its GND with the Arduino GND)
 *   Light sensor:   5V -- [photoresistor] --+-- [10k resistor] -- GND
 *                                           |
 *                                           +--> A0 (LIGHT_PIN)       brighter light = higher reading
 *   LED:            built-in LED on pin 13 (LED_BUILTIN), nothing to wire
 *
 * Protocol: 115200 baud, newline-delimited, one JSON object per line.
 *   Host:   ?\n
 *   Device: {"ghost":"0.1","name":"Desk Arduino","capabilities":[...]}      (one line)
 *   Host:   {"id":"inv_123","cap":"servo.move","args":{"angle":90}}\n
 *   Device: {"id":"inv_123","ok":true,"value":90,"unit":"deg"}
 *       or  {"id":"inv_123","ok":false,"error":"angle out of range (0..180)"}
 *
 * Capabilities
 *   led.set     act      args {on: boolean}        -> value true/false
 *   servo.move  act      args {angle: 0..180}      -> value angle, unit "deg" (out of range = rejected, not clamped)
 *   light.read  measure  no args                   -> value 0..1023, unit "raw" (raw 10-bit ADC reading,
 *                                                      NOT lux; higher = brighter with the divider above)
 *
 * The JSON parsing is deliberately minimal (no ArduinoJson dependency): it pulls out the string
 * value of "id" and "cap" and the number/boolean values of the known argument keys. Lines longer
 * than GHOST_LINE_MAX bytes are discarded and answered with an error.
 */
#include <Servo.h>
#include <string.h>
#include <stdlib.h>

#define BAUD 115200
#define SERVO_PIN 9
#define LIGHT_PIN A0
#define LED_PIN LED_BUILTIN
#define GHOST_LINE_MAX 256
#define ID_MAX 64
#define CAP_MAX 24

static const char DEVICE_NAME[] = "Desk Arduino";

Servo servo;
char line[GHOST_LINE_MAX + 1];
size_t lineLen = 0;
bool overflow = false;
bool ledOn = false;
int servoAngle = -1;  // unknown until first move (servo is not attached/moved at boot)

/* ---------------- output helpers ---------------- */

// Print a JSON string with minimal escaping (quotes, backslashes, control chars).
void printJsonString(const char *s) {
  Serial.print('"');
  for (; *s; s++) {
    char c = *s;
    if (c == '"' || c == '\\') { Serial.print('\\'); Serial.print(c); }
    else if ((unsigned char)c < 0x20) Serial.print(' ');
    else Serial.print(c);
  }
  Serial.print('"');
}

void beginReply(const char *id, bool ok) {
  Serial.print(F("{\"id\":"));
  printJsonString(id);
  Serial.print(ok ? F(",\"ok\":true") : F(",\"ok\":false"));
}

void replyError(const char *id, const __FlashStringHelper *msg) {
  beginReply(id, false);
  Serial.print(F(",\"error\":\""));
  Serial.print(msg);
  Serial.println(F("\"}"));
}

void printManifest() {
  Serial.print(F("{\"ghost\":\"0.1\",\"name\":"));
  printJsonString(DEVICE_NAME);
  Serial.print(F(",\"capabilities\":["));
  Serial.print(F("{\"id\":\"led.set\",\"kind\":\"act\",\"title\":\"Set LED\","
                 "\"description\":\"Turns the built-in LED (pin 13) on or off.\","
                 "\"params\":{\"on\":{\"type\":\"boolean\"}},\"unit\":null},"));
  Serial.print(F("{\"id\":\"servo.move\",\"kind\":\"act\",\"title\":\"Move servo\","
                 "\"description\":\"Moves the hobby servo on D9 to an absolute angle. Reports the commanded angle; position is not sensed.\","
                 "\"params\":{\"angle\":{\"type\":\"number\",\"minimum\":0,\"maximum\":180}},\"unit\":\"deg\"},"));
  Serial.print(F("{\"id\":\"light.read\",\"kind\":\"measure\",\"title\":\"Read light level\","
                 "\"description\":\"Raw 10-bit ADC reading (0..1023) of a photoresistor divider on A0. Higher is brighter. Not calibrated to lux.\","
                 "\"params\":{},\"unit\":\"raw\"}"));
  Serial.println(F("]}"));
}

/* ---------------- minimal JSON extraction ---------------- */

// Find `"key"` followed by optional spaces and ':' ; returns pointer just after ':' (spaces skipped) or NULL.
// Searches only within [from, end). Keys are matched as whole quoted strings.
const char *findKey(const char *from, const char *key) {
  size_t klen = strlen(key);
  const char *p = from;
  while ((p = strchr(p, '"')) != NULL) {
    if (strncmp(p + 1, key, klen) == 0 && p[1 + klen] == '"') {
      const char *q = p + 2 + klen;
      while (*q == ' ' || *q == '\t') q++;
      if (*q == ':') {
        q++;
        while (*q == ' ' || *q == '\t') q++;
        return q;
      }
    }
    p++;
  }
  return NULL;
}

// Copy a JSON string value (no escape support beyond rejecting backslashes). Returns false if invalid/too long.
bool getString(const char *json, const char *key, char *out, size_t outSize) {
  const char *v = findKey(json, key);
  if (!v || *v != '"') return false;
  v++;
  size_t n = 0;
  while (*v && *v != '"') {
    if (*v == '\\' || n + 1 >= outSize) return false;
    out[n++] = *v++;
  }
  if (*v != '"') return false;
  out[n] = '\0';
  return true;
}

// 0 = missing, 1 = ok, -1 = present but not a number
int getNumber(const char *json, const char *key, double *out) {
  const char *v = findKey(json, key);
  if (!v) return 0;
  char *endp;
  double d = strtod(v, &endp);
  if (endp == v) return -1;
  while (*endp == ' ') endp++;
  if (*endp != ',' && *endp != '}') return -1;
  *out = d;
  return 1;
}

// 0 = missing, 1 = ok, -1 = present but not a boolean
int getBool(const char *json, const char *key, bool *out) {
  const char *v = findKey(json, key);
  if (!v) return 0;
  if (strncmp(v, "true", 4) == 0) { *out = true; return 1; }
  if (strncmp(v, "false", 5) == 0) { *out = false; return 1; }
  return -1;
}

/* ---------------- command handling ---------------- */

void handleLine(char *s) {
  while (*s == ' ' || *s == '\t' || *s == '\r') s++;
  size_t n = strlen(s);
  while (n > 0 && (s[n - 1] == ' ' || s[n - 1] == '\r' || s[n - 1] == '\t')) s[--n] = '\0';
  if (n == 0) return;
  if (strcmp(s, "?") == 0) { printManifest(); return; }

  char id[ID_MAX + 1];
  char cap[CAP_MAX + 1];
  if (s[0] != '{' || !getString(s, "id", id, sizeof id)) {
    replyError("", F("expected a JSON object with id and cap, or ?"));
    return;
  }
  if (!getString(s, "cap", cap, sizeof cap)) { replyError(id, F("missing cap")); return; }

  // Arguments: look only inside "args" if present, so "id"/"cap" values can't be mistaken for args.
  const char *args = findKey(s, "args");
  if (args && *args != '{') { replyError(id, F("args must be an object")); return; }
  if (!args) args = "{}";

  if (strcmp(cap, "led.set") == 0) {
    bool on;
    int r = getBool(args, "on", &on);
    if (r != 1) { replyError(id, F("args.on must be true or false")); return; }
    ledOn = on;
    digitalWrite(LED_PIN, on ? HIGH : LOW);
    beginReply(id, true);
    Serial.println(on ? F(",\"value\":true}") : F(",\"value\":false}"));
  } else if (strcmp(cap, "servo.move") == 0) {
    double a;
    int r = getNumber(args, "angle", &a);
    if (r != 1) { replyError(id, F("args.angle must be a number")); return; }
    if (!(a >= 0.0 && a <= 180.0)) { replyError(id, F("angle out of range (0..180)")); return; }
    int angle = constrain((int)(a + 0.5), 0, 180);
    if (!servo.attached()) servo.attach(SERVO_PIN);
    servo.write(angle);
    servoAngle = angle;
    delay(400);  // give the servo time to get there before we report it
    beginReply(id, true);
    Serial.print(F(",\"value\":"));
    Serial.print(angle);
    Serial.println(F(",\"unit\":\"deg\"}"));
  } else if (strcmp(cap, "light.read") == 0) {
    int raw = analogRead(LIGHT_PIN);
    beginReply(id, true);
    Serial.print(F(",\"value\":"));
    Serial.print(raw);
    Serial.println(F(",\"unit\":\"raw\"}"));
  } else {
    replyError(id, F("unknown capability"));
  }
}

void setup() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  Serial.begin(BAUD);
  // Servo is attached on first servo.move, so it doesn't jump at power-up.
}

void loop() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n') {
      if (overflow) {
        replyError("", F("line too long"));
      } else {
        line[lineLen] = '\0';
        handleLine(line);
      }
      lineLen = 0;
      overflow = false;
    } else if (!overflow) {
      if (lineLen < GHOST_LINE_MAX) line[lineLen++] = c;
      else overflow = true;  // keep discarding until newline
    }
  }
}
