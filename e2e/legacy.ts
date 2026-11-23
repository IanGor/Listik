export function legacyStorage(origin: string) {
  return {
    cookies: [],
    origins: [{ origin, localStorage: [{ name: 'listik-view-mode', value: 'legacy' }] }],
  };
}
