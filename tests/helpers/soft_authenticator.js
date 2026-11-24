// tests/helpers/soft_authenticator.js
// A software WebAuthn authenticator for tests: produces real, signed registration and
// assertion responses (ES256, "none" attestation) exactly as a phone would, so the
// server-side passkey verification runs for real.

const crypto = require("crypto");

// ─── minimal CBOR encoder (uint, negint, bytes, text, map) ────────────────────
function head(major, len) {
  if (len < 24) return Buffer.from([(major << 5) | len]);
  if (len < 256) return Buffer.from([(major << 5) | 24, len]);
  if (len < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(len, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(len, 1); return b;
}
function cbor(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === "string") { const s = Buffer.from(value, "utf8"); return Buffer.concat([head(3, s.length), s]); }
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return Buffer.concat(parts);
  }
  throw new Error("unsupported CBOR value");
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");

class SoftAuthenticator {
  constructor({ rpId, origin }) {
    this.rpId = rpId;
    this.origin = origin;
    this.credentials = []; // { id, privateKey, userHandle, counter }
  }

  _rpIdHash() {
    return crypto.createHash("sha256").update(this.rpId).digest();
  }

  register(options) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const credId = crypto.randomBytes(16);
    const coseKey = new Map([
      [1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(jwk.x, "base64url")],
      [-3, Buffer.from(jwk.y, "base64url")],
    ]);
    const credLen = Buffer.alloc(2); credLen.writeUInt16BE(credId.length);
    const authData = Buffer.concat([
      this._rpIdHash(), Buffer.from([0x45]), Buffer.alloc(4),
      Buffer.alloc(16), credLen, credId, cbor(coseKey),
    ]);
    const clientDataJSON = Buffer.from(JSON.stringify({
      type: "webauthn.create", challenge: options.challenge, origin: this.origin, crossOrigin: false,
    }));
    const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    const cred = { id: b64u(credId), privateKey, userHandle: options.user.id, counter: 0 };
    this.credentials.push(cred);
    return {
      id: cred.id,
      rawId: cred.id,
      type: "public-key",
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ["internal"] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** Signs an assertion for `options`; `credential` defaults to the last registered one. */
  assert(options, credential = this.credentials[this.credentials.length - 1], { origin = this.origin } = {}) {
    credential.counter += 1;
    const counter = Buffer.alloc(4); counter.writeUInt32BE(credential.counter);
    const authData = Buffer.concat([this._rpIdHash(), Buffer.from([0x05]), counter]);
    const clientDataJSON = Buffer.from(JSON.stringify({
      type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false,
    }));
    const signature = crypto.sign(
      "sha256",
      Buffer.concat([authData, crypto.createHash("sha256").update(clientDataJSON).digest()]),
      credential.privateKey
    );
    return {
      id: credential.id,
      rawId: credential.id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: credential.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}

module.exports = { SoftAuthenticator };
