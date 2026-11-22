// Turns the timestamps found in log lines into UTC ISO strings ("...Z").

const ISO_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/i;

export function toIso(text: string): string | undefined {
  const isoMatch = ISO_TIMESTAMP.exec(text.trim());
  if (!isoMatch) return undefined;
  const [, date, time, fraction = "", zone = "Z"] = isoMatch;
  const milliseconds = (fraction + "000").slice(0, 3);
  const timezoneOffset = zone.toUpperCase() === "Z" ? "Z" : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  return toIsoOrUndefined(Date.parse(`${date}T${time}.${milliseconds}${timezoneOffset}`));
}

// Epoch seconds or epoch milliseconds: values below 1e11 are taken as seconds.
export function epochToIso(value: number): string | undefined {
  return toIsoOrUndefined(value < 1e11 ? value * 1000 : value);
}

function toIsoOrUndefined(epochMs: number): string | undefined {
  if (!Number.isFinite(epochMs)) return undefined;
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
