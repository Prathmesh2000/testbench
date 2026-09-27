import type { JsonCache } from './cache';
import type { Db } from './db/client';
import type { ObjectStorage } from './storage';

/** What every service module needs from the process that mounts it (deploy/core-api). */
export interface ServiceDeps {
  db: Db;
  cache: JsonCache;
  storage: ObjectStorage;
}
