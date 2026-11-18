import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { VaultToolError } from "./memory-store.mjs";
import { storageFilePath } from "./settings.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const waitWord = new Int32Array(new SharedArrayBuffer(4));
const readFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

function readId(file) {
  const fd = fs.openSync(file, readFlags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size !== 37
      || (process.getuid && stat.uid !== process.getuid())) throw new Error();
    const value = fs.readFileSync(fd, "utf8");
    const id = value.slice(0, -1);
    if (!uuid.test(id) || !value.endsWith("\n")) throw new Error();
    return id;
  } finally { fs.closeSync(fd); }
}

function identity(file, { create = false, preferred } = {}) {
  let id;
  try {
    const target = storageFilePath(file, { createParent: create, tightenParent: false });
    try { id = readId(target); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!create) return null;
      const next = preferred ?? randomUUID();
      const temporary = `${target}.${randomUUID()}.tmp`;
      // Publish a fully written ID by rename; a concurrent process never observes a partial UUID.
      const lock = `${target}.lock`;
      for (let attempt = 0; ; attempt++) {
        let fd;
        try { fd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600); }
        catch (error) {
          if (error.code !== "EEXIST" || attempt >= 100) throw error;
          Atomics.wait(waitWord, 0, 0, 10);
          continue;
        }
        try {
          try { id = readId(target); } catch (error) {
            if (error.code !== "ENOENT") throw error;
            const output = fs.openSync(temporary, "wx", 0o600);
            try { fs.writeFileSync(output, `${next}\n`); fs.fsyncSync(output); } finally { fs.closeSync(output); }
            fs.renameSync(temporary, target);
            const parent = fs.openSync(path.dirname(target), fs.constants.O_RDONLY);
            try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
            id = next;
          }
        } finally {
          try { fs.rmSync(temporary, { force: true }); } finally {
            try { fs.closeSync(fd); } finally { fs.unlinkSync(lock); }
          }
        }
        break;
      }
    }
  } catch (error) {
    if (!create && error.code === "ENOENT") return null;
    throw new VaultToolError("database_identity_invalid", "Database identity must be a private, owner-controlled UUID file.");
  }
  if (preferred !== undefined && id !== preferred) {
    throw new VaultToolError("database_vault_mismatch", "The destination vault identity differs from the SQLite source vault identity.");
  }
  return id;
}

export const vaultDatabaseId = (vault, options) => identity(path.resolve(vault, ".agent-vault/vault-id"), options);

export function memoryTaskHost({ create = true } = {}) {
  const config = process.env.XDG_CONFIG_HOME;
  const base = config && path.isAbsolute(config) ? config : path.join(homedir(), ".config");
  return identity(path.join(base, "agent-vault", "host-id"), { create });
}
