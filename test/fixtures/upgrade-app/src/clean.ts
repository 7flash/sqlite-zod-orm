// @ts-nocheck: deliberately written for sqlite-zod-orm 3.x, scanned by upgrade-check tests.
import { db } from "./db";
// A file with nothing affected: plain reads and writes.
export const names = () => db.users.select().where({ name: "a" }).orderBy("name", "asc").limit(10).all();
