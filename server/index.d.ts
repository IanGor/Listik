import type { Server } from 'node:http';

/** The sync server as an http.Server, for tests and embedding; reads its settings from the environment at import. */
export function createListikServer(): Server;
/** Loads every stored document before serving. */
export function warmUp(): Promise<void>;
