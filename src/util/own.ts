/**
 * A string of its own. V8 returns longer strings (13+ chars) cut out of a
 * big text — JSON.parse, slice, split — as slices that keep the whole source
 * alive: one text of a 26 MB snapshot would hold all of it. Slicing a fresh
 * concatenation makes V8 copy just this string.
 */
export const own = (s: string): string => (s.length < 13 ? s : ` ${s}`.slice(1));
