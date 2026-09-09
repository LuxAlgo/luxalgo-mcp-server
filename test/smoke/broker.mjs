/* Broker tools (stdio only): with no BROKERS_* env, setup lists everything unconfigured and data tools answer empty, never error. */

export async function run({ client, check, callJson }) {
  // No BROKERS_* env in this run: setup lists everything unconfigured and
  // the data tools answer cleanly with empty results, never errors.
  const setup = await callJson(client, "broker_setup", {});
  check(
    "broker_setup lists 16+ brokers, none configured, values never shown",
    !setup.isError &&
      setup.payload.length >= 16 &&
      setup.payload.every((b) => b.configured === false && b.readOnlySetup),
    `${setup.payload.length} brokers`,
  );
  const accounts = await callJson(client, "broker_accounts", {});
  check(
    "broker_accounts with nothing configured returns empty, not an error",
    !accounts.isError && accounts.payload.accounts?.length === 0 && accounts.payload.failures?.length === 0,
    `accounts=${accounts.payload.accounts?.length}, failures=${accounts.payload.failures?.length}`,
  );
}
