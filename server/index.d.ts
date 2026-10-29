import type { Server } from 'node:http';

/** The sync server as an http.Server, for tests and embedding; reads its settings from the environment at import. */
export function createListikServer(): Server;
/** The address failed attempts count against: the last `X-Forwarded-For` entry from a proxy on this machine, else the peer. */
export function addressOf(req: { socket: { remoteAddress?: string }; headers: Record<string, string | string[] | undefined> }): string;
/** How many documents are held in memory (for tests). */
export function openDocuments(): number;
/** Loads every stored document before serving. */
export function warmUp(): Promise<void>;
