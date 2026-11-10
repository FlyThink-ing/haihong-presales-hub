import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLEL = 1;
const KEY_LENGTH = 64;

export function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12) {
    throw new Error("密码长度至少为 12 位");
  }
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLEL,
    maxmem: 64 * 1024 * 1024
  });
  return `scrypt$${SCRYPT_COST}$${SCRYPT_BLOCK_SIZE}$${SCRYPT_PARALLEL}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export function verifyPassword(password, storedHash) {
  try {
    const [algorithm, n, r, p, saltText, keyText] = storedHash.split("$");
    if (algorithm !== "scrypt") return false;
    const expected = Buffer.from(keyText, "base64url");
    const actual = scryptSync(password, Buffer.from(saltText, "base64url"), expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024
    });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function newOpaqueToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

