// Inert CJS stub — MFA is never exercised in TDA-017 tests (mirrors tda015).
module.exports = { authenticator: { generate: () => '000000', check: () => true } };
