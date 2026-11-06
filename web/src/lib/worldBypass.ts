/**
 * World ID switched off, for testing while its setup is being fixed.
 *
 * With NEXT_PUBLIC_BYPASS_WORLD_ID=1, anyone who opens the app gets a test account with
 * no proof of being human, and held payments are approved with a click. Nothing of World
 * ID's is removed: unset the variable and redeploy, and all of it is back.
 *
 * This voids one-human-one-line, so it is for testnet only.
 */
export const worldBypassed = () => process.env.NEXT_PUBLIC_BYPASS_WORLD_ID === "1";
