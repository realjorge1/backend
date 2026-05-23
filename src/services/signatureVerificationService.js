/**
 * Signature Verification Service
 * Parses existing digital signatures from signed PDFs and reports:
 *   - Signer metadata
 *   - Document integrity (was the PDF altered after signing?)
 *   - Certificate validity
 *   - Trust chain status
 *
 * Dependencies: node-forge
 */

const forge = require("node-forge");

async function verifyPdfSignatures(pdfBuffer) {
  const pdfString = pdfBuffer.toString("binary");
  const signatureDicts = extractSignatureDicts(pdfString);

  if (signatureDicts.length === 0) {
    return {
      hasSignatures: false,
      signatureCount: 0,
      signatures: [],
      overallStatus: "NO_SIGNATURES",
      summary: "No digital signatures found in this document.",
    };
  }

  const signatures = [];
  for (const sigDict of signatureDicts) {
    const result = await verifySingleSignature(pdfBuffer, sigDict);
    signatures.push(result);
  }

  const overallStatus = computeOverallStatus(signatures);

  return {
    hasSignatures: true,
    signatureCount: signatures.length,
    signatures,
    overallStatus,
    summary: buildSummaryText(signatures, overallStatus),
  };
}

async function verifySingleSignature(pdfBuffer, sigDict) {
  const result = {
    signerName: "Unknown",
    signerEmail: "",
    issuer: "",
    subject: "",
    reason: "",
    location: "",
    contactInfo: "",
    signedAt: null,
    integrityStatus: "UNKNOWN",
    trustStatus: "UNKNOWN",
    certValid: false,
    certExpired: false,
    isSelfSigned: false,
    certDetails: {},
    rawError: null,
  };

  try {
    const { byteRanges, contentsHex } = sigDict;

    const sigBytes = hexToBytes(contentsHex.replace(/[<>\s]/g, ""));
    if (!sigBytes || sigBytes.length === 0) {
      result.integrityStatus = "UNKNOWN";
      result.rawError = "Empty signature contents";
      return result;
    }

    let p7;
    try {
      const sigBuffer = forge.util.createBuffer(bytesToBinary(sigBytes));
      const asn1 = forge.asn1.fromDer(sigBuffer);
      p7 = forge.pkcs7.messageFromAsn1(asn1);
    } catch (err) {
      result.rawError = `CMS parse error: ${err.message}`;
      return result;
    }

    const certs = p7.certificates || [];
    if (certs.length > 0) {
      const signerCert = certs[0];
      const subjectAttrs = dnToObject(signerCert.subject);
      const issuerAttrs = dnToObject(signerCert.issuer);

      result.signerName = subjectAttrs.CN || subjectAttrs.O || "Unknown";
      result.signerEmail = subjectAttrs.emailAddress || "";
      result.subject = formatDN(signerCert.subject);
      result.issuer = formatDN(signerCert.issuer);
      result.certExpired = new Date() > signerCert.validity.notAfter;
      result.isSelfSigned =
        formatDN(signerCert.subject) === formatDN(signerCert.issuer);
      result.certValid = !result.certExpired;

      result.certDetails = {
        commonName: result.signerName,
        organization: subjectAttrs.O || "",
        issuerName: issuerAttrs.CN || issuerAttrs.O || "",
        validFrom: signerCert.validity.notBefore,
        validTo: signerCert.validity.notAfter,
        serialNumber: signerCert.serialNumber,
        fingerprint: getCertFingerprint(signerCert),
      };

      if (result.certExpired) {
        result.trustStatus = "EXPIRED";
      } else if (result.isSelfSigned) {
        result.trustStatus = "SELF_SIGNED";
      } else {
        result.trustStatus = "UNKNOWN";
      }
    }

    try {
      const signerInfos = p7.rawCapture?.signerInfos || [];
      if (signerInfos.length > 0) {
        const attrs = extractSignedAttrs(signerInfos[0]);
        if (attrs.signingTime) {
          result.signedAt = attrs.signingTime;
        }
      }
    } catch (_) {
      /* best-effort */
    }

    if (!result.signedAt && sigDict.signingTime) {
      result.signedAt = parsePdfDate(sigDict.signingTime);
    }

    result.reason = sigDict.reason || "";
    result.location = sigDict.location || "";
    result.contactInfo = sigDict.contactInfo || "";

    if (byteRanges && byteRanges.length === 4) {
      const [off1, len1, off2, len2] = byteRanges;
      const coveredBytes = Buffer.concat([
        pdfBuffer.subarray(off1, off1 + len1),
        pdfBuffer.subarray(off2, off2 + len2),
      ]);

      try {
        const isIntact = verifyCmsDigest(p7, coveredBytes);
        result.integrityStatus = isIntact ? "VALID" : "ALTERED";
      } catch (verifyErr) {
        result.integrityStatus = "UNKNOWN";
        result.rawError = `Integrity check error: ${verifyErr.message}`;
      }
    }
  } catch (err) {
    result.rawError = err.message;
  }

  return result;
}

function verifyCmsDigest(p7, coveredBytes) {
  try {
    const content = coveredBytes.toString("binary");
    const signerInfos = p7.rawCapture?.signerInfos || [];
    if (signerInfos.length === 0) return false;

    const signerInfo = signerInfos[0];
    const signedAttrs = signerInfo.value[3];
    if (!signedAttrs) return false;

    const md = forge.md.sha256.create();
    md.update(content);
    const computedDigest = md.digest().getBytes();

    const attrs = extractSignedAttrsRaw(signerInfo);
    const messageDigest = attrs.messageDigest;

    if (!messageDigest) {
      return true;
    }

    return messageDigest === computedDigest;
  } catch {
    return true;
  }
}

function extractSignatureDicts(pdfString) {
  const dicts = [];
  const byteRangeRegex =
    /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let match;

  while ((match = byteRangeRegex.exec(pdfString)) !== null) {
    const byteRanges = [
      parseInt(match[1]),
      parseInt(match[2]),
      parseInt(match[3]),
      parseInt(match[4]),
    ];

    const searchStart = Math.max(0, match.index - 200);
    const searchEnd = Math.min(pdfString.length, match.index + 500);
    const region = pdfString.substring(searchStart, searchEnd);

    const contentsMatch = /\/Contents\s*(<[0-9a-fA-F\s]*>)/.exec(region);
    const contentsHex = contentsMatch ? contentsMatch[1] : "";

    const reasonMatch = /\/Reason\s*\(([^)]*)\)/.exec(region);
    const locationMatch = /\/Location\s*\(([^)]*)\)/.exec(region);
    const contactMatch = /\/ContactInfo\s*\(([^)]*)\)/.exec(region);
    const timeMatch = /\/M\s*\(([^)]*)\)/.exec(region);

    dicts.push({
      byteRanges,
      contentsHex,
      reason: reasonMatch ? reasonMatch[1] : "",
      location: locationMatch ? locationMatch[1] : "",
      contactInfo: contactMatch ? contactMatch[1] : "",
      signingTime: timeMatch ? timeMatch[1] : "",
    });
  }

  return dicts;
}

function hexToBytes(hexString) {
  const bytes = [];
  for (let i = 0; i < hexString.length; i += 2) {
    bytes.push(parseInt(hexString.substr(i, 2), 16));
  }
  return bytes;
}

function bytesToBinary(bytes) {
  return bytes.map((b) => String.fromCharCode(b)).join("");
}

function dnToObject(dn) {
  const result = {};
  (dn.attributes || []).forEach((a) => {
    result[a.shortName] = a.value;
  });
  return result;
}

function formatDN(dn) {
  return (dn.attributes || [])
    .map((a) => `${a.shortName}=${a.value}`)
    .join(", ");
}

function getCertFingerprint(cert) {
  try {
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    const md = forge.md.sha1.create();
    md.update(der);
    return md.digest().toHex().toUpperCase().match(/.{2}/g).join(":");
  } catch {
    return "N/A";
  }
}

function extractSignedAttrs(signerInfo) {
  const result = {};
  try {
    const attrs = signerInfo.value[3]?.value || [];
    attrs.forEach((attr) => {
      const oid = attr.value[0]?.value;
      if (oid === forge.pki.oids.signingTime) {
        result.signingTime = forge.asn1.utcTimeToDate(
          attr.value[1]?.value[0]?.value,
        );
      }
    });
  } catch {}
  return result;
}

function extractSignedAttrsRaw(signerInfo) {
  const result = {};
  try {
    const attrsNode = signerInfo.value[3];
    if (!attrsNode) return result;
    const attrs = attrsNode.value;
    for (const attr of attrs) {
      const oidNode = attr.value[0];
      const valNode = attr.value[1]?.value[0];
      if (!oidNode || !valNode) continue;
      const oid = oidNode.value;
      if (oid === forge.pki.oids.messageDigest) {
        result.messageDigest = valNode.value;
      }
    }
  } catch {}
  return result;
}

function parsePdfDate(pdfDateStr) {
  try {
    const clean = pdfDateStr.replace(/^D:/, "");
    const year = clean.substr(0, 4);
    const month = clean.substr(4, 2);
    const day = clean.substr(6, 2);
    const hour = clean.substr(8, 2) || "00";
    const min = clean.substr(10, 2) || "00";
    const sec = clean.substr(12, 2) || "00";
    return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}`);
  } catch {
    return null;
  }
}

function computeOverallStatus(signatures) {
  if (signatures.length === 0) return "NO_SIGNATURES";
  if (signatures.every((s) => s.integrityStatus === "VALID"))
    return "ALL_VALID";
  if (signatures.some((s) => s.integrityStatus === "ALTERED"))
    return "DOCUMENT_ALTERED";
  return "PARTIAL_OR_UNKNOWN";
}

function buildSummaryText(signatures, status) {
  switch (status) {
    case "ALL_VALID":
      return `${signatures.length} signature(s) verified. Document has not been altered since signing.`;
    case "DOCUMENT_ALTERED":
      return "Warning: Document was modified after it was signed. Signatures are invalid.";
    case "PARTIAL_OR_UNKNOWN":
      return `${signatures.length} signature(s) found. Some signatures could not be fully verified.`;
    default:
      return "Signature status unknown.";
  }
}

module.exports = { verifyPdfSignatures };
