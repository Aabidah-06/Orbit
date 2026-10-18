/**
 * Interactive Webhook Payload Signature Verifier & Multi-Language Code Generator (#182)
 *
 * Implements deterministic pure-JS / Web-Crypto compatible SHA-256 & HMAC-SHA256
 * calculation, header parsing (`t=<unix_ts>,v1=<hex>` and `sha256=<hex>`),
 * 5-minute replay-window validation, step-by-step diagnostic classification,
 * and 6-language middleware verification snippet generation.
 */

export type WebhookDiagnosticCode =
  | "VALID_SIGNATURE"
  | "TIMESTAMP_EXPIRED"
  | "DIGEST_MISMATCH"
  | "MALFORMED_HEADER";

export type WebhookVerifyLanguage =
  | "nodejs"
  | "python"
  | "go"
  | "rust"
  | "php"
  | "ruby";

export interface ParsedSignatureHeader {
  valid: boolean;
  scheme: "v1" | "sha256" | "invalid";
  timestamp: number | null;
  signatureHex: string;
  rawHeader: string;
  error?: string;
}

export interface WebhookVerificationStep {
  stepNumber: number;
  title: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  value?: string;
}

export interface WebhookVerificationBreakdown {
  isValid: boolean;
  diagnosticCode: WebhookDiagnosticCode;
  diagnosticTitle: string;
  diagnosticMessage: string;
  parsedHeader: ParsedSignatureHeader;
  canonicalSignedString: string;
  expectedDigestHex: string;
  providedDigestHex: string;
  timestampAgeSeconds: number | null;
  toleranceSeconds: number;
  whitespaceNormalizedMatch: boolean;
  steps: WebhookVerificationStep[];
}

export const DEFAULT_REPLAY_TOLERANCE_SECONDS = 300; // 5 minutes

// Pure JS SHA-256 + HMAC-SHA256 implementation so verification is synchronous,
// deterministic, and runs identically in Browser, Next.js SSR, and Node tests.
const K_SHA256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function utf8Bytes(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

export function sha256Bytes(message: Uint8Array): Uint8Array {
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const bitLen = message.length * 8;
  const padLen = ((message.length + 9 + 63) & ~63);
  const padded = new Uint8Array(padLen);
  padded.set(message);
  padded[message.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padLen - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);

  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K_SHA256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function computeHmacSha256Hex(secret: string, message: string): string {
  const blockSize = 64;
  let keyBytes = utf8Bytes(secret);
  if (keyBytes.length > blockSize) {
    keyBytes = sha256Bytes(keyBytes);
  }

  const oKeyPad = new Uint8Array(blockSize);
  const iKeyPad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    const k = i < keyBytes.length ? keyBytes[i] : 0;
    oKeyPad[i] = k ^ 0x5c;
    iKeyPad[i] = k ^ 0x36;
  }

  const msgBytes = utf8Bytes(message);
  const innerInput = new Uint8Array(blockSize + msgBytes.length);
  innerInput.set(iKeyPad, 0);
  innerInput.set(msgBytes, blockSize);
  const innerHash = sha256Bytes(innerInput);

  const outerInput = new Uint8Array(blockSize + innerHash.length);
  outerInput.set(oKeyPad, 0);
  outerInput.set(innerHash, blockSize);
  const digest = sha256Bytes(outerInput);

  return toHex(digest);
}

/**
 * Constant-time hex digest comparison to mirror production webhook verification.
 */
export function constantTimeHexEquals(expectedHex: string, actualHex: string): boolean {
  const a = expectedHex.trim().toLowerCase();
  const b = actualHex.trim().toLowerCase();
  if (a.length === 0 || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Parses `X-Orbit-Signature` headers in either:
 *   1. Timestamped v1 format: `t=1729260000,v1=a89f0293...`
 *   2. Standard SHA-256 format: `sha256=a89f0293...` (with optional `externalTimestamp`)
 */
export function parseOrbitSignatureHeader(
  headerValue: string,
  externalTimestamp?: string | number | null
): ParsedSignatureHeader {
  const raw = (headerValue || "").trim();
  if (!raw) {
    return {
      valid: false,
      scheme: "invalid",
      timestamp: null,
      signatureHex: "",
      rawHeader: raw,
      error: "Missing X-Orbit-Signature header value.",
    };
  }

  // Case 1: t=<unix>,v1=<hex> (or t=<unix>,sha256=<hex>)
  if (raw.includes(",")) {
    const parts = raw.split(",").map((p) => p.trim());
    let timestamp: number | null = null;
    let signatureHex = "";

    for (const part of parts) {
      const eqIdx = part.indexOf("=");
      if (eqIdx <= 0) continue;
      const k = part.slice(0, eqIdx).trim();
      const v = part.slice(eqIdx + 1).trim();
      if (k === "t") {
        if (!/^\d+$/.test(v)) {
          return {
            valid: false,
            scheme: "invalid",
            timestamp: null,
            signatureHex: "",
            rawHeader: raw,
            error: `Invalid timestamp token 't=${v}' in signature header.`,
          };
        }
        timestamp = Number(v);
      } else if (k === "v1" || k === "sha256") {
        signatureHex = v.toLowerCase();
      }
    }

    if (timestamp === null || !/^[0-9a-f]{64}$/.test(signatureHex)) {
      return {
        valid: false,
        scheme: "invalid",
        timestamp,
        signatureHex,
        rawHeader: raw,
        error:
          "Header must contain both 't=<unix_seconds>' and a 64-character hex digest in 'v1=<hex>'.",
      };
    }

    return {
      valid: true,
      scheme: "v1",
      timestamp,
      signatureHex,
      rawHeader: raw,
    };
  }

  // Case 2: sha256=<64-hex> or v1=<64-hex>
  const match = /^(sha256|v1)=([0-9a-fA-F]{64})$/.exec(raw);
  if (match) {
    let parsedTs: number | null = null;
    if (externalTimestamp !== undefined && externalTimestamp !== null && String(externalTimestamp).trim() !== "") {
      const tsStr = String(externalTimestamp).trim();
      if (!/^\d+$/.test(tsStr)) {
        return {
          valid: false,
          scheme: "invalid",
          timestamp: null,
          signatureHex: match[2].toLowerCase(),
          rawHeader: raw,
          error: `Invalid X-Orbit-Timestamp value '${tsStr}'. Must be unix epoch seconds.`,
        };
      }
      parsedTs = Number(tsStr);
    }

    return {
      valid: true,
      scheme: match[1].toLowerCase() === "v1" ? "v1" : "sha256",
      timestamp: parsedTs,
      signatureHex: match[2].toLowerCase(),
      rawHeader: raw,
    };
  }

  return {
    valid: false,
    scheme: "invalid",
    timestamp: null,
    signatureHex: "",
    rawHeader: raw,
    error:
      "Malformed X-Orbit-Signature header. Expected 't=<timestamp>,v1=<64-char-hex>' or 'sha256=<64-char-hex>'.",
  };
}

/**
 * Generates a signed test webhook bundle (`rawBody`, `signatureHeader`, `timestamp`, `digestHex`).
 */
export function generateSignedWebhookTestBundle(options: {
  secret: string;
  event?: string;
  timestampSeconds?: number;
  scheme?: "v1" | "sha256";
  customBody?: string;
}) {
  const timestamp =
    options.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const scheme = options.scheme ?? "v1";
  const secret = options.secret || "whsec_test_secret";

  const rawBody =
    options.customBody ??
    JSON.stringify(
      {
        event: options.event || "payment.settled",
        subscription_id: "sub_bob_9421",
        customer_wallet_address:
          "GBOBZ7M5W8Y2K6T1R9P0V4N8D2L7C3F9A1H5J8K2",
        amount: 29.0,
        currency: "USDC",
        tx_hash: "7b4c91a82d03ef4991ac8472910fae194830bb21",
        timestamp: new Date(timestamp * 1000).toISOString(),
      },
      null,
      2
    );

  const canonical =
    scheme === "v1" ? `${timestamp}.${rawBody}` : rawBody;
  const digestHex = computeHmacSha256Hex(secret, canonical);
  const signatureHeader =
    scheme === "v1"
      ? `t=${timestamp},v1=${digestHex}`
      : `sha256=${digestHex}`;

  return {
    secret,
    timestamp,
    rawBody,
    canonical,
    digestHex,
    signatureHeader,
  };
}

/**
 * Performs step-by-step HMAC-SHA256 webhook verification with diagnostic classification.
 */
export function verifyWebhookSignature(params: {
  signingSecret: string;
  rawBody: string;
  signatureHeader: string;
  timestampHeader?: string | number | null;
  nowUnixSeconds?: number;
  toleranceSeconds?: number;
}): WebhookVerificationBreakdown {
  const secret = params.signingSecret || "";
  const rawBody = params.rawBody ?? "";
  const nowSeconds = params.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  const toleranceSeconds =
    params.toleranceSeconds ?? DEFAULT_REPLAY_TOLERANCE_SECONDS;

  const parsedHeader = parseOrbitSignatureHeader(
    params.signatureHeader,
    params.timestampHeader
  );

  const steps: WebhookVerificationStep[] = [];

  if (!parsedHeader.valid || !secret.trim()) {
    const reason = !secret.trim()
      ? "Webhook signing secret cannot be empty."
      : parsedHeader.error || "Malformed signature header.";

    steps.push({
      stepNumber: 1,
      title: "Parse X-Orbit-Signature Header",
      status: "fail",
      detail: reason,
      value: params.signatureHeader || "(empty)",
    });

    return {
      isValid: false,
      diagnosticCode: "MALFORMED_HEADER",
      diagnosticTitle: "Malformed header",
      diagnosticMessage: reason,
      parsedHeader,
      canonicalSignedString: "",
      expectedDigestHex: "",
      providedDigestHex: parsedHeader.signatureHex,
      timestampAgeSeconds: null,
      toleranceSeconds,
      whitespaceNormalizedMatch: false,
      steps,
    };
  }

  steps.push({
    stepNumber: 1,
    title: "Parse Signature Header & Scheme",
    status: "pass",
    detail:
      parsedHeader.timestamp !== null
        ? `Extracted scheme '${parsedHeader.scheme}' and timestamp t=${parsedHeader.timestamp}.`
        : `Extracted scheme '${parsedHeader.scheme}' (raw payload digest mode).`,
    value: `scheme=${parsedHeader.scheme}, digest=${parsedHeader.signatureHex.slice(0, 16)}...`,
  });

  // Step 2: Construct canonical signing string
  const canonicalSignedString =
    parsedHeader.timestamp !== null
      ? `${parsedHeader.timestamp}.${rawBody}`
      : rawBody;

  steps.push({
    stepNumber: 2,
    title: "Construct Canonical Signing Payload",
    status: "pass",
    detail:
      parsedHeader.timestamp !== null
        ? "Concatenated timestamp, '.', and exact raw UTF-8 request body bytes."
        : "Using exact raw UTF-8 request body bytes.",
    value:
      canonicalSignedString.length > 140
        ? `${canonicalSignedString.slice(0, 140)}... (${canonicalSignedString.length} bytes)`
        : canonicalSignedString,
  });

  // Step 3: Compute HMAC-SHA256 digest
  const expectedDigestHex = computeHmacSha256Hex(secret, canonicalSignedString);
  const digestMatches = constantTimeHexEquals(
    expectedDigestHex,
    parsedHeader.signatureHex
  );

  // Check if a JSON re-serialization / whitespace mutation caused the mismatch
  let whitespaceNormalizedMatch = false;
  if (!digestMatches) {
    try {
      const parsedJson = JSON.parse(rawBody);
      const compactBody = JSON.stringify(parsedJson);
      const prettyBody = JSON.stringify(parsedJson, null, 2);
      for (const candidate of [compactBody, prettyBody]) {
        const candidateCanonical =
          parsedHeader.timestamp !== null
            ? `${parsedHeader.timestamp}.${candidate}`
            : candidate;
        if (
          constantTimeHexEquals(
            computeHmacSha256Hex(secret, candidateCanonical),
            parsedHeader.signatureHex
          )
        ) {
          whitespaceNormalizedMatch = true;
          break;
        }
      }
      // Also check if header used `t.body` vs `body`
      if (!whitespaceNormalizedMatch && parsedHeader.timestamp !== null) {
        if (
          constantTimeHexEquals(
            computeHmacSha256Hex(secret, rawBody),
            parsedHeader.signatureHex
          )
        ) {
          whitespaceNormalizedMatch = true;
        }
      }
    } catch {
      // Not valid JSON, ignore
    }
  }

  steps.push({
    stepNumber: 3,
    title: "Compute HMAC-SHA256 & Constant-Time Digest Comparison",
    status: digestMatches ? "pass" : "fail",
    detail: digestMatches
      ? "Computed HMAC-SHA256 digest matches header signature via timing-safe comparison."
      : whitespaceNormalizedMatch
        ? "Digest mismatch on provided string, but matched after JSON whitespace normalization! Ensure your server verifies the unparsed raw request buffer before JSON.parse / body-parser."
        : "Computed HMAC-SHA256 digest does not match provided signature.",
    value: `expected=${expectedDigestHex}`,
  });

  if (!digestMatches) {
    return {
      isValid: false,
      diagnosticCode: "DIGEST_MISMATCH",
      diagnosticTitle: "Digest mismatch (possible body parsing issue)",
      diagnosticMessage: whitespaceNormalizedMatch
        ? "Signature matched when JSON whitespace was normalized. Your middleware is likely re-serializing JSON.stringify(req.body) instead of passing the raw request buffer."
        : "Computed HMAC-SHA256 digest does not match the signature header. Verify that your signing secret is correct and the raw request body has not been modified.",
      parsedHeader,
      canonicalSignedString,
      expectedDigestHex,
      providedDigestHex: parsedHeader.signatureHex,
      timestampAgeSeconds:
        parsedHeader.timestamp !== null
          ? nowSeconds - parsedHeader.timestamp
          : null,
      toleranceSeconds,
      whitespaceNormalizedMatch,
      steps,
    };
  }

  // Step 4: Replay window timestamp verification
  if (parsedHeader.timestamp !== null) {
    const ageSeconds = nowSeconds - parsedHeader.timestamp;
    const withinWindow = Math.abs(ageSeconds) <= toleranceSeconds;

    steps.push({
      stepNumber: 4,
      title: "Validate Replay Protection Window (5 mins)",
      status: withinWindow ? "pass" : "fail",
      detail: withinWindow
        ? `Timestamp delta is ${ageSeconds}s (within ±${toleranceSeconds}s tolerance window).`
        : `Timestamp delta is ${ageSeconds}s, exceeding the ±${toleranceSeconds}s (5-minute) replay window.`,
      value: `t=${parsedHeader.timestamp}, now=${nowSeconds}, delta=${ageSeconds}s`,
    });

    if (!withinWindow) {
      return {
        isValid: false,
        diagnosticCode: "TIMESTAMP_EXPIRED",
        diagnosticTitle: "Timestamp expired (>5 mins)",
        diagnosticMessage: `Cryptographic HMAC digest is valid, but the webhook timestamp (t=${parsedHeader.timestamp}) is ${Math.abs(ageSeconds)}s old, outside the ${toleranceSeconds}s replay protection window.`,
        parsedHeader,
        canonicalSignedString,
        expectedDigestHex,
        providedDigestHex: parsedHeader.signatureHex,
        timestampAgeSeconds: ageSeconds,
        toleranceSeconds,
        whitespaceNormalizedMatch: false,
        steps,
      };
    }

    return {
      isValid: true,
      diagnosticCode: "VALID_SIGNATURE",
      diagnosticTitle: "Valid Signature",
      diagnosticMessage:
        "HMAC-SHA256 digest verified in constant time and timestamp is within the 5-minute replay tolerance window.",
      parsedHeader,
      canonicalSignedString,
      expectedDigestHex,
      providedDigestHex: parsedHeader.signatureHex,
      timestampAgeSeconds: ageSeconds,
      toleranceSeconds,
      whitespaceNormalizedMatch: false,
      steps,
    };
  }

  return {
    isValid: true,
    diagnosticCode: "VALID_SIGNATURE",
    diagnosticTitle: "Valid Signature",
    diagnosticMessage:
      "HMAC-SHA256 digest verified in constant time against raw request body.",
    parsedHeader,
    canonicalSignedString,
    expectedDigestHex,
    providedDigestHex: parsedHeader.signatureHex,
    timestampAgeSeconds: null,
    toleranceSeconds,
    whitespaceNormalizedMatch: false,
    steps,
  };
}

/**
 * Generates copy-pasteable webhook signature verification middleware snippets
 * across 6 backend languages/frameworks.
 */
export function generateWebhookVerificationCode(
  language: WebhookVerifyLanguage,
  signingSecret = "whsec_..."
): { label: string; framework: string; code: string } {
  const secretPlaceholder = signingSecret || "whsec_...";

  switch (language) {
    case "nodejs":
      return {
        label: "Node.js",
        framework: "Express / Next.js App Router",
        code: `import crypto from "node:crypto";

const WEBHOOK_SECRET = process.env.ORBIT_WEBHOOK_SECRET || "${secretPlaceholder}";
const TOLERANCE_SECONDS = 300; // 5 minutes

export function verifyOrbitWebhook(rawBodyBuffer, signatureHeader) {
  const parts = Object.fromEntries(
    (signatureHeader || "").split(",").map((kv) => kv.trim().split("="))
  );
  const timestamp = Number(parts.t);
  const receivedHex = parts.v1;
  if (!Number.isFinite(timestamp) || !receivedHex) {
    throw new Error("Malformed X-Orbit-Signature header");
  }

  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > TOLERANCE_SECONDS) {
    throw new Error("Webhook timestamp expired (>5 mins)");
  }

  // IMPORTANT: Use the exact raw request bytes before JSON.parse()
  const signedPayload = \`\${timestamp}.\${rawBodyBuffer.toString("utf8")}\`;
  const expectedHex = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(signedPayload, "utf8")
    .digest("hex");

  const a = Buffer.from(expectedHex, "hex");
  const b = Buffer.from(receivedHex, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("Invalid Orbit webhook signature digest");
  }
  return JSON.parse(rawBodyBuffer.toString("utf8"));
}`,
      };

    case "python":
      return {
        label: "Python",
        framework: "FastAPI / Flask",
        code: `import hmac
import hashlib
import os
import time
from fastapi import Request, HTTPException

WEBHOOK_SECRET = os.environ.get("ORBIT_WEBHOOK_SECRET", "${secretPlaceholder}")
TOLERANCE_SECONDS = 300

async def verify_orbit_webhook(request: Request) -> bytes:
    sig_header = request.headers.get("X-Orbit-Signature", "")
    parts = dict(item.split("=", 1) for item in sig_header.split(",") if "=" in item)
    timestamp = int(parts.get("t", "0"))
    received_sig = parts.get("v1", "")

    if not timestamp or not received_sig:
        raise HTTPException(status_code=400, detail="Malformed X-Orbit-Signature header")

    if abs(int(time.time()) - timestamp) > TOLERANCE_SECONDS:
        raise HTTPException(status_code=400, detail="Webhook timestamp expired (>5 mins)")

    raw_body = await request.body()  # Exact raw bytes before JSON parsing
    signed_payload = f"{timestamp}.".encode("utf-8") + raw_body
    expected_sig = hmac.new(
        WEBHOOK_SECRET.encode("utf-8"),
        signed_payload,
        hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(expected_sig, received_sig):
        raise HTTPException(status_code=401, detail="Webhook signature mismatch")

    return raw_body`,
      };

    case "go":
      return {
        label: "Go",
        framework: "net/http",
        code: `package webhook

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const ToleranceSeconds = 300

func VerifyOrbitWebhook(r *http.Request, secret string) ([]byte, error) {
	sigHeader := r.Header.Get("X-Orbit-Signature")
	var ts int64
	var v1 string
	for _, part := range strings.Split(sigHeader, ",") {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) == 2 && kv[0] == "t" {
			ts, _ = strconv.ParseInt(kv[1], 10, 64)
		} else if len(kv) == 2 && kv[0] == "v1" {
			v1 = kv[1]
		}
	}
	if ts == 0 || len(v1) != 64 {
		return nil, errors.New("malformed X-Orbit-Signature header")
	}
	if diff := time.Now().Unix() - ts; diff > ToleranceSeconds || diff < -ToleranceSeconds {
		return nil, errors.New("webhook timestamp expired (>5 mins)")
	}
	rawBody, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(fmt.Sprintf("%d.%s", ts, string(rawBody))))
	expected := hex.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(expected), []byte(strings.ToLower(v1))) != 1 {
		return nil, errors.New("webhook digest mismatch")
	}
	return rawBody, nil
}`,
      };

    case "rust":
      return {
        label: "Rust",
        framework: "Axum",
        code: `use axum::{body::Bytes, http::{HeaderMap, StatusCode}};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;
const TOLERANCE_SECS: i64 = 300;

pub fn verify_orbit_webhook(headers: &HeaderMap, raw_body: &Bytes, secret: &str) -> Result<(), StatusCode> {
    let header = headers.get("x-orbit-signature").and_then(|v| v.to_str().ok()).ok_or(StatusCode::BAD_REQUEST)?;
    let (mut ts, mut sig_hex) = (None, None);
    for part in header.split(',') {
        if let Some((k, v)) = part.trim().split_once('=') {
            match k {
                "t" => ts = v.parse::<i64>().ok(),
                "v1" => sig_hex = Some(v),
                _ => {}
            }
        }
    }
    let (timestamp, received) = (ts.ok_or(StatusCode::BAD_REQUEST)?, sig_hex.ok_or(StatusCode::BAD_REQUEST)?);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
    if (now - timestamp).abs() > TOLERANCE_SECS {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    mac.update(format!("{}.", timestamp).as_bytes());
    mac.update(raw_body);
    let expected_bytes = hex::decode(received).map_err(|_| StatusCode::BAD_REQUEST)?;
    mac.verify_slice(&expected_bytes).map_err(|_| StatusCode::UNAUTHORIZED)
}`,
      };

    case "php":
      return {
        label: "PHP",
        framework: "Laravel / Native PHP",
        code: `<?php
$secret = getenv('ORBIT_WEBHOOK_SECRET') ?: '${secretPlaceholder}';
$sigHeader = $_SERVER['HTTP_X_ORBIT_SIGNATURE'] ?? '';
$rawBody = file_get_contents('php://input'); // Exact raw body bytes

$parts = [];
foreach (explode(',', $sigHeader) as $segment) {
    [$k, $v] = array_pad(explode('=', trim($segment), 2), 2, '');
    $parts[$k] = $v;
}

$timestamp = isset($parts['t']) ? (int)$parts['t'] : 0;
$receivedSig = $parts['v1'] ?? '';

if (!$timestamp || !$receivedSig || abs(time() - $timestamp) > 300) {
    http_response_code(400);
    exit('Invalid or expired X-Orbit-Signature');
}

$expectedSig = hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret);
if (!hash_equals($expectedSig, strtolower($receivedSig))) {
    http_response_code(401);
    exit('Webhook signature digest mismatch');
}`,
      };

    case "ruby":
      return {
        label: "Ruby",
        framework: "Rails / Sinatra",
        code: `require "openssl"
require "rack"

SECRET = ENV.fetch("ORBIT_WEBHOOK_SECRET", "${secretPlaceholder}")
TOLERANCE_SECONDS = 300

def verify_orbit_webhook!(request)
  sig_header = request.get_header("HTTP_X_ORBIT_SIGNATURE").to_s
  parts = sig_header.split(",").map { |s| s.strip.split("=", 2) }.to_h
  timestamp = parts["t"].to_i
  received_sig = parts["v1"].to_s

  raise "Malformed signature header" if timestamp.zero? || received_sig.empty?
  raise "Timestamp expired (>5 mins)" if (Time.now.to_i - timestamp).abs > TOLERANCE_SECONDS

  raw_body = request.body.read
  request.body.rewind
  expected_sig = OpenSSL::HMAC.hexdigest("SHA256", SECRET, "#{timestamp}.#{raw_body}")

  unless Rack::Utils.secure_compare(expected_sig, received_sig.downcase)
    raise "Webhook digest mismatch"
  end
end`,
      };
  }
}
