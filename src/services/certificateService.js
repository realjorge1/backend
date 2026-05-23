/**
 * Certificate Service
 * Handles .p12 / .pfx parsing, validation, and metadata extraction.
 * Uses node-forge for PKCS#12 container operations.
 */

const forge = require("node-forge");

/**
 * Parse a .p12 / .pfx buffer and extract certificate info + key material.
 * @param {Buffer} p12Buffer - Raw bytes of the .p12/.pfx file
 * @param {string} password - Certificate password
 * @returns {CertificateParseResult}
 */
function parseCertificate(p12Buffer, password) {
  try {
    // Convert Node Buffer to forge-compatible binary string
    const p12Der = forge.util.createBuffer(p12Buffer.toString("binary"));
    const p12Asn1 = forge.asn1.fromDer(p12Der);

    let p12;
    try {
      p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);
    } catch (err) {
      if (
        err.message &&
        err.message.toLowerCase().includes("invalid password")
      ) {
        return {
          success: false,
          error: "INVALID_PASSWORD",
          message: "Incorrect certificate password.",
        };
      }
      return {
        success: false,
        error: "PARSE_ERROR",
        message:
          "Could not parse certificate file. Ensure it is a valid .p12 or .pfx.",
      };
    }

    // Extract certificate bags
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
    const keyBags = p12.getBags({
      bagType: forge.pki.oids.pkcs8ShroudedKeyBag,
    });

    const certBagArray = certBags[forge.pki.oids.certBag] || [];
    const keyBagArray = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag] || [];

    if (certBagArray.length === 0) {
      return {
        success: false,
        error: "NO_CERT",
        message: "No certificate found in this file.",
      };
    }
    if (keyBagArray.length === 0) {
      return {
        success: false,
        error: "NO_KEY",
        message: "No private key found in this file.",
      };
    }

    const signerCert = certBagArray[0].cert;
    const privateKey = keyBagArray[0].key;
    const chainCerts = certBagArray.slice(1).map((b) => b.cert);

    const subject = extractDN(signerCert.subject);
    const issuer = extractDN(signerCert.issuer);

    const certInfo = {
      commonName: subject.CN || subject.O || "Unknown",
      organization: subject.O || "",
      email: subject.emailAddress || "",
      subject: formatDN(signerCert.subject),
      issuer: formatDN(signerCert.issuer),
      serialNumber: signerCert.serialNumber,
      validFrom: signerCert.validity.notBefore,
      validTo: signerCert.validity.notAfter,
      isExpired: new Date() > signerCert.validity.notAfter,
      isSelfSigned: isSelfSigned(signerCert),
      fingerprint: getFingerprint(signerCert),
    };

    return {
      success: true,
      certInfo,
      _signerCert: signerCert,
      _chainCerts: chainCerts,
      _privateKey: privateKey,
      _p12Buffer: p12Buffer,
      _password: password,
    };
  } catch (err) {
    return {
      success: false,
      error: "UNEXPECTED_ERROR",
      message: `Certificate processing failed: ${err.message}`,
    };
  }
}

/**
 * Validate that a certificate is still within its validity period.
 */
function validateCertificateValidity(certInfo) {
  const now = new Date();
  if (now < certInfo.validFrom) {
    return { valid: false, reason: "Certificate is not yet valid." };
  }
  if (now > certInfo.validTo) {
    return {
      valid: false,
      reason: `Certificate expired on ${certInfo.validTo.toLocaleDateString()}.`,
    };
  }
  return { valid: true };
}

function extractDN(dn) {
  const result = {};
  dn.attributes.forEach((attr) => {
    result[attr.shortName] = attr.value;
  });
  return result;
}

function formatDN(dn) {
  return dn.attributes.map((a) => `${a.shortName}=${a.value}`).join(", ");
}

function isSelfSigned(cert) {
  return (
    cert.subject.hash === cert.issuer.hash ||
    formatDN(cert.subject) === formatDN(cert.issuer)
  );
}

function getFingerprint(cert) {
  try {
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    const md = forge.md.sha1.create();
    md.update(der);
    return md.digest().toHex().toUpperCase().match(/.{2}/g).join(":");
  } catch {
    return "N/A";
  }
}

module.exports = { parseCertificate, validateCertificateValidity };
