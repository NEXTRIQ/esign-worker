import { describe, expect, it } from "vitest";
import {
  canDownloadSigned,
  effectiveStatus,
  failureForStatus,
  isSignable,
  type SigningRequest,
} from "../../src/domain/model";

const base: SigningRequest = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "Service agreement",
  message: null,
  signerName: "Jane Doe",
  signerEmail: "signer@example.com",
  documentKey: "documents/x/original.pdf",
  documentSha256: "0".repeat(64),
  documentSize: 1000,
  documentPages: 1,
  status: "open",
  createdAt: "2026-03-01T00:00:00.000Z",
  expiresAt: "2026-03-15T00:00:00.000Z",
  viewedAt: null,
  revokedAt: null,
  signed: null,
};

const signed: SigningRequest = {
  ...base,
  status: "signed",
  signed: {
    signedAt: "2026-03-10T12:00:00.000Z",
    signedName: "Jane Doe",
    ipHash: "1".repeat(64),
    userAgent: "test",
    consentText: "I agree",
    documentKey: "signed/x/y.pdf",
    documentSha256: "2".repeat(64),
    documentSize: 2000,
    evidenceJson: "{}",
  },
};

const at = (iso: string) => new Date(iso);

describe("effective status", () => {
  it("is open or viewed until the expiry instant", () => {
    expect(effectiveStatus(base, at("2026-03-14T23:59:59.999Z"))).toBe("open");
    expect(effectiveStatus({ ...base, status: "viewed" }, at("2026-03-14T23:59:59.999Z"))).toBe(
      "viewed",
    );
  });

  it("is expired from the expiry instant on", () => {
    expect(effectiveStatus(base, at("2026-03-15T00:00:00.000Z"))).toBe("expired");
    expect(effectiveStatus({ ...base, status: "viewed" }, at("2026-04-01T00:00:00.000Z"))).toBe(
      "expired",
    );
  });

  it("keeps final states after expiry", () => {
    expect(effectiveStatus(signed, at("2027-01-01T00:00:00.000Z"))).toBe("signed");
    expect(effectiveStatus({ ...base, status: "revoked" }, at("2027-01-01T00:00:00.000Z"))).toBe(
      "revoked",
    );
  });
});

describe("signability", () => {
  it("allows signing only from open or viewed", () => {
    expect(isSignable("open")).toBe(true);
    expect(isSignable("viewed")).toBe(true);
    expect(isSignable("signed")).toBe(false);
    expect(isSignable("revoked")).toBe(false);
    expect(isSignable("expired")).toBe(false);
  });

  it("maps every other status to a failure reason", () => {
    expect(failureForStatus("open")).toBeNull();
    expect(failureForStatus("viewed")).toBeNull();
    expect(failureForStatus("signed")).toBe("already_signed");
    expect(failureForStatus("revoked")).toBe("revoked");
    expect(failureForStatus("expired")).toBe("expired");
  });
});

describe("signed download window", () => {
  it("is open for the configured number of days after signing", () => {
    expect(canDownloadSigned(signed, at("2026-04-09T11:59:59.000Z"), 30)).toBe(true);
    expect(canDownloadSigned(signed, at("2026-04-09T12:00:00.000Z"), 30)).toBe(false);
  });

  it("does not apply to unsigned requests", () => {
    expect(canDownloadSigned(base, at("2026-03-02T00:00:00.000Z"), 30)).toBe(false);
  });
});
